// 启动一个隔离的 Cabinet Runtime 给 Playwright 用：
// 临时数据目录 + 关闭自动分类 + 假 Agent（确定性、不花钱、可中止）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = path.join(os.tmpdir(), 'cabinet-e2e');
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'),
  JSON.stringify({ backend: 'auto', model: '', classify: false }) + '\n');
process.env.TASK_INBOX_DATA = data;

// 假 Adapter：普通消息 250ms 返回，带 slow 的消息 5 秒，可被中止。
const fake = {
  kind: 'opencode',
  async available() { return true; },
  async ensureSession({ session }) {
    return {
      externalSessionId: session.external_session_id || 'ses_e2e_1',
      created: !session.external_session_id
    };
  },
  runTurn({ text, onEvent, signal }) {
    const delay = /slow/.test(text) ? 5000 : 250;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onEvent({ type: 'step_start', part: {} });
        onEvent({ type: 'text', text: '假回复：' + text, part: {} });
        onEvent({ type: 'step_finish', part: { reason: 'stop' } });
        resolve({ externalRef: 'msg_e2e_1', resultText: '假回复：' + text, exitCode: 0, finalReason: 'stop' });
      }, delay);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('已中止'), { aborted: true }));
      }, { once: true });
    });
  },
  async exportSession() {
    return { outcome: 'succeeded', status: 'idle', lastText: '', messageCount: 0, messages: [] };
  }
};

const { openRuntime } = await import('../../task-inbox/runtime.mjs');
await openRuntime({ port: 46300, startOptions: { ports: [46300], adapters: [fake] }, log: () => {} });
