import type { Mode, Schedule, SiteModeState } from '../shared/schedule';

export interface SiteRow {
  id: string;
  name: string;
  site_key: string;
  domains: string;
  ads_customer_id: string | null;
  campaign_ids: string | null;
  mode: Mode;
  schedule: string | null;
  follow_campaigns: number;
  ads_active: number;
  ads_checked_at: number | null;
  warmup_until: number | null;
  resume_warmup_hours: number;
  target_countries: string;
  watch_threshold: number;
  block_threshold: number;
  share_group: string | null;
  telegram_chat_id: string | null;
  blocks_dirty: number;
  last_sync_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Site extends Omit<SiteRow, 'domains' | 'campaign_ids' | 'schedule' | 'target_countries'> {
  domains: string[];
  campaignIds: string[] | null;
  schedule: Schedule | null;
  targetCountries: string[];
}

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function toSite(r: SiteRow): Site {
  const { domains, campaign_ids, schedule, target_countries, ...rest } = r;
  return {
    ...rest,
    domains: json<string[]>(domains, []),
    campaignIds: json<string[] | null>(campaign_ids, null),
    schedule: json<Schedule | null>(schedule, null),
    targetCountries: json<string[]>(target_countries, ['VN']),
  };
}

export function modeState(s: Site): SiteModeState {
  return {
    mode: s.mode,
    schedule: s.schedule,
    followCampaigns: !!s.follow_campaigns,
    adsActive: !!s.ads_active,
    warmupUntil: s.warmup_until,
  };
}

// Bộ nhớ đệm ngắn hạn trong isolate để không đọc D1 mỗi beacon.
const cache = new Map<string, { site: Site | null; at: number }>();
const TTL = 60_000;

export async function siteByKey(db: D1Database, key: string, now = Date.now()): Promise<Site | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL) return hit.site;
  const row = await db.prepare('SELECT * FROM sites WHERE site_key = ?').bind(key).first<SiteRow>();
  const site = row ? toSite(row) : null;
  cache.set(key, { site, at: now });
  return site;
}

export function clearSiteCache(): void {
  cache.clear();
}

export async function allSites(db: D1Database): Promise<Site[]> {
  const { results } = await db.prepare('SELECT * FROM sites ORDER BY id').all<SiteRow>();
  return results.map(toSite);
}

/** Host của Origin/Referer phải là một domain đã khai báo (hoặc subdomain của nó). */
export function hostAllowed(site: Site, host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return site.domains.some((d) => {
    const dom = d.toLowerCase();
    return h === dom || h.endsWith('.' + dom);
  });
}
