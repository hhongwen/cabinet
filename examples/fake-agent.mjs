// 假 agent：不联网，模拟 codex exec --json 的 JSONL 输出。
// 用途：在没有网络/额度的情况下验证「拼命令 → stdin → 日志 → 状态流转」全链路。
//
// 行为由 prompt 里的标记控制：
//   #DECIDE   → 结论里带「需要决策：」触发 review 分支
//   #JSONL    → 只打 JSONL，不写 last message 文件（测兜底提取）
//   #SILENT   → 什么都不输出（测空结论）
import fs from 'node:fs';

const args = process.argv.slice(2);
const oIdx = args.indexOf('-o');
const outFile = oIdx >= 0 ? args[oIdx + 1] : null;

// 检查参数是否都在，用来验证 buildCommand 的占位符替换
const has = (f) => args.includes(f);
const checks = {
  hasCwd: has('-C'),
  hasSandbox: has('-s'),
  hasModel: has('-m'),
  hasOut: has('-o'),
  argv: args,
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (buf += c));
process.stdin.on('end', () => {
  const prompt = buf.trim();

  // 把收到的 argv / prompt 打到 stderr，便于人工核对
  console.error('[fake] argv=' + JSON.stringify(args));
  console.error('[fake] prompt bytes=' + prompt.length);

  if (prompt.includes('#SILENT')) process.exit(0);

  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-1' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '思考中' } }));

  let answer;
  if (prompt.includes('#DECIDE')) {
    answer = '收到。需要决策：A 方案快但有风险，B 方案稳但要两天，你选哪个？';
  } else {
    answer = '收到。conclusion: prompt=' + prompt.split('\n')[0] + ' checks=' + JSON.stringify(checks);
  }

  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));

  // #JSONL 模式故意不写 -o 文件，验证从 JSONL 提取结论的兜底
  if (outFile && !prompt.includes('#JSONL')) fs.writeFileSync(outFile, answer + '\n', 'utf8');
  process.exit(0);
});
