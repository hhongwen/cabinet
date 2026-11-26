// runtime-host.mjs —— UtilityProcess 里的业务 Runtime
//
// 只做三件事：等主进程下发凭据、起 Runtime、把 ready/日志报回去；
// 收到 shutdown 时按 Runtime 的关闭顺序收尾。业务规则一行都不在这里，
// 保证桌面壳可替换。

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
let booted = false;

async function boot(token) {
  booted = true;
  try {
    rt = await openRuntime({ authToken: token, log: (line) => send({ type: 'log', line }) });
    send({ type: 'ready', port: rt.port, url: rt.url, dataDir: rt.dataDir });
    // Turn 终态事件：桌面通知只认真实事件，不让渲染层自己触发。
    rt.core.onTurnFinished((e) => send({
      type: 'turn-finished',
      status: e.turn ? e.turn.status : '',
      error: e.turn ? String(e.turn.error || '') : '',
      preview: e.turn ? String(e.turn.result_text || '').replace(/\s+/g, ' ').slice(0, 120) : '',
      task: e.task ? e.task.title : '',
      role: e.session ? e.session.role : ''
    }));
  } catch (e) {
    send({ type: 'fatal', message: e.message, code: e.code || '' });
  }
}

parentPort?.on('message', async (e) => {
  const msg = e?.data;
  if (msg?.type === 'init' && !booted) { await boot(msg.token); return; }
  if (msg?.type === 'shutdown' && rt) {
    try { await rt.stop(); } catch (err) { send({ type: 'shutdown-error', message: err.message }); }
    send({ type: 'stopped' });
    process.exit(0);
  }
});

// 告诉主进程「可以下发凭据了」；之前的 postMessage 不保证已经被排队。
send({ type: 'hello' });
