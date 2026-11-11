// rules.json 加载 + 匹配 + 热加载。
// 规则顺序有意义：从上往下，第一条命中即止。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLogger } from './util.mjs';

const log = createLogger('rules');

/** 校验一条规则，返回错误字符串数组。 */
export function validateRule(rule, idx) {
  const errs = [];
  const where = `rules[${idx}]${rule?.id ? `(${rule.id})` : ''}`;
  if (!rule || typeof rule !== 'object') {
    return [`${where}: 不是对象`];
  }
  if (!rule.id) errs.push(`${where}: 缺少 id`);
  if (!rule.agent) errs.push(`${where}: 缺少 agent`);
  if (!rule.prompt) errs.push(`${where}: 缺少 prompt`);
  if (rule.match && typeof rule.match !== 'object') errs.push(`${where}: match 必须是对象`);
  if (rule.approval && !['before', 'after', 'review', 'never'].includes(rule.approval)) {
    errs.push(`${where}: approval 只能是 before/after/review/never，当前 ${rule.approval}`);
  }
  if (rule.concurrency) {
    if (!rule.concurrency.key) errs.push(`${where}: concurrency 缺少 key`);
    if (!(Number(rule.concurrency.max) > 0)) errs.push(`${where}: concurrency.max 必须是正数`);
  }
  return errs;
}

/** 解析规则文件文本，返回 { rules, errors }。文件坏了抛错由调用方处理。 */
export function parseRules(text) {
  // 复用配置的宽松 JSON（注释 / 尾逗号）
  let data;
  const cleaned = text
    .replace(/^\uFEFF/, '')
    // 去掉字符串外的注释
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  data = JSON.parse(cleaned);
  const rules = Array.isArray(data) ? data : data?.rules;
  if (!Array.isArray(rules)) throw new Error('规则文件必须是数组，或 { "rules": [...] }');
  const errors = [];
  rules.forEach((r, i) => errors.push(...validateRule(r, i)));
  return { rules, errors };
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 匹配：rule.match 里每个 key 都要通过。
 * - 值为 "*"          → 任意（字段有没有都行）
 * - 值为空数组/未定义  → 不限制
 * - 值为数组          → 命中任一即可
 * - 值为字符串        → 精确匹配（subject 额外支持尾部 * 前缀匹配）
 */
export function matchEvent(rule, event) {
  const m = rule?.match;
  if (!m || Object.keys(m).length === 0) return true; // 空 match = catch-all
  for (const [key, expected] of Object.entries(m)) {
    const actual = event?.[key];
    if (expected === undefined || expected === null) continue;
    if (Array.isArray(expected)) {
      if (expected.length === 0) continue;
      if (!expected.some((e) => fieldMatches(key, e, actual))) return false;
      continue;
    }
    if (!fieldMatches(key, expected, actual)) return false;
  }
  return true;
}

function fieldMatches(key, expected, actual) {
  const exp = String(expected);
  if (exp === '*') return true;
  const act = actual === undefined || actual === null ? '' : String(actual);
  // subject 支持简单通配：`han_kl/*` 前缀匹配
  if (key === 'subject' && exp.endsWith('*')) {
    return act.startsWith(exp.slice(0, -1));
  }
  // 其他字段也宽容支持一次前缀通配，行为一致更好记
  if (exp.endsWith('*') && exp.indexOf('*') === exp.length - 1) {
    return act.startsWith(exp.slice(0, -1));
  }
  return act === exp;
}

/** 找到第一条命中的规则；都不中返回 null。 */
export function findRule(rules, event) {
  for (const rule of rules ?? []) {
    if (matchEvent(rule, event)) return rule;
  }
  return null;
}

/**
 * 规则持有器：按 mtime 热加载，坏了保留旧规则。
 * 用法：const rules = new RuleStore(path); rules.load(); rules.get(); rules.maybeReload();
 */
export class RuleStore {
  constructor(rulesPath) {
    this.rulesPath = rulesPath;
    this.rules = [];
    this.mtimeMs = 0;
    this.hash = null;
    this.error = null;
    this.loadedAt = null;
    this.parsedOnce = false;
  }

  /** 强制读一次。返回 { ok, rules, error }。坏文件不会清空已有规则。 */
  load() {
    let text;
    let stat;
    try {
      stat = fs.statSync(this.rulesPath);
      text = fs.readFileSync(this.rulesPath, 'utf8');
    } catch (err) {
      // 文件不存在：给空规则，标注错误（doctor 会报）
      if (!this.parsedOnce) {
        this.rules = [];
        this.parsedOnce = true;
      }
      this.error = `读取失败: ${err.message}`;
      return { ok: false, rules: this.rules, error: this.error };
    }
    const hash = hashText(text);
    if (this.parsedOnce && hash === this.hash) {
      this.mtimeMs = stat.mtimeMs;
      return { ok: !this.error, rules: this.rules, error: this.error, unchanged: true };
    }
    try {
      const { rules, errors } = parseRules(text);
      this.rules = rules;
      this.hash = hash;
      this.mtimeMs = stat.mtimeMs;
      this.loadedAt = new Date().toISOString();
      this.parsedOnce = true;
      this.error = errors.length ? errors.join('; ') : null;
      if (errors.length) log.warn(`规则文件有 ${errors.length} 处问题（已加载但可能行为异常）: ${errors[0]}`);
      return { ok: errors.length === 0, rules, error: this.error, errors };
    } catch (err) {
      // 解析失败：保留旧规则，只记错误
      this.error = `解析失败: ${err.message}`;
      this.mtimeMs = stat.mtimeMs;
      log.error(`规则文件坏了，继续用旧规则（${this.rules.length} 条）: ${err.message}`);
      return { ok: false, rules: this.rules, error: this.error };
    }
  }

  /** mtime 变化才重读；tick 里调用，开销是一次 statSync。 */
  maybeReload() {
    let stat;
    try {
      stat = fs.statSync(this.rulesPath);
    } catch {
      return { reloaded: false };
    }
    if (stat.mtimeMs === this.mtimeMs && this.parsedOnce) return { reloaded: false };
    const res = this.load();
    log.info(`规则热加载: ${this.rules.length} 条${res.error ? `（${res.error}）` : ''}`);
    return { reloaded: true, ...res };
  }

  get() {
    return this.rules;
  }

  /** 按 id 查一条规则（CLI / 审批回流用）。 */
  byId(id) {
    return this.rules.find((r) => r.id === id) ?? null;
  }

  summary() {
    return this.rules.map((r) => ({
      id: r.id,
      agent: r.agent,
      approval: r.approval ?? 'never',
      match: r.match ?? {},
      concurrency: r.concurrency ?? null,
    }));
  }
}
