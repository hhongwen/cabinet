// test-parsers.mjs —— classify / chat 的解析层自测
//
// 这两个模块最容易炸的地方不是「模型答得好不好」，而是「模型答得不规范」：
// 多包一层 markdown、字段名写错、给了非法枚举值、干脆不返回 JSON。
// 这些分支不需要真的调模型，注入一个假 backend 就够了。
//
//   node test-parsers.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClassifier } from './classify.mjs';
import { createChat, FIELD_LABEL } from './chat.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

// 假 backend：按顺序吐出预先准备好的回答
function fakeBackend(...replies) {
  let i = 0;
  return {
    name: 'fake',
    calls: [],
    async chat(args) {
      this.calls.push(args);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { text: r, model: 'fake/model' };
    }
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-parsers-'));

// ============================================================
console.log('\n=== 1. classify：正常 JSON ===');

{
  const be = fakeBackend('{"kind":"text","priority":"p1","title":"修复登录崩溃","category":"开发","project":"诺华","reason":"影响核心流程"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: '登录崩了', text: '线上登录一点就崩' }, { projects: [{ name: '诺华', aliases: ['NVRP'], dirs: [] }] });
  eq('priority', r.priority, 'p1');
  eq('kind', r.kind, 'text');
  eq('title', r.title, '修复登录崩溃');
  eq('category', r.category, '开发');
  eq('project', r.project, '诺华');
  eq('reason', r.reason, '影响核心流程');
  ok('带上 backend 名字', !!r.backend);
}

console.log('\n=== 2. classify：模型不规矩的输出 ===');

{
  // markdown 代码块包着
  const be = fakeBackend('```json\n{"kind":"link","priority":"p2","title":"看这篇文档"}\n```');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 't', text: 'x' });
  eq('code fence 也能解析', r.title, '看这篇文档');
  eq('kind link', r.kind, 'link');
}

{
  // 前后有废话
  const be = fakeBackend('好的，我判断如下：\n{"priority":"p0","title":"磁盘满了"}\n以上。');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', text: 'y' });
  eq('前后夹杂文字也能取到 JSON', r.title, '磁盘满了');
  eq('priority p0', r.priority, 'p0');
}

{
  // 非法枚举值 → 应该退回安全默认，不是原样返回
  const be = fakeBackend('{"kind":"video","priority":"p9","title":"随便","category":"未知类别"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', kind: 'image', text: 'y' });
  eq('非法 priority 退回 p3', r.priority, 'p3');
  eq('非法 kind 退回任务自己的 kind', r.kind, 'image');
}

{
  // 完全不是 JSON
  const be = fakeBackend('我无法判断这条内容。');
  const c = createClassifier({ backend: be });
  let threw = null;
  try { await c.classify({ title: 'x', text: 'y' }); } catch (e) { threw = e; }
  ok('无 JSON 时抛错（不能静默吞）', threw !== null);
  ok('错误信息里带原文片段', threw && threw.message.includes('我无法判断'));
}

