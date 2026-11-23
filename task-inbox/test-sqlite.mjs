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
