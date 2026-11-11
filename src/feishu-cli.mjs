// 飞书长连接：通过 lark-cli 子进程收事件，不走 Webhook。
//
// 为什么是这个方案（对比过三条路）：
//   1. 官方 SDK 直连：依赖 protobufjs + ws，破坏零 npm 依赖
//   2. 自己写 pbbp2 protobuf 编解码：约 200 行协议代码，出错表现为「消息随机丢」
//   3. lark-cli 子进程（本方案）：CLI 挡住 protobuf，我们只读 stdout 的 JSON 行。
//      需要机器上装 lark-cli 并登录，但不需要公网地址、不需要 npm 包。
//
// 代价：多一个外部依赖（lark-cli）。用 `alma doctor` 能查出来装没装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from './util.mjs';

const log = createLogger('feishu-cli');


/**
 * 解析 lark-cli 的真实入口。
 *
 * Windows 上 `lark-cli` 是 .cmd 包装脚本，spawn 找不到它（也没有 shell:true）。
 * 照项目一贯做法：直接调 node <run.js>，绕开 .cmd 这层壳。
 * 这和 config 里 codex 的处理方式一致。
 */
export function resolveCli(cliPath = 'lark-cli') {
  // 明确给了路径就直接用
  if (cliPath.includes('/') || cliPath.includes('\\')) return { command: cliPath, args: [] };

  const isWin = process.platform === 'win32';
  const home = os.homedir();

  if (isWin) {
    // npm 全局装的：<prefix>/node_modules/@larksuite/cli/scripts/run.js
    const candidates = [
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm',
        'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return { command: process.execPath, args: [p] };
      } catch { /* ignore */ }
    }
  } else {
    for (const p of ['/usr/local/bin/lark-cli', '/opt/homebrew/bin/lark-cli']) {
      try {
        if (fs.existsSync(p)) return { command: p, args: [] };
      } catch { /* ignore */ }
    }
  }
  // 兜底：让它自己找（非 Windows 通常能行）
  return { command: cliPath, args: [] };
}

/** 默认的事件类型。 */
export const EVENT_MESSAGE = 'im.message.receive_v1';
export const EVENT_CARD = 'card.action.trigger';

/**
 * 长连接客户端。
 * @param {object} opts
 *   cliPath     lark-cli 可执行文件（默认 PATH 里找）
 *   profile     lark-cli 的 profile 名（config init --name 建的那个）
 *   onEvent     收事件的回调 async (evt) => void
 *   onError     错误回调
 *   maxEvents   收到多少条后停（测试用）
 *   restartDelayMs 断线重连间隔
 */
export function createFeishuLongConn(opts = {}) {
  const cfg = {
    cliPath: opts.cliPath ?? 'lark-cli',
    profile: opts.profile ?? null,
    onEvent: opts.onEvent ?? (() => {}),
    onError: opts.onError ?? ((e) => log.warn(String(e))),
    maxEvents: opts.maxEvents ?? 0,
    restartDelayMs: opts.restartDelayMs ?? 10_000,
  };

  const state = {
    running: false,
    child: null,
    eventsSeen: 0,
    restarts: 0,
    lastEventAt: null,
    lastError: null,
  };

  let stopRequested = false;

  /** 拼命令行。profile 有值就带上。 */
  function argsFor(eventKey) {
    const a = ['event', 'consume', eventKey];
    if (cfg.profile) a.push('--profile', cfg.profile);
    a.push('--as', 'bot');
    if (cfg.maxEvents > 0) a.push('--max-events', String(cfg.maxEvents));
    return a;
  }

  /**
   * 起一个消费进程，读到 close 再重连。
   * stdin 必须保持打开：lark-cli 把 stdin EOF 当成退出信号。
   */
  function runOnce(eventKey) {
    return new Promise((resolve) => {
      let child;
      try {
        const exe = resolveCli(cfg.cliPath);
        child = spawn(exe.command, [...exe.args, ...argsFor(eventKey)], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        state.lastError = `spawn 失败: ${err.message}`;
        cfg.onError(state.lastError);
        resolve();
        return;
      }

      state.child = child;
      let buf = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      // stdout：一行一个 JSON 事件
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (!line.startsWith('{')) continue; // 进度信息，不是事件
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          state.eventsSeen++;
          state.lastEventAt = new Date().toISOString();
          Promise.resolve()
            .then(() => cfg.onEvent(evt))
            .catch((e) => cfg.onError(`处理事件失败: ${e.message}`));
        }
      });

      // stderr：CLI 的日志，只记不处理
      child.stderr.on('data', (chunk) => {
        const s = String(chunk).trim();
        if (!s) return;
        if (/ready|connected|listening/i.test(s)) log.info(`[lark-cli] ${s.slice(0, 120)}`);
        else if (/error|fail/i.test(s)) log.warn(`[lark-cli] ${s.slice(0, 160)}`);
      });

      child.on('error', (err) => {
        state.lastError = err.message;
        cfg.onError(`lark-cli 出错: ${err.message}`);
      });

      child.on('close', (code) => {
        state.child = null;
        log.info(`lark-cli 退出 (code=${code})`);
        resolve();
      });

      // 关键：stdin 一直开着，否则 CLI 会以为上游断了
      try {
        child.stdin.write('');
      } catch {
        /* ignore */
      }
    });
  }

  /** 主循环：起来 → 断了就重连。 */
  async function loop(eventKey) {
    state.running = true;
    while (state.running && !stopRequested) {
      await runOnce(eventKey);
      state.child = null;
      if (stopRequested || !state.running) break;
      state.restarts++;
      log.warn(`${cfg.restartDelayMs}ms 后重连（第 ${state.restarts} 次）`);
      await new Promise((r) => setTimeout(r, cfg.restartDelayMs));
    }
    state.running = false;
  }

  return {
    /** 开始消费。返回的 promise 在 stop() 之后才 resolve。 */
    start(eventKey = EVENT_MESSAGE) {
      stopRequested = false;
      return loop(eventKey);
    },
    /** 停止。 */
    stop() {
      stopRequested = true;
      state.running = false;
      if (state.child) {
        try {
          state.child.kill();
        } catch {
          /* ignore */
        }
      }
    },
    state,
    get stats() {
      return {
        running: state.running,
        eventsSeen: state.eventsSeen,
        restarts: state.restarts,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
      };
    },
  };
}

