import type { Context } from 'hono';
import { ipKey, isPrivate, parseIp } from '../shared/ip';
import { effectiveMode } from '../shared/schedule';
import type { Env } from './env';
import { hostAllowed, modeState, siteByKey } from './sites';
import { MAX_BODY_BYTES, parseBeacon } from './validate';

const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** IP luôn lấy từ kết nối. Không đọc IP từ dữ liệu script gửi lên, nên không ai "đổ tội" được IP của người khác. */
function clientIp(c: Context<{ Bindings: Env }>): string | null {
  if (c.env.DEV === '1') {
    // Chỉ khi chạy wrangler dev: cho phép giả lập IP để kiểm thử.
    const fwd = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return c.req.header('CF-Connecting-IP') ?? null;
}

function defer(c: Context<{ Bindings: Env }>, p: Promise<unknown>): Promise<unknown> | void {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    return p; // không có ExecutionContext (kiểm thử) → chờ trực tiếp
  }
}

export async function handleCollect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > MAX_BODY_BYTES) return c.body(null, 413);
  const beacon = parseBeacon(await c.req.text());
  if (!beacon) return c.body(null, 400);

  const site = await siteByKey(c.env.DB, beacon.s);
  if (!site) return c.body(null, 404);

  const origin = c.req.header('Origin');
  const host = hostOf(origin && origin !== 'null' ? origin : c.req.header('Referer'));
  if (!hostAllowed(site, host)) return c.body(null, 403);

  const now = Date.now();
  // Site đang tắt, ngoài lịch, hoặc mọi chiến dịch tạm dừng → không ghi gì.
  if (effectiveMode(modeState(site), now) === 'off') return c.body(null, 204);

  const parsed = parseIp(clientIp(c));
  if (!parsed || (isPrivate(parsed) && c.env.DEV !== '1')) return c.body(null, 204);

  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf;
  const db = c.env.DB;
  let write: Promise<unknown>;

  if (beacon.e === 'load') {
    write = db
      .prepare(
        `INSERT OR IGNORE INTO visits
          (pageview_id, site_id, visitor_id, fp_hash, gclid, gbraid, wbraid, ip, ip_key, ip_version,
           asn, as_org, country, city, user_agent, path, referrer_host, bot_webdriver, bot_headless, started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        beacon.p, site.id, beacon.v, beacon.fp, beacon.g, beacon.gb, beacon.wb,
        parsed.ip, ipKey(parsed), parsed.version,
        typeof cf?.asn === 'number' ? cf.asn : null,
        typeof cf?.asOrganization === 'string' ? cf.asOrganization : null,
        typeof cf?.country === 'string' ? cf.country : null,
        typeof cf?.city === 'string' ? cf.city : null,
        (c.req.header('User-Agent') ?? '').slice(0, 300),
        beacon.u, beacon.r, beacon.wd ? 1 : 0, beacon.hl ? 1 : 0, now,
      )
      .run();
  } else if (beacon.e === 'end') {
    // Nhiều beacon "end" cho cùng một lượt (ẩn/hiện tab) → giữ giá trị lớn nhất.
    write = db
      .prepare(
        `UPDATE visits SET ended_at = ?, dwell_ms = MAX(COALESCE(dwell_ms, 0), ?), scroll_pct = MAX(COALESCE(scroll_pct, 0), ?),
           interactions = MAX(COALESCE(interactions, 0), ?),
           first_interaction_ms = CASE WHEN first_interaction_ms IS NULL OR first_interaction_ms < 0 THEN ? ELSE first_interaction_ms END
         WHERE pageview_id = ? AND site_id = ? AND visitor_id = ?`,
      )
      .bind(now, beacon.t, beacon.sc, beacon.it, beacon.ft, beacon.p, site.id, beacon.v)
      .run();
  } else {
    write = db
      .prepare(
        `INSERT INTO conversions (site_id, pageview_id, visitor_id, type, client_ok, ip_key, at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM visits WHERE pageview_id = ? AND visitor_id = ?)`,
      )
      .bind(site.id, beacon.p, beacon.v, beacon.ct, beacon.ok ? 1 : 0, ipKey(parsed), now, beacon.p, beacon.v)
      .run();
  }

  const pending = defer(c, write);
  if (pending) await pending;
  return c.body(null, 204);
}
