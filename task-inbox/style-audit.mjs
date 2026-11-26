#!/usr/bin/env node
// 样式体检。规范见 STYLE.md。
//
//   node style-audit.mjs          体检 board.html
//   node style-audit.mjs --json   给 CI / 编辑器用
//
// 退出码 1 = 有 error，提交前必须修。0 = 通过（warn 不算失败）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'board.html');
const asJson = process.argv.includes('--json');

const errors = [];
const warns = [];
const err = (rule, msg, line) => errors.push({ rule, msg, line });
const warn = (rule, msg, line) => warns.push({ rule, msg, line });

const src = fs.readFileSync(FILE, 'utf8');

// ---------- 切出 <style> 与 body ----------

const styleOpen = src.indexOf('<style>');
const styleClose = src.indexOf('</style>');
if (styleOpen < 0 || styleClose < 0) {
  console.error('board.html 里找不到 <style> 块');
  process.exit(1);
}
const css = src.slice(styleOpen + 7, styleClose);
const cssStartLine = src.slice(0, styleOpen).split('\n').length;
const body = src.slice(styleClose + 8);

// 注释先剥掉（用等长空格替换，保住行号），否则 "/* ... */" 会被当成选择器的一部分
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const lineOf = (indexInCss) => cssStartLine + css.slice(0, indexInCss).split('\n').length - 1;

// ---------- 解析：把 CSS 切成规则，记录嵌套深度 ----------

function parseRules(text) {
  const out = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const sel = buf.trim();
      buf = '';
      stack.push({ sel, depth: stack.length, start: i });
      continue;
    }
    if (ch === '}') {
      const open = stack.pop();
      if (open) {
        out.push({
          sel: open.sel,
          depth: open.depth,
          atRule: stack.length ? stack[stack.length - 1].sel : '',
          body: text.slice(open.start + 1, i),
          start: open.start,
        });
      }
      buf = '';
      continue;
    }
    buf += ch;
  }
  return out;
}

const rules = parseRules(cssNoComment);
const topRules = rules.filter((r) => r.depth === 0 && !r.atRule && !r.sel.startsWith('@'));

// ---------- 检查 1：重复的顶层选择器 ----------

{
  const isBase = (r) => /var\(--ctl-raise\)|var\(--ctl-inset\)/.test(r.body);

  const seen = new Map();   // selector -> [{ rule, line, base }]
  for (const r of topRules) {
    for (const one of r.sel.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(one)) seen.set(one, []);
      seen.get(one).push({ rule: r, line: lineOf(r.start), base: isBase(r) });
    }
  }

  const propsOf = (bodyText) =>
    (bodyText.match(/(?:^|;)\s*([a-z-]+)\s*:/gi) || [])
      .map((p) => p.replace(/^[;\s]*/, '').replace(/\s*:$/, '').toLowerCase());

  for (const [sel, hits] of seen) {
    if (hits.length < 2) continue;

    const bases = hits.filter((h) => h.base);
    const deltas = hits.filter((h) => !h.base);

    // 允许：一条总则（材质）+ 一条差量。总则多于一条 = 有人又抄了一遍
    if (bases.length > 1) {
      err('duplicate-selector', `"${sel}" 有 ${bases.length} 条「总则」级规则（行 ${bases.map((h) => h.line).join(', ')}）——材质只该定义一次`, bases[0].line);
      continue;
    }

    // 允许多个差量，但同一个属性在两处声明就是真冲突
    if (deltas.length > 1) {
      const propMap = new Map();
      for (const h of deltas) {
        for (const p of new Set(propsOf(h.rule.body))) {
          if (!propMap.has(p)) propMap.set(p, []);
          propMap.get(p).push(h.line);
        }
      }
      const clash = [...propMap.entries()].filter(([, ls]) => ls.length > 1);
      if (clash.length) {
        err('duplicate-selector',
          `"${sel}" 的 ${clash[0][0]} 在行 ${clash[0][1].join(' 与 ')} 各写了一次——后一条会赢，这就是"改一处忘一处"`, clash[0][1][0]);
      } else {
        warn('split-selector', `"${sel}" 被拆成 ${deltas.length} 条差量规则（行 ${deltas.map((h) => h.line).join(', ')}），建议合并成一条`, deltas[0].line);
      }
    }
  }
}

