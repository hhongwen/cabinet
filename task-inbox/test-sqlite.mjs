// test-sqlite.mjs —— 存储层自测：迁移 + 核心行为
//
// 全程在临时目录里跑，不碰真实数据。
//   node test-sqlite.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from './core.mjs';
import { SCHEMA_VERSION } from './storage.mjs';

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
  // 老 tasks.json 里没有 attachments，读回来会补一个 null —— 比对时对齐这一处。
  // 键顺序不同不算不一致，所以按固定字段序重建一遍再比。
  const normMsgs = (ms) => ms.map((m) => ({
    id: m.id, role: m.role, text: m.text,
    patch: m.patch ?? null,
    attachments: m.attachments ?? null,
    at: m.at
  }));
  eq('消息一致 ' + orig.id, normMsgs(orig.messages), normMsgs(core.listMessages(orig.id)));

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
eq('一路升到当前版本', v2core.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));
ok('老数据没丢', v2core.count() > 0);
ok('老任务 needs_project 默认 false', v2core.state({ include_archived: true }).tasks.every((t) => t.needs_project === false));
v2core.close();

console.log('\n=== 13b. v2 → v3 schema 迁移（四个字段一次加完） ===');
// 手工把库降级成 v2：去掉 v3 才有的四列，再把版本号写回 2
{
  const drop = (table, col) => core.conn().exec('ALTER TABLE ' + table + ' DROP COLUMN ' + col);
  drop('tasks', 'dev_ready');
  drop('tasks', 'archived_at');
  drop('messages', 'attachments');
  drop('projects', 'sort_order');
  core.conn().run("UPDATE meta SET value='2' WHERE key='schema_version'");

  const cols = (t) => core.conn().all('PRAGMA table_info(' + t + ')').map((c) => c.name);
  ok('降级成功（四列都没了）',
    !cols('tasks').includes('dev_ready') && !cols('tasks').includes('archived_at')
    && !cols('messages').includes('attachments') && !cols('projects').includes('sort_order'));

  const v3core = createCore(tmp);
  v3core.init();
  const c3 = (t) => v3core.conn().all('PRAGMA table_info(' + t + ')').map((c) => c.name);
  ok('tasks.dev_ready 回来了', c3('tasks').includes('dev_ready'));
  ok('tasks.archived_at 回来了', c3('tasks').includes('archived_at'));
  ok('messages.attachments 回来了', c3('messages').includes('attachments'));
  ok('projects.sort_order 回来了', c3('projects').includes('sort_order'));
  eq('版本升到当前版本', v3core.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));

  // 老任务默认「已确认可以开工、未归档」——不能被这次升级踢进待澄清
  const oldTasks = v3core.state({ include_archived: true }).tasks;
  ok('老任务全部 dev_ready=1', oldTasks.length > 0 && oldTasks.every((t) => t.dev_ready === true));
  ok('老任务全部未归档', oldTasks.every((t) => t.archived_at === null));

  // 回填顺序：每个项目都有值，「默认」固定 0
  const projs = v3core.listProjects();
  ok('sort_order 全部有值', projs.every((p) => Number.isFinite(p.sort_order)));
  eq('「默认」的 sort_order 是 0', projs.find((p) => p.name === '默认')?.sort_order, 0);
  eq('「默认」排在第一位', projs[0].name, '默认');
  ok('其它项目都排在「默认」之后', projs.slice(1).every((p) => p.sort_order > 0));
  ok('listProjects 带 isDefault', projs.filter((p) => p.isDefault).length === 1);

  // 老对话不丢（UI-3 的验收：升级后原有对话一条不少）
  ok('老对话还在', v3core.listMessages('t_1').length === 2);
  v3core.close();
}

console.log('\n=== 13b2. v3 → v4 schema 迁移（dev_gaps） ===');
{
  // v3 已经落过地（真库就在 3），所以 dev_gaps 不能再往 2 那步里加 ——
  // 老库版本号已经写着 3，`fromVersion < SCHEMA_VERSION` 成立的前提是 4。
  core.conn().exec('ALTER TABLE tasks DROP COLUMN dev_gaps');
  core.conn().run("UPDATE meta SET value='3' WHERE key='schema_version'");
  ok('降级成功（dev_gaps 没了）',
    !core.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('dev_gaps'));

  const v4core = createCore(tmp);
  v4core.init();
  ok('tasks.dev_gaps 回来了',
    v4core.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('dev_gaps'));
  eq('版本升到当前版本', v4core.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));

  const all = v4core.state({ include_archived: true }).tasks;
  ok('老任务的 dev_gaps 是空数组', all.length > 0 && all.every((t) => Array.isArray(t.dev_gaps) && t.dev_gaps.length === 0));
  v4core.close();
}

console.log('\n=== 13b3. dev_gaps 的写读与清零 ===');
{
  const t = core.add({ title: '缺信息的任务', dev_ready: false, dev_gaps: ['慢在哪一步', '目标响应时间', '谁来验收', '第四条该被截掉'] });
  eq('落库时截到 3 条', t.dev_gaps.length, 3);
  eq('内容原样', core.getTask(t.id).dev_gaps, ['慢在哪一步', '目标响应时间', '谁来验收']);

  // 脏值不能喂给前端渲染
  core.patch(t.id, { dev_gaps: ['  有空白  ', '', 42, { a: 1 }, '正常'] });
  eq('非字符串和空串被过滤', core.getTask(t.id).dev_gaps, ['有空白', '正常']);

  // 确认可以开工时，初判留下的疑问要一起清掉，否则界面上还挂着一串过期问题
  core.patch(t.id, { dev_ready: true });
  eq('开工后 gaps 清零', core.getTask(t.id).dev_gaps, []);
  ok('dev_ready 也变成 true', core.getTask(t.id).dev_ready === true);

  // 反过来：只写 gaps 不写 dev_ready 也允许（用户手写）
  core.patch(t.id, { dev_gaps: ['用户自己写的'] });
  eq('可以只改 gaps', core.getTask(t.id).dev_gaps, ['用户自己写的']);
}

