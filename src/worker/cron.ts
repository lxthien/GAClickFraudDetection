/**
 * Vòng chạy mỗi 5 phút: chấm điểm lượt mới → gắn cờ / chặn → đồng bộ Google Ads → hết hạn lệnh chặn.
 * Việc hằng ngày (xóa log cũ, nhập click_view) chạy một lần lúc 3 giờ sáng giờ Việt Nam.
 *
 * Mọi truy vấn D1 được gom theo lô vì gói miễn phí giới hạn 50 lệnh gọi ra ngoài mỗi lần chạy.
 */
import { canonicalCidr, cidrContains, parseIp } from '../shared/ip';
import { classifyNetwork } from '../shared/networks';
import { type BlockPlan, planBlock } from '../shared/policy';
import { effectiveMode, type Mode, vnDate } from '../shared/schedule';
import { type LeadStatus, type ScoreResult, scoreVisit } from '../shared/scoring';
import { type Candidate, selectExclusions } from '../shared/selection';
import type { Env } from './env';
import { type AdsCreds, type CriterionOp, credsFromEnv, mutateCampaignCriteria, Q, search } from './googleads';
import { allSites, clearSiteCache, modeState, type Site } from './sites';
import { notify } from './telegram';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BATCH = 40;                 // 40 visitor_id + 40 fp_hash = 80 tham số, dưới giới hạn 100 của D1
const ADS_STATUS_EVERY = 30 * MIN;
const SYNC_AT_LEAST_EVERY = 6 * HOUR;

export interface VisitRow {
  pageview_id: string;
  site_id: string;
  visitor_id: string;
  fp_hash: string | null;
  gclid: string | null;
  ip: string;
  ip_key: string;
  asn: number | null;
  as_org: string | null;
  country: string | null;
  bot_webdriver: number;
  bot_headless: number;
  started_at: number;
  ended_at: number | null;
  dwell_ms: number | null;
  scroll_pct: number | null;
  interactions: number | null;
}

export interface SiteReport {
  id: string;
  mode: Mode;
  scored: number;
  flagged: number;
  synced?: { created: number; removed: number };
  error?: string;
}

export interface CronReport {
  sites: SiteReport[];
  daily: boolean;
}

export interface CronDeps {
  fetch?: typeof fetch;
}

export async function runScheduled(env: Env, now = Date.now(), deps: CronDeps = {}): Promise<CronReport> {
  const f = deps.fetch ?? fetch;
  const creds = credsFromEnv(env);
  const db = env.DB;
  const sites = await allSites(db);
  const report: CronReport = { sites: [], daily: false };

  for (const site of sites) {
    const r: SiteReport = { id: site.id, mode: 'off', scored: 0, flagged: 0 };
    report.sites.push(r);
    try {
      if (creds && site.ads_customer_id && site.follow_campaigns && site.mode !== 'off' &&
          (site.ads_checked_at === null || now - site.ads_checked_at >= ADS_STATUS_EVERY)) {
        await refreshAdsStatus(db, site, creds, now, f);
      }
      r.mode = effectiveMode(modeState(site), now);
      if (r.mode === 'off') continue;

      const { scored, flagged } = await scorePending(db, site, sites, r.mode, now);
      r.scored = scored;
      r.flagged = flagged;
      if (flagged > 0) {
        const action = r.mode === 'auto' ? 'đã đưa vào danh sách chặn' : 'được gợi ý chặn (chờ bạn duyệt)';
        await notify(env, site.telegram_chat_id, `[${site.name}] ${flagged} IP mới ${action}.`, f);
      }
    } catch (e) {
      r.error = (e as Error).message;
      console.error(`site ${site.id}:`, e);
    }
  }

  await expireBlocks(db, now);

  // Đồng bộ sau cùng, khi mọi site đã chấm xong (nhóm chia sẻ có thể vừa thêm IP cho site khác).
  if (creds) {
    const fresh = await allSites(db);
    for (const site of fresh) {
      const r = report.sites.find((x) => x.id === site.id);
      if (!r || r.mode !== 'auto' || !site.ads_customer_id) continue;
      if (!site.blocks_dirty && site.last_sync_at !== null && now - site.last_sync_at < SYNC_AT_LEAST_EVERY) continue;
      try {
        r.synced = await syncExclusions(db, site, creds, now, f);
      } catch (e) {
        r.error = (e as Error).message;
        console.error(`sync ${site.id}:`, e);
      }
    }
  }

  report.daily = await maybeDaily(env, sites, creds, now, f);
  clearSiteCache();
  return report;
}

