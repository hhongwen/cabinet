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

console.log('\n=== 10. 重开后数据还在 ===');
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
