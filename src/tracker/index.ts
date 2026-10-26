/**
 * Script theo dõi gắn qua GTM. Ngân sách: dưới 3 KB gzip.
 *
 * - Chỉ hoạt động với lượt đến từ quảng cáo (URL có gclid/gbraid/wbraid, hoặc cookie _gcf_ad trong 30 phút).
 * - Không dùng canvas/WebGL; chỉ đọc vài thuộc tính có sẵn để tạo dấu vân tay nhẹ.
 * - Listener thụ động, không đọc lại bố cục khi cuộn; gửi bằng sendBeacon, không chặn trang.
 * - Đẩy sự kiện dataLayer `gcf_conv_ok` / `gcf_conv_blocked` để GTM chỉ bắn chuyển đổi cho lượt sạch.
 */
(() => {
  const w = window as any;
  const d = document;
  const n = navigator as any;
  const sc = d.currentScript as HTMLScriptElement | null;
  if (!sc || !sc.src) return;
  const src = new URL(sc.src);
  const site = src.searchParams.get('s');
  if (!site) return;
  const endpoint = src.origin + '/c';

  const store = (s: Storage, k: string, v?: string): string | null => {
    try {
      if (v !== undefined) s.setItem(k, v);
      return s.getItem(k);
    } catch {
      return null;
    }
  };

  // ---- Chỉ chạy với lượt quảng cáo ----
  const q = new URLSearchParams(location.search);
  const ids = { g: q.get('gclid'), gb: q.get('gbraid'), wb: q.get('wbraid') };
  const AD = '_gcf_ad';
  if (ids.g || ids.gb || ids.wb) {
    store(sessionStorage, '_gcf_c', JSON.stringify(ids));
  } else if (d.cookie.indexOf(AD + '=1') < 0) {
    return;
  } else {
    const saved = store(sessionStorage, '_gcf_c');
    if (saved) Object.assign(ids, JSON.parse(saved));
  }
  d.cookie = AD + '=1;max-age=1800;path=/;SameSite=Lax';

  const rid = (): string =>
    (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
  const vid = store(localStorage, '_gcf_v') || store(localStorage, '_gcf_v', rid()) || rid();
  const pv = rid();

  // ---- Dấu vân tay nhẹ (FNV-1a 32 bit) ----
  const s = screen;
  const fpSrc = [
    s.width, s.height, s.colorDepth, w.devicePixelRatio,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    n.language, (n.languages || []).join(), n.hardwareConcurrency, n.deviceMemory, n.platform, n.maxTouchPoints,
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < fpSrc.length; i++) h = Math.imul(h ^ fpSrc.charCodeAt(i), 16777619);
  const fp = (h >>> 0).toString(16);

  const webdriver = n.webdriver ? 1 : 0;
  const headless = /Headless|PhantomJS|Puppeteer|Playwright/i.test(n.userAgent) ? 1 : 0;

  // ---- Hành vi ----
  const t0 = Date.now();
  let visibleMs = 0;
  let visibleSince: number | null = d.visibilityState === 'visible' ? t0 : null;
  let scrollPct = 0;
  let scrolled = false;
  let interactions = 0;
  let firstAt = -1;
  const visible = () => visibleMs + (visibleSince ? Date.now() - visibleSince : 0);

  const on = (t: any, ev: string, fn: (e: any) => void) => t.addEventListener(ev, fn, { passive: true, capture: true });
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    on(d, ev, () => {
      interactions++;
      if (firstAt < 0) firstAt = Date.now() - t0;
    });
  }
  on(w, 'scroll', () => (scrolled = true));
  setInterval(() => {
    if (!scrolled) return;
    scrolled = false;
    const max = d.documentElement.scrollHeight - innerHeight;
    scrollPct = Math.max(scrollPct, max > 0 ? Math.min(100, Math.round((scrollY / max) * 100)) : 100);
  }, 500);

  // ---- Gửi dữ liệu ----
  const send = (e: string, extra?: object) => {
    const body = JSON.stringify({ s: site, v: vid, p: pv, e, ...extra });
    if (!(n.sendBeacon && n.sendBeacon(endpoint, body))) {
      fetch(endpoint, { method: 'POST', body, keepalive: true, mode: 'no-cors' }).catch(() => {});
    }
  };

  send('load', {
    ...ids,
    fp,
    wd: webdriver,
    hl: headless,
    u: location.pathname.slice(0, 200),
    r: d.referrer ? new URL(d.referrer).hostname : '',
  });

  const end = () => send('end', { t: visible(), sc: scrollPct, it: interactions, ft: firstAt });
  on(d, 'visibilitychange', () => {
    if (d.visibilityState === 'hidden') {
      if (visibleSince) visibleMs += Date.now() - visibleSince;
      visibleSince = null;
      end();
    } else {
      visibleSince = Date.now();
    }
  });
  on(w, 'pagehide', end);

  // ---- Chuyển đổi + bộ lọc lead giả phía trình duyệt ----
  const conv = (type: string, ok: boolean, why: string) => {
    send('conv', { ct: type, ok: ok ? 1 : 0, why });
    (w.dataLayer = w.dataLayer || []).push({ event: ok ? 'gcf_conv_ok' : 'gcf_conv_blocked', gcf_type: type, gcf_reason: why });
  };
  const baseCheck = (minMs: number): string =>
    webdriver || headless ? 'automation' : visible() < minMs ? 'too_fast' : '';

  on(d, 'click', (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    const type = /^tel:/i.test(href) ? 'call' : /zalo\.me/i.test(href) ? 'zalo' : /(m\.me|messenger\.com)/i.test(href) ? 'mess' : '';
    if (!type) return;
    const why = baseCheck(2000);
    conv(type, !why, why);
  });

  on(d, 'submit', (e: Event) => {
    const f = e.target as HTMLFormElement;
    let why = baseCheck(4000);
    const hp = f.querySelector('[name="_hp"]') as HTMLInputElement | null;
    if (!why && hp && hp.value) why = 'honeypot';
    const phone = f.querySelector('input[type=tel],input[name*=phone i],input[name*=sdt i],input[name*=dien i]') as HTMLInputElement | null;
    if (!why && phone && !/^(0|\+?84)(3|5|7|8|9)\d{8}$/.test(phone.value.replace(/[\s.-]/g, ''))) why = 'phone_format';
    conv('form', !why, why);
  });
})();
