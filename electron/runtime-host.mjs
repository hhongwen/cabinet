// runtime-host.mjs —— UtilityProcess 里的业务 Runtime
//
// 只做三件事：起 Runtime、把 ready/日志报给 Electron 主进程、收到 shutdown
// 时按 Runtime 的关闭顺序收尾。业务规则一行都不在这里，保证桌面壳可替换。

import { openRuntime } from '../task-inbox/runtime.mjs';

// 集中管理一条 Electron 差异：backend.mjs 用 process.execPath 跑 JS CLI，
// 在桌面模式里它就是 electron.exe。只给 Runtime 的子进程设，而不是
// 在 Electron 主进程里全局设——避免影响壳自身和无关子进程。
if (process.versions && process.versions.electron) {
  process.env.ELECTRON_RUN_AS_NODE = '1';
}

const parentPort = process.parentPort;
const send = (msg) => { try { parentPort?.postMessage(msg); } catch { /* 壳没了 */ } };

let rt = null;

try {
  rt = await openRuntime({ log: (line) => send({ type: 'log', line }) });
  send({ type: 'ready', port: rt.port, url: rt.url, dataDir: rt.dataDir });
} catch (e) {
  send({ type: 'fatal', message: e.message, code: e.code || '' });
  process.exit(0);
}

parentPort?.on('message', async (e) => {
  const msg = e?.data;
  if (msg?.type === 'shutdown') {
    try { await rt.stop(); } catch (err) { send({ type: 'shutdown-error', message: err.message }); }
    send({ type: 'stopped' });
    process.exit(0);
  }
});
