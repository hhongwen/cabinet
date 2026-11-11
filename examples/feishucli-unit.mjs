// lark-cli 结果解析的单元测试。不需要网络。
// 重点：失败时 lark-cli 把 JSON 打到 stderr、stdout 为空、退出码非零。
// 只读 stdout 会把所有失败当成「无输出」，进而静默吞掉。
import { parseResult } from '../src/feishu-cli.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
};
const eq = (a, b, l) => ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);

console.log('\n=== 成功：JSON 在 stdout ===');
{
  const r = parseResult({
    out: '{"ok":true,"identity":"bot","data":{"message_id":"om_1"}}',
    err: '',
    code: 0,
  });
  eq(r.ok, true, '判定成功');
  eq(r.data.message_id, 'om_1', '解析出 data');
}

console.log('\n=== 失败：JSON 在 stderr、stdout 空、退出码非零 ===');
{
  const r = parseResult({
    out: '',
    err: '{"ok":false,"error":{"code":99992354,"message":"invalid message id"}}',
    code: 1,
  });
  eq(r.ok, false, '判定失败（这是之前的 bug：会被当成 null 成功）');
  eq(r.error.code, 99992354, '错误码解析出来');
  ok(String(r.error.message).includes('invalid'), '错误信息可读');
}

console.log('\n=== 失败但退出码是 0（罕见）===');
{
  const r = parseResult({
    out: '{"ok":false,"error":{"message":"x"}}',
    err: '',
    code: 0,
  });
  eq(r.ok, false, 'ok:false 优先于退出码');
}

console.log('\n=== 成功但退出码非 0（不一致）===');
{
  const r = parseResult({
    out: '{"ok":true,"data":{}}',
    err: '',
    code: 3,
  });
  eq(r.ok, false, '退出码非 0 视为失败');
}

console.log('\n=== 完全没输出 ===');
{
  const r = parseResult({ out: '', err: '', code: 0 });
  eq(r.ok, false, '没有输出也算失败，不能静默');
  ok(!!r.error, '给出错误对象');
}

console.log('\n=== 非 JSON 输出 ===');
{
  const r = parseResult({ out: 'some plain text error', err: '', code: 1 });
  eq(r.ok, false, '非 JSON 失败');
  ok(String(r.error.message).includes('plain text'), '把原始输出带进错误里');
}

console.log('\n=== stderr 混了日志但结尾有 JSON ===');
{
  const r = parseResult({
    out: '',
    err: '[plugin] starting...\n{"ok":true,"data":{"x":1}}',
    code: 0,
  });
  eq(r.ok, true, '从混杂日志里挖出 JSON');
}

console.log('\n' + '='.repeat(50));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} / 共 ${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
