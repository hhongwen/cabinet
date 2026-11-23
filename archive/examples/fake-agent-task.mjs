// 任务版假 agent。模拟 codex exec --json，支持续轮（resume）。
// 行为由 prompt 内容控制：
//   #DECIDE  → 输出「需要决策：」
//   #FAIL    → 非零退出（测重试）
//   #FAIL2   → 前两次失败（用 env FAKE_ATTEMPT 判断）
//   #SILENT  → 空输出
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const isResume = args.includes('resume');
const oIdx = args.indexOf('-o');
const outFile = oIdx >= 0 ? args[oIdx + 1] : null;

// 续轮时 thread_id 从参数里取，首轮自己造一个
const resumeIdx = args.indexOf('resume');
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const threadId = resumeId ?? `fake-thread-${Date.now()}`;

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => {
  const prompt = buf.trim();

  // 把收到的东西记到 stderr，便于核对（runner 会写进 log）
  console.error(`[fake] mode=${isResume ? 'resume' : 'fresh'} thread=${threadId}`);
  console.error(`[fake] argv=${JSON.stringify(args)}`);
  console.error(`[fake] prompt=${prompt.length} bytes`);

  if (prompt.includes('#SILENT')) process.exit(0);

  // 首行必须是 thread.started，runner 靠这个拿 session id
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  console.log(JSON.stringify({ type: 'turn.started' }));

  const failTimes = prompt.includes('#FAIL2') ? 2 : prompt.includes('#FAIL') ? 99 : 0;
    // 从 prompt 读尝试次数（scheduler 在重试时会写「这是第 N 次尝试」）
  const am = /第 ([0-9]+) 次尝试/.exec(prompt);
  const attempt = am ? Number(am[1]) : 1;

  if (attempt <= failTimes) {
    console.log(JSON.stringify({ type: 'item.completed',
      item: { type: 'agent_message', text: `第 ${attempt} 次故意失败` } }));
    console.error(`[fake] 故意失败 attempt=${attempt}`);
    process.exit(1);
  }

  let answer;
  if (prompt.includes('#DECIDE')) {
    answer = '改完了。需要决策：是把旧配置删掉还是留着兼容？';
  } else {
    // 把收到的未读消息条数写进结论，验证消息确实喂进去了
    const msgLines = prompt.split('\n').filter((l) => l.startsWith('- [') && l.includes('] ')).length;
    answer = `已处理。prompt=${prompt.length}字节 读到消息=${msgLines}条 mode=${isResume ? 'resume' : 'fresh'}`;
  }

  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));

  if (outFile) fs.writeFileSync(outFile, answer + '\n', 'utf8');
  process.exit(0);
});
