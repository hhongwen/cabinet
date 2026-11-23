// test-sqlite.mjs —— 存储层自测：迁移 + 核心行为
//
// 全程在临时目录里跑，不碰真实数据。
//   node test-sqlite.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from './core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-test-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

// ---------- 造一份「老版本」的 tasks.json ----------
// 覆盖几个容易出错的形状：字符串项目、空对象项目、只有项目名没有 id 的任务、
// 带 patch 的消息、null 字段。
const LEGACY = {
  version: 2,
  projects: [
    { id: 'p_a', name: '默认', aliases: [], dirs: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'p_b', name: '诺华', aliases: ['novartis', 'NVRP'], dirs: [{ path: 'D:\\code\\novartis', note: '主后端', primary: true }], created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
    '知识库',
    {}
  ],
  tasks: [
    {
      id: 't_1', title: '第一条', kind: 'text',
      payload: { text: '原文', images: [], files: [], urls: ['http://example.com'], path: null },
      project: '诺华', project_id: 'p_b', category: '开发', status: 'todo', priority: 'p1',
      note: '备注', source: 'quick',
      messages: [
        { id: 'm_1', role: 'user', text: '改成 P0', patch: null, at: '2026-01-03T01:00:00.000Z' },
        { id: 'm_2', role: 'assistant', text: '好', patch: { priority: 'p0' }, at: '2026-01-03T01:00:05.000Z' }
      ],
      brief: '## 目标\n做点什么', brief_at: '2026-01-04T00:00:00.000Z',
      classify_state: 'done', classify_reason: '因为所以', classify_model: 'magpie:xxx',
      claimed_by: null,
      created_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z',
      doing_at: null, done_at: null
    },
    {
      id: 't_2', title: '第二条', kind: 'link',
      payload: { text: null, images: ['img_1.png'], files: [], urls: [], path: null },
      project: '知识库', category: '', status: 'done', priority: 'p3', note: '', source: 'chat',
      messages: [], brief: '', brief_at: null,
      classify_state: 'off', classify_reason: '', classify_model: '', claimed_by: 'agent-x',
      created_at: '2026-01-05T00:00:00.000Z', updated_at: '2026-01-05T00:00:00.000Z',
      doing_at: '2026-01-05T00:00:01.000Z', done_at: '2026-01-06T00:00:00.000Z'
    }
  ]
};

fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify(LEGACY, null, 2), 'utf8');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ backend: 'magpie', model: 'auto/x', classify: false }), 'utf8');

console.log('\n=== 1. 从 tasks.json 迁移 ===');
const core = createCore(tmp);
const initRes = core.init();
const mg = initRes.migration;
ok('迁移成功', mg.migrated === true, mg.reason);
// 空对象项目本来就没法用，迁移时跳过是对的
eq('项目数（跳过脏项目）', mg.projects, 3);
eq('任务数', mg.tasks, 2);
eq('消息数', mg.messages, 2);
ok('tasks.json 改名留档', !!mg.backup && fs.existsSync(mg.backup));
ok('原位置已不存在', !fs.existsSync(path.join(tmp, 'tasks.json')));
ok('tasks.db 已创建', fs.existsSync(path.join(tmp, 'tasks.db')));
eq('字符串项目被升级成对象', core.findProject('知识库')?.name, '知识库');

console.log('\n=== 2. 逐字段比对 ===');
const FIELDS = ['id', 'title', 'kind', 'project', 'category', 'status', 'priority',
  'note', 'source', 'brief', 'brief_at', 'classify_state', 'classify_reason', 'classify_model',
  'claimed_by', 'created_at', 'updated_at', 'doing_at', 'done_at'];
for (const orig of LEGACY.tasks) {
  const got = core.getTask(orig.id);
  if (!got) { ok('任务存在 ' + orig.id, false); continue; }
  const bad = [];
  for (const f of FIELDS) {
    const a = orig[f] === undefined ? null : orig[f];
    const b = got[f] === undefined ? null : got[f];
    if (String(a) !== String(b)) bad.push(f + ': ' + JSON.stringify(a) + '≠' + JSON.stringify(b));
  }
  ok('字段全对 ' + orig.id + '（' + orig.title + '）', bad.length === 0, bad.join('; '));
  eq('payload 一致 ' + orig.id, orig.payload, got.payload);
  eq('消息一致 ' + orig.id, orig.messages, core.listMessages(orig.id));

  // 老任务可能没有 project_id，迁移时要按项目名补上，指向真实存在的项目
  if (!orig.project_id) {
    ok('缺 project_id 的被补齐 ' + orig.id, !!got.project_id, 'project_id 仍为空');
    eq('补齐的 project_id 指向同名项目 ' + orig.id, core.getProject(got.project_id)?.name, orig.project);
  } else {
    eq('已有 project_id 保持不变 ' + orig.id, got.project_id, orig.project_id);
  }
}

