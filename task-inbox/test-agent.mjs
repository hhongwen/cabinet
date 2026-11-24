// test-agent.mjs —— 阶段 1A 的解析层与运行器自测
//
// 不碰真模型：运行器用假 Adapter 验状态机；Adapter 的 spawn 用一个
// 假的 opencode 脚本验「stdin + JSONL + 多 step + 退出码」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCore } from './core.mjs';
import { createAgentRunner } from './agent.mjs';
import { createOpenCodeAdapter, parseEventLine, summarizeExport } from './opencode-agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'test-fixtures', 'fake-opencode.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-agent-test-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

const core = createCore(tmp);
core.init();
const task = core.add({ title: '阶段 1A 会话测试宿主', project: 'Cabinet' });

function newSession(role = 'dev') {
  return core.createSession({
    taskId: task.id, role, agent: 'opencode', workingDirectory: tmp,
    model: 'provider/model-a'
  });
}

function fakeAdapter(mode = 'ok', summary = null) {
  return {
    kind: 'opencode',
    async available() { return true; },
    async ensureSession({ session }) {
      return {
        externalSessionId: session.external_session_id || 'ses_fake_' + session.id,
        created: !session.external_session_id
      };
    },
    async runTurn({ onEvent, signal }) {
      if (mode === 'ok') {
        onEvent({ type: 'step_start', sessionID: 'ses_fake', part: { messageID: 'msg_1' } });
        onEvent({ type: 'text', text: '收到', part: {} });
        onEvent({ type: 'step_finish', part: { reason: 'stop' } });
        return { externalRef: 'msg_1', resultText: '收到', exitCode: 0, finalReason: 'stop', timedOut: false };
      }
      if (mode === 'no-finish') {
        onEvent({ type: 'step_start', sessionID: 'ses_fake', part: { messageID: 'msg_2' } });
        onEvent({ type: 'text', text: '半截', part: {} });
        return { externalRef: 'msg_2', resultText: '半截', exitCode: 0, finalReason: null, timedOut: false };
      }
      if (mode === 'fail') {
        onEvent({ type: 'stderr', text: 'boom' });
        return { externalRef: null, resultText: '', exitCode: 1, finalReason: null, timedOut: false };
      }
      if (mode === 'hang') {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({
            externalRef: 'msg_h', resultText: '', exitCode: null, finalReason: null, timedOut: false
          }), { once: true });
        });
      }
      throw new Error('未知 fake mode: ' + mode);
    },
    async exportSession() {
      if (!summary) throw new Error('导出失败');
      return summary;
    }
  };
}

console.log('\n=== 1. 事件解析 ===');
eq('step_start 取 sessionID',
  parseEventLine('{"type":"step_start","sessionID":"ses_x","part":{"messageID":"msg_1"}}').sessionID, 'ses_x');
eq('step_start 取 messageID',
  parseEventLine('{"type":"step_start","sessionID":"ses_x","part":{"messageID":"msg_1"}}').messageID, 'msg_1');
eq('text 取正文',
  parseEventLine('{"type":"text","text":"收到","part":{}}').text, '收到');
eq('step_finish 取 reason',
  parseEventLine('{"type":"step_finish","part":{"reason":"stop"}}').finishReason, 'stop');
eq('坏 JSON 返回 null', parseEventLine('not json'), null);
eq('空行返回 null', parseEventLine('   '), null);

console.log('\n=== 2. 导出摘要 ===');
const okExport = {
  info: { outcome: 'succeeded', time: { busy: 10, idle: 20 } },
  messages: [
    { id: 'msg_1', type: 'assistant', time: { completed: 15 }, content: [{ type: 'text', text: '收到' }] },
    { type: 'idle', outcome: 'succeeded' }
  ]
};
eq('导出成功识别 succeeded', summarizeExport(okExport).outcome, 'succeeded');
eq('非 busy 时状态 idle', summarizeExport(okExport).status, 'idle');
eq('导出取最后一段助手正文', summarizeExport(okExport).lastText, '收到');
eq('导出带消息索引', summarizeExport(okExport).messages[0].id, 'msg_1');
eq('消息 completed 标记', summarizeExport(okExport).messages[0].completed, true);