console.log('\n=== 13c. 「默认」不可删（DEF-1） ===');
{
  const def = core.listProjects().find((p) => p.name === '默认');
  let blocked = null;
  try { core.deleteProject(def.id); } catch (e) { blocked = e.message; }
  ok('deleteProject(默认) 被拒绝', blocked !== null);
  ok('错误话说清了原因', /收件筐/.test(String(blocked)));
  ok('「默认」还在', core.listProjects().some((p) => p.name === '默认'));

  // 其它项目仍然能删，且它下面的任务落回收件筐，不会塞进某个真实项目
  const junk = core.addProject('待删项目');
  const stuckTask = core.add({ title: '挂在待删项目下', project: '待删项目' });
  const r = core.deleteProject(junk.id);
  eq('其它项目可删', r.removed.id, junk.id);
  eq('它的任务回到收件筐', r.movedTo, '默认');
  eq('任务本身没被删', core.getTask(stuckTask.id)?.project, '默认');
}

console.log('\n=== 13d. 项目拖拽排序（SIDE-1） ===');
{
  const a = core.addProject('排序A');
  const b = core.addProject('排序B');
  const c = core.addProject('排序C');
  const def = core.listProjects().find((p) => p.isDefault);

  // 新项目排在「默认」之后，不会插到第一位
  eq('新项目排在最后', core.listProjects().slice(-1)[0].id, c.id);

  // 一次提交整串（库里还有别的项目，没提到的会被排到末尾）
  const after = core.reorderProjects([c.id, def.id, a.id, b.id]);
  eq('传入的三个按顺序排在前面', after.slice(1, 4).map((p) => p.name), ['排序C', '排序A', '排序B']);
  eq('「默认」仍在第一位', after[0].name, '默认');
  eq('「默认」仍是 0', after[0].sort_order, 0);
  eq('其余从 1 开始', after.slice(1).map((p) => p.sort_order), after.slice(1).map((_, i) => i + 1));

  // 未知 id 要被拒（否则顺序会写成半截）
  let rejected = false;
  try { core.reorderProjects([a.id, 'p_not_exist']); } catch { rejected = true; }
  ok('未知 id 被拒', rejected);
  eq('被拒时顺序没变', core.listProjects().map((p) => p.id).indexOf(a.id), 2);

  // 连续拖 5 次不产生重复 sort_order
  for (let i = 0; i < 5; i++) core.reorderProjects([b.id, c.id, a.id]);
  const orders = core.listProjects().map((p) => p.sort_order);
  eq('sort_order 无重复', orders.length, new Set(orders).size);

  // 每次只提交部分项目也不能写出重复值 —— 没提到的要顺延，不能原地留着抢号
  core.reorderProjects([a.id, b.id]);
  const partial = core.listProjects().map((p) => p.sort_order);
  eq('部分提交也不重复', partial.length, new Set(partial).size);
}

console.log('\n=== 13e. 已完成自动归档（LIFE-2） ===');
{
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const oldDone = core.add({ title: '31 天前就做完了' });
  core.move(oldDone.id, 'done');
  core.conn().run('UPDATE tasks SET done_at = ? WHERE id = ?', [daysAgo(31), oldDone.id]);

  const freshDone = core.add({ title: '今天刚做完' });
  core.move(freshDone.id, 'done');

  eq('默认阈值是 30 天', core.loadSettings().archive_after_days, 30);
  const n = core.archiveStale(30);
  ok('归档了至少 1 条', n >= 1, '归档 ' + n + ' 条');

  const archived = core.getTask(oldDone.id);
  ok('超期的那条有 archived_at', !!archived.archived_at);
  ok('归档不动 status', archived.status === 'done');
  ok('刚做完的没被归档', core.getTask(freshDone.id).archived_at === null);

  ok('list() 默认不含归档', !core.list().tasks.some((t) => t.id === oldDone.id));
  ok('list({include_archived:1}) 含归档',
    core.list({ include_archived: 1 }).tasks.some((t) => t.id === oldDone.id));
  ok('state() 默认不含归档', !core.state().tasks.some((t) => t.id === oldDone.id));

  // counts 只算未归档，否则「已完成」会一直虚高
  const withArchive = core.state({ include_archived: true });
  const noneArchive = core.state();
  ok('counts 不含已归档',
    noneArchive.counts.done <= withArchive.tasks.filter((t) => t.status === 'done' && !t.archived_at).length);
  eq('counts 仍然只有三个键', Object.keys(noneArchive.counts), ['todo', 'doing', 'done']);

  // 归档是时间戳：取回就是把时间戳清掉
  const back = core.patch(oldDone.id, { archived_at: null });
  eq('取回后 archived_at 为 null', back.archived_at, null);
  ok('取回后回到默认列表', core.list().tasks.some((t) => t.id === oldDone.id));
  core.conn().run('UPDATE tasks SET done_at = ? WHERE id = ?', [daysAgo(31), oldDone.id]);
  core.archiveStale(30);
}

console.log('\n=== 13f. dev_ready（待澄清，LIFE-1） ===');
{
  const vague = core.add({ title: '那个页面有点慢', dev_ready: false });
  eq('库里存成布尔 false', core.getTask(vague.id).dev_ready, false);
  ok('默认任务是 1', core.getTask(core.add({ title: '默认可开工' }).id).dev_ready === true);

  const only0 = core.list({ dev_ready: 0 }).tasks;
  ok('dev_ready=0 只返回待澄清的', only0.length >= 1 && only0.every((t) => t.dev_ready === false));
  ok('待澄清那条在里面', only0.some((t) => t.id === vague.id));
  ok('dev_ready=1 排除了它', !core.list({ dev_ready: 1 }).tasks.some((t) => t.id === vague.id));
  ok('不传 dev_ready 时两种都返回', core.list().tasks.some((t) => t.id === vague.id));

  // URL 传下来的是字符串，也得认
  ok('字符串 "0" 生效', core.list({ dev_ready: '0' }).tasks.every((t) => t.dev_ready === false));
  ok('空值等于不传', core.list({ dev_ready: '' }).tasks.length >= only0.length);

  eq('确认可以开工 → 回到 1', core.patch(vague.id, { dev_ready: true }).dev_ready, true);
  ok('state 里也带这个字段', typeof core.state().tasks[0].dev_ready === 'boolean');
  ok('state 里也带 archived_at', core.state().tasks.every((t) => 'archived_at' in t));
}