// ---------- 检查 2：白字按钮不许直接用 --orange ----------

{
  // 找出所有声明里同时有 color:#fff 和 background:...var(--orange) 的规则
  for (const r of rules) {
    const b = r.body;
    const whiteText = /color\s*:\s*(#fff|#ffffff|white)\b/i.test(b);
    const orangeBg = /background(-color)?\s*:[^;]*var\(--orange\)/i.test(b);
    if (whiteText && orangeBg) {
      err('cta-contrast', `"${r.sel.split(',')[0].trim()}" 用 --orange 做底配白字（3.53:1，不过 AA）——白字按钮必须用 --orange-cta`, lineOf(r.start));
    }
  }
}

// ---------- 检查 3：按钮/输入框总则之外不许重写材质 ----------

const BUTTON_POOL = [
  '.icon-btn', '.rail-toggle', '.sys-btn', '.mini', '.mini-btn', '.flt-reset',
  '.dlg button', '.dr-row button', '.pick-bar button', '.dock .go',
];

{
  // 总则块 = 那条把多个按钮选择器合在一起写材质的规则
  const shared = rules.find((r) =>
    r.sel.includes('.icon-btn') && r.sel.includes('.dr-row button') && /var\(--ctl-raise\)/.test(r.body)
  );
  if (!shared) {
    err('button-base-missing', '找不到「按钮总则」那条共享材质规则（应含 .icon-btn 且用 var(--ctl-raise)）——有人把地基删了', 0);
  } else {
    // 单独针对某个按钮的规则里，重新声明 background/box-shadow 就说明在另起炉灶
    for (const r of topRules) {
      if (r === shared) continue;
      const sels = r.sel.split(',').map((s) => s.trim());
      const hitsPool = sels.some((s) => BUTTON_POOL.includes(s));
      if (!hitsPool) continue;
      if (/var\(--ctl-raise\)/.test(r.body)) continue;         // 又把总则抄了一遍
      if (/(^|[;\s])background\s*:\s*linear-gradient/i.test(r.body)) {
        err('button-material', `"${sels[0]}" 自己重写了 background 渐变——按钮材质只能在总则里定义，这里只写差量`, lineOf(r.start));
      }
    }
  }
}

// 允许不挂总则的"另类按钮"：贴在别的东西上的装饰性按钮，本来就不该有瓷底
const BUTTON_EXEMPT = new Set([
  '.thumb button',      // 缩略图右上角的 ✕，浮在图上
  '.combo-toggle',      // 输入框右侧的箭头，是输入框的一部分
  '.sel-btn',           // 自定义下拉的触发器，有自己的三档尺寸
  '.mini-btn',          // 已挂在总则里，这里列上防误报
  '.tag-retry',         // 抽屉里的「未判断·重试」：贴着 tag 行的行内补救入口，
                        // 刻意不长成瓷底按钮，否则会跟正常卡片抢注意力
  '.rel-x',             // 依赖行尾的「取消前置」：18px 方形热点，挂在可点整行里，
                        // 做成瓷底按钮会比它所在的行还显眼
  '.tbl-sort',          // 表格表头的排序触发器：整格是点击区、贴着实色的 sticky
                        // 表头。挂总则会变成一排浮在表头上的白瓷块，把表头撑高
                        // 又比表里的内容抢眼；它的"凸起"语义也不对 —— 点它
                        // 改的是排序而不是提交动作
]);

{
  const shared = rules.find((r) =>
    r.sel.includes('.icon-btn') && r.body.includes('var(--ctl-raise)'));
  if (shared) {
    const pool = shared.sel.split(',').map((s) => s.trim());
    // markup 里所有 <button class="x"> 的类名
    const usedBtnClasses = new Set();
    for (const m of body.matchAll(/<button[^>]*class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) usedBtnClasses.add('.' + c);
    }
    for (const c of usedBtnClasses) {
      if (pool.includes(c) || BUTTON_EXEMPT.has(c)) continue;
      // 只报"自己有完整外观"的：写了两条以上材质属性的
      const rule = topRules.find((r) => r.sel.split(',').map((s) => s.trim()).includes(c));
      if (!rule) continue;
      const props = ['background', 'border', 'box-shadow'].filter((p) => new RegExp(p).test(rule.body));
      if (props.length < 2) continue;
      warn('button-offbase',
        `按钮 "${c}" 自己有 ${props.join('/')}，但没挂到「按钮总则」——先加进总则池，再只写差量`, lineOf(rule.start));
    }
  }
}

const INPUT_POOL = ['.dock textarea', '.dr-foot textarea', '.dr-fields select', '.pick-bar input', '.dir-row input'];

{
  const shared = rules.find((r) => r.sel.includes('.dock textarea') && /var\(--ctl-inset\)/.test(r.body));
  if (!shared) {
    err('input-base-missing', '找不到「输入框总则」那条共享材质规则（应含 .dock textarea 且用 var(--ctl-inset)）', 0);
  } else {
    for (const r of topRules) {
      if (r === shared) continue;
      const sels = r.sel.split(',').map((s) => s.trim());
      const hitsPool = sels.some((s) => INPUT_POOL.includes(s));
      if (!hitsPool) continue;
      // background-image 是箭头，属于差量，允许；background 简写会连带重置箭头
      if (/(^|[;\s])background\s*:\s*(?!none)/i.test(r.body) && !/var\(--ctl-inset\)/.test(r.body)) {
        err('input-material', `"${sels[0]}" 用 background 简写重写了输入框底色——会把自定义箭头一起冲掉，改成只写差量（见 STYLE.md 第八节）`, lineOf(r.start));
      }
    }
  }
}

// ---------- 检查 4：每个 backdrop-filter 都要有降级 ----------

{
  // 只看"真的开了滤镜"的规则；:not(backdrop-filter) 那种否定判断不算
  const glassSels = new Set();
  for (const r of rules) {
    if (r.atRule) continue;                       // 降级块自己的声明不算
    const declarations = r.body.replace(/-webkit-backdrop-filter\s*:[^;]*/gi, '');
    if (!/(^|[;\s])backdrop-filter\s*:\s*(?!none)/i.test(declarations)) continue;
    for (const one of r.sel.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/^(:root|body|html|\*)$/.test(one)) continue;
      glassSels.add(one);
    }
  }

  // 降级块里的规则：@supports not(...) 或 prefers-reduced-transparency 内的
  const fallbacks = rules.filter((r) =>
    r.atRule && /backdrop-filter|prefers-reduced-transparency/i.test(r.atRule)
  );

  const covered = new Set();
  for (const fb of fallbacks) {
    for (const one of fb.sel.split(',').map((s) => s.trim())) {
      if (glassSels.has(one)) { covered.add(one); continue; }
      for (const g of glassSels) if (one.endsWith(g)) covered.add(g);
    }
  }

  for (const g of glassSels) {
    if (covered.has(g)) continue;
    // 伪元素（如 dialog::backdrop）跟着宿主一起降级，不单独报
    const host = g.split('::')[0];
    if (host !== g && covered.has(host)) continue;
    warn('glass-fallback', `"${g}" 用了 backdrop-filter，但降级查询里没看到它的实色回退`, 0);
  }
}