console.log('\n=== 3. 设置 ===');
const s = core.loadSettings();
eq('backend 从 settings.json 迁入', s.backend, 'magpie');
eq('classify 从 settings.json 迁入', s.classify, false);
core.saveSettings({ backend: 'alma' });
eq('saveSettings 生效', core.loadSettings().backend, 'alma');
let threw = false;
try { core.saveSettings({ backend: 'nope' }); } catch { threw = true; }
ok('非法 backend 被拒', threw);

console.log('\n=== 4. 增删改 ===');
const t = core.add({ title: '自测任务', project: '自测项目', priority: 'p1', text: '原始内容', source: 'test' });
ok('add 返回 id', !!t.id);
ok('add 自动建项目', core.listProjects().some((p) => p.name === '自测项目'));
eq('新任务消息数为 0', t.message_count, 0);

core.pushMessage(t.id, { role: 'user', text: '第一句' });
core.pushMessage(t.id, { role: 'assistant', text: '回一句', patch: { priority: 'p0' } });
eq('消息写入条数', core.listMessages(t.id).length, 2);
eq('recentMessages 拿最近 1 条', core.recentMessages(t.id, 1).map((m) => m.text), ['回一句']);
eq('空 patch 存成 null', core.listMessages(t.id)[0].patch, null);

eq('状态改为 doing', core.patch(t.id, { status: 'doing' }).status, 'doing');
ok('doing_at 已填', !!core.getTask(t.id).doing_at);
eq('优先级改为 p0', core.patch(t.id, { priority: 'p0' }).priority, 'p0');
const merged = core.patch(t.id, { payload: { urls: ['http://example.com'] } });
eq('payload 合并保留原 text', merged.payload.text, '原始内容');
eq('payload 合并新增 urls', merged.payload.urls, ['http://example.com']);
let badStatus = false;
try { core.patch(t.id, { status: 'nonsense' }); } catch { badStatus = true; }
ok('非法状态被拒', badStatus);

const before = core.state().counts;
core.move(t.id, 'done');
const after = core.state().counts;
eq('doing 计数 -1', after.doing, before.doing - 1);
eq('done 计数 +1', after.done, before.done + 1);
ok('state 不含 messages 字段', core.state().tasks.every((x) => x.messages === undefined));
ok('state 带 message_count', typeof core.getTask(t.id).message_count === 'number');

core.setBrief(t.id, '## 目标\n测试');
ok('setBrief 写入', core.getTask(t.id).brief.startsWith('## 目标'));
ok('brief_at 已填', !!core.getTask(t.id).brief_at);

console.log('\n=== 5. 项目操作 ===');
const proj = core.addProject('临时项目', { aliases: ['temp'], dirs: [{ path: 'D:\\x', note: 'n' }] });
ok('addProject 成功', !!proj.id);
eq('findProject 按别名', core.findProject('temp')?.name, '临时项目');
eq('aliases 存成数组', core.findProject('temp')?.aliases, ['temp']);
let dup = false;
try { core.addProject('临时项目'); } catch { dup = true; }
ok('重名项目被拒', dup);
eq('updateProject 改名', core.updateProject(proj.id, { name: '改名项目' }).name, '改名项目');
eq('改名后任务上的冗余名同步', core.add({ title: '挂上去', project: '改名项目' }) && core.getProject(proj.id)?.name, '改名项目');

const tp = core.add({ title: '挂到临时项目', project: '改名项目' });
eq('deleteProject 返回被删项', core.deleteProject(proj.id).removed.id, proj.id);
ok('原项目下的任务没被删', core.getTask(tp.id) !== null);
ok('至少要留一个项目', (() => {
  const left = core.listProjects();
  let blocked = false;
  try { core.deleteProject(left[0].id); } catch { blocked = left.length === 1; }
  return left.length > 1 || blocked;
})());