console.log('\n=== 13g. 对话附件（UI-3） ===');
{
  const img = core.saveImage('data:image/png;base64,' + Buffer.from('chat-png').toString('base64'));
  const fl = core.saveFile('data:text/markdown;base64,' + Buffer.from('# hi').toString('base64'), 'note.md');
  const t = core.add({ title: '对话里带附件' });

  core.pushMessage(t.id, { role: 'user', text: '', attachments: { images: [img.path], files: [fl.path] } });
  const m = core.listMessages(t.id)[0];
  eq('attachments.images 能读回来', m.attachments.images, [img.path]);
  eq('attachments.files 能读回来', m.attachments.files, [fl.path]);
  eq('空文字也允许（纯附件）', m.text, '');

  core.pushMessage(t.id, { role: 'user', text: '没带附件' });
  eq('没附件时存 null', core.listMessages(t.id)[1].attachments, null);
  core.pushMessage(t.id, { role: 'user', text: '空壳附件', attachments: { images: [], files: [] } });
  eq('两个数组都空也存 null', core.listMessages(t.id)[2].attachments, null);

  ok('图先落盘了', fs.existsSync(img.path) && fs.existsSync(fl.path));
  const removed = core.remove(t.id);
  ok('删任务把对话里的图一起清掉', !fs.existsSync(img.path));
  ok('删任务把对话里的文件一起清掉', !fs.existsSync(fl.path));
  eq('清掉的附件数一共 2 个', removed.removedFiles.length, 2);
  ok('删完任务就没了', core.getTask(t.id) === null);
}


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

  // 视图参数要进指纹：否则 ?dev_ready=0 和 ?include_archived=1 会共用同一个
  // 指纹，前端做完 since 短路就会把 A 视图的缓存当成 B 视图的数据用
  const sA = core.revision('1|-');
  const sB = core.revision('0|0');
  ok('同一视图的指纹稳定（不因 scope 自我变化）', core.revision('1|-') === sA);
  ok('不同视图的指纹不同', sA !== sB, sA + ' / ' + sB);
  ok('不带 scope 仍可用（老调用点）', typeof core.revision() === 'string');
}

console.log('\n=== 15. 导出与备份（P1-4） ===');
{
  // 备份语义是全都要：归档任务也算，所以基准是 count() 而不是 state().total
  const before = core.count();
  const dump = core.exportAll();
  eq('导出格式是 version 3', dump.version, 3);
  eq('导出任务数一致（含归档）', dump.tasks.length, before);
  ok('导出里真有归档任务', dump.tasks.some((t) => t.archived_at));
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

console.log('\n=== 16. 卡片关系：v4 → v5 迁移 ===');
{
  // 手工降级成 v4：DROP links 表和 merged_into 列，版本写回 4
  const drop = (table, col) => { try { core.conn().exec('ALTER TABLE ' + table + ' DROP COLUMN ' + col); } catch { /* 已没有 */ } };
  core.conn().exec('DROP TABLE IF EXISTS links');
  drop('tasks', 'merged_into');
  drop('tasks', 'split_state');
  core.conn().run("UPDATE meta SET value='4' WHERE key='schema_version'");

  const cols = (t) => core.conn().all('PRAGMA table_info(' + t + ')').map((c) => c.name);
  ok('降级成功（links 表没了）',
    !core.conn().get("SELECT name FROM sqlite_master WHERE type='table' AND name='links'"));
  ok('降级成功（merged_into 没了）', !cols('tasks').includes('merged_into'));

  const v5 = createCore(tmp);
  v5.init();
  eq('版本升到当前版本', v5.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));
  ok('links 表回来了',
    !!v5.conn().get("SELECT name FROM sqlite_master WHERE type='table' AND name='links'"));
  const c5 = v5.conn().all('PRAGMA table_info(tasks)').map((c) => c.name);
  ok('tasks.merged_into 回来了', c5.includes('merged_into'));
  ok('tasks.split_state 回来了', c5.includes('split_state'));
  // 老任务一律「没被合并」
  ok('老任务 merged_into 全是 null',
    v5.state({ include_archived: true }).tasks.every((t) => t.merged_into === null));
  v5.close();
}

