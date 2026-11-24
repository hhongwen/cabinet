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
import { resolveCliBin } from './backend.mjs';

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

// 固化一份脱敏的真实导出形状，防止以后只按假数据改解析
const realExport = JSON.parse(fs.readFileSync(
  path.join(HERE, 'test-fixtures', 'opencode-export.json'), 'utf8'));
eq('真实导出 fixture outcome', summarizeExport(realExport).outcome, 'succeeded');
eq('真实导出 fixture 助手 message id', summarizeExport(realExport).messages[1].id, 'msg_assistant_1');
eq('真实导出 fixture 助手正文', summarizeExport(realExport).lastText, '收到');

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
  ok('事件文件路径用 POSIX 分隔符',
    /^sessions\/[^\\]+\.jsonl$/.test(core.getTurn(turn.id).events_file),
    core.getTurn(turn.id).events_file);
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

console.log('\n=== 12. CLI 解析：优先 @opencode/cli 的真身 ===');
{
  // 真机上踩过：opencode-ai/bin/opencode.exe 只有 479 字节，是壳；
  // 真正的 278MB 二进制在 @opencode/cli。先命中壳会让 spawn 直接 UNKNOWN。
  const root = path.join(tmp, 'npm-global');
  const real = process.platform === 'win32'
    ? path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    : path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode');
  const stub = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(real, 'real');
  fs.writeFileSync(stub, 'stub');

  const old = process.env.NPM_GLOBAL_DIR;
  process.env.NPM_GLOBAL_DIR = root;
  try {
    const bin = resolveCliBin('opencode');
    eq('命中 @opencode/cli 的真身', bin.command, real);
    ok('没有落到 479 字节的壳', !bin.command.includes('opencode-ai'));
  } finally {
    if (old === undefined) delete process.env.NPM_GLOBAL_DIR;
    else process.env.NPM_GLOBAL_DIR = old;
  }
}

console.log('\n=== 13. CLI 早退：stdin EPIPE 不能杀进程 ===');
{
  const adapter = createOpenCodeAdapter({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'early-exit' }
  });
  const r = await adapter.runTurn({
    session: { working_directory: tmp, external_session_id: 'ses_x', model: null },
    text: 'x'.repeat(6 * 1024 * 1024),
    onEvent: () => {},
    signal: new AbortController().signal
  });
  ok('子进程早退后主进程还活着', true);
  ok('stdin 错误被记录，或子进程正常退出', !!r.stdinError || r.exitCode === 0,
    JSON.stringify({ stdin: r.stdinError, exit: r.exitCode }));

  const sess = newSession('test');
  const fake = {
    ...fakeAdapter('ok'),
    async runTurn() {
      return { stdinError: 'write EOF', exitCode: 0, resultText: '', finalReason: null };
    }
  };
  const runner = createAgentRunner({ core, dataDir: tmp, adapters: [fake], timeoutMs: 2000 });
  const { turn, done } = runner.start({ sessionId: sess.id, text: 'x' });
  await done;
  eq('stdin 错误落 failed', core.getTurn(turn.id).status, 'failed');
  ok('错误说清没读到消息', /没有读到消息/.test(core.getTurn(turn.id).error));
  runner.close();
}

console.log('\n=== 14. 工作目录：删除后拒绝 / 相对路径拒绝 ===');
{
  const d = path.join(tmp, 'will-delete');
  fs.mkdirSync(d, { recursive: true });
  const s = core.createSession({
    taskId: task.id, role: 'dev', agent: 'opencode', workingDirectory: d
  });
  fs.rmSync(d, { recursive: true, force: true });
  const runner = createAgentRunner({
    core, dataDir: tmp, adapters: [fakeAdapter('ok')], timeoutMs: 2000
  });
  let threw = false;
  try { runner.start({ sessionId: s.id, text: 'x' }); } catch (e) {
    threw = /工作目录不存在/.test(e.message);
  }
  ok('工作目录没了时拒绝发送', threw);
  eq('会话仍是 idle', core.getSession(s.id).status, 'idle');

  let rel = false;
  try {
    core.createSession({ taskId: task.id, role: 'dev', agent: 'opencode', workingDirectory: '.' });
  } catch (e) { rel = /绝对路径/.test(e.message); }
  ok('相对路径被拒', rel);
  runner.close();
}