// ---------- 检查 5：定义了但没人用的类 ----------

{
  // 先剥掉内联 SVG 和 url(...)，否则 "www.w3.org" 会被当成 .w3 这个类
  const cssClean = cssNoComment
    .replace(/url\(\s*(['"]?).*?\1\s*\)/gs, 'url()')
    .replace(/data:image\/[^"')\s]+/g, '');

  const defined = new Set();
  for (const m of cssClean.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    // 排除数字开头的小数/单位误伤
    if (/^\d/.test(m[1])) continue;
    defined.add(m[1]);
  }

  const used = new Set();
  // 静态 class 属性
  for (const m of body.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !/[$`{}]/.test(c)) used.add(c);
  }
  // 模板字符串里的 class="..."
  for (const m of body.matchAll(/class=\\?"([^"]*)\\?"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !/[$`{}]/.test(c)) used.add(c);
  }
  // classList.add/remove/toggle('x')
  for (const m of body.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*['"]([\w-]+)['"]/g)) used.add(m[1]);
  // classList.toggle('x', cond) 上面已覆盖；className = 'a b'
  for (const m of body.matchAll(/className\s*=\s*['"]([^'"]*)['"]/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !/[$`{}]/.test(c)) used.add(c);
  }
  // 三元里拼出来的 class（"c-" + key 这种），把 c-todo 等按前缀放行
  const dynamicPrefix = new Set();
  for (const m of body.matchAll(/class="([^"]*)\$\{[^}]*\}/g)) {
    const before = m[1].trim();
    if (/[\w-]$/.test(before)) dynamicPrefix.add(before.match(/[\w-]+$/)[0]);
  }

  // JS 里以字符串形式出现过的类（比如 'drag-over'）
  const jsText = body;

  for (const c of defined) {
    if (used.has(c)) continue;
    if ([...dynamicPrefix].some((p) => c.startsWith(p))) continue;
    // JS 里以字符串片段出现也算用到（允许 ' sel--inline' 这种带前缀空格的拼接）
    if (new RegExp(`(^|[^\\w-])${c.replace(/[-]/g, '\\-')}([^\\w-]|$)`, 'm').test(jsText)) continue;
    // 伪状态/变量名误伤
    if (/^(root|on|open|active|hot)$/.test(c)) continue;
    warn('unused-class', `.${c} 定义了但没在 HTML/JS 里用到`, 0);
  }
}

// ---------- 检查 5b：定义了但没人用的 CSS 变量 ----------

{
  const rootRule = topRules.find((r) => r.sel.trim() === ':root');
  if (rootRule) {
    const declared = [...rootRule.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
    const usedInCss = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const usedInJs = new Set([...body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    for (const v of declared) {
      if (usedInCss.has(v) || usedInJs.has(v)) continue;
      warn('unused-token', `${v} 在 :root 里声明了，但全文件没有一处 var(${v}) 用它`, 0);
    }
  }
}

// ---------- 检查 5c：引用了不存在的变量 ----------

{
  const rootRule = topRules.find((r) => r.sel.trim() === ':root');
  const declared = new Set(
    rootRule ? [...rootRule.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]) : []
  );
  // JS / 内联 style 里现写的变量（比如卡片上的 --bar）也算"已声明"。
  // 三种写法都要认，否则运行期写进去的变量会被误判成"没声明"：
  //   style="--bar:…"            模板字符串
  //   setProperty('--boot-h', …) 运行时按实测值写
  //   style.setProperty("--x", …)
  const inlineDeclared = new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of body.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) inlineDeclared.add(m[1]);

  const missing = new Set();
  for (const m of (css + body).matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (declared.has(m[1]) || inlineDeclared.has(m[1])) continue;
    // var(--x, fallback) 有兜底值，颜色不会"整个失效"，不按 error 算
    if (m[2] === ',') { warn('token-fallback', `var(${m[1]}) 没有声明，靠 fallback 兜着——建议补上声明`, 0); continue; }
    missing.add(m[1]);
  }
  for (const v of missing) {
    err('missing-token', `用了 var(${v})，但 :root 和内联样式里都没有声明——颜色会整个失效，退成继承值`, 0);
  }
}

// ---------- 检查 5d：z-index 只能用表里的值（STYLE.md 第五节） ----------

{
  // 72 是项目选择浮层：它要盖过抽屉（71），从抽屉里点徽章也得看得见。
  // 改这里必须同时改 STYLE.md 第五节的表，两边是同一份约定的两处抄写。
  // 69 是顶部横幅：压在顶栏/看板头之上，但必须在抽屉遮罩(70)之下。
  // 95 已废弃 —— 它比抽屉高，会盖住抽屉标题栏的按钮。
  const ALLOWED = new Set([1, 2, 3, 5, 60, 69, 70, 71, 72, 80, 90, 99]);
  for (const r of rules) {
    const m = r.body.match(/(?:^|[;\s])z-index\s*:\s*(-?\d+)/i);
    if (!m) continue;
    const v = Number(m[1]);
    if (ALLOWED.has(v)) continue;
    warn('z-index', `"${r.sel.split(',')[0].trim()}" 用了 z-index:${v}，不在 STYLE.md 的分层表里——先补表再写值`, lineOf(r.start));
  }
}

// ---------- 检查 5e：字号不许小于 10px（STYLE.md 第二节） ----------

{
  // 8.5 / 9 / 9.5px 这类"微缩字"在 1080p 100% 缩放下中文是糊的。
  // 只拦承载信息的字号：装饰性箭头、图标内字形不算（用 .no-min-font 注释放行）。
  const MIN = 10;
  const hits = [];
  for (const r of rules) {
    // 允许单条规则前一行写 /* min-font-ok */ 显式放行
    const before = cssNoComment.slice(Math.max(0, r.start - 60), r.start);
    if (/min-font-ok\s*\*\/\s*$/.test(before)) continue;
    for (const m of r.body.matchAll(/font(?:-size)?\s*:\s*(?:[^;]*?\s)?(\d+(?:\.\d+)?)px/gi)) {
      const v = Number(m[1]);
      if (v >= MIN) continue;
      hits.push({ sel: r.sel.split(',')[0].trim(), v, line: lineOf(r.start) });
      break;
    }
  }
  for (const h of hits) {
    warn('min-font-size',
      `"${h.sel}" 用了 ${h.v}px 字号（下限 ${MIN}px）——中文在这个尺寸下读不出来`,
      h.line);
  }
}

// ---------- 检查 6：:root 之外写死颜色 ----------

{
  // 「:root 之外」指的是**主 :root 块之外**。文件里还有第二个 :root——
  // 深色模式那条 `@media (prefers-color-scheme: dark){ :root{--lg-*:…} }`，
  // 它同样是变量声明层，不该算写死颜色。只在主块之后截一段就会把它判成违规。
  // 注意用 rules 而不是 topRules：深色模式那条 :root 嵌在 @media 里，
  // topRules 会按「不带 @ 的顶层规则」把它过滤掉。
  const rootRules = rules.filter((r) => r.sel.trim() === ':root');
  const rootSpans = rootRules.map((r) => [r.start, r.start + r.body.length]);
  const inRoot = (i) => rootSpans.some(([a, b]) => i >= a && i <= b);
  // 注释里提到的历史色值（"原来 #cbd2d4 上只有 2.4:1"）不是样式，
  // 用等长空格把注释抹掉再扫，行号不受影响。
  const restStart = 0;
  const rest = cssNoComment;

  // 允许清单：纯白/纯黑高光、以及 @supports 里的透明色
  const ALLOW = new Set(['#fff', '#ffffff', '#000', '#000000']);
  const bad = [];
  for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const v = m[0].toLowerCase();
    if (ALLOW.has(v) || inRoot(m.index)) continue;
    bad.push({ v, line: lineOf(restStart + m.index) });
  }
  if (bad.length) {
    // 只报总数 + 前几个，避免刷屏
    const uniq = [...new Set(bad.map((b) => b.v))];
    warn('hardcoded-color', `:root 之外有 ${bad.length} 处写死颜色（${uniq.length} 种）：${uniq.slice(0, 6).join(' ')}${uniq.length > 6 ? ' …' : ''}`, bad[0].line);
  }
}

// ---------- 检查 7：var() 后面直接拼十六进制透明度 ----------
//
// `'var(--p3)' + '22'` 拼出来是 `var(--p3)22` —— 这不是合法颜色，浏览器整条
// 声明丢掉。结果优先级标签全是透明底，浅灰字直接压在卡片上，几乎看不见。
// 这类错**不会报错、不会崩**，只是颜色静默消失，所以必须上硬门禁。

{
  // 十六进制透明度必须"紧贴"var() 且后面不能再跟 % 或字母 ——
  // 否则 `var(--side-mid) 72%` 这种渐变色标位置会被误判。
  const BAD = /var\(\s*--[\w-]+\s*\)\s*[0-9a-fA-F]{2}(?![0-9a-zA-Z%.])/g;
  const hits = [];
  for (const m of (css + body).matchAll(BAD)) {
    hits.push({ at: m.index, s: m[0] });
  }
  // 反向：'22' + 'var(...)' 之类拼接不合法，但最常见的是上面那种
  if (hits.length) {
    err('token-hex-concat',
      `${hits.length} 处把十六进制透明度直接拼在 var() 后面（如 ${hits[0].s}）——不是合法颜色，整条声明会被丢弃。改成成对的顶层 token（见 --p*-soft）`,
      0);
  }
}

// ---------- 检查 8：橙色不许当字色 ----------
//
// STYLE.md 只写了"白字必须配深橙"，漏了另一半：--orange 自己当字色也只有
// 3.53:1。橙色两头都不能碰文字 —— 不能当白字的底，也不能自己当字色。

{
  for (const r of rules) {
    if (r.atRule) continue;
    const m = r.body.match(/(?:^|[;\s])color\s*:\s*var\(\s*--orange\s*\)/i);
    if (!m) continue;
    err('orange-as-text',
      `"${r.sel.split(',')[0].trim()}" 用 --orange 当字色（3.53:1，不过 AA）——用 --accent-text 或 --danger-text`,
      lineOf(r.start));
  }
}

// ---------- 检查 9：圆角只能走阶梯 ----------

{
  // 阶梯在 :root 里；这里只认 token 和两个语义固定值。
  const LADDER = /^var\(--radius-(2|4|xs|sm|md|lg|xl)\)$/;
  const FIXED = /^(999px|50%|0)$/;
  const ALLOWED_IN_MULTI = /^(0|var\(--radius-(2|4|xs|sm|md|lg|xl)\))$/;
  const bad = [];
  for (const r of rules) {
    if (r.atRule) continue;
    for (const m of r.body.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (LADDER.test(v) || FIXED.test(v)) continue;
      // 「0 0 lg lg」这种四角写法：每一段都得是 0 或阶梯值
      const parts = v.split(/\s+(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => ALLOWED_IN_MULTI.test(p))) continue;
      bad.push({ sel: r.sel.split(',')[0].trim(), v, line: lineOf(r.start) });
    }
  }
  for (const b of bad) {
    // error 而不是 warn：阶梯外的半径一定要清掉，否则"6/7/8/9/10 五个档"
    // 会一夜之间长回来。已经收敛过一次（21 种 → 6 档），别让它反弹。
    err('radius-ladder',
      `"${b.sel}" 写了 border-radius:${b.v}——圆角只走 :root 的 6 档阶梯（见 STYLE.md 第四节）`, b.line);
  }
}

// ---------- 检查 10：投影只走 --shadow-* / 已知语义层 ----------
//
// 55 条各写一遍的 box-shadow 是"同一块玻璃贴了 55 种胶"。真正需要自己写
// 阴影的只有两类：结构层的内高光/内阴影（拟态），以及浮动层的投影。
// 两者都用同一套 --shadow-*-* 变量，散写的一律报出来。

{
  const ok = /var\(--(shadow-[0-9]|shadow-halo|raise-hi|ctl-inset-shadow|ctl-focus-ring)/;
  const semantic = /inset|var\(--(draft|rel|dep|table|ctl|banner)/;
  const bad = [];
  for (const r of rules) {
    if (r.atRule) continue;
    if (/^(:root|body|html)$/.test(r.sel.trim())) continue;
    for (const m of r.body.matchAll(/(?:^|[;\s])box-shadow\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (v === 'none' || ok.test(v) || semantic.test(v)) continue;
      bad.push({ sel: r.sel.split(',')[0].trim(), v: v.slice(0, 60), line: lineOf(r.start) });
    }
  }
  if (bad.length) {
    warn('shadow-offscale',
      `${bad.length} 条 box-shadow 没走 token（首例 "~{SEL}"）——见下`.replace('~{SEL}', bad[0].sel), bad[0].line);
    for (const b of bad.slice(0, 8)) {
      console.log(`    · ${b.line} ${b.sel}  ${b.v}`);
    }
  }
}

// ---------- 输出 ----------

if (asJson) {
  console.log(JSON.stringify({ errors, warns }, null, 2));
} else {
  const show = (list, tag) => {
    for (const it of list) {
      const loc = it.line ? `:${it.line}` : '';
      console.log(`${tag} [${it.rule}] ${it.msg}${loc}`);
    }
  };
  if (errors.length) show(errors, '✗');
  if (warns.length) show(warns, '·');
  if (!errors.length && !warns.length) console.log('✓ 样式检查通过');
  else console.log(`\n${errors.length} 个 error，${warns.length} 个 warning`);
}

process.exit(errors.length ? 1 : 0);
