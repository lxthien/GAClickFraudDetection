// Chạy trang quản lý thật trong jsdom, gọi thẳng vào Worker (không qua mạng).
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { UI_HTML } from '../src/worker/generated/ui';
import { app } from '../src/worker/index';
import { clearSiteCache } from '../src/worker/sites';
import { createD1, raw } from './helpers/d1';

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function openUi(env: Env, hash = '') {
  clearSiteCache();
  const dom = new JSDOM(UI_HTML, {
    url: `https://gcf-worker.example.workers.dev/ui${hash}`,
    runScripts: 'outside-only',
  });
  const w = dom.window as unknown as Window & { eval: (s: string) => unknown; HTMLDialogElement: any };
  w.sessionStorage.setItem('gcf_admin_token', 'secret-token');
  // jsdom chưa hỗ trợ <dialog>.showModal
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  (w as any).fetch = async (path: string, init?: RequestInit) => app.request(path, init, env);
  const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)![1]!;
  w.eval(script);
  await wait(150);
  return { w, doc: w.document };
}

describe('trang quản lý', () => {
  it('liệt kê 3 website khai báo sẵn', async () => {
    const env: Env = { DB: createD1({ keepSeed: true }), ADMIN_TOKEN: 'secret-token' };
    const { doc } = await openUi(env);
    const text = doc.getElementById('app')!.textContent!;
    expect(text).toContain('Kiến Trúc Kim Anh');
    expect(text).toContain('Xây Dựng Kim Anh');
    expect(text).toContain('Xây Dựng Minh Duy');
    expect(doc.querySelectorAll('.site')).toHaveLength(3);
  });

  it('trang chi tiết hiện tag GTM đúng site_key và thoát ký tự HTML trong dữ liệu', async () => {
    const env: Env = { DB: createD1({ keepSeed: true }), ADMIN_TOKEN: 'secret-token' };
    const now = Date.now();
    raw(env.DB).prepare(
      `INSERT INTO visits (pageview_id, site_id, visitor_id, ip, ip_key, ip_version, as_org, path, started_at, scored_at, score, verdict, reasons)
       VALUES ('pv-xss-00001','xaydungkimanh','visitor00001','14.161.2.3','14.161.2.3',4,'<img src=x onerror=alert(1)>','/<b>x</b>',?,?,90,'block','[{"code":"AUTOMATION","points":70}]')`,
    ).run(now, now);
    const { doc } = await openUi(env, '#site/xaydungkimanh');
    expect((doc.getElementById('tag') as HTMLTextAreaElement).value).toBe(
      '<script async src="https://gcf-worker.example.workers.dev/t.js?s=xdka_9_IjjvxvxB-0"></script>',
    );
    expect(doc.querySelector('img')).toBeNull(); // không chèn được HTML
    expect(doc.getElementById('app')!.textContent).toContain('Trình duyệt tự động');
  });

  it('thêm website mới qua form', async () => {
    const env: Env = { DB: createD1({ keepSeed: true }), ADMIN_TOKEN: 'secret-token' };
    const { w, doc } = await openUi(env);
    (doc.getElementById('addSite') as HTMLButtonElement).click();
    const f = (doc.getElementById('editForm') as HTMLFormElement).elements as any;
    f.id.value = 'namvietphat';
    f.name.value = 'Nam Việt Phát';
    f.domains.value = 'https://www.xaydungnamvietphat.com/';
    f.ads_customer_id.value = '111-222-3333';
    doc.getElementById('editForm')!.dispatchEvent(new (w as any).Event('submit', { cancelable: true }));
    await wait(150);
    const row = raw(env.DB).prepare(`SELECT name, domains, ads_customer_id, mode, site_key FROM sites WHERE id = 'namvietphat'`).get() as any;
    expect(row).toMatchObject({ name: 'Nam Việt Phát', domains: '["xaydungnamvietphat.com"]', ads_customer_id: '1112223333', mode: 'log' });
    expect(row.site_key).toMatch(/^namvietphat_[A-Za-z0-9_-]{12}$/);
  });

  it('khóa sai → quay về màn đăng nhập', async () => {
    const env: Env = { DB: createD1({ keepSeed: true }), ADMIN_TOKEN: 'another-token' };
    const { doc } = await openUi(env);
    expect(doc.getElementById('loginForm')).not.toBeNull();
  });
});