console.log('\n=== 15. 结果超 200 KB 截断 ===');
{
  const sess = newSession('plan');
  const big = 'x'.repeat(210 * 1024);
  const fake = {
    ...fakeAdapter('ok'),
    async runTurn({ onEvent }) {
      onEvent({ type: 'text', text: big });
      return { externalRef: 'msg_big', resultText: big, exitCode: 0, finalReason: 'stop' };
    }
  };
  const runner = createAgentRunner({ core, dataDir: tmp, adapters: [fake], timeoutMs: 2000 });
  const { turn, done } = runner.start({ sessionId: sess.id, text: 'big' });
  await done;
  const t = core.getTurn(turn.id);
  ok('结果截到 200 KB 以内', t.result_text.length < 210 * 1024, String(t.result_text.length));
  ok('带截断标记', /超过 200 KB/.test(t.result_text));
  runner.close();
}

console.log('\n=== 16. 导出没对上 messageID：不误判、不清结果 ===');
{
  const sess = newSession('review');
  const turn = core.startTurn(sess.id, 'no match');
  core.markTurnRunning(turn.id, {
    externalRef: 'msg_real', eventsFile: 'sessions/' + turn.id + '.jsonl'
  });
  core.recoverOpenTurns();
  const evAbs = path.join(tmp, 'sessions', turn.id + '.jsonl');
  fs.mkdirSync(path.dirname(evAbs), { recursive: true });
  fs.writeFileSync(evAbs, '{"keep":true}\n');
  core.conn().run('UPDATE session_turns SET result_text = ? WHERE id = ?', ['半截', turn.id]);

  const runner = createAgentRunner({
    core, dataDir: tmp,
    adapters: [fakeAdapter('ok', {
      outcome: 'failed', status: 'unknown', lastText: '', messageCount: 0, messages: []
    })],
    timeoutMs: 2000
  });
  await runner.reconcile(sess.id);
  eq('Turn 仍是 unknown', core.getTurn(turn.id).status, 'unknown');
  eq('Session 仍是 unknown', core.getSession(sess.id).status, 'unknown');
  eq('半截结果没被清空', core.getTurn(turn.id).result_text, '半截');
  eq('事件文件没被动', fs.readFileSync(evAbs, 'utf8'), '{"keep":true}\n');
  runner.close();
}

console.log('\n=== 17. 导出坏 JSON / 非零 / 超时 ===');
{
  const s = { working_directory: tmp, external_session_id: 'ses_fixture', model: null };
  const bad = createOpenCodeAdapter({
    command: process.execPath, args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'bad-export' }
  });
  let badErr = null;
  try { await bad.exportSession({ session: s }); } catch (e) { badErr = e.message; }
  ok('坏 JSON 导出抛错', /不是 JSON/.test(badErr || ''), badErr);

  const fail = createOpenCodeAdapter({
    command: process.execPath, args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'fail-export' }
  });
  let failErr = null;
  try { await fail.exportSession({ session: s }); } catch (e) { failErr = e.message; }
  ok('非零退出导出抛错', /导出失败/.test(failErr || ''), failErr);

  const hang = createOpenCodeAdapter({
    command: process.execPath, args: [FIXTURE],
    env: { ...process.env, FAKE_OPENCODE_MODE: 'hang-export' },
    exportTimeoutMs: 100
  });
  let hangErr = null;
  try { await hang.exportSession({ session: s }); } catch (e) { hangErr = e.message; }
  ok('导出超时抛错', /导出失败/.test(hangErr || ''), hangErr);
}

console.log('\n=== 18. PATH 上的裸 opencode 命令 ===');
{
  const bin = path.join(tmp, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const file = process.platform === 'win32'
    ? path.join(bin, 'opencode.cmd')
    : path.join(bin, 'opencode');
  fs.writeFileSync(file, process.platform === 'win32'
    ? '@echo off\r\necho 1.0.0\r\n'
    : '#!/bin/sh\necho 1.0.0\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  const old = process.env.PATH;
  process.env.PATH = bin + path.delimiter + old;
  try {
    const a = createOpenCodeAdapter({ command: 'opencode' });
    ok('PATH 上的命令可用', await a.available());
  } finally {
    process.env.PATH = old;
  }
}

core.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