const busyExport = { info: { outcome: 'running', time: { busy: 30, idle: 20 } }, messages: [] };
eq('busy > idle 判为 busy', summarizeExport(busyExport).status, 'busy');
eq('导出失败结果给 unknown', summarizeExport({ info: { outcome: 'failed', time: {} } }).status, 'unknown');

console.log('\n=== 3. 运行器：正常完成 ===');
{
  const sess = newSession('dev');
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('ok')], timeoutMs: 2000
  });
  const { turn, done } = runner.start({ sessionId: sess.id, text: '只回复收到' });
  await done;
  eq('Turn completed', core.getTurn(turn.id).status, 'completed');
  eq('结果落库', core.getTurn(turn.id).result_text, '收到');
  eq('会话回 idle', core.getSession(sess.id).status, 'idle');
  eq('外部 Session 已绑定', core.getSession(sess.id).external_session_id, 'ses_fake_' + sess.id);
  ok('事件文件存在且有 step_start',
    fs.readFileSync(path.join(tmp, core.getTurn(turn.id).events_file), 'utf8').includes('step_start'));
  ok('外部 messageID 对回这一轮', core.getTurn(turn.id).external_ref === 'msg_1');
  runner.close();
}

console.log('\n=== 4. 运行器：退出 0 但没有 step_finish → unknown ===');
{
  const sess = newSession('review');
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('no-finish')], timeoutMs: 2000
  });
  const { turn, done } = runner.start({ sessionId: sess.id, text: '半截' });
  await done;
  eq('没有终态时不能冒充 completed', core.getTurn(turn.id).status, 'unknown');
  eq('半截结果仍保留', core.getTurn(turn.id).result_text, '半截');
  eq('会话标成 unknown', core.getSession(sess.id).status, 'unknown');
  ok('错误说清待核对', /待核对/.test(core.getTurn(turn.id).error));
  runner.close();
}

console.log('\n=== 5. 运行器：非零退出 → failed ===');
{
  const sess = newSession('test');
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('fail')], timeoutMs: 2000
  });
  const { turn, done } = runner.start({ sessionId: sess.id, text: '会失败' });
  await done;
  eq('非零退出落 failed', core.getTurn(turn.id).status, 'failed');
  ok('错误带退出码', /1/.test(core.getTurn(turn.id).error), core.getTurn(turn.id).error);
  ok('错误带 stderr 尾部', /boom/.test(core.getTurn(turn.id).error), core.getTurn(turn.id).error);
  eq('失败后会话仍可用', core.getSession(sess.id).status, 'idle');
  runner.close();
}

console.log('\n=== 6. 运行器：超时 → failed，会话不永久 busy ===');
{
  const sess = newSession('plan');
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('hang')], timeoutMs: 60
  });
  const { turn, done } = runner.start({ sessionId: sess.id, text: '永远不返回' });
  await done;
  eq('超时落 failed', core.getTurn(turn.id).status, 'failed');
  ok('错误说清超时', /超时/.test(core.getTurn(turn.id).error), core.getTurn(turn.id).error);
  eq('会话不留在 busy', core.getSession(sess.id).status, 'idle');
  runner.close();
}

console.log('\n=== 7. 运行器：同会话并发 + 中断 ===');
{
  const sess = newSession('dev');
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('hang')], timeoutMs: 5000
  });
  const first = runner.start({ sessionId: sess.id, text: '第一轮慢慢跑' });
  let refused = false;
  try { runner.start({ sessionId: sess.id, text: '第二轮插队' }); } catch { refused = true; }
  ok('同一会话第二次发送被拒', refused);
  runner.interrupt(first.turn.id);
  await first.done;
  eq('中断后 Turn interrupted', core.getTurn(first.turn.id).status, 'interrupted');
  eq('中断后会话回 idle', core.getSession(sess.id).status, 'idle');
  runner.close();
}

