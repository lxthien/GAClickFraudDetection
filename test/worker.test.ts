import { beforeEach, describe, expect, it } from 'vitest';
import { runScheduled } from '../src/worker/cron';
import type { Env } from '../src/worker/env';
import { _resetTokenCache } from '../src/worker/googleads';
import { app } from '../src/worker/index';
import { clearSiteCache } from '../src/worker/sites';
import { createD1, raw, SITE_KEY, seedSite } from './helpers/d1';

let env: Env;
const MIN = 60_000;

beforeEach(() => {
  clearSiteCache();
  _resetTokenCache();
  env = { DB: createD1(), ADMIN_TOKEN: 'secret-token' };
});

const db = () => raw(env.DB);

function beacon(body: Record<string, unknown>, opts: { origin?: string; ip?: string } = {}) {
  return app.request(
    '/c',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'text/plain',
        Origin: opts.origin ?? 'https://kientruckimanh.com',
        'CF-Connecting-IP': opts.ip ?? '14.161.20.30',
        'User-Agent': 'Mozilla/5.0 (iPhone)',
      },
    },
    env,
  );
}

const load = { e: 'load', s: SITE_KEY, v: 'visitor00001', p: 'pageview0001', g: 'Cj0KCQjwtest_gclid_1', fp: 'a1b2c3d4', wd: 0, hl: 0, u: '/xay-nha-tron-goi', r: 'www.google.com' };

