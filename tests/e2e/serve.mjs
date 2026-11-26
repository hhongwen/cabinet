// 启动一个隔离的 Cabinet Runtime 给 Playwright 用：
// 临时数据目录 + 关闭自动分类（避免 E2E 依赖真实模型），端口固定 46300。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = path.join(os.tmpdir(), 'cabinet-e2e');
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'),
  JSON.stringify({ backend: 'auto', model: '', classify: false }) + '\n');
process.env.TASK_INBOX_DATA = data;

const { main } = await import('../../task-inbox/runtime.mjs');
await main(['node', 'server.mjs', '--port', '46300']);