console.log('\n=== 17. 卡片关系：合并 / 拆分 ===');
{
  // 三张独立的卡，其中两张要合并
  const a = core.add({ title: '合并样本A', text: 'A 的原文' });
  const b = core.add({ title: '合并样本B', text: 'B 的原文' });
  const c = core.add({ title: '拆分样本', text: 'C 的原文' });
  core.pushMessage(a.id, { role: 'user', text: 'A 的对话' });
  core.pushMessage(b.id, { role: 'user', text: 'B 的对话' });

  // ---- 合并 ----
  const merged = core.mergeTasks([a.id, b.id], { title: '合并后的卡' });
  ok('合并生成新卡', !!merged && merged.id !== a.id && merged.id !== b.id);
  eq('新卡标题按 opts', merged.title, '合并后的卡');

  const a2 = core.getTask(a.id);
  const b2 = core.getTask(b.id);
  eq('旧卡A 标了 merged_into', a2.merged_into, merged.id);
  eq('旧卡B 标了 merged_into', b2.merged_into, merged.id);
  ok('旧卡没被删', !!a2 && !!b2);
  ok('旧卡没被归档', !a2.archived_at && !b2.archived_at);
  eq('旧卡A 的对话还在', core.listMessages(a.id).length, 1);
  eq('旧卡B 的对话还在', core.listMessages(b.id).length, 1);
  eq('旧卡A 的原文还在', a2.payload.text, 'A 的原文');

  const linksOfMerged = core.listLinks(merged.id);
  eq('新卡有 2 条 merge_parent 出边', linksOfMerged.asFrom.length, 2);
  ok('link_counts 反映了合并', merged.link_counts.merge_parent >= 2);
  ok('新卡 has_merge 为真', merged.has_merge === true);

  // ---- 只读与重复合并 ----
  let readonly = null;
  try { core.patch(a.id, { title: '想改历史' }); } catch (e) { readonly = e.message; }
  ok('被合并的卡不能改字段', readonly !== null);
  ok('错误话说清了原因', /合并|历史/.test(String(readonly)));

  let dupMerge = null;
  try { core.mergeTasks([a.id, c.id], {}); } catch (e) { dupMerge = e.message; }
  ok('已被合并的卡不能再合并', dupMerge !== null);

  let single = null;
  try { core.mergeTasks([c.id], {}); } catch (e) { single = e.message; }
  ok('单张卡合并被拒', single !== null);

  // 被合并的卡不进看板
  const visible = core.state({}).tasks.map((t) => t.id);
  ok('被合并的卡不出现在看板', !visible.includes(a.id) && !visible.includes(b.id));
  ok('合并出来的卡在看板上', visible.includes(merged.id));

  // ---- 撤销合并 ----
  const back = core.revertMerge(merged.id);
  eq('撤销还原了 2 张', back.restored.length, 2);
  eq('旧卡A 不再指向任何人', core.getTask(a.id).merged_into, null);
  eq('旧卡B 不再指向任何人', core.getTask(b.id).merged_into, null);
  ok('旧卡A 恢复可编辑', (() => {
    try { core.patch(a.id, { title: '合并样本A（已恢复）' }); return true; } catch { return false; }
  })());
  ok('合并出来的卡被归档（不是删除）', !!core.getTask(merged.id).archived_at);
  eq('撤销后没有 merge_parent 边', core.listLinks(merged.id).asFrom.length, 0);

  // ---- 拆分 ----
  const split = core.splitTask(c.id, [
    { title: '子卡1' }, { title: '子卡2' }, { title: '子卡3' }
  ]);
  eq('拆出 3 张子卡', split.children.length, 3);
  eq('原卡变成 done', split.source.status, 'done');
  ok('原卡备注里记了子项', /已拆分为 3 条/.test(split.source.note));
  const splitLinks = core.listLinks(c.id);
  eq('原卡有 3 条 split_of 出边', splitLinks.asFrom.length, 3);
  ok('原卡 has_split 为真', core.getTask(c.id).has_split === true);
  ok('子卡都活着', split.children.every((x) => core.getTask(x.id)));
  eq('子卡继承原卡项目', split.children[0].project, c.project);

  // 拆一条「当前处于被合并状态」的卡要被拒。
  // 注意不能拿 merged.id 试 —— 撤销之后它只是归档，merged_into 已经空了，
  // 那种情况该允许（一个人可以拆一张自己归档的卡）。所以另造一组。
  const e1 = core.add({ title: '只读样本E1' });
  const e2 = core.add({ title: '只读样本E2' });
  core.mergeTasks([e1.id, e2.id], { title: '合并E' });
  let splitMerged = null;
  try { core.splitTask(e1.id, [{ title: 'x' }, { title: 'y' }]); } catch (e) { splitMerged = e.message; }
  ok('拆一条已被合并的卡被拒', splitMerged !== null);
  ok('错误话说清了原因', /合并|历史/.test(String(splitMerged)));

  // ---- 删除：边要级联清，merged_into 不能留悬空 ----
  const d1 = core.add({ title: '待合并D1' });
  const d2 = core.add({ title: '待合并D2' });
  const dm = core.mergeTasks([d1.id, d2.id], { title: '合并D' });
  core.remove(d1.id);
  ok('删旧卡后新卡还在', !!core.getTask(dm.id));
  eq('删旧卡后对应那条边被级联清掉', core.listLinks(dm.id).asFrom.length, 1);

  // 删掉「合并出来的那张卡」：旧卡的 merged_into 必须被清空，
  // 否则它们永远只读、又没有任何卡能撤销回来 —— 等于永久锁死
  core.remove(dm.id);
  eq('删合并卡后旧卡D2 的 merged_into 被清空', core.getTask(d2.id).merged_into, null);
  ok('旧卡D2 恢复可编辑', (() => {
    try { core.patch(d2.id, { title: '待合并D2（已解锁）' }); return true; } catch { return false; }
  })());
}

console.log('\n=== 20. 层级（parent / child） ===');
{
  // ---- v6 → v7 迁移 ----
  // 先删索引再删列：SQLite 不允许删掉还挂在索引里的列，
  // 而 MIGRATIONS[6] 会重建这个索引 —— 所以降级要成套做。
  core.conn().exec('DROP INDEX IF EXISTS idx_tasks_parent');
  core.conn().exec('ALTER TABLE tasks DROP COLUMN parent_id');
  core.conn().run("UPDATE meta SET value='6' WHERE key='schema_version'");
  ok('降级成功（parent_id 没了）',
    !core.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('parent_id'));

  const v7 = createCore(tmp);
  v7.init();
  ok('tasks.parent_id 回来了',
    v7.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('parent_id'));
  eq('版本升到当前版本',
    v7.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));
  ok('老任务 parent_id 都是 null',
    v7.state({ include_archived: true }).tasks.every((t) => t.parent_id === null));
  v7.close();
}

