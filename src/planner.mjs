// 拆解器：把一个任务拆成可执行的任务图。
//
// 这是整套系统最脆弱的环节（DESIGN.md 第十二节）。
// 所以所有设计都围绕「限制错误传播」而不是「保证不犯错」：
//   1. 判模糊不靠模型自评，靠结构化完备性（cwd/done_when/agent 填不全就算模糊）
//   2. 副作用分级：external 一律人审
//   3. 父任务保留，可整体回退重拆
//
// 调用 LLM 走 Magpie 网关，不碰任何 provider 和 key。
import { createLogger } from './util.mjs';

const log = createLogger('planner');

/** 副作用等级。 */
export const EFFECTS = ['read_only', 'write', 'external'];

/** 必须填全的字段。填不全 = 需求本身模糊。 */
const REQUIRED_FIELDS = ['title', 'cwd', 'done_when', 'agent'];

/** 判断一个子任务是否「完备」：三项必须齐全且不是占位符。 */
export function validateSubtask(t, index = 0) {
  const problems = [];
  for (const f of REQUIRED_FIELDS) {
    const v = t?.[f];
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`子任务[${index}] 缺少 ${f}`);
      continue;
    }
    // 占位符也算没填：模型很爱写这种
    if (/^(待定|todo|tbd|未知|unknown|\?+|-+|<.*>)$/i.test(v.trim())) {
      problems.push(`子任务[${index}] 的 ${f} 是占位符「${v.trim()}」`);
    }
  }
  if (t?.effect && !EFFECTS.includes(t.effect)) {
    problems.push(`子任务[${index}] 的 effect「${t.effect}」不合法`);
  }
  return problems;
}

/**
 * 判定整个拆解结果要不要人审。
 * @returns {{needsReview: boolean, reasons: string[]}}
 */
export function assessPlan(plan) {
  const reasons = [];

  if (!plan || typeof plan !== 'object') {
    return { needsReview: true, reasons: ['拆解结果不是对象'] };
  }
  if (!Array.isArray(plan.tasks)) {
    return { needsReview: true, reasons: ['拆解结果没有 tasks 数组'] };
  }

  // 原子任务：不拆就是正确答案，不该被逼着拆
  if (plan.kind === 'atomic') {
    if (plan.tasks.length !== 1) {
      reasons.push(`标为 atomic 却给了 ${plan.tasks.length} 个子任务`);
    }
    return { needsReview: reasons.length > 0, reasons };
  }

  if (plan.tasks.length === 0) {
    return { needsReview: true, reasons: ['plan 但没有任何子任务'] };
  }

  // 完备性检查
  for (let i = 0; i < plan.tasks.length; i++) {
    reasons.push(...validateSubtask(plan.tasks[i], i));
  }

  // 副作用检查：external 一律人审
  const externals = plan.tasks.filter((t) => t?.effect === 'external');
  if (externals.length > 0) {
    reasons.push(`有 ${externals.length} 个子任务带外部副作用（发送/发布），必须人审`);
  }

  return { needsReview: reasons.length > 0, reasons };
}

/** 拆解用的 system prompt。要短、要具体，别写成长篇说明书。 */
export const PLANNER_SYSTEM = `你是任务拆解器。把一个任务拆成可执行的任务图，或者判定它已经是原子任务。

只输出 JSON，不要任何解释文字、不要 markdown 代码块。

格式：
{
  "kind": "atomic" | "plan",
  "reason": "为什么这么拆（一句话）",
  "tasks": [
    {
      "title": "简短标题",
      "body": "具体要做什么",
      "cwd": "绝对路径",
      "agent": "codex",
      "model": "magpie/auto/xxx 或 null",
      "done_when": "怎么算做完，必须可验证",
      "effect": "read_only" | "write" | "external",
      "deps": [0]
    }
  ]
}

硬规则：
1. 判 atomic 还是 plan，看的是「能不能独立验证 / 副作用等级是否不同 / 能否并行」，
   不是工作量大小。一个人能一口气干完，不代表它是一件。
   - atomic：只有一个可验证的产出，且做完就是做完了。
   - plan：出现下列任一情况就该拆：
     a. 有多个可以分开验证的产出（比如「改存储」和「改界面」能各测各的）
     b. 子步骤的 effect 等级不同（有的只读、有的写文件、有的对外发送）
     c. 有真实的先后依赖（A 不做完 B 没法开始）
     d. 某一步失败时，其他部分不该跟着重做
   反过来，纯查询、纯阅读、单一文件的小改动，就该是 atomic。
   两种都不算错，判错的代价是：该拆没拆 → 一个失败全废；不该拆硬拆 → 白白多花调度成本。
2. 每个子任务必须填全 cwd / done_when / agent。填不出来说明需求模糊，
   就照实留空——系统会转给人确认，这比瞎猜好。
3. effect 判断标准是「做错了能不能撤回」：
   - read_only：只读，不改任何东西
   - write：改本机文件，能改回来
   - external：对外发送（发消息、提 PR、发邮件、调外部 API），发出去收不回
4. deps 用下标指向 tasks 数组里的其他项，表示「必须先完成那一个」。
   没有依赖就不写这个字段。
5. 不要循环依赖。
6. 子任务数量控制在 6 个以内。超过说明拆得太细。`;

