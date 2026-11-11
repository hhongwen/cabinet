// 运行配置加载。配置里的路径统一在这里解析成绝对路径，下游模块不再处理 ~ 和 %VAR%。
import fs from 'node:fs';
import path from 'node:path';
import { expandVars, resolveConfigPath, ensureDir } from './util.mjs';

export const CABINET_ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_CONFIG_PATH = path.join(CABINET_ROOT, 'cabinet.config.json');

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  dbPath: '~/.cabinet/cabinet.db',
  logsDir: '~/.cabinet/logs',
  rulesPath: './rules.json',
  workers: 2,
  tickMs: 1000,
  defaultTimeoutMs: 15 * 60 * 1000,
  httpToken: null,
  sources: { cron: [], watch: [], http: { enabled: true } },
  notify: { panel: true, webhook: { url: null } },
  agents: {},
};

/**
 * 读配置。configPath 为空时用项目根的 cabinet.config.json。
 * 返回的对象带 `_meta`：{ configPath, baseDir, dbPath, logsDir, rulesPath } 全是绝对路径。
 */
export function loadConfig(configPath) {
  const abs = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_PATH;
  let raw = {};
  if (fs.existsSync(abs)) {
    const text = fs.readFileSync(abs, 'utf8');
    try {
      raw = JSON.parse(stripJsonComments(text));
    } catch (err) {
      throw new Error(`配置文件解析失败: ${abs}\n${err.message}`);
    }
  } else if (configPath) {
    throw new Error(`配置文件不存在: ${abs}`);
  }
  return normalizeConfig(raw, abs);
}

/** 去掉 // 和 /* *\/ 注释（strict JSON 不允许，但人编辑时有用）。字符串内的不处理。 */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // 允许尾逗号
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function normalizeConfig(raw, configPath) {
  const baseDir = configPath ? path.dirname(configPath) : CABINET_ROOT;
  const cfg = {
    ...DEFAULTS,
    ...raw,
    sources: { ...DEFAULTS.sources, ...(raw.sources ?? {}) },
    notify: { ...DEFAULTS.notify, ...(raw.notify ?? {}) },
    agents: { ...DEFAULTS.agents, ...(raw.agents ?? {}) },
  };
  const dbPath = resolveConfigPath(cfg.dbPath, baseDir);
  const logsDir = resolveConfigPath(cfg.logsDir, baseDir);
  const rulesPath = resolveConfigPath(cfg.rulesPath, baseDir);
  cfg._meta = { configPath, baseDir, dbPath, logsDir, rulesPath };
  cfg.workers = Number(cfg.workers) > 0 ? Number(cfg.workers) : 1;
  return cfg;
}

/** 建好 logs 目录 / db 父目录，返回路径。 */
export function prepareDirs(cfg) {
  ensureDir(cfg._meta.logsDir);
  ensureDir(path.dirname(cfg._meta.dbPath));
  return cfg._meta;
}

/** 把 agent 的 args 里的占位符变量先做一次环境展开（%APPDATA% 等）。 */
export function expandAgentArgs(agents) {
  const out = {};
  for (const [name, agent] of Object.entries(agents ?? {})) {
    out[name] = {
      ...agent,
      command: agent.command ? expandVars(agent.command) : agent.command,
      args: Array.isArray(agent.args) ? agent.args.map((a) => expandVars(a)) : [],
    };
  }
  return out;
}