{
  // 没给 title 字段 → 用兜底
  const be = fakeBackend('{"priority":"p2","reason":"这是一条关于报表优化的记录"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: '优化报表', text: '报表太慢' });
  eq('没 title 时用原任务标题', r.title, '优化报表');
}

{
  // 标题是「截图」这种没信息量的 → 也要兜底
  const be = fakeBackend('{"priority":"p2","title":"截图","reason":"一张报错截图"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: '截图', text: '订单超时报错' });
  eq('无信息量标题被替换', r.title, '订单超时报错');
}

{
  // project 返回 null 要能过
  const be = fakeBackend('{"priority":"p3","title":"随便看看","project":null}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', text: 'y' });
  eq('project null 保留', r.project, null);
}

console.log('\n=== 3. classify：prompt 拼装 ===');

{
  const be = fakeBackend('{"priority":"p3","title":"t"}');
  const c = createClassifier({ backend: be });
  await c.classify(
    {
      title: '标题甲',
      text: '原文乙',
      urls: ['https://example.com'],
      images: [],
      files: []
    },
    {
      projects: [
        { name: '诺华', aliases: ['NVRP', 'novartis'], dirs: [{ path: 'D:\\code\\novartis', note: '主后端' }] }
      ]
    }
  );
  const sent = be.calls[0].text;
  ok('prompt 带原文', sent.includes('原文乙'));
  ok('prompt 带链接', sent.includes('https://example.com'));
  ok('prompt 带项目名', sent.includes('诺华'));
  ok('prompt 带别名', sent.includes('NVRP') && sent.includes('novartis'));
  ok('prompt 带目录名', sent.includes('novartis'));
  ok('system prompt 非空', !!be.calls[0].system && be.calls[0].system.length > 100);
}

{
  // 附件里的文本内容要能进 prompt
  const f = path.join(tmp, 'notes.md');
  fs.writeFileSync(f, '# 会议记录\n讨论报表导出性能', 'utf8');
  const be = fakeBackend('{"priority":"p2","title":"t"}');
  const c = createClassifier({ backend: be, filesDir: tmp });
  await c.classify({ title: 'x', files: [f] });
  const sent = be.calls[0].text;
  ok('附件文件名进 prompt', sent.includes('notes.md'));
  ok('附件文本片段进 prompt', sent.includes('讨论报表导出性能'));
}

{
  // 二进制附件不该被当文本读
  const f = path.join(tmp, 'blob.bin');
  fs.writeFileSync(f, Buffer.from([0, 1, 2, 3, 255]));
  const be = fakeBackend('{"priority":"p2","title":"t"}');
  const c = createClassifier({ backend: be, filesDir: tmp });
  await c.classify({ title: 'x', files: [f] });
  ok('非文本附件不塞内容', !be.calls[0].text.includes('内容片段'));
}

console.log('\n=== 4. chat：patch 白名单 ===');

const task = {
  id: 't_1', title: '优化报表', status: 'todo', priority: 'p2',
  project: '诺华', category: '开发', note: '',
  payload: { text: '报表太慢' }
};

{
  const be = fakeBackend('{"reply":"改成 P1 了","patch":{"priority":"p1"}}');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: '改成 P1', projects: [] });
  eq('reply', r.reply, '改成 P1 了');
  eq('patch', r.patch, { priority: 'p1' });
}

{
  // 模型想改白名单外的字段 → 必须被丢掉
  const be = fakeBackend('{"reply":"好","patch":{"priority":"p0","id":"hacked","claimed_by":"evil","created_at":"2000-01-01"}}');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: '改一下', projects: [] });
  eq('只保留白名单字段', Object.keys(r.patch), ['priority']);
  ok('id 没被改', !('id' in r.patch));
  ok('claimed_by 没被改', !('claimed_by' in r.patch));
  ok('created_at 没被改', !('created_at' in r.patch));
}

{
  // 空 patch、null patch、非对象 patch
  for (const [label, raw] of [
    ['空对象', '{"reply":"知道了","patch":{}}'],
    ['null', '{"reply":"知道了","patch":null}'],
    ['字符串', '{"reply":"知道了","patch":"p1"}'],
    ['数组', '{"reply":"知道了","patch":["p1"]}']
  ]) {
    const be = fakeBackend(raw);
    const c = createChat({ backend: be });
    const r = await c.reply({ task, thread: [], userText: '嗯', projects: [] });
    eq(label + ' → patch 为空', r.patch, {});
  }
}

{
  // 值里带空白 / null / 数字
  const be = fakeBackend('{"reply":"好","patch":{"note":"   ","title":null,"priority":"p2"}}');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: 'x', projects: [] });
  eq('空白值和 null 被过滤', Object.keys(r.patch), ['priority']);
}

console.log('\n=== 5. chat：不返回 JSON 的兜底 ===');

{
  const be = fakeBackend('我觉得应该先看日志，再定位是查询慢还是渲染慢。');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: '你觉得该怎么修', projects: [] });
  ok('原文当回复', r.reply.includes('先看日志'));
  eq('patch 为空', r.patch, {});
}

