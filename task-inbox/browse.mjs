// browse.mjs —— 目录浏览
//
// 浏览器里没法弹系统文件对话框（<input type="file" webkitdirectory> 只给相对路径，
// 拿不到盘符）。所以这里做一个纯 HTTP 的目录浏览：列盘符 → 逐层进入。
//
// 插件跑在 Node 里，有完整的 fs 权限，列目录没问题。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Windows 上列盘符；其它平台只有一个根
export function listRoots() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const roots = [];
  for (let i = 65; i <= 90; i++) {          // A..Z
    const letter = String.fromCharCode(i) + ':\\';
    try {
      fs.accessSync(letter, fs.constants.R_OK);
      roots.push({ name: letter.slice(0, 2), path: letter });
    } catch { /* 不存在或不可读 */ }
  }
  return roots;
}

// 列一层目录。只返回子目录（文件对这个用途没意义）
export function listDir(target) {
  const dir = path.resolve(target || os.homedir());

  const st = fs.statSync(dir);              // 不存在会抛，由上层 catch
  if (!st.isDirectory()) throw new Error('不是目录: ' + dir);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    // 跳过系统隐藏目录，但保留 .config 这类有用的
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    // 符号链接要确认能读，避免点了报错
    let ok = true;
    try { ok = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { ok = false; }
    if (!ok) continue;
    dirs.push(e.name);
  }
  dirs.sort((a, b) => a.localeCompare(b, 'zh'));

  const parent = path.dirname(dir);
  const isRoot = parent === dir;

  return {
    path: dir,
    parent: isRoot ? null : parent,
    dirs: dirs.map((name) => ({ name, path: path.join(dir, name) })),
    isGitRepo: safeExists(path.join(dir, '.git')),
    isProject: safeExists(path.join(dir, 'package.json'))
      || safeExists(path.join(dir, 'AGENTS.md'))
      || safeExists(path.join(dir, '.git')),
    counts: { dirs: dirs.length }
  };
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
