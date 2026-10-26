import { Hono } from 'hono';
import { admin } from './admin';
import { handleCollect } from './collect';
import { runScheduled } from './cron';
import type { Env } from './env';
import { TRACKER_JS } from './generated/tracker';
import { UI_HTML } from './generated/ui';

export const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('gcf-worker ok'));

/** Trang quản lý. Không chứa dữ liệu; mọi dữ liệu lấy qua /admin bằng ADMIN_TOKEN người dùng tự nhập. */
app.get('/ui', (c) =>
  c.body(UI_HTML, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  }),
);

/** Script theo dõi; tag GTM tải: <script async src="https://<worker>/t.js?s=SITE_KEY"></script> */
app.get('/t.js', (c) =>
  c.body(TRACKER_JS, 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  }),
);

app.post('/c', handleCollect);
app.options('/c', (c) => c.body(null, 204));
app.route('/admin', admin);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, Date.now()).then((r) => console.log(JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
