// backend.mjs —— 三种模型接入方式，自动探测降级
//
//   1. magpie   http://127.0.0.1:3425/v1    首选：OpenAI 兼容，base64 图直接给，不要 key
//   2. alma     http://localhost:23001      次选：图要先传 gallery 换成 url
//   3. cli      opencode run / codex exec   兜底：进程启动慢，但完全不依赖本机服务
//
// 三者都只做一件事：给一段文本（可带图），返回模型输出的字符串。
// 上层不用关心走的是哪条。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const MAGPIE = process.env.MAGPIE_URL || 'http://127.0.0.1:3425/v1';
const ALMA = process.env.ALMA_API_URL || 'http://localhost:23001';
const DEFAULT_MODEL = process.env.TASK_INBOX_MODEL || 'auto/deepseek-v4.1-flash';
const CLI_TIMEOUT = Number(process.env.TASK_INBOX_CLI_TIMEOUT || 60000);

// ---------- 工具 ----------

function guessImageType(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

async function probe(url, timeout = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch { return false; }
}

function dataUrlOf(file) {
  const buf = fs.readFileSync(file);
  return 'data:' + guessImageType(file) + ';base64,' + buf.toString('base64');
}

// ---------- 1. magpie ----------

function magpieBackend() {
  return {
    name: 'magpie',
    async available() {
      return await probe(MAGPIE + '/models');
    },
    async chat({ system, text, images = [], model }) {
      const content = [{ type: 'text', text }];
      for (const img of images.slice(0, 3)) {
        content.push({ type: 'image_url', image_url: { url: dataUrlOf(img) } });
      }

      const body = {
        model: model || DEFAULT_MODEL,
        stream: false,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content }
        ]
      };

      const r = await fetch(MAGPIE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
      const raw = await r.text();
      if (!r.ok) throw new Error('magpie ' + r.status + ': ' + raw.slice(0, 200));

      const d = JSON.parse(raw);
      const msg = d?.choices?.[0]?.message;
      if (!msg) throw new Error('magpie 返回没有 choices');
      return { text: msg.content || '', model: d.model || body.model };
    }
  };
}

// ---------- 2. alma ----------

