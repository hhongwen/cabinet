// agent.mjs —— Turn 运行器
//
// 职责边界：
//   core    —— 数据（Session / Turn / 状态）
//   opencode-agent.mjs —— CLI 怎么跑、JSONL 怎么解析
//   agent.mjs —— 这一轮从 queued 到终态的生命周期、串行、超时、事件落盘、恢复
//
// 这里不判断任务做完了没有。Turn completed 只是「这一轮 Agent 停了」，
// 任务是否验收通过仍然是人点的那一下。

import fs from 'node:fs';
import path from 'node:path';

import { createOpenCodeAdapter } from './opencode-agent.mjs';

const DEFAULT_TIMEOUT = 30 * 60 * 1000;

function timeoutFromEnv() {
  const n = Number(process.env.AGENT_TURN_TIMEOUT_MS || 0);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT;
}

function tail(s, n = 400) {
  const t = String(s || '');
  return t.length > n ? t.slice(-n) : t;
}

export function createAgentRunner(opts = {}) {
  const core = opts.core;
  if (!core) throw new Error('createAgentRunner 需要 core');
  const dataDir = opts.dataDir || core.dataDir;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeoutFromEnv();
  const adapters = Array.isArray(opts.adapters) && opts.adapters.length
    ? opts.adapters
    : [createOpenCodeAdapter()];

  // turnId -> { turnId, sessionId, controller, timedOut, done }
  const running = new Map();

  function adapterFor(agent) {
    return adapters.find((a) => a.kind === agent) || null;
  }

  function ensureDir(dir) {
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('不是目录');
    } catch {
      throw new Error('工作目录不存在: ' + dir);
    }
  }

  function start({ sessionId, text }) {
    const session = core.getSession(sessionId);
    if (!session) throw new Error('会话不存在: ' + sessionId);
    const clean = String(text || '').trim();
    if (!clean) throw new Error('说点什么再发送');
    ensureDir(session.working_directory);

    const adapter = adapterFor(session.agent);
    if (!adapter) throw new Error('这个 Agent 还没有接入: ' + session.agent);

    const turn = core.startTurn(sessionId, clean);
    const eventsFile = path.join('sessions', turn.id + '.jsonl');
    const eventsAbs = path.join(dataDir, eventsFile);
    let stream = null;
    try {
      fs.mkdirSync(path.dirname(eventsAbs), { recursive: true });
      stream = fs.createWriteStream(eventsAbs, { flags: 'a' });
    } catch (e) {
      const failed = core.finishTurn(turn.id, {
        status: 'failed', error: '事件文件写不了：' + String(e.message || e)
      });
      return { turn: failed, done: Promise.resolve(failed) };
    }

    const controller = new AbortController();
    const entry = {
      turnId: turn.id,
      sessionId,
      controller,
      timedOut: false,
      done: null
    };
    running.set(turn.id, entry);

    // 超时/中断后子进程可能还会吐最后几行。流已经 end 了再 write 会异步
    // 抛 ERR_STREAM_WRITE_AFTER_END —— 不挂 error 监听会直接把进程带走。
    let streamClosed = false;
    stream.on('error', (e) => {
      console.warn('[task-inbox] 事件文件写入失败：' + e.message);
    });

    let stderrText = '';
    const onEvent = (ev) => {
      if (streamClosed) return;
      try { stream.write(JSON.stringify(ev) + '\n'); } catch { /* 文件已关，不阻断执行 */ }
      if (ev && ev.type === 'stderr' && ev.text) stderrText += ev.text + '\n';
      // 第一个 step_start 就带 messageID。先写进去，重启后核对才能对回这一轮。
      if (ev && ev.type === 'step_start' && ev.part && ev.part.messageID) {
        try {
          core.markTurnRunning(turn.id, { externalRef: ev.part.messageID, eventsFile });
        } catch { /* 状态已经被别的路径改掉，不阻断本轮 */ }
      }
    };

    const done = (async () => {
      let result = null;
      let thrown = null;
      let timer = null;
      let abortP = null;

      try {
        const available = await adapter.available();
        if (!available) throw new Error('Agent 不可用: ' + session.agent);

        const ensured = await adapter.ensureSession({ session });
        core.bindExternalSession(sessionId, ensured.externalSessionId);
        core.markTurnRunning(turn.id, { eventsFile });

        // 不要 unref：超时计时器本身就是「这一轮还在跑」的最后一个句柄。
        // unref 之后如果 Agent 是纯内存假实现（测试里就是这样），Node 会
        // 在计时器触发前直接退出，留下一个永远不结束的 await。
        timer = setTimeout(() => {
          entry.timedOut = true;
          controller.abort();
        }, timeoutMs);

        // 中断可能发生在 start() 返回之后、这里注册监听之前。已经 abort 的
        // signal 不会再触发 addEventListener，必须显式判一次，否则这一轮
        // 永远等不到结果（测试里「发完立刻停」就是这个时序）。
        abortP = new Promise((resolve) => {
          if (controller.signal.aborted) return resolve({ aborted: true });
          controller.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
        });

        result = controller.signal.aborted ? { aborted: true } : await Promise.race([
          adapter.runTurn({
            session: core.getSession(sessionId),
            text: clean,
            onEvent,
            signal: controller.signal
          }),
          abortP
        ]);
      } catch (e) {
        thrown = e;
      } finally {
        if (timer) clearTimeout(timer);
        streamClosed = true;
        await new Promise((resolve) => stream.end(resolve));
      }

      let status;
      let error = '';
      if (entry.timedOut) {
        status = 'failed';
        error = '执行超时（' + Math.max(1, Math.round(timeoutMs / 60000)) + ' 分钟）已中止';
      } else if (controller.signal.aborted) {
        status = 'interrupted';
        error = '已手动停止';
      } else if (thrown) {
        status = 'failed';
        error = String(thrown.message || thrown).slice(0, 1000);
      } else if (result && result.aborted) {
        status = 'interrupted';
        error = '已手动停止';
      } else if (!result || result.exitCode === null || result.exitCode === undefined) {
        status = 'failed';
        error = 'Agent 没有正常退出' + (stderrText ? '：' + tail(stderrText) : '');
      } else if (result.exitCode !== 0) {
        status = 'failed';
        error = 'Agent 退出码 ' + result.exitCode
          + (result.stderr || stderrText ? '：' + tail(result.stderr || stderrText) : '');
      } else if (result.finalReason === 'stop') {
        status = 'completed';
      } else if (result.finalReason === 'length') {
        status = 'completed';
        error = '模型输出达到长度上限，结果可能不完整';
      } else {
        status = 'unknown';
        error = '事件流不完整，执行结果待核对';
      }

      // 有 messageID 但没经过 step_start 的适配器：收尾前补一次，
      // 否则重启后这一轮没有 external_ref 可核对。
      if (result && result.externalRef) {
        const t = core.getTurn(turn.id);
        if (t && !t.external_ref) {
          try { core.markTurnRunning(turn.id, { externalRef: result.externalRef, eventsFile }); } catch { /* 已结束 */ }
        }
      }

      try {
        core.finishTurn(turn.id, {
          status,
          resultText: result ? result.resultText : '',
          error,
          exitCode: result ? result.exitCode : null
        });
      } finally {
        running.delete(turn.id);
      }
      return core.getTurn(turn.id);
    })();

    entry.done = done;
    return { turn, done };
  }

  function state(sessionId) {
    const session = core.getSession(sessionId);
    if (!session) return null;
    const entry = [...running.values()].find((e) => e.sessionId === sessionId);
    const runningTurn = entry ? core.getTurn(entry.turnId) : core.openTurn(sessionId);
    return {
      session,
      turns: core.listTurns(sessionId, 20),
      running: runningTurn || null
    };
  }

  /**
   * 重启后用外部导出核对。只有导出明确说「这条 messageID 已完成」才改
   * completed；导出失败 / 找不到这一轮，就保持 unknown，不猜。
   */
  async function reconcile(sessionId) {
    const session = core.getSession(sessionId);
    if (!session) return { error: '会话不存在: ' + sessionId };
    const adapter = adapterFor(session.agent);
    if (!adapter) return { session, error: '这个 Agent 还没有接入: ' + session.agent };

    let sum;
    try {
      sum = await adapter.exportSession({ session });
    } catch (e) {
      return { session, error: String(e.message || e) };
    }

    let changed = null;
    // 从最近一轮往前找：一次只核对最近一条 unknown，避免把更早的历史
    // 按导出结果批量改写（导出没有「第几轮」的概念，只能靠 messageID）。
    const turns = core.listTurns(sessionId, 50).slice().reverse();
    for (const t of turns) {
      if (t.status !== 'unknown' || !t.external_ref) continue;
      const msg = (sum.messages || []).find((m) => m.id === t.external_ref);
      if (msg && msg.completed) {
        changed = core.finishTurn(t.id, { status: 'completed', resultText: msg.text });
        break;
      }
      if (sum.outcome && sum.outcome !== 'succeeded' && sum.status !== 'busy') {
        changed = core.finishTurn(t.id, {
          status: 'failed', error: '外部会话结果：' + sum.outcome
        });
        break;
      }
    }

    if (!changed && ['idle', 'busy', 'unavailable', 'unknown'].includes(sum.status)) {
      core.setSessionStatus(sessionId, sum.status);
    }
    return { session: core.getSession(sessionId), turn: changed };
  }

  /**
   * 服务启动时调用。先把所有没结束的 Turn 收成 unknown（core 里做），
   * 再后台核对最多 20 个 unknown 会话 —— 不阻塞监听端口。
   */
  function recover(opts2 = {}) {
    const n = core.recoverOpenTurns();
    if (opts2.reconcile !== false) {
      const timer = setTimeout(() => {
        let rows = [];
        try {
          rows = core.conn().all(
            "SELECT id FROM agent_sessions WHERE status = 'unknown' ORDER BY updated_at DESC LIMIT 20"
          );
        } catch { /* 表还没建好时忽略 */ }
        for (const r of rows) reconcile(r.id).catch(() => { /* 单个失败不影响其他 */ });
      }, 0);
      if (timer.unref) timer.unref();
    }
    return n;
  }

  function interrupt(turnId) {
    const entry = running.get(turnId);
    if (entry) {
      entry.controller.abort();
      return core.getTurn(turnId);
    }
    const t = core.getTurn(turnId);
    if (t && (t.status === 'queued' || t.status === 'running')) {
      return core.finishTurn(turnId, {
        status: 'interrupted',
        error: 'Cabinet 未找到运行中的进程，已按中断记录'
      });
    }
    return t;
  }

  async function close() {
    const entries = [...running.values()];
    for (const e of entries) e.controller.abort();
    await Promise.allSettled(entries.filter((e) => e.done).map((e) => e.done));
    running.clear();
  }

  return {
    start,
    state,
    reconcile,
    recover,
    interrupt,
    close,
    get runningCount() { return running.size; }
  };
}
