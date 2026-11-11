// hub HTTP 端到端验证：面板静态资源、/api/state、POST /api/events、approve/reject。
// 用法: node examples/httptest.mjs [port]
const port = Number(process.argv[2] ?? 8891);
const BASE = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

console.log(`\nCabinet HTTP 自测 @ ${BASE}\n`);

await t('GET / 返回面板 HTML（内嵌样式，无外部依赖）', async () => {
  const res = await fetch(BASE + '/');
  assert(res.status === 200, `状态码 ${res.status}`);
  assert((res.headers.get('content-type') || '').includes('text/html'), 'Content-Type 应含 text/html');
  const html = await res.text();
  assert(html.includes('<title>Cabinet'), '缺少标题');
  assert(!/https?:\/\/(cdn|unpkg|jsdelivr|cdnjs)/i.test(html), '不能引用外部 CDN');
  assert(!/<script[^>]+src=/.test(html), '不应有外链脚本');
  assert(html.includes('手动触发'), '缺少手动触发表单');
  assert(html.includes('/api/state'), '面板应轮询 /api/state');
});

await t('GET /api/state 返回 jobs/stats/config', async () => {
  const res = await fetch(BASE + '/api/state');
  assert(res.status === 200);
  const d = await res.json();
  assert(Array.isArray(d.jobs), 'jobs 应是数组');
  assert(d.stats && typeof d.stats.total === 'number', 'stats.total 应是数字');
  assert(d.config && d.config.host === '127.0.0.1', 'config.host 应是 127.0.0.1');
  assert(Array.isArray(d.rules), '应带 rules 摘要');
});

await t('GET /api/state?status=failed 能按状态过滤', async () => {
  const res = await fetch(BASE + '/api/state?status=failed');
  const d = await res.json();
  assert(d.jobs.every((j) => j.status === 'failed'), '过滤后仍有非 failed 的 job');
});

await t('GET /api/health 正常', async () => {
  const res = await fetch(BASE + '/api/health');
  const d = await res.json();
  assert(res.status === 200 && d.ok === true);
  assert(typeof d.queued === 'number' && typeof d.running === 'number');
});

await t('POST /api/events 收事件（approval=before → 等你批）', async () => {
  const { status, data } = await post('/api/events', {
    source: 'httptest',
    type: 'manual',
    subject: 'http-1',
    summary: '面板手动触发的测试事件',
  });
  assert(status === 200, `状态码 ${status}: ${JSON.stringify(data)}`);
  assert(data.ok === true, 'ok 应为 true');
  assert(data.action === 'awaiting_approval', `catch-all 是 before，期望 awaiting_approval，实际 ${data.action}`);
  assert(data.jobId, '应返回 jobId');
  globalThis.__jobId = data.jobId;
});

await t('GET /api/jobs/:id 返回详情（含 prompt / transcript 字段）', async () => {
  const res = await fetch(BASE + '/api/jobs/' + globalThis.__jobId);
  const d = await res.json();
  assert(res.status === 200 && d.ok);
  assert(d.job.id === globalThis.__jobId);
  assert(typeof d.job.prompt === 'string' && d.job.prompt.length > 0, '应有 prompt');
  assert('transcript_tail' in d.job, '应有 transcript_tail');
});

await t('POST /api/jobs/:id/reject 能拒绝', async () => {
  const { status, data } = await post('/api/jobs/' + globalThis.__jobId + '/reject', { note: '测试拒绝' });
  assert(status === 200, `状态码 ${status}: ${JSON.stringify(data)}`);
  assert(data.status === 'rejected', `期望 rejected，实际 ${data.status}`);
  assert(data.job.decision_note === '测试拒绝', '备注应落库');
});

await t('拒绝后重复审批返回 400（状态机拦截）', async () => {
  const { status, data } = await post('/api/jobs/' + globalThis.__jobId + '/approve', {});
  assert(status === 400, `期望 400，实际 ${status}`);
  assert(data.ok === false);
});

await t('POST /api/events 缺字段返回 400', async () => {
  const { status, data } = await post('/api/events', { type: 'x' });
  assert(status === 400, `期望 400，实际 ${status}`);
  assert(data.ok === false && /source/.test(data.error), '应提示缺 source');
});

await t('POST /api/events 坏 JSON 返回 400', async () => {
  const res = await fetch(BASE + '/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert(res.status === 400);
});

await t('未知 API 返回 404', async () => {
  const res = await fetch(BASE + '/api/nope');
  assert(res.status === 404);
});

await t('静态资源目录穿越被挡', async () => {
  const res = await fetch(BASE + '/../cabinet.config.json');
  assert(res.status === 403 || res.status === 404, `期望 403/404，实际 ${res.status}`);
});

await t('去重：同 subject 再来一次被合并', async () => {
  const a = await post('/api/events', { source: 'httptest', type: 'manual', subject: 'dedup-1', summary: 'A' });
  assert(a.data.action === 'awaiting_approval', `第一次应入队，实际 ${a.data.action}`);
  const b = await post('/api/events', { source: 'httptest', type: 'manual', subject: 'dedup-1', summary: 'B' });
  assert(b.data.action === 'duplicate', `第二次应合并，实际 ${b.data.action}`);
  assert(b.data.jobId === a.data.jobId, '应指向同一个 job');
  // 清理
  await post('/api/jobs/' + a.data.jobId + '/reject', { note: '清理' });
});

console.log(`\n${fail === 0 ? `全部通过：${pass} 项` : `${pass} 通过，${fail} 失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