function insertVisit(over: Record<string, unknown>) {
  const row = {
    site_id: 'kim-anh', visitor_id: 'visitor00001', fp_hash: 'a1b2c3d4', gclid: null,
    ip: '14.161.20.30', ip_key: '14.161.20.30', ip_version: 4, asn: 7552, as_org: 'Viettel Group', country: 'VN',
    bot_webdriver: 0, bot_headless: 0, started_at: Date.now() - 40 * MIN, ended_at: Date.now() - 39 * MIN,
    dwell_ms: 40_000, scroll_pct: 50, interactions: 8,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(`INSERT INTO visits (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
}

describe('nhận beacon', () => {
  it('ghi lượt vào trang, IP lấy từ kết nối chứ không từ dữ liệu gửi lên', async () => {
    seedSite(env.DB);
    expect((await beacon({ ...load, ip: '1.1.1.1' })).status).toBe(204);
    expect((await beacon({ e: 'end', s: SITE_KEY, v: load.v, p: load.p, t: 42_000, sc: 70, it: 9, ft: 1500 })).status).toBe(204);
    const v = db().prepare('SELECT * FROM visits').get() as Record<string, unknown>;
    expect(v).toMatchObject({ ip: '14.161.20.30', gclid: load.g, dwell_ms: 42_000, scroll_pct: 70, interactions: 9, path: '/xay-nha-tron-goi' });
  });

  it('nhận cả domain thứ hai và subdomain www của site', async () => {
    seedSite(env.DB);
    expect((await beacon(load, { origin: 'https://www.xaydungkimanh.com' })).status).toBe(204);
  });

  it('từ chối domain lạ và lượt không có mã click quảng cáo', async () => {
    seedSite(env.DB);
    expect((await beacon(load, { origin: 'https://doi-thu.vn' })).status).toBe(403);
    expect((await beacon({ ...load, g: null })).status).toBe(400);
    expect(db().prepare('SELECT COUNT(*) AS n FROM visits').get()).toEqual({ n: 0 });
  });

  it('site đang tắt thì không ghi gì', async () => {
    seedSite(env.DB, { mode: 'off' });
    expect((await beacon(load)).status).toBe(204);
    expect(db().prepare('SELECT COUNT(*) AS n FROM visits').get()).toEqual({ n: 0 });
  });

  it('chỉ ghi chuyển đổi khi lượt xem trang tồn tại', async () => {
    seedSite(env.DB);
    await beacon({ e: 'conv', s: SITE_KEY, v: load.v, p: load.p, ct: 'call', ok: 1, why: '' });
    expect(db().prepare('SELECT COUNT(*) AS n FROM conversions').get()).toEqual({ n: 0 });
    await beacon(load);
    await beacon({ e: 'conv', s: SITE_KEY, v: load.v, p: load.p, ct: 'call', ok: 1, why: '' });
    expect(db().prepare('SELECT type, client_ok FROM conversions').get()).toEqual({ type: 'call', client_ok: 1 });
  });

  it('phục vụ script theo dõi tại /t.js', async () => {
    const res = await app.request('/t.js', {}, env);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    expect(await res.text()).toContain('sendBeacon');
  });
});

describe('vòng chấm điểm', () => {
  it('chế độ ghi log: chấm điểm nhưng không gắn cờ IP', async () => {
    seedSite(env.DB, { mode: 'log' });
    insertVisit({ pageview_id: 'pv-bot-0001', bot_headless: 1 });
    const r = await runScheduled(env);
    expect(r.sites[0]).toMatchObject({ mode: 'log', scored: 1, flagged: 0 });
    expect(db().prepare('SELECT verdict FROM visits').get()).toEqual({ verdict: 'block' });
    expect(db().prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('chế độ gợi ý: bot trên mạng Viettel bị gợi ý chặn 48 giờ', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-bot-0001', bot_webdriver: 1 });
    const now = Date.now();
    await runScheduled(env, now);
    const b = db().prepare('SELECT * FROM blocks').get() as Record<string, unknown>;
    expect(b).toMatchObject({ ip_key: '14.161.20.30', status: 'suggested', zone: 'rotating', network: 'vn_consumer' });
    expect(b.expires_at).toBe(now + 48 * 3600_000);
  });

  it('mạng Viettel: thoát trang nhanh ngoài vùng không đủ để chặn IP', async () => {
    seedSite(env.DB, { mode: 'suggest', block_threshold: 40 });
    insertVisit({ pageview_id: 'pv-bounce-01', country: 'KH', dwell_ms: 800, scroll_pct: 0, interactions: 0 });
    await runScheduled(env);
    expect(db().prepare('SELECT verdict FROM visits').get()).toEqual({ verdict: 'block' });
    expect(db().prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('một thiết bị click lặp lại qua 3 IP → chặn cả 3 IP', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    const t = Date.now();
    ['14.161.20.30', '14.161.99.1', '27.72.5.5'].forEach((ip, i) =>
      insertVisit({ pageview_id: `pv-rep-000${i}`, ip, ip_key: ip, started_at: t - (50 - i) * MIN, ended_at: t - (49 - i) * MIN }),
    );
    await runScheduled(env, t);
    const keys = (db().prepare('SELECT ip_key FROM blocks ORDER BY ip_key').all() as Array<{ ip_key: string }>).map((x) => x.ip_key);
    expect(keys).toEqual(['14.161.20.30', '14.161.99.1', '27.72.5.5']);
  });

  it('datacenter: chặn cả dải /24, cố định', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-dc-00001', ip: '45.76.10.200', ip_key: '45.76.10.200', asn: 20473, as_org: 'Vultr', country: 'SG', dwell_ms: 900, scroll_pct: 0, interactions: 0 });
    await runScheduled(env);
    expect(db().prepare('SELECT ip_key, zone, expires_at FROM blocks').get()).toEqual({ ip_key: '45.76.10.0/24', zone: 'fixed', expires_at: null });
  });

  it('khách đã gọi điện: miễn chặn, vào whitelist, gỡ lệnh chặn cũ trên IP đó', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    const now = Date.now();
    db().prepare(`INSERT INTO blocks (site_id, ip_key, zone, status, score, reasons, network, created_at, updated_at) VALUES ('kim-anh','14.161.20.30','rotating','suggested',80,'[]','vn_consumer',?,?)`).run(now, now);
    insertVisit({ pageview_id: 'pv-real-0001', bot_webdriver: 1 });
    db().prepare(`INSERT INTO conversions (site_id, pageview_id, visitor_id, type, client_ok, ip_key, at) VALUES ('kim-anh','pv-real-0001','visitor00001','call',1,'14.161.20.30',?)`).run(now);
    await runScheduled(env, now);
    expect(db().prepare('SELECT verdict FROM visits').get()).toEqual({ verdict: 'exempt' });
    expect(db().prepare('SELECT status FROM blocks').get()).toEqual({ status: 'removed' });
    expect(db().prepare('SELECT kind FROM whitelist ORDER BY kind').all()).toEqual([{ kind: 'device' }, { kind: 'ip' }]);
  });

  it('IP trong whitelist không bao giờ bị gắn cờ', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    db().prepare(`INSERT INTO whitelist (site_id, kind, value, created_at) VALUES (NULL, 'ip', '14.161.20.0/24', 0)`).run();
    insertVisit({ pageview_id: 'pv-office-01', bot_webdriver: 1 });
    await runScheduled(env);
    expect(db().prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('nhóm chia sẻ: IP bị chặn ở một site được áp dụng cho site cùng nhóm', async () => {
    seedSite(env.DB, { mode: 'suggest', share_group: 'kim-anh' });
    seedSite(env.DB, { id: 'kim-anh-2', site_key: 'kimanh_second_key', mode: 'suggest', share_group: 'kim-anh', domains: '["xaydungkimanh.com"]' });
    seedSite(env.DB, { id: 'minh-duy', site_key: 'minhduy_test_key', mode: 'suggest', domains: '["xaydungminhduy.com"]' });
    insertVisit({ pageview_id: 'pv-bot-0001', bot_headless: 1 });
    await runScheduled(env);
    const sites = (db().prepare('SELECT site_id FROM blocks ORDER BY site_id').all() as Array<{ site_id: string }>).map((x) => x.site_id);
    expect(sites).toEqual(['kim-anh', 'kim-anh-2']);
  });
});

describe('đồng bộ Google Ads (chế độ tự chặn)', () => {
  it('thêm IP mới, giữ nguyên IP bạn tự thêm, đánh dấu đã đẩy', async () => {
    env = { ...env, GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'sec', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt' };
    seedSite(env.DB, { mode: 'auto', ads_customer_id: '1234567890' });
    insertVisit({ pageview_id: 'pv-bot-0001', bot_headless: 1 });

    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url.includes('oauth2')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.endsWith(':searchStream')) {
        if (body.query.includes('FROM campaign_criterion')) {
          return Response.json([{ results: [{ campaign: { id: '111' }, campaignCriterion: { resourceName: 'customers/1234567890/campaignCriteria/111~9', ipBlock: { ipAddress: '113.161.1.1' } } }] }]);
        }
        return Response.json([{ results: [{ campaign: { id: '111' } }] }]);
      }
      if (url.endsWith('campaignCriteria:mutate')) return Response.json({ results: [{ resourceName: 'x' }] });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const r = await runScheduled(env, Date.now(), { fetch: fakeFetch });
    expect(r.sites[0]?.synced).toEqual({ created: 1, removed: 0 });
    const mutate = calls.find((c) => c.url.endsWith('campaignCriteria:mutate'))!;
    expect(mutate.body.operations).toEqual([
      { create: { campaign: 'customers/1234567890/campaigns/111', negative: true, ipBlock: { ipAddress: '14.161.20.30' } } },
    ]);
    expect(db().prepare('SELECT status, pushed FROM blocks').get()).toEqual({ status: 'active', pushed: 1 });
    expect(db().prepare('SELECT blocks_dirty FROM sites').get()).toEqual({ blocks_dirty: 0 });
  });
});

describe('API quản trị', () => {
  const auth = { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' };

  it('yêu cầu ADMIN_TOKEN', async () => {
    expect((await app.request('/admin/sites', {}, env)).status).toBe(401);
  });

  it('thêm site mới bằng một lệnh PUT', async () => {
    const res = await app.request('/admin/sites/minh-duy', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ name: 'Minh Duy', site_key: 'minhduy_pub_key', domains: ['xaydungminhduy.com'], ads_customer_id: '123-456-7890', mode: 'log', schedule: { start: '2026-12-01' } }),
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'minh-duy', ads_customer_id: '1234567890', domains: ['xaydungminhduy.com'], schedule: { start: '2026-12-01' } });
  });

  it('xuất danh sách IP gợi ý để dán vào Google Ads', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-bot-0001', bot_headless: 1 });
    await runScheduled(env);
    const res = await app.request('/admin/sites/kim-anh/blocks/export', { headers: auth }, env);
    expect(await res.text()).toBe('14.161.20.30');
  });

  it('lead bị đánh dấu đối thủ → lượt đó được chấm lại và bị gắn cờ', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-lead-0001', gclid: 'Cj0KCQjw_lead_gclid' });
    await runScheduled(env);
    expect(db().prepare('SELECT verdict FROM visits').get()).toEqual({ verdict: 'normal' });
    await app.request('/admin/leads', { method: 'POST', headers: auth, body: JSON.stringify({ site_id: 'kim-anh', gclid: 'Cj0KCQjw_lead_gclid', status: 'competitor' }) }, env);
    await runScheduled(env);
    expect(db().prepare('SELECT verdict FROM visits').get()).toEqual({ verdict: 'block' });
    expect(db().prepare('SELECT ip_key FROM blocks').get()).toEqual({ ip_key: '14.161.20.30' });
  });
});

describe('trang quản lý và dữ liệu khởi tạo', () => {
  it('phục vụ /ui với header bảo mật, không chứa dữ liệu', async () => {
    const res = await app.request('/ui', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain('Chặn click ảo');
  });

  it('migration khai báo sẵn 3 website, mỗi website một tài khoản, chỉ ghi log', async () => {
    const seeded = createD1({ keepSeed: true });
    const rows = raw(seeded).prepare('SELECT id, mode, share_group, domains FROM sites ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'kientruckimanh', mode: 'log', share_group: 'kim-anh', domains: '["kientruckimanh.com"]' },
      { id: 'xaydungkimanh', mode: 'log', share_group: 'kim-anh', domains: '["xaydungkimanh.com"]' },
      { id: 'xaydungminhduy', mode: 'log', share_group: null, domains: '["xaydungminhduy.com"]' },
    ]);
  });
});

describe('lượt thử nghiệm (gclid TEST_)', () => {
  const auth = { Authorization: 'Bearer secret-token' };

  it('được đánh dấu khi ghi nhận', async () => {
    seedSite(env.DB);
    await beacon({ ...load, g: 'TEST_gcf_check_0001' });
    expect(db().prepare('SELECT is_test FROM visits').get()).toEqual({ is_test: 1 });
  });

  it('được chấm điểm nhưng không bao giờ tạo lệnh chặn hay whitelist', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-test-0001', gclid: 'TEST_sim_headless', is_test: 1, bot_headless: 1 });
    db().prepare(`INSERT INTO conversions (site_id, pageview_id, visitor_id, type, client_ok, ip_key, at) VALUES ('kim-anh','pv-test-0001','visitor00001','call',1,'14.161.20.30',?)`).run(Date.now());
    insertVisit({ pageview_id: 'pv-test-0002', visitor_id: 'visitor00002', gclid: 'TEST_sim_bot', is_test: 1, bot_webdriver: 1 });
    await runScheduled(env);
    expect(db().prepare('SELECT verdict FROM visits ORDER BY pageview_id').all()).toEqual([{ verdict: 'exempt' }, { verdict: 'block' }]);
    expect(db().prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) AS n FROM whitelist').get()).toEqual({ n: 0 });
  });

  it('chuyển đổi của lượt thử không miễn chặn cho lượt thật của cùng thiết bị', async () => {
    seedSite(env.DB, { mode: 'suggest' });
    insertVisit({ pageview_id: 'pv-test-0001', gclid: 'TEST_preview', is_test: 1 });
    db().prepare(`INSERT INTO conversions (site_id, pageview_id, visitor_id, type, client_ok, ip_key, at) VALUES ('kim-anh','pv-test-0001','visitor00001','call',1,'14.161.20.30',?)`).run(Date.now());
    insertVisit({ pageview_id: 'pv-real-0001', bot_webdriver: 1 });
    await runScheduled(env);
    expect(db().prepare(`SELECT verdict FROM visits WHERE pageview_id = 'pv-real-0001'`).get()).toEqual({ verdict: 'block' });
    expect(db().prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 1 });
  });

  it('lượt thử không cộng vào số click lặp lại của lượt thật', async () => {
    seedSite(env.DB, { mode: 'log' });
    const t = Date.now();
    insertVisit({ pageview_id: 'pv-test-0001', gclid: 'TEST_a', is_test: 1, started_at: t - 50 * MIN, ended_at: t - 49 * MIN });
    insertVisit({ pageview_id: 'pv-test-0002', gclid: 'TEST_b', is_test: 1, started_at: t - 48 * MIN, ended_at: t - 47 * MIN });
    insertVisit({ pageview_id: 'pv-real-0001', started_at: t - 46 * MIN, ended_at: t - 45 * MIN });
    await runScheduled(env, t);
    expect(db().prepare(`SELECT verdict, reasons FROM visits WHERE pageview_id = 'pv-real-0001'`).get()).toEqual({ verdict: 'normal', reasons: '[]' });
  });

  it('không tính vào thống kê; xem riêng bằng ?test=1', async () => {
    seedSite(env.DB);
    insertVisit({ pageview_id: 'pv-test-0001', gclid: 'TEST_a', is_test: 1 });
    insertVisit({ pageview_id: 'pv-real-0001', visitor_id: 'visitor00009' });
    const sm = (await (await app.request('/admin/sites/kim-anh/summary', { headers: auth }, env)).json()) as any;
    expect(sm.visits_by_verdict).toEqual([{ verdict: 'pending', n: 1 }]);
    expect(sm.test_visits).toBe(1);
    const tests = (await (await app.request('/admin/sites/kim-anh/visits?test=1', { headers: auth }, env)).json()) as any[];
    expect(tests.map((v) => v.gclid)).toEqual(['TEST_a']);
  });

  it('POST /admin/cron/run chạy ngay một vòng chấm điểm', async () => {
    seedSite(env.DB);
    insertVisit({ pageview_id: 'pv-real-0001' });
    const res = await app.request('/admin/cron/run', { method: 'POST', headers: auth }, env);
    expect(((await res.json()) as any).sites[0]).toMatchObject({ id: 'kim-anh', scored: 1 });
  });
});
