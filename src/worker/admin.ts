/**
 * API quản trị (JSON), bảo vệ bằng ADMIN_TOKEN. Dashboard ở giai đoạn sau sẽ gọi các endpoint này.
 */
import { Hono } from 'hono';
import { canonicalCidr } from '../shared/ip';
import type { Env } from './env';
import { clearSiteCache, toSite, type SiteRow } from './sites';

type App = { Bindings: Env };
export const admin = new Hono<App>();

const DAY = 86_400_000;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const SITE_ID = /^[a-z0-9-]{2,40}$/;
const MODES = new Set(['off', 'log', 'suggest', 'auto']);
const LEAD_STATUSES = new Set(['new', 'real', 'unreachable', 'fake', 'competitor', 'signed']);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

admin.use('*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN chưa được đặt' }, 503);
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

admin.get('/sites', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM sites ORDER BY id').all<SiteRow>();
  return c.json(results.map(toSite));
});

/** Tạo hoặc cập nhật một site. Thêm domain mới = một lệnh PUT. */
admin.put('/sites/:id', async (c) => {
  const id = c.req.param('id');
  if (!SITE_ID.test(id)) return c.json({ error: 'id chỉ gồm a-z, 0-9, dấu gạch (2–40 ký tự)' }, 400);
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!b) return c.json({ error: 'JSON không hợp lệ' }, 400);

  const domains = b.domains;
  if (typeof b.name !== 'string' || !b.name) return c.json({ error: 'thiếu name' }, 400);
  if (typeof b.site_key !== 'string' || !KEY.test(b.site_key)) return c.json({ error: 'site_key: 8–64 ký tự A-Z a-z 0-9 _ -' }, 400);
  if (!Array.isArray(domains) || domains.length === 0 || !domains.every((d) => typeof d === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) {
    return c.json({ error: 'domains phải là mảng tên miền' }, 400);
  }
  const mode = (b.mode as string | undefined) ?? 'log';
  if (!MODES.has(mode)) return c.json({ error: 'mode: off | log | suggest | auto' }, 400);
  const cid = b.ads_customer_id == null ? null : String(b.ads_customer_id).replace(/-/g, '');
  if (cid !== null && !/^\d{10}$/.test(cid)) return c.json({ error: 'ads_customer_id: 10 chữ số' }, 400);
  const campaignIds = Array.isArray(b.campaign_ids) ? b.campaign_ids.map(String) : null;
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO sites (id, name, site_key, domains, ads_customer_id, campaign_ids, mode, schedule, follow_campaigns,
        resume_warmup_hours, target_countries, watch_threshold, block_threshold, share_group, telegram_chat_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, site_key = excluded.site_key, domains = excluded.domains,
        ads_customer_id = excluded.ads_customer_id, campaign_ids = excluded.campaign_ids, mode = excluded.mode,
        schedule = excluded.schedule, follow_campaigns = excluded.follow_campaigns,
        resume_warmup_hours = excluded.resume_warmup_hours, target_countries = excluded.target_countries,
        watch_threshold = excluded.watch_threshold, block_threshold = excluded.block_threshold,
        share_group = excluded.share_group, telegram_chat_id = excluded.telegram_chat_id, updated_at = excluded.updated_at`,
  ).bind(
    id, b.name, b.site_key, JSON.stringify(domains.map((d: string) => d.toLowerCase())), cid,
    campaignIds ? JSON.stringify(campaignIds) : null, mode,
    b.schedule ? JSON.stringify(b.schedule) : null,
    b.follow_campaigns === false ? 0 : 1,
    Number(b.resume_warmup_hours ?? 72),
    JSON.stringify(Array.isArray(b.target_countries) ? b.target_countries : ['VN']),
    Number(b.watch_threshold ?? 40), Number(b.block_threshold ?? 70),
    typeof b.share_group === 'string' && b.share_group ? b.share_group : null,
    b.telegram_chat_id == null ? null : String(b.telegram_chat_id),
    now, now,
  ).run();
  clearSiteCache();
  const row = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<SiteRow>();
  return c.json(row ? toSite(row) : null);
});

/** Tổng quan một site trong N ngày: lượt, kết luận, lý do hay gặp, click tính tiền mà không vào trang. */
admin.get('/sites/:id/summary', async (c) => {
  const id = c.req.param('id');
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7)));
  const since = Date.now() - days * DAY;
  const sinceDate = new Date(since + 7 * 3600_000).toISOString().slice(0, 10);
  const db = c.env.DB;
  const [verdicts, convs, blocks, reasons, billed] = await db.batch([
    db.prepare(`SELECT COALESCE(verdict, 'pending') AS verdict, COUNT(*) AS n FROM visits WHERE site_id = ? AND started_at >= ? GROUP BY 1`).bind(id, since),
    db.prepare(`SELECT type, client_ok, COUNT(*) AS n FROM conversions WHERE site_id = ? AND at >= ? GROUP BY 1, 2`).bind(id, since),
    db.prepare(`SELECT status, COUNT(*) AS n FROM blocks WHERE site_id = ? GROUP BY 1`).bind(id),
    db.prepare(`SELECT reasons FROM visits WHERE site_id = ? AND started_at >= ? AND verdict IN ('watch','block') LIMIT 2000`).bind(id, since),
    db.prepare(
      `SELECT COUNT(*) AS billed, SUM(CASE WHEN v.pageview_id IS NULL THEN 1 ELSE 0 END) AS without_visit
       FROM ad_clicks a LEFT JOIN visits v ON v.gclid = a.gclid WHERE a.site_id = ? AND a.date >= ?`,
    ).bind(id, sinceDate),
  ]);
  const reasonCount: Record<string, number> = {};
  for (const r of (reasons?.results ?? []) as Array<{ reasons: string | null }>) {
    for (const x of JSON.parse(r.reasons ?? '[]') as Array<{ code: string }>) reasonCount[x.code] = (reasonCount[x.code] ?? 0) + 1;
  }
  return c.json({
    site_id: id,
    days,
    visits_by_verdict: verdicts?.results ?? [],
    conversions: convs?.results ?? [],
    blocks_by_status: blocks?.results ?? [],
    top_reasons: Object.entries(reasonCount).sort((a, b) => b[1] - a[1]),
    billed_clicks: (billed?.results ?? [])[0] ?? null,
  });
});

admin.get('/sites/:id/visits', async (c) => {
  const verdict = c.req.query('verdict');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const sql = `SELECT pageview_id, visitor_id, gclid, ip, asn, as_org, country, city, path, started_at, dwell_ms, scroll_pct,
                      interactions, score, verdict, reasons
               FROM visits WHERE site_id = ?${verdict ? ' AND verdict = ?' : ''} ORDER BY started_at DESC LIMIT ?`;
  const stmt = verdict
    ? c.env.DB.prepare(sql).bind(c.req.param('id'), verdict, limit)
    : c.env.DB.prepare(sql).bind(c.req.param('id'), limit);
  const { results } = await stmt.all();
  return c.json(results);
});

admin.get('/sites/:id/blocks', async (c) => {
  const status = c.req.query('status');
  const sql = `SELECT * FROM blocks WHERE site_id = ?${status ? ' AND status = ?' : ''} ORDER BY updated_at DESC LIMIT 1000`;
  const stmt = status ? c.env.DB.prepare(sql).bind(c.req.param('id'), status) : c.env.DB.prepare(sql).bind(c.req.param('id'));
  const { results } = await stmt.all();
  return c.json(results);
});

/** Chế độ gợi ý: danh sách IP dạng văn bản, mỗi dòng một IP, để dán vào mục "Loại trừ IP" của Google Ads. */
admin.get('/sites/:id/blocks/export', async (c) => {
  const status = c.req.query('status') ?? 'suggested';
  const { results } = await c.env.DB.prepare(`SELECT ip_key FROM blocks WHERE site_id = ? AND status = ? ORDER BY score DESC, updated_at DESC LIMIT 500`)
    .bind(c.req.param('id'), status)
    .all<{ ip_key: string }>();
  return c.text(results.map((r) => r.ip_key).join('\n'));
});

/** Gỡ chặn tay (lần sau không tự chặn lại), tùy chọn đưa vào whitelist. */
admin.post('/sites/:id/blocks/remove', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<{ ip_key?: string; whitelist?: boolean; note?: string }>().catch(() => null);
  if (!b?.ip_key) return c.json({ error: 'thiếu ip_key' }, 400);
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(`UPDATE blocks SET status = 'removed', updated_at = ? WHERE site_id = ? AND ip_key = ?`).bind(now, id, b.ip_key),
    c.env.DB.prepare('UPDATE sites SET blocks_dirty = 1 WHERE id = ?').bind(id),
  ];
  if (b.whitelist) {
    stmts.push(
      c.env.DB.prepare(`INSERT INTO whitelist (site_id, kind, value, note, expires_at, created_at) VALUES (?, 'ip', ?, ?, NULL, ?)`)
        .bind(id, b.ip_key, b.note ?? 'gỡ chặn tay', now),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

admin.post('/whitelist', async (c) => {
  const b = await c.req.json<{ site_id?: string | null; kind?: string; value?: string; note?: string; days?: number }>().catch(() => null);
  if (!b || (b.kind !== 'ip' && b.kind !== 'device') || !b.value) return c.json({ error: 'cần kind (ip|device) và value' }, 400);
  const value = b.kind === 'ip' ? canonicalCidr(b.value) : b.value;
  if (!value) return c.json({ error: 'IP hoặc CIDR không hợp lệ' }, 400);
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO whitelist (site_id, kind, value, note, expires_at, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(b.site_id ?? null, b.kind, value, b.note ?? null, b.days ? now + b.days * DAY : null, now)
    .run();
  return c.json({ ok: true, value });
});

/** Trạng thái lead từ Google Sheet (Apps Script gọi khi sale đổi trạng thái). */
admin.post('/leads', async (c) => {
  const b = await c.req.json<{ site_id?: string; gclid?: string; visitor_id?: string; status?: string; note?: string }>().catch(() => null);
  if (!b?.site_id || !b.status || !LEAD_STATUSES.has(b.status) || (!b.gclid && !b.visitor_id)) {
    return c.json({ error: 'cần site_id, status hợp lệ, và gclid hoặc visitor_id' }, 400);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO leads (site_id, gclid, visitor_id, status, note, updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(b.site_id, b.gclid ?? null, b.visitor_id ?? null, b.status, b.note ?? null, now),
    // Chấm lại các lượt liên quan ở vòng cron kế tiếp.
    c.env.DB.prepare(`UPDATE visits SET scored_at = NULL WHERE site_id = ? AND (gclid = ? OR visitor_id = ?) AND started_at > ?`)
      .bind(b.site_id, b.gclid ?? '', b.visitor_id ?? '', now - 30 * DAY),
  ]);
  return c.json({ ok: true });
});

/** Hồ sơ xin hoàn tiền: click Google đã tính tiền mà hệ thống đánh giá là gian lận, dạng CSV. */
admin.get('/sites/:id/refund-report', async (c) => {
  const from = c.req.query('from') ?? new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT a.date, a.gclid, a.campaign_id, a.keyword, v.ip, v.as_org, v.country, v.score, v.reasons, v.started_at
     FROM ad_clicks a JOIN visits v ON v.gclid = a.gclid
     WHERE a.site_id = ? AND a.date BETWEEN ? AND ? AND v.verdict = 'block' ORDER BY a.date`,
  ).bind(c.req.param('id'), from, to).all<Record<string, unknown>>();
  const cols = ['date', 'gclid', 'campaign_id', 'keyword', 'ip', 'as_org', 'country', 'score', 'reasons', 'started_at'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...results.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8' });
});
