// backend.mjs —— 模型接入，自动探测降级
//
//   1. magpie   http://127.0.0.1:3425/v1    首选：OpenAI 兼容，base64 图直接给，不要 key
//   2. cli      opencode run / codex exec   兜底：进程启动慢，但完全不依赖本机服务
//
// 两者都只做一件事：给一段文本（可带图），返回模型输出的字符串。
// 上层不用关心走的是哪条。
//
// 以前还有第三条「alma」（走 Alma 自己的 /api/chat/completions）。已经删掉了：
// 这个应用不再依赖 Alma，就不该在探测链里留一条指向它的分支 —— 那会让
// 「Alma 开着/关着」悄悄改变任务分类的结果，排查时完全看不出来。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const MAGPIE = process.env.MAGPIE_URL || 'http://127.0.0.1:3425/v1';
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

// ---------- 2. CLI 兜底 ----------

// Windows 上 opencode/codex 是 .cmd，spawn 直接给名字会 ENOENT。
// 这里绕开：找到 npm 全局装的真实 js 入口，用 node 跑。
// mac/Linux 上 npm 全局是可直接执行的 shim，但同样别猜 —— 挨个真实路径探一遍。
function npmGlobalDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    // NPM_GLOBAL_DIR 也放在 Windows 第一位 —— 否则测试没法用临时目录
    // 验「真身优先于壳」这件事，只能依赖本机装了什么。
    const dirs = [];
    if (process.env.NPM_GLOBAL_DIR) dirs.push(process.env.NPM_GLOBAL_DIR);
    dirs.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'));
    return dirs;
  }
  // Intel mac / Linux：/usr/local/lib/node_modules
  // Apple Silicon（Homebrew）：/opt/homebrew/lib/node_modules
  // 用户自己配的：~/.npm-global/lib/node_modules
  // NPM_GLOBAL_DIR 语义与 Windows 一致：给的是 npm 全局前缀（下面还有
  // node_modules），这样两平台的测试夹具可以共用同一份目录结构。
  const dirs = ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules'];
  if (process.env.NPM_GLOBAL_DIR) dirs.unshift(path.join(process.env.NPM_GLOBAL_DIR, 'node_modules'));
  dirs.push(path.join(home, '.npm-global', 'lib', 'node_modules'));
  return dirs;
}

export function resolveCliBin(name) {
  const win = process.platform === 'win32';
  // 同一份产物在不同平台的上架形式不一样，各自列清楚
  const map = win ? {
    // opencode 装的是原生 exe，可以直接当命令跑。
    // 新版 npm 包把真二进制放在 @opencode/cli；opencode-ai 里那个
    // 只有 479 字节，是给旧入口留的壳，spawn 它会直接 UNKNOWN。
    opencode: [
      { file: ['node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'], asExe: true },
      { file: ['node_modules', 'opencode-ai', 'bin', 'opencode.exe'], asExe: true },
      { file: ['node_modules', 'opencode', 'bin', 'opencode.exe'], asExe: true }
    ],
    // codex 是 js 入口，要用 node 跑
    codex: [
      { file: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'], asExe: false }
    ]
  } : {
    // mac 上是无后缀的原生二进制；同样先找 @opencode/cli 的真身
    opencode: [
      { file: ['@opencode', 'cli', 'bin', 'opencode'], asExe: true },
      { file: ['opencode-ai', 'bin', 'opencode'], asExe: true },
      { file: ['opencode', 'bin', 'opencode'], asExe: true }
    ],
    codex: [
      { file: ['@openai', 'codex', 'bin', 'codex.js'], asExe: false }
    ]
  };

  for (const base of npmGlobalDirs()) {
    for (const rel of map[name] || []) {
      const p = path.join(base, ...rel.file);
      if (fs.existsSync(p)) {
        return rel.asExe
          ? { command: p, args: [] }
          : { command: process.execPath, args: [p] };
      }
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
        throw new Error(kind + ' 通道不支持图片，请用 magpie');
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
    for (const name of ['magpie', 'opencode', 'codex']) {
      if (await all[name].available()) { resolved = all[name]; return resolved; }
    }
    throw new Error('没有可用的模型通道（magpie / cli 都不在）');
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
