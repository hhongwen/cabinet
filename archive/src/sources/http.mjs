// HTTP 事件源：把「POST /api/events」的收单逻辑从 hub 里拆出来，
// 这样 hub 只负责路由，事件格式校验/鉴权集中在一处。
import crypto from 'node:crypto';
import { nowIso } from '../util.mjs';

/**
 * 校验 Authorization: Bearer <token>。
 * token 为空时全部放行（本机默认绑定 127.0.0.1，够安全）。
 */
export function checkToken(cfg, req) {
  const expected = cfg?.httpToken ?? cfg?.sources?.http?.token ?? null;
  if (!expected) return true;
  const header = req.headers?.authorization ?? req.headers?.Authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!m) return false;
  const got = m[1].trim();
  // 定长比较，避免时序泄漏（本机工具其实无所谓，但便宜）
  const a = Buffer.from(got);
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 校验事件必填字段。返回错误字符串或 null。 */
export function validateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body 必须是 JSON 对象';
  if (!body.source) return '缺少 source';
  if (!body.type) return '缺少 type';
  if (body.payload !== undefined && body.payload !== null && typeof body.payload !== 'object') {
    return 'payload 必须是对象或 null';
  }
  return null;
}

/** 把 HTTP body 规整成内部事件信封。 */
export function normalizeEvent(body) {
  return {
    source: String(body.source),
    type: String(body.type),
    subject: body.subject == null ? null : String(body.subject),
    summary: body.summary == null ? null : String(body.summary),
    link: body.link == null ? null : String(body.link),
    payload: body.payload ?? null,
    dedupe_key: body.dedupeKey ?? body.dedupe_key ?? null,
    received_at: nowIso(),
  };
}

/**
 * 给 hub 用的收单函数。
 * @param {object} deps { cfg, queue }
 * @returns {(body:object)=>{ok:boolean, ...}}
 */
export function createHttpSource(deps) {
  const { cfg, queue } = deps;
  return {
    name: 'http',
    enabled: cfg?.sources?.http?.enabled !== false,
    checkToken: (req) => checkToken(cfg, req),
    accept(body) {
      const err = validateEvent(body);
      if (err) return { ok: false, error: err };
      const ev = normalizeEvent(body);
      const res = queue.ingest(ev);
      return { ok: true, ...res };
    },
  };
}
