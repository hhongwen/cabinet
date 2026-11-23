#!/usr/bin/env node
// cli.mjs —— 不打开浏览器也能管任务
//
//   node cli.mjs                    看所有任务
//   node cli.mjs add "买咖啡豆"      加一条
//   node cli.mjs add "写周报" -p 工作 --p0 -c 工作
//   node cli.mjs ls --todo          只看未开始
//   node cli.mjs move <id> doing    换列
//   node cli.mjs done <id>          标完成
//   node cli.mjs ls --json          给程序看的输出

import os from 'node:os';
import path from 'node:path';
import { createCore, PRIORITY_LABEL, KIND_LABEL } from './core.mjs';

const DATA_DIR = process.env.TASK_INBOX_DATA || path.join(os.homedir(), '.config', 'alma', 'task-inbox');
const core = createCore(DATA_DIR);

const argv = process.argv.slice(2);
const cmd = argv[0] || 'ls';

function flag(name) {
  const i = argv.indexOf(name);
  return i > -1;
}
function opt(name, short) {
  for (const n of [name, short].filter(Boolean)) {
    const i = argv.indexOf(n);
    if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  }
  return undefined;
}
function args() {
  // 去掉命令本身和所有 --flag / -x value
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a.startsWith('-')) {
      if (!a.includes('=') && ['-p', '-c', '--project', '--category', '--priority'].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const PRI = { '--p0': 'p0', '--p1': 'p1', '--p2': 'p2', '--p3': 'p3' };

function fmt(t) {
  const pr = PRIORITY_LABEL[t.priority] || t.priority;
  const marks = { todo: '  ', doing: '▶ ', done: '✓ ' };
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const bar = { p0: '\x1b[31m', p1: '\x1b[33m', p2: '\x1b[34m', p3: '\x1b[90m' }[t.priority] || '';
  const meta = [t.project !== '默认' ? t.project : '', t.category].filter(Boolean).join(' · ');
  const title = t.status === 'done' ? dim(t.title) : t.title;
  return `${marks[t.status] || '  '}${bar}${pr.padEnd(4)}\x1b[0m ${title}${meta ? dim('  ' + meta) : ''}`;
}

try {
  if (cmd === 'add' || cmd === 'a') {
    const parts = args();
    const title = parts.join(' ').trim();
    if (!title) { console.error('用法: node cli.mjs add "要做什么" [-p 项目] [--p0] [-c 类别]'); process.exit(1); }
    const priority = Object.keys(PRI).find((k) => flag(k))?.slice(2) || opt('--priority') || 'p3';
    const t = core.add({
      title,
      project: opt('--project', '-p') || '默认',
      priority,
      category: opt('--category', '-c') || '',
      source: 'cli'
    });
    console.log('已收下: ' + t.title + '   [' + t.id + ']');
    process.exit(0);
  }

  if (cmd === 'ls' || cmd === 'list') {
    const status = flag('--todo') ? 'todo' : flag('--doing') ? 'doing' : flag('--done') ? 'done' : undefined;
    const r = core.list({
      status,
      project: opt('--project', '-p'),
      category: opt('--category', '-c'),
      limit: opt('--limit', '-n')
    });

    if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

    const check = core.state().counts;
    if (!r.tasks.length) { console.log('（空）'); }
    else console.log(r.tasks.map(fmt).join('\n'));
    console.log('');
    console.log(`共 ${check.todo} 待办 / ${check.doing} 进行中 / ${check.done} 已完成`);
    process.exit(0);
  }

  if (cmd === 'move' || cmd === 'mv') {
    const [id, status] = args();
    if (!id || !status) { console.error('用法: node cli.mjs move <id> todo|doing|done'); process.exit(1); }
    const t = core.move(id, status);
    console.log('已移动: ' + t.title + ' → ' + status);
    process.exit(0);
  }

  if (cmd === 'done') {
    const [id] = args();
    if (!id) { console.error('用法: node cli.mjs done <id>'); process.exit(1); }
    const t = core.move(id, 'done');
    console.log('已完成: ' + t.title);
    process.exit(0);
  }

  if (cmd === 'rm' || cmd === 'delete') {
    const [id] = args();
    if (!id) { console.error('用法: node cli.mjs rm <id>'); process.exit(1); }
    const t = core.remove(id);
    console.log('已删除: ' + t.title);
    process.exit(0);
  }

  if (cmd === 'open' || cmd === 'url') {
    console.log('http://127.0.0.1:46001/');
    process.exit(0);
  }

  if (cmd === 'init') {
    // 建库建表；目录里如果有老的 tasks.json，顺手迁进来
    const r = core.init();
    console.log('数据目录已就绪: ' + core.dbFile);
    if (r.migration?.migrated) {
      console.log('已从 tasks.json 迁移: ' + r.migration.tasks + ' 个任务 / '
        + r.migration.messages + ' 条消息 / ' + r.migration.projects + ' 个项目');
      if (r.migration.backup) console.log('原文件已改名: ' + path.basename(r.migration.backup));
    } else if (r.migration?.reason) {
      console.log('迁移: ' + r.migration.reason);
    }
    console.log('现有任务: ' + core.count() + ' 条');
    process.exit(0);
  }

  console.log(`task-inbox

  add <标题> [-p 项目] [--p0..--p3] [-c 类别]   收一条
  ls [--todo|--doing|--done] [--json]            看列表
  move <id> todo|doing|done                      换列
  done <id>                                      标完成
  rm <id>                                        删除
  init                                           初始化数据目录
  open                                           打印看板地址

数据: ${core.dbFile}`);
} catch (e) {
  console.error('错误: ' + e.message);
  process.exit(1);
}
