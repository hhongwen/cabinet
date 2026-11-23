// 通用小工具：路径展开、id、glob、文件尾读等。保持零依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 展开 ~ 和 Windows 的 %VAR%，以及 posix 的 ${VAR}。 */
export function expandVars(input) {
  if (input === undefined || input === null) return input;
  let s = String(input);
  // ~ 只在开头有意义
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  // %APPDATA% 形式（Windows）
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v === undefined ? m : v;
  });
  // ${VAR} 形式（跨平台）
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
  return s;
}

/**
 * 把配置里的路径变成绝对路径。
 * 相对路径以 baseDir（一般是配置文件所在目录）为基准。
 */
export function resolveConfigPath(p, baseDir) {
  const expanded = expandVars(p);
  if (!expanded) return null;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDir, expanded);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 生成短 id：前缀 + 时间 + 随机，便于人肉识别。 */
export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${t}${r}`;
}

export function parseJson(text, fallback = null) {
  if (text === undefined || text === null || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** glob -> RegExp，支持 **（跨目录）* ? 。够用即可，不做 POSIX 全套。 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * 判断相对路径是否命中任一 ignore 规则。
 * 会同时测试全路径、祖先目录、以及补上尾部斜杠的形式，
 * 这样 `**\/.git/**` 也能挡住 `.git` 目录本身。
 */
export function matchAnyGlob(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const p = String(relPath).replace(/\\/g, '/');
  const segs = p.split('/').filter(Boolean);
  const candidates = new Set([p, `${p}/`]);
  for (let i = 1; i < segs.length; i++) {
    const prefix = segs.slice(0, i).join('/');
    candidates.add(prefix);
    candidates.add(`${prefix}/`);
  }
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    const bare = String(pattern).replace(/\/\*\*$/, '');
    const bareRe = bare === pattern ? null : globToRegExp(bare);
    for (const c of candidates) {
      if (re.test(c)) return true;
      if (bareRe && bareRe.test(c.replace(/\/$/, ''))) return true;
    }
  }
  return false;
}

/** 读文件末尾 n 行，文件不存在返回 ''。用于 `show` 打 transcript 尾部。 */
export function tailFile(file, n = 40) {
  if (!file || !fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const maxBytes = 256 * 1024;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    return lines.slice(-n).join('\n').trim();
  } finally {
    fs.closeSync(fd);
  }
}

/** 递归列出目录下的相对路径（有上限，避免扫爆 node_modules）。 */
export function walkFiles(root, { limit = 5000, ignore = [] } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const norm = childRel.split(path.sep).join('/');
      if (matchAnyGlob(norm, ignore)) continue;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else {
        out.push(norm);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/** 毫秒 -> 人类可读，用于表格。 */
export function fmtDuration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** 时间戳 -> 本地短格式 2025-11-11 14:07:31 */
export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 终端显示宽度（中日韩全角算 2 列），表格对齐用。 */
export function displayWidth(str) {
  let w = 0;
  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 按显示宽度截断并补齐，用于表格列。 */
export function pad(str, width) {
  const s = truncate(str, width);
  const w = displayWidth(s);
  return s + ' '.repeat(Math.max(0, width - w));
}

export function truncate(str, width) {
  const s = String(str ?? '').replace(/\s+/g, ' ');
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 统一日志，带时间前缀。 */
export function createLogger(scope = 'hub') {
  const emit = (level, msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${level} [${scope}] ${msg}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  };
  return {
    info: (m) => emit('INFO ', m),
    warn: (m) => emit('WARN ', m),
    error: (m) => emit('ERROR', m),
    debug: (m) => {
      if (process.env.CABINET_DEBUG) emit('DEBUG', m);
    },
  };
}
