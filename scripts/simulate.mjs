// Giả lập traffic vào website THẬT (gclid TEST_…), rồi kiểm tra hệ thống chấm điểm đúng từng kịch bản.
// Chạy trên GitHub Actions: Actions → Simulate → Run workflow.
//
// Lượt thử không bao giờ bị chặn hay tính vào thống kê. Request tới Google Analytics / Google Ads /
// Facebook / Clarity bị chặn ngay trong trình duyệt giả lập để không làm bẩn số liệu analytics.
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE_URL = process.env.SITE_URL;
const SITE_ID = process.env.SITE_ID;
const WORKER = (process.env.WORKER_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const RUN = process.env.GITHUB_RUN_ID || Date.now().toString(36);
if (!SITE_URL || !SITE_ID || !WORKER || !ADMIN_TOKEN) {
  console.error('Thiếu SITE_URL / SITE_ID / WORKER_URL / ADMIN_TOKEN');
  process.exit(1);
}

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BLOCK_THIRD_PARTY = /google-analytics\.com|analytics\.google\.com|googleadservices\.com|doubleclick\.net|google\.[a-z.]+\/pagead|\/ccm\/collect|facebook\.(com|net)|clarity\.ms|tiktok\.com|zalo\.me\/sdk/i;

const gclid = (name, n = 1) => `TEST_sim_${RUN}_${name}_${n}`;
const withGclid = (url, g) => { const u = new URL(url); u.searchParams.set('gclid', g); return u.toString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newContext(browser, { disguise }) {
  const ctx = await browser.newContext(disguise ? { userAgent: DESKTOP_UA, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' } : {});
  if (disguise) {
    // Trông như trình duyệt người thật: ẩn navigator.webdriver mà Playwright luôn bật.
    await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  }
  await ctx.route(BLOCK_THIRD_PARTY, (route) => route.abort());
  return ctx;
}

async function visit(ctx, g, behave) {
  const page = await ctx.newPage();
  await page.goto(withGclid(SITE_URL, g), { waitUntil: 'load', timeout: 60_000 });
  // Script theo dõi chạy sau Window Loaded và đặt cookie _gcf_ad khi đã ghi nhận lượt quảng cáo.
  await page.waitForFunction(() => document.cookie.includes('_gcf_ad=1'), null, { timeout: 30_000 });
  await behave(page);
  await page.goto('about:blank'); // kích hoạt pagehide → beacon "end"
  await sleep(1500);
  await page.close();
}

const readLikeHuman = async (page) => {
  await sleep(2000);
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(200 + i * 40, 300 + i * 25);
    await page.mouse.wheel(0, 500);
    await page.keyboard.press('ArrowDown');
    await sleep(2500);
  }
};

const scenarios = [
  {
    name: 'human',
    label: 'Người đọc trang 17 giây, cuộn, bấm phím',
    async run(browser) {
      const ctx = await newContext(browser, { disguise: true });
      await visit(ctx, gclid('human'), readLikeHuman);
      await ctx.close();
      return [gclid('human')];
    },
    expect: { has: ['NET_DATACENTER'], not: ['AUTOMATION', 'BOUNCE', 'REPEAT_CLICKS'] },
  },
  {
    name: 'headless',
    label: 'Bot headless, rời trang ngay',
    async run(browser) {
      const ctx = await newContext(browser, { disguise: false });
      await visit(ctx, gclid('headless'), () => sleep(300));
      await ctx.close();
      return [gclid('headless')];
    },
    expect: { has: ['AUTOMATION', 'BOUNCE'], verdict: 'block' },
  },
  {
    name: 'repeat',
    label: 'Một thiết bị click quảng cáo 3 lần',
    async run(browser) {
      const ctx = await newContext(browser, { disguise: true });
      for (let n = 1; n <= 3; n++) {
        await visit(ctx, gclid('repeat', n), async (page) => {
          await sleep(2000);
          await page.mouse.wheel(0, 400);
          await page.keyboard.press('ArrowDown');
          await sleep(3000);
        });
      }
      await ctx.close();
      return [gclid('repeat', 3)]; // lượt thứ 3 phải bị gắn cờ click lặp lại
    },
    expect: { has: ['REPEAT_CLICKS'], not: ['AUTOMATION'] },
  },
];

async function admin(path, init = {}) {
  const res = await fetch(WORKER + '/admin' + path, { ...init, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const browser = await chromium.launch();
const checks = [];
for (const s of scenarios) {
  try {
    console.log(`▶ ${s.label}`);
    const ids = await s.run(browser);
    checks.push({ s, ids });
  } catch (e) {
    checks.push({ s, ids: [], error: `không chạy được: ${e.message.split('\n')[0]}` });
  }
}
await browser.close();

console.log('Chờ 70 giây để lượt kết thúc đủ điều kiện chấm điểm…');
await sleep(70_000);
await admin('/cron/run', { method: 'POST' });
const visits = await admin(`/sites/${encodeURIComponent(SITE_ID)}/visits?test=1&limit=200`);
const byGclid = new Map(visits.map((v) => [v.gclid, v]));

let failed = 0;
const rows = [];
for (const { s, ids, error } of checks) {
  for (const id of ids.length ? ids : ['—']) {
    const v = byGclid.get(id);
    const codes = v ? JSON.parse(v.reasons || '[]').map((r) => r.code) : [];
    const problems = [];
    if (error) problems.push(error);
    else if (!v) problems.push('không thấy lượt trong hệ thống (script không gửi được dữ liệu?)');
    else if (!v.verdict) problems.push('chưa được chấm điểm');
    else {
      for (const c of s.expect.has || []) if (!codes.includes(c)) problems.push(`thiếu ${c}`);
      for (const c of s.expect.not || []) if (codes.includes(c)) problems.push(`không được có ${c}`);
      if (s.expect.verdict && v.verdict !== s.expect.verdict) problems.push(`kết luận ${v.verdict}, mong đợi ${s.expect.verdict}`);
    }
    if (problems.length) failed++;
    rows.push(`| ${s.label} | ${v?.verdict ?? '—'} | ${v?.score ?? '—'} | ${codes.join(', ') || '—'} | ${v?.as_org ?? ''} ${v?.country ?? ''} | ${problems.length ? '❌ ' + problems.join('; ') : '✅'} |`);
  }
}

const report = [
  `## Giả lập traffic: ${SITE_URL}`,
  '',
  '| Kịch bản | Kết luận | Điểm | Lý do | Mạng | Kiểm tra |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  failed ? `**${failed} kịch bản không đạt.**` : '**Mọi kịch bản đều đạt.**',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
process.exit(failed ? 1 : 0);