{
  // ---- 建边 / 派生字段 ----
  const p = core.add({ title: '父卡P', project: '层级样本' });
  const c1 = core.add({ title: '子项C1', project: '层级样本' });
  const c2 = core.add({ title: '子项C2', project: '层级样本' });
  const c3 = core.add({ title: '子项C3', project: '层级样本' });

  core.linkTasks(c1.id, p.id, 'parent');
  core.linkTasks(c2.id, p.id, 'parent');
  core.linkTasks(c3.id, p.id, 'parent');

  eq('子卡的 parent_id 指向父卡', core.getTask(c1.id).parent_id, p.id);
  const kids = core.childrenOf(p.id);
  eq('childrenOf 返回 3 个', kids.length, 3);
  eq('父卡 child_count 是 3', core.getTask(p.id).child_count, 3);
  ok('父卡 has_children 为真', core.getTask(p.id).has_children === true);
  eq('子卡没有 has_children', core.getTask(c1.id).has_children, false);
  eq('subtree 初始全是 todo', core.getTask(p.id).subtree.todo, 3);

  // ---- 状态派生：2 done + 1 todo → 父卡仍是 todo ----
  core.move(c1.id, 'done');
  core.move(c2.id, 'done');
  eq('2/3 完成时父卡还是 todo', core.getTask(p.id).status, 'todo');
  eq('subtree 反映 2 个 done', core.getTask(p.id).subtree.done, 2);

  // 全部 done → 父卡自动 done
  core.move(c3.id, 'done');
  eq('子项全 done 后父卡自动 done', core.getTask(p.id).status, 'done');
  ok('派生 done 也写了 done_at（否则归档漏掉它）', !!core.getTask(p.id).done_at);

  // ---- 有子项的卡不能手改 status ----
  let locked = null;
  try { core.patch(p.id, { status: 'doing' }); } catch (e) { locked = e.message; }
  ok('有子项的卡改 status 被拒', locked !== null);
  ok('错误话说清了原因', /子项/.test(String(locked)));

  // ---- 取消一个子项的 done → 父卡跟着回退 ----
  core.move(c1.id, 'todo');
  eq('取消一个子项后父卡退回 todo', core.getTask(p.id).status, 'todo');
  eq('派生回退时清掉 done_at', core.getTask(p.id).done_at, null);

  // ---- 祖先传播：孙卡影响爷爷 ----
  const g = core.add({ title: '祖父G', project: '层级样本' });
  const mid = core.add({ title: '中间M', project: '层级样本' });
  const leaf = core.add({ title: '叶子L', project: '层级样本' });
  core.linkTasks(mid.id, g.id, 'parent');
  core.linkTasks(leaf.id, mid.id, 'parent');
  ok('三层建得起来', core.getTask(leaf.id).parent_id === mid.id);
  core.move(leaf.id, 'done');
  eq('叶子 done → 中间 done', core.getTask(mid.id).status, 'done');
  eq('叶子 done → 祖父也 done', core.getTask(g.id).status, 'done');

  // ---- 环检测 ----
  let cycle = null;
  try { core.linkTasks(g.id, leaf.id, 'parent'); } catch (e) { cycle = e.message; }
  ok('父子成环被拒', cycle !== null);

  // ---- 深度上限 5 层 ----
  // 根算第 1 层，所以「深0..深4」正好 5 层，挂得上；
  // 再挂「深5」就是第 6 层，必须被拒。
  const chain = [];
  let cur = core.add({ title: '深0', project: '层级样本' });
  chain.push(cur.id);
  for (let i = 1; i <= 4; i++) {
    const n = core.add({ title: '深' + i, project: '层级样本' });
    core.linkTasks(n.id, cur.id, 'parent');
    chain.push(n.id);
    cur = n;
  }
  eq('5 层能建起来', chain.length, 5);

  const tooDeep = core.add({ title: '深5', project: '层级样本' });
  let deep = null;
  try { core.linkTasks(tooDeep.id, cur.id, 'parent'); } catch (e) { deep = e.message; }
  ok('第 6 层被拒', deep !== null);
  ok('错误信息提到了拆项目', /拆项目|5 层/.test(String(deep)));

  // ---- 解除父子 ----
  core.unlinkTasks(c3.id, p.id, 'parent');
  eq('解除后子卡 parent_id 清空', core.getTask(c3.id).parent_id, null);
  eq('解除后父卡少一个子项', core.getTask(p.id).child_count, 2);

  // 还有子项时仍然是只读的 —— 这是对的行为，别把「少了一个」当「没有子项了」
  let stillLocked = null;
  try { core.patch(p.id, { status: 'doing' }); } catch (e) { stillLocked = e.message; }
  ok('还剩 2 个子项时仍然只读', stillLocked !== null);

  // 全部解除后才是自由的
  core.unlinkTasks(c1.id, p.id, 'parent');
  core.unlinkTasks(c2.id, p.id, 'parent');
  eq('全部解除后 child_count 归零', core.getTask(p.id).child_count, 0);
  ok('全部解除后父卡可以手改状态', (() => {
    try { core.patch(p.id, { status: 'todo' }); return true; } catch { return false; }
  })());

  // ---- 删父卡：子卡 parent_id 要清 ----
  const dp = core.add({ title: '待删父卡', project: '层级样本' });
  const dc = core.add({ title: '待删子卡', project: '层级样本' });
  core.linkTasks(dc.id, dp.id, 'parent');
  core.remove(dp.id);
  eq('删父卡后子卡 parent_id 清空', core.getTask(dc.id).parent_id, null);
  ok('删父卡后子卡还在', !!core.getTask(dc.id));
}

console.log('\n=== 18. 重开后数据还在 ===');
const totalBefore = core.count();
core.close();
const core2 = createCore(tmp);
eq('重开后任务数一致', core2.count(), totalBefore);
ok('重开后数据非空', core2.count() > 0);