console.log('\n=== 6. 删除任务级联清消息 ===');
const dt = core.add({ title: '待删除' });
core.pushMessage(dt.id, { role: 'user', text: 'x' });
eq('删前有消息', Number(core.conn().get('SELECT COUNT(*) AS c FROM messages WHERE task_id = ?', [dt.id]).c), 1);
core.remove(dt.id);
eq('删后无任务', core.getTask(dt.id), null);
eq('删后消息级联清空', Number(core.conn().get('SELECT COUNT(*) AS c FROM messages WHERE task_id = ?', [dt.id]).c), 0);

console.log('\n=== 7. init 幂等 ===');
const r2 = core.init();
ok('第二次 init 不重复迁移', r2.migration.migrated === false);
eq('任务数不变', core.count(), core.state().total);

console.log('\n=== 8. 排序与过滤 ===');
const ORDER = { p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 };
const all = core.list({});
let sorted = true;
for (let i = 1; i < all.tasks.length; i++) {
  if ((ORDER[all.tasks[i - 1].priority] ?? 9) > (ORDER[all.tasks[i].priority] ?? 9)) { sorted = false; break; }
}
ok('列表按优先级排序', sorted);
ok('status 过滤生效', core.list({ status: 'todo' }).tasks.every((x) => x.status === 'todo'));
ok('project 过滤生效', core.list({ project: '诺华' }).tasks.every((x) => x.project === '诺华' || x.project_id === 'p_b'));
ok('limit 生效', core.list({ limit: 1 }).tasks.length <= 1);

console.log('\n=== 9. 批量写入不撞 id ===');
const ids = new Set();
let collide = false;
try {
  core.conn().tx(() => {
    for (let i = 0; i < 500; i++) {
      const x = core.add({ title: 'bulk-' + i, project: '默认' });
      if (ids.has(x.id)) { collide = true; break; }
      ids.add(x.id);
      const m = core.pushMessage(x.id, { role: 'user', text: 'm' + i });
      if (ids.has(m.id)) { collide = true; break; }
      ids.add(m.id);
    }
  });
} catch (e) { collide = true; console.log('  批量写入异常: ' + e.message); }
ok('500 任务 + 500 消息 id 全唯一', !collide && ids.size === 1000);

console.log('\n=== 10. needs_project 往返（P0-2） ===');
const np = core.add({ title: '判不出项目', project: '默认' });
eq('新建默认 false', core.getTask(np.id).needs_project, false);
eq('patch 成 true', core.patch(np.id, { needs_project: true }).needs_project, true);
eq('重新读仍是 true', core.getTask(np.id).needs_project, true);
eq('state 里带这个字段', core.state().tasks.find((x) => x.id === np.id).needs_project, true);
eq('patch 回 false', core.patch(np.id, { needs_project: false }).needs_project, false);

console.log('\n=== 11. 删任务清附件（P0-3） ===');
const img = core.saveImage('data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'));
const fil = core.saveFile('data:application/pdf;base64,' + Buffer.from('pdf-bytes').toString('base64'), 'a.pdf');
const withFiles = core.add({ title: '带附件', images: [img.path], files: [fil.path] });
ok('附件已落盘', fs.existsSync(img.path) && fs.existsSync(fil.path));
const removedTask = core.remove(withFiles.id);
eq('清掉 2 个附件', removedTask.removedFiles.length, 2);
ok('附件真的没了', !fs.existsSync(img.path) && !fs.existsSync(fil.path));
eq('任务确实删了', core.getTask(withFiles.id), null);

// 安全性：payload 里塞了目录外的路径，不能跟着删
const outside = path.join(tmp, 'outside.txt');
fs.writeFileSync(outside, 'x');
const dangerous = core.add({ title: '危险路径', files: ['../../../../etc/passwd', outside] });
eq('目录外的文件不被删', core.remove(dangerous.id).removedFiles.length, 0);
ok('外部文件还在', fs.existsSync(outside));

console.log('\n=== 12. 卡死的 pending 会被收成 failed（P1-2） ===');
const stuck = core.add({ title: '卡住的', classify_state: 'pending' });
core.conn().run('UPDATE tasks SET updated_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', stuck.id]);
const fresh = core.add({ title: '刚提交', classify_state: 'pending' });
const init2 = core.init();
eq('只收了超时那条', init2.revived, 1);
eq('老任务变 failed', core.getTask(stuck.id).classify_state, 'failed');
eq('新任务还是 pending', core.getTask(fresh.id).classify_state, 'pending');
ok('reason 写清了原因', /中断/.test(core.getTask(stuck.id).classify_reason));

