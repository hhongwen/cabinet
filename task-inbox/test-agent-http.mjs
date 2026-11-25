// test-agent-http.mjs —— 阶段 1A 的 HTTP 接口自测
//
// 用真 handler + 假 Adapter，不碰真 OpenCode，也不写真实数据目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createCore } from './core.mjs';
import { createAgentRunner } from './agent.mjs';
import { createHandler, acquireDataLock } from './server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-agent-http-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

const core = createCore(tmp);
core.init();
const project = core.addProject('HTTP 测试项目', {
  dirs: [{ path: tmp, note: '测试目录', primary: true }]
});
core.updateProject(project.id, {
  default_agent: 'opencode',
  default_model: 'provider/model-http'
});
const task = core.add({ title: 'HTTP 会话宿主', project: 'HTTP 测试项目' });
core.patch(task.id, { payload: { text: 'HTTP 原始需求' } });
core.setBrief(task.id, '## 目标\nHTTP 上下文验证');

// 假 Adapter：第一轮故意慢 150ms，好让「运行中再发」稳定撞到 409。
const seenTexts = [];
const fake = {
  kind: 'opencode',
  async available() { return true; },
  async ensureSession({ session }) {
    return {
      externalSessionId: session.external_session_id || 'ses_http_1',
      created: !session.external_session_id
    };
  },
  async runTurn({ text, onEvent }) {
    seenTexts.push(text);
    await new Promise((r) => setTimeout(r, 150));
    onEvent({ type: 'step_start', sessionID: 'ses_http_1', part: { messageID: 'msg_http_1' } });
    onEvent({ type: 'text', text: '收到', part: {} });
    onEvent({ type: 'step_finish', part: { reason: 'stop' } });
    return { externalRef: 'msg_http_1', resultText: '收到', exitCode: 0, finalReason: 'stop' };
  },
  async exportSession() {
    return {
      outcome: 'succeeded', status: 'idle', lastText: '收到', messageCount: 2,
      messages: [{ id: 'msg_http_1', type: 'assistant', text: '收到', completed: true }]
    };
  }
};

const runner = createAgentRunner({ core, dataDir: tmp, adapters: [fake], timeoutMs: 5000 });
const handler = createHandler(core, { runner, queue: null });
const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log('\n=== 1. Agent 能力清单 ===');
{
  const r = await call('GET', '/api/agents');
  eq('GET /api/agents 200', r.status, 200);
  eq('注册了 OpenCode', r.data.agents?.map((a) => a.kind), ['opencode']);
  eq('OpenCode 可用', r.data.agents?.[0]?.available, true);
  ok('角色清单包含 dev', (r.data.roles || []).includes('dev'));
}

console.log('\n=== 2. 建会话：继承项目默认值 ===');
let sid = null;
{
  const r = await call('POST', '/api/tasks/' + task.id + '/sessions', {});
  eq('建会话 200', r.status, 200);
  eq('created=true', r.data.created, true);
  eq('继承 Agent', r.data.session.agent, 'opencode');
  eq('继承模型', r.data.session.model, 'provider/model-http');
  eq('继承主工作目录', r.data.session.working_directory, tmp);
  eq('默认角色 dev', r.data.session.role, 'dev');
  eq('外部 ID 先为空', r.data.session.external_session_id, null);
  sid = r.data.session.id;

  const again = await call('POST', '/api/tasks/' + task.id + '/sessions', {});
  eq('重复建返回已有', again.data.session.id, sid);
  eq('created=false', again.data.created, false);

  const list = await call('GET', '/api/tasks/' + task.id + '/sessions');
  eq('任务会话列表 1 条', list.data.sessions.length, 1);

  const bad = await call('POST', '/api/tasks/' + task.id + '/sessions', { agent: 'codex' });
  eq('未接入的 Agent 被拒', bad.status, 400);
  ok('错误说清未接入', /还没有接入|不可用/.test(bad.data.error || ''), bad.data.error);
}

console.log('\n=== 3. 发送 Turn：202 + 并发 409 ===');
{
  const r = await call('POST', '/api/sessions/' + sid + '/turns', { text: '只回复收到' });
  eq('发送 202', r.status, 202);
  eq('Turn 先落 queued/running', ['queued', 'running'].includes(r.data.turn.status) || r.data.turn.status === 'queued', true);

  const second = await call('POST', '/api/sessions/' + sid + '/turns', { text: '插队' });
  eq('同一会话并发 409', second.status, 409);

  const empty = await call('POST', '/api/sessions/' + sid + '/turns', { text: '   ' });
  eq('空消息 400', empty.status, 400);
}

