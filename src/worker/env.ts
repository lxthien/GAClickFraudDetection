export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GOOGLE_ADS_API_VERSION?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  RETENTION_DAYS?: string;
  /** "1" khi chạy wrangler dev: cho phép IP nội bộ và header X-Forwarded-For. */
  DEV?: string;
}