// ---------------------------------------------------------------------------------------------
// Chấm điểm

export async function scorePending(db: D1Database, site: Site, sites: Site[], mode: Mode, now: number) {
  const { results: pending } = await db
    .prepare(
      `SELECT * FROM visits WHERE site_id = ? AND scored_at IS NULL
         AND ((ended_at IS NOT NULL AND ended_at < ?) OR started_at < ?)
       ORDER BY started_at LIMIT ?`,
    )
    .bind(site.id, now - MIN, now - 30 * MIN, BATCH)
    .all<VisitRow>();
  if (pending.length === 0) return { scored: 0, flagged: 0 };

  const vids = [...new Set(pending.map((v) => v.visitor_id))];
  const fps = [...new Set(pending.map((v) => v.fp_hash).filter((x): x is string => !!x))];
  const gclids = [...new Set(pending.map((v) => v.gclid).filter((x): x is string => !!x))].slice(0, 40);
  const since = Math.min(...pending.map((v) => v.started_at)) - DAY;
  const ph = (n: number) => Array(n).fill('?').join(',');

  const [related, convs, leads, wl] = await db.batch([
    db.prepare(
      `SELECT * FROM visits WHERE site_id = ? AND started_at > ?
         AND (visitor_id IN (${ph(vids.length)})${fps.length ? ` OR fp_hash IN (${ph(fps.length)})` : ''})`,
    ).bind(site.id, since, ...vids, ...fps),
    db.prepare(`SELECT visitor_id FROM conversions WHERE site_id = ? AND client_ok = 1 AND visitor_id IN (${ph(vids.length)})`)
      .bind(site.id, ...vids),
    db.prepare(
      `SELECT visitor_id, gclid, status FROM leads WHERE site_id = ?
         AND (visitor_id IN (${ph(vids.length)})${gclids.length ? ` OR gclid IN (${ph(gclids.length)})` : ''})
       ORDER BY updated_at`,
    ).bind(site.id, ...vids, ...gclids),
    db.prepare(`SELECT kind, value FROM whitelist WHERE (site_id IS NULL OR site_id = ?) AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(site.id, now),
  ]);

  const relatedRows = (related?.results ?? []) as VisitRow[];
  const converted = new Set(((convs?.results ?? []) as Array<{ visitor_id: string }>).map((c) => c.visitor_id));
  const leadByVisitor = new Map<string, LeadStatus>();
  const leadByGclid = new Map<string, LeadStatus>();
  for (const l of (leads?.results ?? []) as Array<{ visitor_id: string | null; gclid: string | null; status: LeadStatus }>) {
    if (l.visitor_id) leadByVisitor.set(l.visitor_id, l.status);
    if (l.gclid) leadByGclid.set(l.gclid, l.status);
  }
  const whitelist = (wl?.results ?? []) as Array<{ kind: 'ip' | 'device'; value: string }>;
  const wlDevices = new Set(whitelist.filter((w) => w.kind === 'device').map((w) => w.value));
  const wlIps = whitelist.filter((w) => w.kind === 'ip').map((w) => w.value);
  const ipWhitelisted = (ip: string) => {
    const p = parseIp(ip);
    return !!p && wlIps.some((c) => cidrContains(c, p));
  };

  const stmts: D1PreparedStatement[] = [];
  const plans = new Map<string, BlockPlan & { score: number; reasons: string; network: string; source: string }>();
  const exemptVisitors = new Map<string, string>(); // visitor_id → ip_key

  for (const v of pending) {
    // Cùng thiết bị = cùng visitor_id, hoặc cùng dấu vân tay VÀ cùng IP (dấu vân tay nhẹ trùng nhau nhiều giữa các iPhone).
    const sameDevice = relatedRows.filter(
      (r) => r.visitor_id === v.visitor_id || (!!v.fp_hash && r.fp_hash === v.fp_hash && r.ip_key === v.ip_key),
    );
    const recent = sameDevice.filter((r) => r.started_at <= v.started_at && r.started_at > v.started_at - DAY);
    const network = classifyNetwork(v.asn, v.as_org, v.country);
    const lead = leadByVisitor.get(v.visitor_id) ?? (v.gclid ? leadByGclid.get(v.gclid) : undefined) ?? null;

    const result: ScoreResult = scoreVisit(
      {
        visit: {
          botWebdriver: !!v.bot_webdriver,
          botHeadless: !!v.bot_headless,
          ended: v.ended_at !== null,
          dwellMs: v.dwell_ms,
          scrollPct: v.scroll_pct,
          interactions: v.interactions,
          country: v.country,
          startedAt: v.started_at,
        },
        network,
        targetCountries: site.targetCountries,
        device: {
          adClicks24h: Math.max(1, recent.length),
          distinctIps24h: new Set(recent.map((r) => r.ip_key)).size || 1,
        },
        outcome: { validConversion: converted.has(v.visitor_id), leadStatus: lead },
        now,
      },
      { watch: site.watch_threshold, block: site.block_threshold },
    );

    stmts.push(
      db.prepare('UPDATE visits SET scored_at = ?, score = ?, verdict = ?, reasons = ? WHERE pageview_id = ?')
        .bind(now, result.score, result.verdict, JSON.stringify(result.reasons), v.pageview_id),
    );

    if (result.verdict === 'exempt') {
      exemptVisitors.set(v.visitor_id, v.ip_key);
      continue;
    }
    if (mode !== 'suggest' && mode !== 'auto') continue;
    if (result.verdict !== 'block' || wlDevices.has(v.visitor_id)) continue;

    // Chặn IP của lượt này; nếu bằng chứng ở mức thiết bị thì chặn cả các IP khác thiết bị đó đã dùng.
    const deviceLevel = result.reasons.some((x) => ['AUTOMATION', 'REPEAT_CLICKS', 'DEVICE_MULTI_IP', 'LEAD_FAKE'].includes(x.code));
    const targets = deviceLevel ? [v, ...recent.filter((r) => r.pageview_id !== v.pageview_id)] : [v];
    for (const t of targets) {
      if (ipWhitelisted(t.ip)) continue;
      const parsed = parseIp(t.ip);
      if (!parsed) continue;
      const net = classifyNetwork(t.asn, t.as_org, t.country);
      const plan = planBlock(result, parsed, net);
      if (!plan) continue;
      const prev = plans.get(plan.ipKey);
      if (!prev || prev.score < result.score) {
        plans.set(plan.ipKey, { ...plan, score: result.score, reasons: JSON.stringify(result.reasons), network: net, source: v.pageview_id });
      }
    }
  }

  // Khách thật: miễn chặn thiết bị vĩnh viễn, IP 30 ngày; gỡ mọi lệnh chặn đang có trên IP đó.
  for (const [vid, key] of exemptVisitors) {
    stmts.push(
      db.prepare(
        `INSERT INTO whitelist (site_id, kind, value, note, expires_at, created_at)
         SELECT ?, 'device', ?, 'tự động: đã chuyển đổi', NULL, ?
         WHERE NOT EXISTS (SELECT 1 FROM whitelist WHERE site_id = ? AND kind = 'device' AND value = ?)`,
      ).bind(site.id, vid, now, site.id, vid),
      db.prepare(
        `INSERT INTO whitelist (site_id, kind, value, note, expires_at, created_at)
         SELECT ?, 'ip', ?, 'tự động: đã chuyển đổi', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM whitelist WHERE site_id = ? AND kind = 'ip' AND value = ?)`,
      ).bind(site.id, key, now + 30 * DAY, now, site.id, key),
      db.prepare(`UPDATE blocks SET status = 'removed', updated_at = ? WHERE site_id = ? AND ip_key = ? AND status IN ('active','suggested')`)
        .bind(now, site.id, key),
    );
    plans.delete(key);
  }

  // Áp dụng cho site này và các site cùng nhóm chia sẻ đang ở chế độ gợi ý / tự chặn.
  const targetsSites = sites.filter(
    (s) => s.id === site.id || (!!site.share_group && s.share_group === site.share_group && (s.mode === 'suggest' || s.mode === 'auto')),
  );
  for (const plan of plans.values()) {
    for (const s of targetsSites) {
      const status = (s.id === site.id ? mode : s.mode) === 'auto' ? 'active' : 'suggested';
      stmts.push(
        db.prepare(
          `INSERT INTO blocks (site_id, ip_key, zone, status, score, reasons, network, source_pageview, created_at, updated_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(site_id, ip_key) DO UPDATE SET
             status = CASE WHEN blocks.status = 'removed' THEN 'removed' ELSE excluded.status END,
             score = MAX(blocks.score, excluded.score),
             reasons = excluded.reasons, zone = excluded.zone, network = excluded.network,
             source_pageview = excluded.source_pageview, updated_at = excluded.updated_at,
             expires_at = CASE WHEN excluded.expires_at IS NULL OR blocks.expires_at IS NULL THEN NULL
                               ELSE MAX(blocks.expires_at, excluded.expires_at) END`,
        ).bind(
          s.id, plan.ipKey, plan.zone, status, plan.score, plan.reasons, plan.network,
          s.id === site.id ? plan.source : `${site.id}:${plan.source}`,
          now, now, plan.ttlMs === null ? null : now + plan.ttlMs,
        ),
      );
    }
  }
  if (plans.size > 0 || exemptVisitors.size > 0) {
    for (const s of targetsSites) stmts.push(db.prepare('UPDATE sites SET blocks_dirty = 1 WHERE id = ?').bind(s.id));
  }

  await db.batch(stmts);
  return { scored: pending.length, flagged: plans.size };
}

// ---------------------------------------------------------------------------------------------
// Hết hạn

export async function expireBlocks(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE blocks SET status = 'expired', updated_at = ? WHERE status IN ('active','suggested') AND expires_at IS NOT NULL AND expires_at < ?`)
      .bind(now, now),
    db.prepare(`UPDATE sites SET blocks_dirty = 1 WHERE id IN (SELECT DISTINCT site_id FROM blocks WHERE status IN ('expired','removed') AND pushed = 1)`),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Google Ads

async function refreshAdsStatus(db: D1Database, site: Site, creds: AdsCreds, now: number, f: typeof fetch) {
  const rows = await search<{ campaign?: { id?: string } }>(creds, site.ads_customer_id!, Q.enabledSearchCampaigns, f);
  const ids = rows.map((r) => String(r.campaign?.id ?? ''));
  const active = site.campaignIds ? ids.some((id) => site.campaignIds!.includes(id)) : ids.length > 0;
  const resumed = active && !site.ads_active;
  const warmup = resumed ? now + site.resume_warmup_hours * HOUR : site.warmup_until;
  await db.prepare('UPDATE sites SET ads_active = ?, ads_checked_at = ?, warmup_until = ? WHERE id = ?')
    .bind(active ? 1 : 0, now, warmup, site.id).run();
  site.ads_active = active ? 1 : 0;
  site.ads_checked_at = now;
  site.warmup_until = warmup;
}

interface IpBlockRow {
  campaign?: { id?: string };
  campaignCriterion?: { resourceName?: string; ipBlock?: { ipAddress?: string } };
}

export async function syncExclusions(db: D1Database, site: Site, creds: AdsCreds, now: number, f: typeof fetch) {
  const cid = site.ads_customer_id!;
  const campaignIds = site.campaignIds ??
    (await search<{ campaign?: { id?: string } }>(creds, cid, Q.enabledSearchCampaigns, f)).map((r) => String(r.campaign?.id ?? '')).filter(Boolean);

  const current = await search<IpBlockRow>(creds, cid, Q.ipBlocks, f);
  const { results: ours } = await db
    .prepare('SELECT ip_key, zone, status, score, updated_at, pushed FROM blocks WHERE site_id = ?')
    .bind(site.id)
    .all<{ ip_key: string; zone: 'fixed' | 'rotating'; status: string; score: number; updated_at: number; pushed: number }>();

  const key = (s: string) => canonicalCidr(s) ?? s;
  const pushedByUs = new Set(ours.filter((o) => o.pushed).map((o) => key(o.ip_key)));
  const candidates: Candidate[] = ours
    .filter((o) => o.status === 'active')
    .map((o) => ({ ipKey: key(o.ip_key), zone: o.zone, score: o.score, updatedAt: o.updated_at }));

  const ops: CriterionOp[] = [];
  const desiredAnywhere = new Set<string>();
  let created = 0, removed = 0;

  for (const campaignId of campaignIds) {
    const inCampaign = new Map<string, string>(); // ip → resourceName
    for (const row of current) {
      if (String(row.campaign?.id) !== campaignId) continue;
      const ip = row.campaignCriterion?.ipBlock?.ipAddress;
      const rn = row.campaignCriterion?.resourceName;
      if (ip && rn) inCampaign.set(key(ip), rn);
    }
    const manual = [...inCampaign.keys()].filter((ip) => !pushedByUs.has(ip)).length; // IP bạn tự thêm: giữ nguyên
    const desired = new Set(selectExclusions(candidates, manual, now));
    desired.forEach((d) => desiredAnywhere.add(d));

    for (const ip of desired) {
      if (inCampaign.has(ip)) continue;
      ops.push({ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, negative: true, ipBlock: { ipAddress: ip } } });
      created++;
    }
    for (const [ip, rn] of inCampaign) {
      if (pushedByUs.has(ip) && !desired.has(ip)) {
        ops.push({ remove: rn });
        removed++;
      }
    }
  }

  for (let i = 0; i < ops.length; i += 1000) {
    await mutateCampaignCriteria(creds, cid, ops.slice(i, i + 1000), f);
  }

  const stmts = ours.map((o) =>
    db.prepare('UPDATE blocks SET pushed = ? WHERE site_id = ? AND ip_key = ?')
      .bind(desiredAnywhere.has(key(o.ip_key)) ? 1 : 0, site.id, o.ip_key),
  );
  stmts.push(db.prepare('UPDATE sites SET blocks_dirty = 0, last_sync_at = ? WHERE id = ?').bind(now, site.id));
  await db.batch(stmts);
  return { created, removed };
}

// ---------------------------------------------------------------------------------------------
// Việc hằng ngày

async function maybeDaily(env: Env, sites: Site[], creds: AdsCreds | null, now: number, f: typeof fetch): Promise<boolean> {
  const { date, hour } = vnDate(now);
  if (hour !== 3) return false;
  const db = env.DB;
  const last = await db.prepare(`SELECT value FROM job_state WHERE name = 'daily'`).first<{ value: string }>();
  if (last?.value === date) return false;
  await db.prepare(`INSERT INTO job_state (name, value) VALUES ('daily', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`)
    .bind(date).run();

  const days = Number(env.RETENTION_DAYS ?? '90') || 90;
  const cutoff = now - days * DAY;
  await db.batch([
    db.prepare('DELETE FROM visits WHERE started_at < ?').bind(cutoff),
    db.prepare('DELETE FROM conversions WHERE at < ?').bind(cutoff),
    db.prepare('DELETE FROM ad_clicks WHERE date < ?').bind(vnDate(cutoff).date),
    db.prepare('DELETE FROM whitelist WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now),
  ]);

  if (creds) {
    const yesterday = vnDate(now - DAY).date;
    for (const site of sites) {
      if (!site.ads_customer_id || site.mode === 'off') continue;
      try {
        await importClickView(db, site, creds, yesterday, now, f);
      } catch (e) {
        console.error(`click_view ${site.id}:`, e);
      }
    }
  }
  return true;
}

interface ClickViewRow {
  clickView?: { gclid?: string; keywordInfo?: { text?: string }; areaOfInterest?: { city?: string }; locationOfPresence?: { city?: string } };
  segments?: { date?: string };
  campaign?: { id?: string };
}

/** Nhập các click Google đã tính tiền để đối soát với lượt vào trang (truy vấn được tối đa 90 ngày trước). */
export async function importClickView(db: D1Database, site: Site, creds: AdsCreds, date: string, now: number, f: typeof fetch) {
  const rows = await search<ClickViewRow>(creds, site.ads_customer_id!, Q.clickView(date), f);
  const stmts = rows
    .filter((r) => r.clickView?.gclid)
    .map((r) =>
      db.prepare(
        `INSERT OR REPLACE INTO ad_clicks (gclid, site_id, date, campaign_id, keyword, area_of_interest, location_of_presence, imported_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        r.clickView!.gclid!, site.id, r.segments?.date ?? date, r.campaign?.id ?? null,
        r.clickView?.keywordInfo?.text ?? null, r.clickView?.areaOfInterest?.city ?? null,
        r.clickView?.locationOfPresence?.city ?? null, now,
      ),
    );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return stmts.length;
}
