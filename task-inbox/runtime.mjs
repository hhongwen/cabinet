// runtime.mjs —— Cabinet Runtime 的共享启动与关闭入口
//
// 分工在 D0 就固定，不允许两处都管生命周期：
//   runtime.mjs：数据锁 / 初始化与迁移 / 归档扫描 / start / 关闭顺序 / 释放锁
//   server.mjs ：createHandler + start(core, opts)（监听与端口回退）
//   cli.mjs、node server.mjs、Electron 都从这里进出
//
// 这样 Node 独立模式、CLI 和桌面模式共用同一份锁、初始化和恢复逻辑，
// 不会出现「Electron 直接调 start() 绕过锁和初始化」的分叉。
//
// 注意：server.mjs 既是库也是入口。`node server.mjs` 时它会在自己的
// 顶层求值过程中调用本模块，所以这里不能静态 import server.mjs
// （否则两个模块互相等待求值，Node 会直接报 unsettled top-level await）。
// 入口把 server 的导出显式传进来，其余调用方走动态 import。

import { createCore } from './core.mjs';

export class RuntimeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// 独立模式 / Electron 模式没有传 server 模块时，这里动态加载一次。
// 目的只是让调用方少写几行，不改变生命周期归属。
async function loadServer(opts) {
  if (opts.server) return opts.server;
  return import('./server.mjs');
}

export function resolveDataDir(server, env = process.env) {
  return env.TASK_INBOX_DATA || server.DEFAULT_DATA_DIR;
}

/**
 * 打开一个独占数据目录的 Runtime。
 *
 * @param {object} opts
 * @param {string} [opts.dataDir]      默认 TASK_INBOX_DATA 或 ~/.config/cabinet
 * @param {number} [opts.port]         首选端口，默认 46001
 * @param {object} [opts.server]       server.mjs 的导出（入口显式传入，避免循环求值）
 * @param {object} [opts.startOptions] 透传给 server.start（如测试用的 ports）
 * @param {function|false} [opts.log]  日志出口，false 表示静默
 */
export async function openRuntime(opts = {}) {
  const server = await loadServer(opts);
  const { acquireDataLock, start, DEFAULT_PORT, FALLBACK_PORTS } = server;
  const log = opts.log === false ? () => {} : (opts.log || console.log);
  const dataDir = opts.dataDir || resolveDataDir(server);
  const port = opts.port || DEFAULT_PORT;

  // 先拿锁再建库：恢复 Turn、打开可写业务库之前必须已拥有数据目录
  const lock = acquireDataLock(dataDir);
  const core = createCore(dataDir);

  let started = null;
  let closed = false;

  const releaseLock = () => { try { lock.release(); } catch { /* 已经没了 */ } };

  const stop = async () => {
    if (closed) return;
    closed = true;
    try { started?.server.close(); } catch {}
    // 先把子进程收掉，再关库：反过来的话，正在跑的 Agent 收尾时会写一个
    // 已经关掉的连接，日志里全是「database is closed」。
    try { await started?.runner?.close(); } catch {}
    // 关库时把 WAL 收回去，不留一个几 MB 的 -wal 文件在目录里
    try { core.close(); } catch {}
    releaseLock();
  };

  try {
    const initResult = core.init();
    if (initResult.migration?.migrated) {
      const mg = initResult.migration;
      log('[task-inbox] 已从 tasks.json 迁移：'
        + mg.tasks + ' 个任务 / ' + mg.messages + ' 条消息 / ' + mg.projects + ' 个项目'
        + (mg.backup ? '，原文件改名为 ' + String(mg.backup).split(/[\\/]/).pop() : ''));
    } else if (initResult.migration?.reason && !/没有 tasks\.json/.test(initResult.migration.reason)) {
      log('[task-inbox] 迁移跳过：' + initResult.migration.reason);
    }
    if (initResult.revived) {
      log('[task-inbox] ' + initResult.revived + ' 条任务的判断被上次退出打断，已标成失败，可以重新判断');
    }

    try {
      const archived = core.archiveStale(core.loadSettings().archive_after_days);
      if (archived) log('[task-inbox] 已归档 ' + archived + ' 条超期的已完成任务');
    } catch (e) {
      log('[task-inbox] 归档扫描失败：' + e.message);
    }

    started = await start(core, { port, ...opts.startOptions });
    if (!started) {
      throw new RuntimeError('端口都被占用了：' + [port, ...FALLBACK_PORTS].join(', '), 'EPORTS');
    }

    return {
      dataDir,
      core,
      port: started.port,
      url: 'http://127.0.0.1:' + started.port,
      started,
      initResult,
      recoveredTurns: started.recoveredTurns,
      stop,
      releaseLock
    };
  } catch (e) {
    // 启动失败不能留下自己的锁和半开的库
    await stop();
    throw e;
  }
}

/**
 * `node server.mjs` 的入口。行为与迁移前保持一致：
 * 锁、初始化、归档、恢复、信号退出都在这里收口。
 */
export async function main(argv = process.argv, server) {
  const sm = await loadServer({ server });
  const i = argv.indexOf('--port');
  const port = i > -1 ? Number(argv[i + 1]) : sm.DEFAULT_PORT;

  const rt = await openRuntime({ port, server: sm });

  // 进程异常退出时也要释放锁（stop 是异步的，exit 里只能同步释放）
  process.on('exit', rt.releaseLock);

  console.log('[task-inbox] 已启动  v' + sm.buildInfo().version + '  pid ' + process.pid);
  console.log('  看板：' + rt.url + '/');
  console.log('  随手记：' + rt.url + '/quick');
  console.log('  数据：' + rt.core.dbFile);
  if (rt.recoveredTurns) {
    console.log('[task-inbox] ' + rt.recoveredTurns + ' 轮 Agent 执行被上次退出打断，已标成待核对');
  }

  const stop = async () => {
    await rt.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return rt;
}
