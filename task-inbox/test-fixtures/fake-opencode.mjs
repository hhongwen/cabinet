// 假的 opencode CLI：只实现 Adapter 用到的那几条参数形状。
//
// 为什么用脚本而不是 mock spawn：Adapter 真正容易错的地方是
//   stdin 写 prompt → stdout 逐行 JSONL → 多 step → 退出码 / stderr
// 这一段；用真进程跑才能验到 stdio 和行缓冲。
//
// 模式由 FAKE_OPENCODE_MODE 决定：ok / multi / no-finish / fail / hang / export。
const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
const args = process.argv.slice(2);

if (args.includes('export')) {
  process.stdout.write(JSON.stringify({
    info: { outcome: 'succeeded', time: { busy: 10, idle: 20 } },
    messages: [
      {
        id: 'msg_1', type: 'assistant', time: { completed: 15 },
        content: [{ type: 'text', text: '收到' }]
      },
      { type: 'idle', outcome: 'succeeded' }
    ]
  }) + '\n');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const start = (mid) => emit({
    type: 'step_start', sessionID: 'ses_fixture',
    part: { messageID: mid, type: 'step-start' }
  });
  const text = (t) => emit({
    type: 'text', sessionID: 'ses_fixture',
    part: { type: 'text', text: t }
  });
  const finish = (reason) => emit({
    type: 'step_finish', sessionID: 'ses_fixture',
    part: { type: 'step-finish', reason }
  });

  if (mode === 'ok') {
    start('msg_1'); text('收到'); finish('stop');
    process.exit(0);
  }

  if (mode === 'multi') {
    start('msg_1'); text('先查一下'); finish('tool-calls');
    start('msg_2'); text('收到'); finish('stop');
    process.exit(0);
  }

  if (mode === 'no-finish') {
    start('msg_1'); text('半截');
    process.exit(0);
  }

  if (mode === 'fail') {
    process.stderr.write('boom\n');
    process.exit(1);
  }

  if (mode === 'hang') {
    // Adapter 应该 abort → kill 这个进程；如果它没 kill，测试会超时。
    setInterval(() => {}, 1000);
    return;
  }

  process.stderr.write('unknown fake mode: ' + mode + '\n');
  process.exit(2);
});