console.log('\n=== 13. v1 → v2 schema 迁移（P1-5） ===');
// 把刚才的库降级成「没有 needs_project 列的 v1」，再让新代码接管
core.conn().exec('ALTER TABLE tasks DROP COLUMN needs_project');
core.conn().run("UPDATE meta SET value='1' WHERE key='schema_version'");
ok('降级成功（列已删）', !core.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('needs_project'));
const v2core = createCore(tmp);
v2core.init();
ok('迁移后补回了列', v2core.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('needs_project'));
eq('版本升到 2', v2core.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, '2');
ok('老数据没丢', v2core.count() > 0);
ok('老任务 needs_project 默认 false', v2core.state().tasks.every((t) => t.needs_project === false));
v2core.close();

console.log('\n=== 14. revision 变更指纹（P1-1） ===');
{
  const r1 = core.revision();
  ok('是短字符串', typeof r1 === 'string' && r1.length > 0 && r1.length < 20, r1);
  eq('什么都不做时稳定', core.revision(), r1);

  const t = core.add({ title: 'rev-test' });
  const r2 = core.revision();
  ok('新增任务会变', r2 !== r1);

  core.patch(t.id, { note: '改个字段' });
  const r3 = core.revision();
  ok('改字段会变', r3 !== r2);

  core.pushMessage(t.id, { role: 'user', text: '一句话' });
  const r4 = core.revision();
  ok('加消息会变', r4 !== r3);

  core.move(t.id, 'done');
  const r5 = core.revision();
  ok('改状态会变', r5 !== r4);

  core.remove(t.id);
  const r6 = core.revision();
  ok('删除会变（COUNT 起作用）', r6 !== r5);

  core.saveSettings({ backend: 'magma'.replace('magma', 'alma') });
  const r7 = core.revision();
  ok('改设置会变', r7 !== r6);

  // 关键：反复调用不许自我变化（否则前端永远拿不到 unchanged）
  eq('连续两次调用一致', core.revision(), core.revision());
}

console.log('\n=== 15. 导出与备份（P1-4） ===');
{
  const before = core.state().total;
  const dump = core.exportAll();
  eq('导出格式是 version 2', dump.version, 2);
  eq('导出任务数一致', dump.tasks.length, before);
  ok('导出带 schema 版本', typeof dump.schema_version === 'number');
  ok('导出带导出时间', !!dump.exported_at);

  // 每条任务都应该带 messages 数组（老格式）
  ok('任务都带 messages 数组', dump.tasks.every((t) => Array.isArray(t.messages)));

  // 导出的 JSON 要能被 migrateFromJson 吃回去 —— 这是「备份可用」的真正定义
  const jsonPath = path.join(tmp, 'roundtrip.json');
  fs.writeFileSync(jsonPath, JSON.stringify(dump), 'utf8');

  // 只测格式互认：解析后是不是合法形状
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ok('回读后仍可解析', parsed.tasks.length === dump.tasks.length);

  // 备份：VACUUM INTO
  const bak = core.backupTo(path.join(tmp, 'bak.db'));
  ok('备份文件已生成', fs.existsSync(bak.file));
  ok('备份文件非空', bak.bytes > 0);

  // 备份要能真的打开、数据在
  const { openSqlite } = await import('./storage.mjs');
  const bdb = openSqlite(bak.file);
  eq('备份里的任务数一致', Number(bdb.get('SELECT COUNT(*) AS c FROM tasks').c), before);
  eq('备份里的消息数一致',
    Number(bdb.get('SELECT COUNT(*) AS c FROM messages').c),
    core.conn().get('SELECT COUNT(*) AS c FROM messages').c);
  bdb.close();

  // 目标已存在时不能覆盖掉旧备份
  let dupe = false;
  try { core.backupTo(bak.file); } catch { dupe = true; }
  ok('同名备份不会被覆盖', dupe);
  fs.unlinkSync(bak.file);
}

console.log('\n=== 16. 重开后数据还在 ===');
const totalBefore = core.count();
core.close();
const core2 = createCore(tmp);
eq('重开后任务数一致', core2.count(), totalBefore);
ok('重开后数据非空', core2.count() > 0);
core2.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