console.log('\n=== 8. 运行器：重启后按导出核对 unknown Turn ===');
{
  const sess = newSession('review');
  const turn = core.startTurn(sess.id, '重启前没跑完');
  core.markTurnRunning(turn.id, { externalRef: 'msg_1', eventsFile: 'sessions/' + turn.id + '.jsonl' });
  core.recoverOpenTurns();
  eq('先落 unknown', core.getTurn(turn.id).status, 'unknown');

  const runner = createAgentRunner({
    core, dataDir: tmp,
    adapters: [fakeAdapter('ok', {
      outcome: 'succeeded', status: 'idle', lastText: '收到', messageCount: 2,
      messages: [{ id: 'msg_1', type: 'assistant', text: '收到', completed: true }]
    })],
    timeoutMs: 2000
  });
  const r = await runner.reconcile(sess.id);
  eq('核对后 Turn completed', core.getTurn(turn.id).status, 'completed');
  eq('核对结果正文', core.getTurn(turn.id).result_text, '收到');
  eq('核对后会话 idle', core.getSession(sess.id).status, 'idle');
  ok('返回里带会话', !!r.session);
  runner.close();
}

console.log('\n=== 9. 运行器：导出失败不能把 unknown 改成成功 ===');
{
  const sess = newSession('test');
  const turn = core.startTurn(sess.id, '导出会失败');
  core.markTurnRunning(turn.id, { externalRef: 'msg_x' });
  core.recoverOpenTurns();
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('ok', null)], timeoutMs: 2000
  });
  const r = await runner.reconcile(sess.id);
  eq('Turn 仍是 unknown', core.getTurn(turn.id).status, 'unknown');
  ok('返回里有错误给 UI', /导出失败/.test(r.error || ''));
  runner.close();
}

console.log('\n=== 10. OpenCode Adapter：真实 spawn 假 CLI ===');
{
  const adapter = createOpenCodeAdapter({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'multi' }
  });
  const events = [];
  const r = await adapter.runTurn({
    session: { working_directory: tmp, external_session_id: 'ses_fixture', model: null },
    text: '多 step',
    onEvent: (e) => events.push(e),
    signal: new AbortController().signal
  });
  eq('多 step 的最终 reason 是 stop', r.finalReason, 'stop');
  eq('只取最后一个有文本的 step', r.resultText, '收到');
  eq('外部 ref 是最后一个 messageID', r.externalRef, 'msg_2');
  eq('事件里有两个 step_start', events.filter((e) => e.type === 'step_start').length, 2);
  eq('工具调用的 step_finish 也保留', events.filter((e) => e.type === 'step_finish').length, 2);

  const exportAdapter = createOpenCodeAdapter({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'export' }
  });
  const sum = await exportAdapter.exportSession({
    session: { working_directory: tmp, external_session_id: 'ses_fixture', model: null }
  });
  eq('导出 outcome', sum.outcome, 'succeeded');
  eq('导出 lastText', sum.lastText, '收到');
  eq('导出 messages 索引', sum.messages[0].id, 'msg_1');

  const failAdapter = createOpenCodeAdapter({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'fail' }
  });
  const failed = await failAdapter.runTurn({
    session: { working_directory: tmp, external_session_id: 'ses_fixture', model: null },
    text: '失败',
    onEvent: () => {},
    signal: new AbortController().signal
  });
  eq('非零退出码保留', failed.exitCode, 1);
  ok('stderr 通过 onEvent 出来', failed.stderr.includes('boom'), failed.stderr);
}

console.log('\n=== 11. 核心：显式设置会话状态 ===');
{
  const sess = newSession('dev');
  core.setSessionStatus(sess.id, 'unavailable');
  eq('unavailable 能落库', core.getSession(sess.id).status, 'unavailable');
  let bad = false;
  try { core.setSessionStatus(sess.id, 'nope'); } catch { bad = true; }
  ok('非法状态被拒', bad);
}

core.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
