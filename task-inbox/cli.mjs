#!/usr/bin/env node
// cli.mjs —— 不打开浏览器也能管任务
//
//   node cli.mjs                    看所有任务
//   node cli.mjs add "买咖啡豆"      加一条
//   node cli.mjs add "写周报" -p 工作 --p0 -c 工作
//   node cli.mjs ls --todo          只看未开始
//   node cli.mjs ls --archived      只看已归档
//   node cli.mjs move <id> doing    换列
//   node cli.mjs done <id>          标完成
//   node cli.mjs archive            手动跑一次自动归档
//   node cli.mjs unarchive <id>     从归档里取回
//   node cli.mjs ls --json          给程序看的输出

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore, PRIORITY_LABEL, KIND_LABEL } from './core.mjs';

// 文件名用的时间戳：2026-11-23T10-59-00
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

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
    // 不传 dev_ready —— core 会落默认值 1（已确认可开工）。
    // CLI 本来就不跑分类；settings.classify 关掉时更是没人判「够不够开发」，
    // 这种情况下把任务塞进待澄清是凭空造出来的门。
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
    // 默认不含归档。--archived 是「只看归档」，不是「连归档一起看」——
    // 混在一起时已经做完归档的那些会挤掉真正要看的。
    const archivedOnly = flag('--archived');
    const r = core.list({
      status,
      project: opt('--project', '-p'),
      category: opt('--category', '-c'),
      limit: opt('--limit', '-n'),
      include_archived: archivedOnly ? true : undefined
    });
    if (archivedOnly) r.tasks = r.tasks.filter((t) => t.archived_at);

    if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

    const check = core.state().counts;
    if (!r.tasks.length) { console.log('（空）'); }
    else console.log(r.tasks.map(fmt).join('\n'));
    console.log('');
    console.log(`共 ${check.todo} 待办 / ${check.doing} 进行中 / ${check.done} 已完成`);
    if (archivedOnly) console.log('（以上是已归档任务，不计入上面的计数）');
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

  if (cmd === 'archive') {
    // 手动跑一次自动归档。服务自己会在启动和收任务时各扫一遍，这里只是
    // 「现在就想看一下会归档几条」的入口，不改任何阈值。
    const days = core.loadSettings().archive_after_days;
    const n = core.archiveStale(days);
    console.log('已归档 ' + n + ' 条（阈值 ' + days + ' 天）');
    process.exit(0);
  }

  if (cmd === 'unarchive') {
    const [id] = args();
    if (!id) { console.error('用法: node cli.mjs unarchive <id>'); process.exit(1); }
    // 取回 = 把时间戳清掉。任务回到它原来的列（归档不改 status）。
    const t = core.patch(id, { archived_at: null });
    console.log('已取回: ' + t.title + '（' + t.status + '）');
    process.exit(0);
  }

  if (cmd === 'open' || cmd === 'url') {
    console.log('http://127.0.0.1:46001/');
    process.exit(0);
  }

  if (cmd === 'export') {
    // 整库导成 tasks.json 形状，给迁移/审阅/自己 diff 用
    const target = args()[0] || path.join(DATA_DIR, 'export-' + stamp() + '.json');
    const data = core.exportAll();
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
    const bytes = fs.statSync(target).size;
    console.log('已导出: ' + target);
    console.log('  ' + data.tasks.length + ' 个任务 / ' + data.projects.length + ' 个项目 / '
      + data.tasks.reduce((n, t) => n + (t.messages || []).length, 0) + ' 条消息'
      + '（' + (bytes / 1024).toFixed(1) + 'KB）');
    process.exit(0);
  }

  if (cmd === 'backup' || cmd === 'bak') {
    // VACUUM INTO：SQLite 原生热备，服务在跑也能备份，不用停
    const target = args()[0] || path.join(DATA_DIR, 'backup-' + stamp() + '.db');
    const r = core.backupTo(target);
    console.log('已备份: ' + r.file);
    console.log('  大小: ' + (r.bytes / 1024).toFixed(1) + 'KB');
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
  ls [--todo|--doing|--done] [--archived] [--json]  看列表（默认不含归档）
  move <id> todo|doing|done                      换列
  done <id>                                      标完成
  rm <id>                                        删除
  archive                                        手动跑一次自动归档
  unarchive <id>                                 从归档里取回
  init                                           初始化数据目录
  export [文件]                                  导成 tasks.json（给迁移/审阅用）
  backup [文件]                                  热备份成 .db（服务在跑也能备）
  open                                           打印看板地址

数据: ${core.dbFile}`);
} catch (e) {
  console.error('错误: ' + e.message);
  process.exit(1);
}
