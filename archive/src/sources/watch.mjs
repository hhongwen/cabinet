// 文件变化源。用 fs.watch({recursive:true})，Windows 和 macOS 原生支持。
// 带 debounce：编辑器保存会连发好几个事件，合并成一个。
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, newId, nowIso, matchAnyGlob, ensureDir } from '../util.mjs';

const log = createLogger('watch');

/**
 * @param {object} cfg 完整配置
 * @param {(ev:object)=>void} emit 投递回调
 */
export function createWatchSource(cfg, emit) {
  const defs = Array.isArray(cfg?.sources?.watch) ? cfg.sources.watch : [];
  const watchers = [];
  const debounceMs = Number(cfg?.sources?.watchDebounceMs ?? 1500);
  const pending = new Map(); // key -> timer

  /** 忽略了就返回 true。 */
  function ignored(relPath, ignorePatterns) {
    const norm = relPath.split(path.sep).join('/');
    if (matchAnyGlob(norm, ignorePatterns)) return true;
    // 硬编码兜底：版本库和依赖目录永远忽略
    if (/(^|\/)(\.git|node_modules|\.obsidian|\.trash)(\/|$)/.test(norm)) return true;
    return false;
  }

  function emitDebounced(subject, relPath, type) {
    const key = `${subject}::${relPath}::${type}`;
    // debounce 窗口内的连续写只发一条。这里不做跨窗口的长时间抑制：
    // 「同一个文件还在处理中」交给 queue 的 dedupe_key 去合并，
    // watch 层再压一次会把 t+2s 的真实改动吞掉。
    if (pending.has(key)) clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        try {
          emit({
            id: newId('evt'),
            source: 'watch',
            type,
            subject,
            summary: `${relPath} ${type === 'file.created' ? '新增' : '变化'}`,
            link: null,
            payload: { path: relPath, subject },
            // 去重键只到「文件 + 类型」，不带到毫秒时间，避免同一文件抖动堆一堆
            dedupe_key: `watch|${subject}|${relPath}|${type}`,
            received_at: nowIso(),
          });
        } catch (err) {
          log.error(`投递失败: ${err.message}`);
        }
      }, debounceMs),
    );
  }

  function startDef(def) {
    const subject = def.subject ?? def.name ?? 'watch';
    const target = def.path;
    if (!target) {
      log.warn(`watch 项 ${subject} 缺少 path，跳过`);
      return;
    }
    if (!fs.existsSync(target)) {
      // 目录不存在时兜底建一个，避免监控直接失效
      try {
        ensureDir(target);
        log.warn(`watch 目录不存在，已创建: ${target}`);
      } catch (err) {
        log.error(`watch 目录不可用 ${target}: ${err.message}`);
        return;
      }
    }
    const ignore = Array.isArray(def.ignore) ? def.ignore : [];
    try {
      const w = fs.watch(target, { recursive: true, persistent: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join('/');
        if (ignored(rel, ignore)) return;
        const abs = path.join(target, rel);
        let isFile = true;
        try {
          isFile = fs.statSync(abs).isFile();
        } catch {
          // 文件被删/改名：stat 失败就跳过
          return;
        }
        if (!isFile) return;
        const type = eventType === 'rename' ? 'file.created' : 'file.changed';
        emitDebounced(subject, rel, type);
      });
      w.on('error', (err) => log.error(`watch 出错 ${target}: ${err.message}`));
      watchers.push(w);
      log.info(`watch 启动：${subject} ← ${target} (ignore: ${ignore.join(', ') || '无'})`);
    } catch (err) {
      log.error(`watch 启动失败 ${target}: ${err.message}`);
    }
  }

  return {
    name: 'watch',
    start() {
      for (const def of defs) startDef(def);
      if (defs.length === 0) log.info('watch 未配置任何目录');
    },
    stop() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      watchers.length = 0;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    _ignore: ignored,
  };
}