/** 发消息时用 lark-cli，不用自己拼 HTTP（省得管 token）。 */
export function createFeishuCliSender(opts = {}) {
  const cliPath = opts.cliPath ?? 'lark-cli';
  const profile = opts.profile ?? null;

  function run(args, input = null) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        const exe = resolveCli(cliPath);
        child = spawn(exe.command, [...exe.args, ...args], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ out, err, code }));
      try {
        if (input != null) child.stdin.write(input);
        child.stdin.end();
      } catch {
        /* ignore */
      }
    });
  }

  function baseArgs() {
    return profile ? ['--profile', profile] : [];
  }

  return {
    /** 给某人（open_id）发文本。 */
    async sendText(text, openId) {
      const args = [
        'im', '+messages-send',
        ...baseArgs(),
        '--user-id', openId,
        '--as', 'bot',
        '--msg-type', 'text',
        '--content', JSON.stringify({ text: String(text ?? '') }),
      ];
      const parsed = parseResult(await run(args));
      if (!parsed.ok) {
        log.warn(`发消息失败: ${JSON.stringify(parsed.error).slice(0, 200)}`);
      }
      return parsed;
    },

    /**
     * 更新一张已发出的卡片。用于「点完之后把按钮换成结果」，
     * 防止同一张卡片被反复点。
     */
    async patchCard(messageId, card) {
      const r = await run([
        'im', 'messages', 'patch',
        ...baseArgs(),
        '--message-id', messageId,
        '--as', 'bot',
        '--data', '-',
      ], JSON.stringify({ content: JSON.stringify(card) }));
      const parsed = parseResult(r);
      if (!parsed.ok) {
        log.warn(`更新卡片失败: ${JSON.stringify(parsed.error).slice(0, 200)}`);
      }
      return parsed;
    },

    /** 发交互卡片（JSON 字符串作为 content）。 */
    async sendCard(card, openId) {
      const args = [
        'im', '+messages-send',
        ...baseArgs(),
        '--user-id', openId,
        '--as', 'bot',
        '--msg-type', 'interactive',
        '--content', JSON.stringify(card),
      ];
      const parsed = parseResult(await run(args));
      if (!parsed.ok) {
        log.warn(`发卡片失败: ${JSON.stringify(parsed.error).slice(0, 200)}`);
      }
      return parsed;
    },

    run,
  };
}

/**
 * 解析 lark-cli 的结果。
 *
 * 关键事实（踩过）：成功时 JSON 在 stdout；失败时 lark-cli 把 JSON 打到 stderr，
 * stdout 是空的，退出码非零。之前只读 stdout，导致所有失败都被当成 null
 * ——「patch 返回成功但卡片没变」就是这么来的。
 */
export function parseResult(result) {
  const out = String(result?.out ?? '').trim();
  const err = String(result?.err ?? '').trim();
  const code = result?.code ?? 0;

  // 优先 stdout，其次 stderr（失败信息在那里）
  let parsed = tryJson(out) ?? tryJson(err);

  if (parsed === null) {
    return {
      ok: false,
      error: { type: 'parse', message: (err || out || '').slice(0, 300) || 'lark-cli 没有输出' },
      exitCode: code,
    };
  }
  if (parsed.ok === false || code !== 0) {
    return { ...parsed, ok: false, exitCode: code };
  }
  return { ...parsed, ok: true, exitCode: code };
}

function tryJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 先试整体
  try {
    return JSON.parse(raw);
  } catch { /* 继续 */ }

  // 再试「从第一个 { 到最后一个 }」，跳过混进来的日志行
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch { /* 放弃 */ }
  }
  return null;
}