console.log('\n=== 4. 轮询状态与核对 ===');
{
  await new Promise((r) => setTimeout(r, 300));
  const r = await call('GET', '/api/sessions/' + sid);
  eq('会话状态 idle', r.data.session.status, 'idle');
  eq('Turn 已记录', r.data.turns.length, 1);
  eq('Turn completed', r.data.turns[0].status, 'completed');
  eq('结果正文', r.data.turns[0].result_text, '收到');
  eq('外部 Session 已绑定', r.data.session.external_session_id, 'ses_http_1');
  ok('首轮 prompt 含任务标题', seenTexts[0]?.includes('HTTP 会话宿主'), seenTexts[0]?.slice(0, 160));
  ok('首轮 prompt 含原始需求', seenTexts[0]?.includes('HTTP 原始需求'));
  ok('首轮 prompt 含 brief', seenTexts[0]?.includes('HTTP 上下文验证'));
  ok('首轮 prompt 含用户原话', seenTexts[0]?.includes('只回复收到'));
  ok('首轮后 context_seeded_at 有值', !!r.data.session.context_seeded_at);

  const rec = await call('POST', '/api/sessions/' + sid + '/reconcile');
  eq('核对 200', rec.status, 200);
  eq('核对后仍 idle', rec.data.session.status, 'idle');

  const miss = await call('GET', '/api/sessions/nope');
  eq('不存在的会话 404', miss.status, 404);

  const noTurn = await call('POST', '/api/turns/nope/interrupt');
  eq('不存在的 Turn 404', noTurn.status, 404);
}

console.log('\n=== 4b. 第二轮不再重复带上下文 ===');
{
  const before = seenTexts.length;
  const r = await call('POST', '/api/sessions/' + sid + '/turns', { text: '第二轮只发这句' });
  eq('第二轮 202', r.status, 202);
  await new Promise((r2) => setTimeout(r2, 300));
  ok('第二轮 prompt 不带上下文', !seenTexts[before].includes('【Cabinet 任务上下文】'),
    seenTexts[before].slice(0, 160));
  eq('第二轮 prompt 是用户原话', seenTexts[before], '第二轮只发这句');
}

console.log('\n=== 5. 项目归档参数 ===');
{
  const spare = core.addProject('HTTP 归档项目');
  core.updateProject(spare.id, { archived_at: new Date().toISOString() });
  const withArch = await call('GET', '/api/projects?include_archived=1');
  ok('include_archived 带归档项目', withArch.data.projects.some((p) => p.archived_at));
  const without = await call('GET', '/api/projects');
  ok('默认列表不含归档项目', !without.data.projects.some((p) => p.id === spare.id));
}

console.log('\n=== 6. 运行中任务 / 会话的删除保护 ===');
{
  const host = core.add({ title: '删除保护任务', project: 'HTTP 测试项目' });
  const sess = core.createSession({
    taskId: host.id, role: 'dev', agent: 'opencode', workingDirectory: tmp
  });
  const turn = core.startTurn(sess.id, '运行中');
  core.markTurnRunning(turn.id, {
    externalRef: 'msg_guard', eventsFile: 'sessions/' + turn.id + '.jsonl'
  });

  const delTask = await call('DELETE', '/api/tasks/' + host.id);
  eq('运行中任务删除 409', delTask.status, 409);

  const delSess = await call('DELETE', '/api/sessions/' + sess.id);
  eq('运行中会话删除 409', delSess.status, 409);

  core.finishTurn(turn.id, { status: 'interrupted', error: '测试' });
  const okSess = await call('DELETE', '/api/sessions/' + sess.id);
  eq('结束后会话删除 200', okSess.status, 200);
  const gone = await call('GET', '/api/sessions/' + sess.id);
  eq('会话已不存在', gone.status, 404);
  const okTask = await call('DELETE', '/api/tasks/' + host.id);
  eq('结束后任务删除 200', okTask.status, 200);
}

console.log('\n=== 7. 同一数据目录单实例锁 ===');
{
  const lockDir = path.join(tmp, 'lockdir');
  const first = acquireDataLock(lockDir);
  let blocked = false;
  try { acquireDataLock(lockDir); } catch (e) { blocked = /已经有一个 Cabinet/.test(e.message); }
  ok('第二个实例被拒', blocked);
  first.release();
  const again = acquireDataLock(lockDir);
  ok('释放后能重新加锁', !!again.file);
  again.release();
}

console.log('\n=== 8. 没有 runner 时给明确错误 ===');
{
  const noRunner = createHandler(core, { queue: null });
  const s2 = http.createServer((req, res) => noRunner(req, res).catch(() => {}));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = 'http://127.0.0.1:' + s2.address().port;
  const res = await fetch(b2 + '/api/tasks/' + task.id + '/sessions');
  eq('Agent 未启用 400', res.status, 400);
  await new Promise((r) => s2.close(r));
}

await new Promise((r) => server.close(r));
await runner.close();
core.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