function almaBackend() {
  let cachedModel = null;

  async function resolveModel(model) {
    if (cachedModel) return cachedModel;
    const want = model || DEFAULT_MODEL;
    try {
      const r = await fetch(ALMA + '/api/models', { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      const list = d.data || [];
      const hit = list.find((m) => m.id === want);
      if (hit) { cachedModel = hit.providerId + ':' + hit.id; return cachedModel; }
      const anyVision = list.find((m) => m.capabilities?.vision);
      if (anyVision) { cachedModel = anyVision.providerId + ':' + anyVision.id; return cachedModel; }
    } catch { /* 忽略 */ }
    return want.includes(':') ? want : want;
  }

  async function uploadImage(file) {
    const buf = await fs.promises.readFile(file);
    const r = await fetch(ALMA + '/api/attachments/image', {
      method: 'POST',
      headers: { 'content-type': guessImageType(file) },
      body: buf,
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('gallery 上传 ' + r.status);
    const d = await r.json();
    return d.url;
  }

  return {
    name: 'alma',
    async available() { return await probe(ALMA + '/api/health'); },
    async chat({ system, text, images = [], model }) {
      const parts = [{ type: 'text', text }];
      for (const img of images.slice(0, 3)) {
        const url = await uploadImage(img);
        parts.push({
          type: 'file',
          filename: path.basename(img),
          mediaType: guessImageType(img),
          url
        });
      }

      const body = {
        model: await resolveModel(model),
        stream: false,
        messages: [
          ...(system ? [{ role: 'system', parts: [{ type: 'text', text: system }] }] : []),
          { role: 'user', parts }
        ]
      };

      const r = await fetch(ALMA + '/api/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
      const raw = await r.text();
      if (!r.ok) throw new Error('alma ' + r.status + ': ' + raw.slice(0, 200));
      const d = JSON.parse(raw);
      const msg = d?.choices?.[0]?.message;
      if (!msg) throw new Error('alma 返回没有 choices');
      return { text: msg.content || '', model: d.model || body.model };
    }
  };
}

// ---------- 3. CLI 兜底 ----------

// Windows 上 opencode/codex 是 .cmd，spawn 直接给名字会 ENOENT。
// 这里绕开：找到 npm 全局装的真实 js 入口，用 node 跑。
function resolveCliBin(name) {
  const home = os.homedir();
  const npmDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm');
  const map = {
    // opencode 装的是原生 exe，可以直接当命令跑
    opencode: [
      { file: ['node_modules', 'opencode-ai', 'bin', 'opencode.exe'], asExe: true },
      { file: ['node_modules', 'opencode', 'bin', 'opencode.exe'], asExe: true }
    ],
    // codex 是 js 入口，要用 node 跑
    codex: [
      { file: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'], asExe: false }
    ]
  };
  for (const rel of map[name] || []) {
    const p = path.join(npmDir, ...rel.file);
    if (fs.existsSync(p)) {
      return rel.asExe
        ? { command: p, args: [] }
        : { command: process.execPath, args: [p] };
    }
  }
  return { command: name, args: [] };
}

function runCli(cmd, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('CLI 超时')); }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('CLI 退出码 ' + code + ': ' + (err || out).slice(0, 200)));
    });

    // prompt 走 stdin —— Windows 上拼进命令行必然会炸
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function cliBackend(kind) {
  return {
    name: kind,
    async available() {
      const b = resolveCliBin(kind);
      if (b.command === kind) return false;          // 没找到真实入口
      if (b.args.length) return fs.existsSync(b.args[0]);  // js 入口
      return fs.existsSync(b.command);               // 原生 exe 直接查自身
    },
    async chat({ system, text, images = [] }) {
      if (images.length) {
        // CLI 传图各家参数都不一样，容易失败。这里直说，不假装能行。
        throw new Error(kind + ' 通道不支持图片，请用 magpie 或 alma');
      }
      const prompt = (system ? system + '\n\n' : '') + text;
      const bin = resolveCliBin(kind);

      if (kind === 'opencode') {
        const out = await runCli(bin.command, [...bin.args, 'run', '--model', 'magpie/' + DEFAULT_MODEL], prompt, CLI_TIMEOUT);
        return { text: out, model: 'cli/' + kind };
      }
      // codex exec 读 stdin
      const out = await runCli(bin.command, [...bin.args, 'exec', '--skip-git-repo-check'], prompt, CLI_TIMEOUT);
      return { text: out, model: 'cli/' + kind };
    }
  };
}

// ---------- 组合 ----------

export function createBackend(opts = {}) {
  const mode = String(opts.mode || process.env.TASK_INBOX_BACKEND || 'auto').toLowerCase();
  const model = opts.model || DEFAULT_MODEL;

  const all = {
    magpie: magpieBackend(),
    alma: almaBackend(),
    opencode: cliBackend('opencode'),
    codex: cliBackend('codex')
  };

  let resolved = null;

  async function pick() {
    if (resolved) return resolved;

    if (mode !== 'auto') {
      const b = all[mode];
      if (!b) throw new Error('未知 backend: ' + mode);
      resolved = b;
      return resolved;
    }

    // 固定顺序：最快的先试
    for (const name of ['magpie', 'alma', 'opencode', 'codex']) {
      if (await all[name].available()) { resolved = all[name]; return resolved; }
    }
    throw new Error('没有可用的模型通道（magpie / alma / cli 都不在）');
  }

  return {
    get name() { return resolved?.name || '(未探测)'; },
    async chat(args) {
      const b = await pick();
      return await b.chat({ ...args, model });
    },
    async status() {
      const out = {};
      for (const [k, v] of Object.entries(all)) out[k] = await v.available();
      return out;
    },
    reset() { resolved = null; }
  };
}