{
  // reply 缺失
  const be = fakeBackend('{"patch":{"priority":"p1"}}');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: 'x', projects: [] });
  ok('reply 缺失给默认值', r.reply.length > 0);
  eq('patch 仍然生效', r.patch, { priority: 'p1' });
}

{
  // reply 超长要截断（防止模型写小作文塞进气泡）
  const be = fakeBackend('{"reply":"' + '啊'.repeat(3000) + '","patch":{}}');
  const c = createChat({ backend: be });
  const r = await c.reply({ task, thread: [], userText: 'x', projects: [] });
  ok('超长 reply 被截断', r.reply.length <= 800, '实际 ' + r.reply.length);
}

console.log('\n=== 6. chat：prompt 拼装 ===');

{
  const be = fakeBackend('{"reply":"好","patch":{}}');
  const c = createChat({ backend: be });
  await c.reply({
    task: { ...task, note: '客户催过两次' },
    thread: [
      { role: 'user', text: '这个是诺华的问题' },
      { role: 'assistant', text: '好的，我改成诺华' }
    ],
    userText: '顺便把优先级提到 P1',
    projects: [{ name: '诺华' }, { name: '欧加隆' }]
  });
  const sent = be.calls[0].text;
  ok('带任务标题', sent.includes('优化报表'));
  ok('带状态和优先级', sent.includes('todo') && sent.includes('p2'));
  ok('带备注', sent.includes('客户催过两次'));
  ok('带历史对话', sent.includes('这个是诺华的问题'));
  ok('带用户刚说的话', sent.includes('顺便把优先级提到 P1'));
  ok('带可选项目', sent.includes('诺华') && sent.includes('欧加隆'));
  ok('带原文', sent.includes('报表太慢'));
}

{
  // 线程很长时只带最近 10 条
  const be = fakeBackend('{"reply":"好","patch":{}}');
  const c = createChat({ backend: be });
  const thread = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: '第' + i + '句' }));
  await c.reply({ task, thread, userText: 'x', projects: [] });
  const sent = be.calls[0].text;
  ok('最早的对话被截掉', !sent.includes('第0句') && !sent.includes('第1句'));
  ok('最近的对话还在', sent.includes('第29句'));
}

console.log('\n=== 7. FIELD_LABEL 与 core 实际能改的字段一致 ===');
{
  // chat 允许模型改的字段，core.patch 必须真的接受，否则模型改了等于没改
  // （P0-2 就是这么发现 needs_project 存不进去的）
  //
  // 注意 status 不在 PATCHABLE 数组里：它走 applyStatus 单独分支，
  // 因为改状态要顺带维护 doing_at / done_at。所以这里要两边一起看。
  const { createCore } = await import('./core.mjs');
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-fields-'));
  const core = createCore(db);
  core.init();

  const samples = {
    title: '新标题', priority: 'p1', category: '开发',
    project: '默认', status: 'done', note: '新备注'
  };
  const chatFields = Object.keys(FIELD_LABEL);
  eq('FIELD_LABEL 覆盖了 samples 里的所有字段', chatFields.filter((f) => !(f in samples)), []);

  const missing = [];
  for (const f of chatFields) {
    const t = core.add({ title: 'scratch' });
    try {
      const after = core.patch(t.id, { [f]: samples[f] });
      if (String(after[f]) !== String(samples[f])) missing.push(f + '(值没变)');
    } catch (e) {
      missing.push(f + '(' + e.message + ')');
    }
  }
  eq('每个字段都能真的写进去', missing, []);

  // status 特殊：要顺带维护时间戳
  const st = core.add({ title: '状态测试' });
  core.patch(st.id, { status: 'doing' });
  ok('doing 会写 doing_at', !!core.getTask(st.id).doing_at);
  core.patch(st.id, { status: 'done' });
  ok('done 会写 done_at', !!core.getTask(st.id).done_at);
  core.patch(st.id, { status: 'todo' });
  ok('退回 todo 会清掉两个时间戳',
    !core.getTask(st.id).doing_at && !core.getTask(st.id).done_at);

  core.close();
  fs.rmSync(db, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