/**
 * 把任务描述 + 可用信息拼成 user prompt。
 * @param {object} task   任务（有 title/body/cwd 等）
 * @param {object} ctx    { project, agents, models, siblings }
 */
export function buildPlannerPrompt(task, ctx = {}) {
  const lines = [];
  lines.push('任务：');
  lines.push(`标题：${task.title ?? '(无)'}`);
  if (task.body) lines.push(`描述：${task.body}`);
  if (task.done_when) lines.push(`已有验收标准：${task.done_when}`);
  if (task.cwd) lines.push(`工作目录：${task.cwd}`);
  lines.push('');

  if (ctx.project) {
    lines.push(`项目：${ctx.project.name}（${ctx.project.cwd}）`);
  }
  if (Array.isArray(ctx.agents) && ctx.agents.length) {
    lines.push(`可用 agent：${ctx.agents.join(', ')}`);
  }
  if (Array.isArray(ctx.models) && ctx.models.length) {
    // 别把 63 个模型全塞进去，给几个代表就行
    lines.push(`推荐模型（可留 null 用默认）：${ctx.models.slice(0, 8).join(', ')}`);
  }
  if (Array.isArray(ctx.siblings) && ctx.siblings.length) {
    lines.push('');
    lines.push('同级已有任务（避免重复拆）：');
    for (const s of ctx.siblings) lines.push(`- ${s.title}（${s.status}）`);
  }
  lines.push('');
  lines.push('输出 JSON：');
  return lines.join('\n');
}

/**
 * 从模型回复里抽出 JSON。
 * 处理三种常见脏输出：markdown 代码块、前后废话、尾逗号。
 * @returns {object|null} 解析失败返回 null
 */
export function extractPlanJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // 剥 markdown 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();

  // 从第一个 { 到最后一个 }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);

  // 去尾逗号（模型很爱留）
  s = s.replace(/,(\s*[}\]])/g, '$1');

  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 拆解器主体。
 * @param {object} deps { magpie, model, timeoutMs }
 */
export function createPlanner({ magpie, model = null, timeoutMs = 120_000 } = {}) {
  if (!magpie) throw new Error('createPlanner 需要 magpie 客户端');

  /** 调网关的 chat completions。零依赖，Node 内置 fetch。 */
  async function callLlm(messages, opts = {}) {
    const body = {
      model: opts.model ?? model ?? magpie.pickDefaultModel() ?? 'group/smart-split',
      messages,
      temperature: opts.temperature ?? 0.2,
      stream: false,
    };
    const url = `${magpie.gateway}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`网关返回 ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('网关返回里没有 message.content');
    return content;
  }

  /**
   * 拆一个任务。
   * @returns {Promise<{ok:boolean, plan?:object, needsReview:boolean, reasons:string[],
   *                    raw?:string, error?:string, attempts:number}>}
   */
  async function plan(task, ctx = {}) {
    const userPrompt = buildPlannerPrompt(task, ctx);
    const messages = [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: userPrompt },
    ];

    let lastRaw = null;
    let lastError = null;

    // 两次机会：第一次失败时把解析错误告诉它，通常第二次就对了
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const msgs = attempt === 1
          ? messages
          : [...messages,
             { role: 'assistant', content: lastRaw ?? '' },
             { role: 'user', content: `上面这段不是合法 JSON（${lastError}）。只输出 JSON，不要任何其他文字。` }];

        const raw = await callLlm(msgs);
        lastRaw = raw;
        const parsed = extractPlanJson(raw);

        if (!parsed) {
          lastError = '无法解析出 JSON';
          log.warn(`拆解第 ${attempt} 次：JSON 解析失败`);
          continue;
        }

        const assess = assessPlan(parsed);
        log.info(`拆解成功：kind=${parsed.kind} 子任务=${parsed.tasks?.length ?? 0} ` +
          `需人审=${assess.needsReview}${assess.reasons.length ? `（${assess.reasons[0]}）` : ''}`);

        return {
          ok: true,
          plan: parsed,
          needsReview: assess.needsReview,
          reasons: assess.reasons,
          raw,
          attempts: attempt,
        };
      } catch (err) {
        lastError = err.message;
        log.warn(`拆解第 ${attempt} 次失败: ${err.message}`);
      }
    }

    // 两次都失败：不抛错，返回可处理的结果。
    // 拆解在任务开头，失败只是慢一点，不该让整个任务白做（DESIGN.md 3.4）。
    return {
      ok: false,
      needsReview: true,
      reasons: [`拆解失败：${lastError}`],
      raw: lastRaw,
      error: lastError,
      attempts: 2,
    };
  }

  return { plan, callLlm, model };
}
