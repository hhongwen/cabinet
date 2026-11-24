// opencode-agent.mjs —— OpenCode CLI 适配层
//
// 这一层只回答四个问题：
//   1. OpenCode 装在哪、能不能跑
//   2. 这个会话的外部 ID 是什么
//   3. 发一轮消息时，stdout 的 JSONL 怎么变成「正文 / 终态 / 外部 messageID」
//   4. 重启之后，`opencode session export` 能不能证明上一轮到底跑完没有
//
// 它不碰 SQLite、不决定 Turn 状态 —— 那些在 agent.mjs。这样 CLI 的输出
// 形状变了，只需要改这一个文件。

import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';

import { resolveCliBin } from './backend.mjs';

/**
 * 解析一行 JSONL。坏行返回 null，不抛 —— CLI 偶尔会在 JSON 前面
 * 打一行日志，一行坏数据不该让整轮执行失败。
 */
export function parseEventLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  let e;
  try { e = JSON.parse(s); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const part = e.part && typeof e.part === 'object' ? e.part : {};
  return {
    type: String(e.type || ''),
    sessionID: e.sessionID || part.sessionID || null,
    messageID: part.messageID || e.messageID || null,
    text: typeof part.text === 'string' ? part.text
      : (typeof e.text === 'string' ? e.text : ''),
    finishReason: e.type === 'step_finish' ? (part.reason || e.reason || null) : null
  };
}

/**
 * 把 `opencode session export` 的 JSON 压成核对需要的形状。
 * `messages` 只保留 id / type / text / completed —— 核对只按 external_ref
 * 找那一轮，不需要把完整 transcript 再存一份。
 */
export function summarizeExport(json) {
  const info = json && json.info ? json.info : {};
  const time = info.time || {};
  const busy = Number(time.busy || 0);
  const idle = Number(time.idle || 0);

  let status = 'unknown';
  if (busy > idle) status = 'busy';
  else if (info.outcome === 'succeeded') status = 'idle';

  const messages = (Array.isArray(json && json.messages) ? json.messages : []).map((m) => {
    const type = m.type || (m.info && m.info.role) || '';
    const text = type === 'assistant'
      ? (Array.isArray(m.content) ? m.content : [])
        .filter((p) => p && p.type === 'text')
        .map((p) => p.text || '').join('\n')
      : (typeof m.text === 'string' ? m.text : '');
    return {
      id: m.id || (m.info && m.info.id) || null,
      type,
      text,
      completed: !!(m.time && m.time.completed)
    };
  }).filter((m) => m.id || m.type);

  let lastText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant' && messages[i].text) {
      lastText = messages[i].text;
      break;
    }
  }

  return {
    outcome: info.outcome || null,
    status,
    lastText,
    messageCount: messages.length,
    messages
  };
}

function newExternalSessionId() {
  return 'ses_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 杀掉整棵进程树。OpenCode 可能自己再起子进程，只 kill 父进程会留下
 * 一个还在跑的 Agent —— 下一轮就会抢同一个会话。
 */
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore'
      });
    } catch { /* 已经退出 */ }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
  }, 2000);
  if (timer.unref) timer.unref();
}

function baseCommand(opts = {}) {
  if (opts.command) return { command: opts.command, args: opts.args || [] };
  return resolveCliBin('opencode');
}

export function createOpenCodeAdapter(opts = {}) {
  const base = baseCommand(opts);
  const env = opts.env || process.env;

  async function available() {
    try {
      if (base.command === 'opencode') return false;
      if (base.args.length) return fs.existsSync(base.args[0]);
      return fs.existsSync(base.command);
    } catch {
      return false;
    }
  }

  async function ensureSession({ session }) {
    if (session && session.external_session_id) {
      return { externalSessionId: session.external_session_id, created: false };
    }
    return { externalSessionId: newExternalSessionId(), created: true };
  }

  async function runTurn({ session, text, onEvent, signal }) {
    if (!session || !session.external_session_id) {
      throw new Error('会话还没绑定外部 Session ID');
    }
    if (!session.working_directory) throw new Error('会话没有工作目录');

    const args = [
      ...base.args,
      'run', '--format', 'json', '--auto',
      '--session', session.external_session_id
    ];
    if (session.model) args.push('--model', session.model);

    const child = spawn(base.command, args, {
      cwd: session.working_directory,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuf = '';
    let stderr = '';
    let lastMessageID = null;
    let finalReason = null;
    const steps = [];
    let current = [];

    const flushLine = (line) => {
      const parsed = parseEventLine(line);
      if (!parsed) return;
      const raw = (() => { try { return JSON.parse(line); } catch { return null; } })();
      if (raw && typeof onEvent === 'function') onEvent(raw);

      if (parsed.messageID) lastMessageID = parsed.messageID;
      if (parsed.type === 'step_start') {
        if (current.length) steps.push(current);
        current = [];
      } else if (parsed.type === 'text' && parsed.text) {
        current.push(parsed.text);
      } else if (parsed.type === 'step_finish') {
        finalReason = parsed.finishReason;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        flushLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // stderr 也按行交给 Runner 落事件文件；不混进结果正文。
      if (typeof onEvent === 'function') {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) onEvent({ type: 'stderr', text: line });
        }
      }
    });

    let aborted = false;
    const onAbort = () => { aborted = true; killTree(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const result = await new Promise((resolve, reject) => {
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (stdoutBuf.trim()) flushLine(stdoutBuf);
        if (current.length) steps.push(current);
        resolve({
          externalRef: lastMessageID,
          resultText: steps.length
            ? steps[steps.length - 1].join('\n')
            : steps.join('\n'),
          exitCode: code === null ? null : Number(code),
          finalReason,
          stderr,
          aborted
        });
      });
      // prompt 走 stdin：Windows 命令行有长度上限，中文/换行也容易被转义坏。
      child.stdin.end(String(text || ''), 'utf8');
    });

    if (signal) signal.removeEventListener('abort', onAbort);
    return result;
  }

  async function exportSession({ session }) {
    if (!session || !session.external_session_id) {
      throw new Error('会话还没绑定外部 Session ID');
    }
    const args = [...base.args, 'session', 'export', session.external_session_id];
    const out = await new Promise((resolve, reject) => {
      execFile(base.command, args, {
        cwd: session.working_directory,
        env,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15000
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error('导出失败：' + String(stderr || err.message || err).slice(0, 300)));
          return;
        }
        resolve(stdout);
      });
    });

    let json;
    try { json = JSON.parse(out); } catch {
      throw new Error('导出结果不是 JSON');
    }
    if (!json || !json.info) throw new Error('导出结果没有 info');
    return summarizeExport(json);
  }

  return { kind: 'opencode', available, ensureSession, runTurn, exportSession };
}