console.log('\n=== 19. 依赖关系 ===');
{
  // ---- 19.1 v5 → v6 迁移 ----
  // 这一步要 DROP 列，所以先把 core2 关掉独占这个库。
  core2.close();
  {
    const cols0 = createCore(tmp);
    cols0.init();
    cols0.conn().exec('ALTER TABLE tasks DROP COLUMN link_warn');
    cols0.conn().run("UPDATE meta SET value='5' WHERE key='schema_version'");
    ok('降级成功（link_warn 没了）',
      !cols0.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('link_warn'));
    cols0.close();

    const v6 = createCore(tmp);
    v6.init();
    ok('tasks.link_warn 回来了',
      v6.conn().all('PRAGMA table_info(tasks)').map((c) => c.name).includes('link_warn'));
    // 这一步只验「v5 → v6 那批列补回来了」，版本号本身跟着 SCHEMA_VERSION 走：
    // 后面每加一步都会往上抬，写死 6 会让所有后续迁移都得回来改这两行。
    eq('版本升到当前版本', v6.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, String(SCHEMA_VERSION));
    ok('SCHEMA_VERSION ≥ 6（v6 那批迁移必须已经存在）', SCHEMA_VERSION >= 6, String(SCHEMA_VERSION));
    ok('老任务的 link_warn 是空串',
      v6.state({ include_archived: true }).tasks.every((t) => t.link_warn === ''));
    v6.close();
  }

  // 后面都在这份升级完的库上跑
  const dep = createCore(tmp);
  dep.init();

  // ---- 19.2 建边 + blockedBy ----
  {
    const p = dep.add({ title: '前置：RIS 表对接' });
    const d = dep.add({ title: '通知：架构变更定时检查' });
    dep.linkTasks(d.id, p.id, 'depends_on');

    const b = dep.blockedBy(d.id);
    ok('建 depends_on 边后 blocked', b.blocked === true);
    eq('waiting 里就是那条前置', b.waiting.map((x) => x.id), [p.id]);
    eq('waiting 项带标题', b.waiting[0].title, '前置：RIS 表对接');
    ok('waiting 项带 status/project',
      b.waiting[0].status === 'todo' && typeof b.waiting[0].project === 'string');
    ok('前置自己不被阻塞', dep.blockedBy(p.id).blocked === false);

    // ---- 19.3 前置做完就不阻塞 ----
    dep.move(p.id, 'done');
    ok('前置 done 之后不再 blocked', dep.blockedBy(d.id).blocked === false);
    eq('waiting 清空', dep.blockedBy(d.id).waiting.length, 0);
    ok('done 之后可以进 doing', dep.move(d.id, 'doing').status === 'doing');

    // ---- 19.4 前置没做完时 move 被拦 ----
    const p2 = dep.add({ title: '前置：埋点上报' });
    const d2 = dep.add({ title: '通知：等埋点' });
    dep.linkTasks(d2.id, p2.id, 'depends_on');
    let errDoing = null;
    try { dep.move(d2.id, 'doing'); } catch (e) { errDoing = e.message; }
    ok('前置没做完时进 doing 被拒', errDoing !== null);
    ok('错误信息里带前置标题', /前置：埋点上报/.test(String(errDoing)), String(errDoing));
    ok('错误信息里带条数', /还有 1 条前置没做完/.test(String(errDoing)), String(errDoing));

    let errDone = null;
    try { dep.move(d2.id, 'done'); } catch (e) { errDone = e.message; }
    ok('前置没做完时直接标 done 也被拒', errDone !== null);

    // patch 那条路同样被拦（不是只有 move 拦）
    let errPatch = null;
    try { dep.patch(d2.id, { status: 'doing' }); } catch (e) { errPatch = e.message; }
    ok('patch 改状态同样被拦', errPatch !== null);

    // ---- 19.9 往回退永远允许 ----
    // d2 现在是 todo 且被拦住；先让它进 doing 再从 doing 退回 todo 也不该被拦，
    // 所以这里用另一条已经 doing 的卡补一条前置来验证「退回去不受限」。
    const d3 = dep.add({ title: '已经在做的卡' });
    dep.move(d3.id, 'doing');
    const p3 = dep.add({ title: '后补的前置' });
    dep.linkTasks(d3.id, p3.id, 'depends_on');
    ok('补前置后立刻算 blocked', dep.getTask(d3.id).blocked === true);
    ok('blocked 的卡退回去不被拦', dep.move(d3.id, 'todo').status === 'todo');

    // ---- 19.5 前置被合并 → 不再算阻塞 ----
    const p4 = dep.add({ title: '前置：会被合并的' });
    const p5 = dep.add({ title: '前置：合并的另一半' });
    const d4 = dep.add({ title: '下游：等一条会被合并的前置' });
    dep.linkTasks(d4.id, p4.id, 'depends_on');
    ok('合并前 blocked', dep.blockedBy(d4.id).blocked === true);
    const mergedDep = dep.mergeTasks([p4.id, p5.id], { title: '合并出来的前置' });
    ok('被合并的前置不再算阻塞', dep.blockedBy(d4.id).blocked === false);
    eq('waiting 清空', dep.blockedBy(d4.id).waiting.length, 0);
    ok('下游卡因此可以进 doing', dep.move(d4.id, 'doing').status === 'doing');
    ok('前置被合并时下游留了提示', dep.getTask(d4.id).link_warn.trim().length > 0);
    ok('提示里说清是「合并」',
      /原来的前置「前置：会被合并的」被合并了/.test(dep.getTask(d4.id).link_warn),
      dep.getTask(d4.id).link_warn);

    // ---- 19.6 环检测 ----
    const c1 = dep.add({ title: '环A' });
    const c2 = dep.add({ title: '环B' });
    dep.linkTasks(c1.id, c2.id, 'depends_on');
    let cyc = null;
    try { dep.linkTasks(c2.id, c1.id, 'depends_on'); } catch (e) { cyc = e.message; }
    ok('反向再加一条被拒（成环）', cyc !== null);
    ok('错误信息说清了是依赖成环', /依赖关系会成环/.test(String(cyc)), String(cyc));
    eq('被拒之后边没写进去', dep.listLinks(c2.id).asFrom.length, 0);

    // 三节点的间接环也要拦住：A 等 B、B 等 C，再加 C 等 A
    const c3 = dep.add({ title: '环C' });
    dep.linkTasks(c2.id, c3.id, 'depends_on');
    let cyc3 = null;
    try { dep.linkTasks(c3.id, c1.id, 'depends_on'); } catch (e) { cyc3 = e.message; }
    ok('间接环（三节点）也被拒', cyc3 !== null);

    // 自己连自己被拒
    let selfDep = null;
    try { dep.linkTasks(c1.id, c1.id, 'depends_on'); } catch (e) { selfDep = e.message; }
    ok('不能自己依赖自己', selfDep !== null);

    // 两种 kind 的链不能混着爬：合并链上的人不该被当成依赖链上的祖先
    const m1 = dep.add({ title: '混合样本M1' });
    const m2 = dep.add({ title: '混合样本M2' });
    const mm = dep.mergeTasks([m1.id, m2.id], { title: '混合合并M' });
    // mm → m1 是 merge_parent 边；再加 m1 → mm 的依赖不该因为「合并链上有 mm」被拒
    let crossKind = null;
    try { dep.linkTasks(m1.id, mm.id, 'depends_on'); } catch (e) { crossKind = e.message; }
    ok('merge 链不参与 depends_on 的环检测', crossKind === null, String(crossKind));
    dep.unlinkTasks(m1.id, mm.id, 'depends_on');

    // ---- 19.7 state() 里的派生字段 ----
    const s1 = dep.add({ title: '派生：等的那个' });
    const s2 = dep.add({ title: '派生：前置一' });
    const s3 = dep.add({ title: '派生：前置二' });
    dep.linkTasks(s1.id, s2.id, 'depends_on');
    dep.linkTasks(s1.id, s3.id, 'depends_on');
    const st = dep.state({ include_archived: true });
    const byId = new Map(st.tasks.map((t) => [t.id, t]));
    ok('state 里 s1 是 blocked', byId.get(s1.id).blocked === true);
    eq('s1 的 waiting_count', byId.get(s1.id).waiting_count, 2);
    eq('s1 的 blocking_count', byId.get(s1.id).blocking_count, 0);
    eq('s2 的 blocking_count', byId.get(s2.id).blocking_count, 1);
    eq('s3 的 blocking_count', byId.get(s3.id).blocking_count, 1);
    ok('s2 自己不被阻塞', byId.get(s2.id).blocked === false);
    eq('s2 的 waiting_count', byId.get(s2.id).waiting_count, 0);
    ok('list() 里也有这些字段', (() => {
      const one = dep.list({ include_archived: true }).tasks.find((t) => t.id === s1.id);
      return one.blocked === true && one.waiting_count === 2 && one.blocking_count === 0;
    })());
    ok('getTask 也带上（抽屉读这一份）', dep.getTask(s1.id).blocked === true);
    eq('link_counts.depends_on 两个方向都算',
      dep.getTask(s1.id).link_counts.depends_on, 2);

    // s2 做完之后 s1 只剩 1 条
    dep.move(s2.id, 'done');
    eq('一条前置做完后 waiting_count 降下来', dep.getTask(s1.id).waiting_count, 1);
    ok('还有一条没做完时仍然 blocked', dep.getTask(s1.id).blocked === true);

    // ---- 19.8 删掉前置 → link_warn ----
    const w1 = dep.add({ title: '下游：前置会被删' });
    const w2 = dep.add({ title: '前置：马上被删' });
    dep.linkTasks(w1.id, w2.id, 'depends_on');
    ok('删之前没有被删提示', dep.getTask(w1.id).link_warn === '');
    dep.remove(w2.id);
    const warned = dep.getTask(w1.id).link_warn;
    ok('删掉前置后下游有 link_warn', warned.trim().length > 0, JSON.stringify(warned));
    ok('提示里说清是「删除」并带标题', /原来的前置「前置：马上被删」被删除了/.test(warned), warned);
    ok('删完之后不再 blocked', dep.getTask(w1.id).blocked === false);

    // 看过就清：PATCH link_warn 成空串
    eq('link_warn 能清空', dep.patch(w1.id, { link_warn: '' }).link_warn, '');
    // 只清这一句，不动别的字段
    ok('清提示不影响标题', dep.getTask(w1.id).title === '下游：前置会被删');
  }

  dep.close();
}

