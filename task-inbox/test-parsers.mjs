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

console.log('\n=== 2b. classify：dev_ready / dev_gaps ===');

{
  const be = fakeBackend('{"priority":"p2","title":"优化那个页面","dev_ready":false,"dev_gaps":["慢在哪一步","目标响应时间","谁来验收"]}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: '那个页面有点慢', text: '那个页面有点慢' });
  eq('dev_ready 是布尔 false', r.dev_ready, false);
  eq('dev_gaps 逐条带出', r.dev_gaps, ['慢在哪一步', '目标响应时间', '谁来验收']);
  ok('system prompt 里写了 dev_ready', be.calls[0].system.includes('dev_ready'));
  ok('system prompt 里写了「宁可判 false」', be.calls[0].system.includes('宁可判 false'));
}

{
  const be = fakeBackend('{"priority":"p2","title":"挪筛选条","dev_ready":true,"dev_gaps":[]}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: '把筛选条挪到标题行右侧', text: '把筛选条挪到标题行右侧' });
  eq('dev_ready 是布尔 true', r.dev_ready, true);
  eq('信息足够时 gaps 为空', r.dev_gaps, []);
}

{
  // 模型爱写的几种「差不多是 true」都要当成没给 —— 上层靠 undefined 决定不覆盖库里的值
  for (const raw of ['"true"', '1', '"是"', 'null']) {
    const be = fakeBackend('{"priority":"p2","title":"t","dev_ready":' + raw + '}');
    const c = createClassifier({ backend: be });
    const r = await c.classify({ title: 'x', text: 'y' });
    eq('dev_ready=' + raw + ' → undefined', r.dev_ready, undefined);
  }
}

{
  // gaps 是字符串 / 带空串 / 超过 3 条，都要收干净
  const be = fakeBackend('{"priority":"p2","title":"t","dev_ready":false,"dev_gaps":["  a  ","","b","c","d"]}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', text: 'y' });
  eq('空格被裁掉、空串被滤、最多 3 条', r.dev_gaps, ['a', 'b', 'c']);
}

{
  const be = fakeBackend('{"priority":"p2","title":"t","dev_ready":false,"dev_gaps":"缺对象"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', text: 'y' });
  eq('gaps 不是数组时给空数组', r.dev_gaps, []);
}

{
  // 模型完全没提这两个字段 —— 不能变成 false
  const be = fakeBackend('{"priority":"p2","title":"t"}');
  const c = createClassifier({ backend: be });
  const r = await c.classify({ title: 'x', text: 'y' });
  eq('没给 dev_ready 时是 undefined', r.dev_ready, undefined);
  eq('没给 dev_gaps 时是空数组', r.dev_gaps, []);
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

console.log('\n=== 6b. chat：图片和文件（UI-3） ===');

{
  const imgFile = path.join(tmp, 'shot.png');
  fs.writeFileSync(imgFile, Buffer.from('png'));

  const be = fakeBackend('{"reply":"看到了","patch":{}}');
  const c = createChat({ backend: be, imagesDir: tmp });
  // 附件里传的是相对名字（upload 只返回 name/url），要能落到 imagesDir 里的真实文件
  await c.reply({ task, thread: [], userText: '看这张图', images: ['shot.png'], projects: [] });

  eq('图片传给了 backend.chat', be.calls[0].images, [imgFile]);
  ok('用户的话也在 prompt 里', be.calls[0].text.includes('看这张图'));
}

{
  const mdFile = path.join(tmp, 'chat-notes.md');
  fs.writeFileSync(mdFile, '# 标题\n这一段是文件内容', 'utf8');

  const be = fakeBackend('{"reply":"好的","patch":{}}');
  const c = createChat({ backend: be, filesDir: tmp });
  await c.reply({ task, thread: [], userText: '', files: ['chat-notes.md'], projects: [] });

  const sent = be.calls[0].text;
  ok('文件名进 prompt', sent.includes('chat-notes.md'));
  ok('文件文本片段进 prompt', sent.includes('这一段是文件内容'));
  // 纯文件没有文字时，prompt 里那条「用户刚说」不能是空的
  ok('没有文字时有占位说明', sent.includes('只有附件'));
  eq('没有图片时 images 是空数组', be.calls[0].images, []);
}

{
  // CLI 通道不支持图片会抛错 —— 必须一路抛到调用方，不能被 chat 吞掉
  const be = {
    name: 'codex',
    async chat() { throw new Error('codex 通道不支持图片，请用 magpie'); }
  };
  const imgFile = path.join(tmp, 'shot2.png');
  fs.writeFileSync(imgFile, Buffer.from('png'));
  const c = createChat({ backend: be, imagesDir: tmp });
  let threw = null;
  try { await c.reply({ task, thread: [], userText: '看图', images: ['shot2.png'], projects: [] }); }
  catch (e) { threw = e; }
  ok('不支持图片的通道错误原样抛出', threw !== null && /不支持图片/.test(threw.message));
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

console.log('\n=== 8. 分类队列（P2-5） ===');
{
  // 队列必须是零定时器的：跑满之后 wake 下一个，而不是每 200ms 空转
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  ok('没有 setInterval 轮询空位', !/setInterval\(\(\) => \{\s*if \(running < MAX\)/.test(src));
  ok('有显式等待队列', src.includes('const waiting = []'));
  ok('有 pump()', src.includes('function pump()'));
  ok('暴露排队水位给 /api/backend', src.includes("queue: { running: queue.runningCount, waiting: queue.pendingCount() }"));
}

console.log('\n=== 9. 任务路由（P2-4） ===');
{
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');

  // classify_* 是引擎字段，PATCH 时要剥掉
  ok('PATCH 会剥掉 classify_state', /for \(const k of \['classify_state', 'classify_reason', 'classify_model'\]\) delete body\[k\]/.test(src));

  // 子路径路由必须分开处理，不能拿 move 的 handler 去接 reclassify
  ok('路由正则认 reclassify', src.includes('(?:move|reclassify)'));
  ok('/move 只在 POST 时生效', /if \(action === '\/move'\) \{[\s\S]{0,80}req\.method !== 'POST'/.test(src));
  ok('/reclassify 防止重复排队', /already running/.test(src));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n────────────────────────');
console.log(`通过 ${pass} / 共 ${pass + fail}` + (fail ? `  失败 ${fail}` : '  全绿'));
process.exit(fail ? 1 : 0);