console.log('\n=== 21. 表格字段（v8：seq_no / plan_* / owner / *_hours） ===');
{
  // ---- 21.1 v7 → v8 迁移 ----
  // 降级：把 6 个列 DROP 掉、版本写回 7。
  // 这 6 列没有索引也没有约束挂在上面，所以 SQLite 的 DROP COLUMN 能直接做
  // （parent_id 那次不行，因为它带索引，得先删索引）。
  const v7 = createCore(tmp);
  v7.init();
  const DROP8 = ['seq_no', 'plan_start_at', 'plan_end_at', 'owner', 'estimate_hours', 'actual_hours'];
  for (const c of DROP8) {
    try { v7.conn().exec('ALTER TABLE tasks DROP COLUMN ' + c); } catch { /* 已经没有 */ }
  }
  v7.conn().run("UPDATE meta SET value='7' WHERE key='schema_version'");
  const colsOf = (c) => c.conn().all('PRAGMA table_info(tasks)').map((x) => x.name);
  ok('降级成功（6 列都没了）', DROP8.every((c) => !colsOf(v7).includes(c)),
    DROP8.filter((c) => colsOf(v7).includes(c)).join(','));
  const totalBefore = Number(v7.conn().get('SELECT COUNT(*) AS c FROM tasks').c);
  ok('降级不会删数据', totalBefore > 0, String(totalBefore));
  v7.close();

  const v8 = createCore(tmp);
  v8.init();
  ok('tasks 的 6 个列回来了', DROP8.every((c) => colsOf(v8).includes(c)));
  eq('版本升到 8', v8.conn().get("SELECT value FROM meta WHERE key='schema_version'").value, '8');
  eq('SCHEMA_VERSION 就是 8', SCHEMA_VERSION, 8);
  eq('迁移不动任务条数', Number(v8.conn().get('SELECT COUNT(*) AS c FROM tasks').c), totalBefore);

  // ---- 21.2 老任务的 seq_no 回填 ----
  const seqs = v8.conn().all('SELECT seq_no FROM tasks ORDER BY seq_no').map((r) => Number(r.seq_no));
  eq('每条任务都有 seq_no', seqs.length, totalBefore);
  ok('seq_no 没有 null', seqs.every((n) => Number.isFinite(n) && n > 0), JSON.stringify(seqs.slice(0, 5)));
  eq('seq_no 从 1 开始', seqs[0], 1);
  eq('seq_no 不重复', new Set(seqs).size, seqs.length);
  // 回填按 created_at, rowid 顺序：最早建的那条拿到 1
  const earliest = v8.conn().get('SELECT id, seq_no FROM tasks ORDER BY created_at, rowid LIMIT 1');
  eq('最早的卡拿到 T-001', earliest.seq_no, 1);
  ok('迁移后派生字段 no 也对得上',
    v8.state({ include_archived: true }).tasks.every((t) => t.no === 'T-' + String(t.seq_no).padStart(3, '0')));

  // 幂等：再跑一次 init 不会把编号重排/洗掉
  const before2 = v8.conn().all('SELECT id, seq_no FROM tasks ORDER BY id').map((r) => r.id + ':' + r.seq_no);
  v8.init();
  const after2 = v8.conn().all('SELECT id, seq_no FROM tasks ORDER BY id').map((r) => r.id + ':' + r.seq_no);
  eq('重跑 init 不动已有 seq_no', after2, before2);
  v8.close();

  // 后面在这份升级完的库上跑
  const tt = createCore(tmp);
  tt.init();

  // ---- 21.3 新任务 seq_no = MAX + 1 ----
  const maxSeq = Number(tt.conn().get('SELECT MAX(seq_no) AS m FROM tasks').m);
  const n1 = tt.add({ title: '表格样本一', project: '表格样本' });
  eq('新任务 seq_no = MAX+1', n1.seq_no, maxSeq + 1);
  const n2 = tt.add({ title: '表格样本二', project: '表格样本' });
  eq('再建一条继续 +1', n2.seq_no, maxSeq + 2);
  eq('add 返回里带派生 no', n2.no, 'T-' + String(maxSeq + 2).padStart(3, '0'));
  eq('落库的 seq_no 也是这个', Number(tt.conn().get('SELECT seq_no FROM tasks WHERE id=?', [n2.id]).seq_no), maxSeq + 2);

  // ---- 21.7 编号派生串 ----
  const t1 = tt.conn().get('SELECT id FROM tasks WHERE seq_no = 1');
  eq('seq_no=1 派生 T-001', tt.getTask(t1.id).no, 'T-001');
  ok('低于 100 的补零见到 3 位', /^T-\d{3,}$/.test(tt.getTask(t1.id).no), tt.getTask(t1.id).no);

  // ---- 21.4 patch 能写 5 个字段，seq_no 不行 ----
  const p = tt.patch(n1.id, {
    owner: ' 韩宏文 ',
    estimate_hours: 3.5,
    actual_hours: '2',
    plan_start_at: '2026-03-05',
    plan_end_at: '2026-03-09'
  });
  eq('owner 写进去了（并去掉首尾空格）', p.owner, '韩宏文');
  eq('estimate_hours 写进去了', p.estimate_hours, 3.5);
  eq('actual_hours 字符串 "2" 存成数字 2', p.actual_hours, 2);
  eq('plan_start_at 写进去了', p.plan_start_at, '2026-03-05');
  eq('plan_end_at 写进去了', p.plan_end_at, '2026-03-09');

  const seqBefore = tt.getTask(n1.id).seq_no;
  const afterPatchSeq = tt.patch(n1.id, { seq_no: 9999 });
  eq('seq_no 不可改（patch 忽略它）', afterPatchSeq.seq_no, seqBefore);
  eq('库里 seq_no 也没变', Number(tt.conn().get('SELECT seq_no FROM tasks WHERE id=?', [n1.id]).seq_no), seqBefore);

  // 清空一格 = 存 NULL，不是空串
  const cleared = tt.patch(n1.id, { owner: '', plan_end_at: null, estimate_hours: null });
  eq('owner 清空后是 null', cleared.owner, null);
  eq('plan_end_at 清空后是 null', cleared.plan_end_at, null);
  eq('estimate_hours 清空后是 null', cleared.estimate_hours, null);
  ok('库里存的也是 NULL 而不是空串',
    tt.conn().get('SELECT owner, plan_end_at, estimate_hours FROM tasks WHERE id=?', [n1.id]).owner === null);

  // 只改一个字段不能把别的清掉（undefined = 这次没改它）
  tt.patch(n1.id, { plan_start_at: '2026-04-01' });
  eq('只改 plan_start_at 时 actual_hours 原样保留', tt.getTask(n1.id).actual_hours, 2);
  eq('只改 plan_start_at 时 plan_start_at 变了', tt.getTask(n1.id).plan_start_at, '2026-04-01');

  // ---- 21.5 工时脏值一律 NULL ----
  const dirty = (v) => tt.patch(n1.id, { estimate_hours: v }).estimate_hours;
  eq("estimate_hours '' → null", dirty(''), null);
  eq("estimate_hours '   ' → null", dirty('   '), null);
  eq("estimate_hours 'abc' → null", dirty('abc'), null);
  eq('estimate_hours -1 → null', dirty(-1), null);
  eq('estimate_hours null → null', dirty(null), null);
  eq('estimate_hours 0 是合法值', dirty(0), 0);
  const dirtyA = (v) => tt.patch(n1.id, { actual_hours: v }).actual_hours;
  eq("actual_hours 'abc' → null", dirtyA('abc'), null);
  eq('actual_hours -2.5 → null', dirtyA(-2.5), null);
  // 脏值不写进库
  tt.patch(n1.id, { actual_hours: 'abc' });
  ok('库里的 actual_hours 是 NULL',
    tt.conn().get('SELECT actual_hours FROM tasks WHERE id=?', [n1.id]).actual_hours === null);

  // ---- 21.6 日期格式非法要抛错 ----
  const badDate = (v) => { try { tt.patch(n1.id, { plan_start_at: v }); return null; } catch (e) { return e.message; } };
  ok("'2026/03/05' 被拒", badDate('2026/03/05') !== null);
  ok('错误话说清了格式', /YYYY-MM-DD/.test(String(badDate('2026/03/05'))));
  ok("'20260305' 被拒", badDate('20260305') !== null);
  ok("'2026-3-5' 被拒（要求两位）", badDate('2026-3-5') !== null);
  ok("'2026-02-31' 被拒（那天不存在）", badDate('2026-02-31') !== null);
  ok("'2026-13-01' 被拒（月份不存在）", badDate('2026-13-01') !== null);
  eq('被拒之后原来的值没被改掉', tt.getTask(n1.id).plan_start_at, '2026-04-01');
  const badEnd = (v) => { try { tt.patch(n1.id, { plan_end_at: v }); return null; } catch (e) { return e.message; } };
  ok('plan_end_at 同样校验', badEnd('明天') !== null);
  eq('空串仍然是合法的「清空」', tt.patch(n1.id, { plan_end_at: '' }).plan_end_at, null);

  // ---- add() 也走同一套归一化 ----
  const n3 = tt.add({
    title: '带业务字段的新卡', project: '表格样本',
    owner: '  李四  ', estimate_hours: '-1', actual_hours: 'abd', plan_start_at: '2026-05-06'
  });
  eq('add 的 owner 也去空格', n3.owner, '李四');
  eq('add 的 estimate_hours 负数 → null', n3.estimate_hours, null);
  eq("add 的 actual_hours 'abd' → null", n3.actual_hours, null);
  eq('add 的 plan_start_at 正常写入', n3.plan_start_at, '2026-05-06');
  let addBad = null;
  try { tt.add({ title: '日期非法的新卡', plan_start_at: '2026/5/6' }); } catch (e) { addBad = e.message; }
  ok('add 的非法日期也抛错', addBad !== null);
  ok('add 被拒后没有留下半条任务',
    !tt.state({ include_archived: true }).tasks.some((x) => x.title === '日期非法的新卡'));

  // 新字段在 state / list / getTask 三处都带
  const inState = tt.state({ include_archived: true }).tasks.find((x) => x.id === n1.id);
  ok('state 带表格字段',
    inState.seq_no === seqBefore && inState.no === tt.getTask(n1.id).no
    && 'estimate_hours' in inState && 'plan_start_at' in inState && 'owner' in inState);
  const inList = tt.list({ include_archived: true }).tasks.find((x) => x.id === n1.id);
  ok('list 带表格字段', inList.no === inState.no && inList.plan_start_at === inState.plan_start_at);

  // 导出/备份也带上 6 个字段，原样倒回来编号还在
  const dump = tt.exportAll();
  const dumped = dump.tasks.find((x) => x.id === n1.id);
  ok('导出里有 seq_no / owner / 工时', dumped.seq_no === seqBefore && dumped.owner === null
    && dumped.actual_hours === null && dumped.plan_start_at === '2026-04-01');
  ok('导出里没有派生的 no（由 seq_no 推得出来）', dumped.no === undefined);

  tt.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
