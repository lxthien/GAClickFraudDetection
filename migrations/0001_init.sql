-- Mỗi website (hoặc nhóm domain của một công ty) là một "site".
CREATE TABLE sites (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  site_key            TEXT NOT NULL UNIQUE,          -- khóa công khai, gắn trong tag GTM
  domains             TEXT NOT NULL,                 -- JSON array, ví dụ ["kientruckimanh.com","xaydungkimanh.com"]
  ads_customer_id     TEXT,                          -- ID tài khoản Google Ads, 10 chữ số, không gạch
  campaign_ids        TEXT,                          -- JSON array; NULL = mọi chiến dịch Search đang bật
  mode                TEXT NOT NULL DEFAULT 'log' CHECK (mode IN ('off','log','suggest','auto')),
  schedule            TEXT,                          -- JSON {"start","end","hours":[from,to]}; NULL = luôn bật
  follow_campaigns    INTEGER NOT NULL DEFAULT 1,    -- tự "ngủ" khi mọi chiến dịch tạm dừng
  ads_active          INTEGER NOT NULL DEFAULT 1,
  ads_checked_at      INTEGER,
  warmup_until        INTEGER,                       -- sau khi chạy lại quảng cáo: chỉ ghi log tới mốc này
  resume_warmup_hours INTEGER NOT NULL DEFAULT 72,
  target_countries    TEXT NOT NULL DEFAULT '["VN"]',
  watch_threshold     INTEGER NOT NULL DEFAULT 40,
  block_threshold     INTEGER NOT NULL DEFAULT 70,
  share_group         TEXT,                          -- các site cùng nhóm dùng chung danh sách chặn
  telegram_chat_id    TEXT,
  blocks_dirty        INTEGER NOT NULL DEFAULT 0,
  last_sync_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Một dòng cho mỗi lượt xem trang đến từ quảng cáo.
CREATE TABLE visits (
  pageview_id          TEXT PRIMARY KEY,
  site_id              TEXT NOT NULL,
  visitor_id           TEXT NOT NULL,
  fp_hash              TEXT,
  gclid                TEXT,
  gbraid               TEXT,
  wbraid               TEXT,
  ip                   TEXT NOT NULL,                -- luôn lấy từ kết nối, không bao giờ từ dữ liệu script gửi
  ip_key               TEXT NOT NULL,                -- IPv4 nguyên địa chỉ, IPv6 theo tiền tố /64
  ip_version           INTEGER NOT NULL,
  asn                  INTEGER,
  as_org               TEXT,
  country              TEXT,
  city                 TEXT,
  user_agent           TEXT,
  path                 TEXT,
  referrer_host        TEXT,
  bot_webdriver        INTEGER NOT NULL DEFAULT 0,
  bot_headless         INTEGER NOT NULL DEFAULT 0,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  dwell_ms             INTEGER,
  scroll_pct           INTEGER,
  interactions         INTEGER,
  first_interaction_ms INTEGER,
  scored_at            INTEGER,
  score                INTEGER,
  verdict              TEXT,
  reasons              TEXT
);
CREATE INDEX idx_visits_site_started ON visits(site_id, started_at);
CREATE INDEX idx_visits_pending      ON visits(site_id, scored_at);
CREATE INDEX idx_visits_visitor      ON visits(visitor_id, started_at);
CREATE INDEX idx_visits_fp           ON visits(fp_hash, started_at);
CREATE INDEX idx_visits_gclid        ON visits(gclid);

-- Click nút gọi / Zalo / Messenger / gửi form.
CREATE TABLE conversions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT NOT NULL,
  pageview_id TEXT NOT NULL,
  visitor_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  client_ok   INTEGER NOT NULL,                      -- đã qua bộ lọc lead giả phía trình duyệt
  ip_key      TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX idx_conv_visitor ON conversions(visitor_id);

-- Trạng thái lead do sale cập nhật (từ Google Sheet).
CREATE TABLE leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  gclid      TEXT,
  visitor_id TEXT,
  status     TEXT NOT NULL CHECK (status IN ('new','real','unreachable','fake','competitor','signed')),
  note       TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_leads_visitor ON leads(visitor_id);
CREATE INDEX idx_leads_gclid   ON leads(gclid);

-- Không bao giờ chặn: IP văn phòng, nhân viên, khách đã chuyển đổi thật.
CREATE TABLE whitelist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT,                                   -- NULL = áp dụng mọi site
  kind       TEXT NOT NULL CHECK (kind IN ('ip','device')),
  value      TEXT NOT NULL,                          -- IP, CIDR, hoặc visitor_id
  note       TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_whitelist_site ON whitelist(site_id);

-- IP bị gắn cờ / đang chặn.
CREATE TABLE blocks (
  site_id         TEXT NOT NULL,
  ip_key          TEXT NOT NULL,                     -- IP hoặc CIDR gửi lên Google Ads
  zone            TEXT NOT NULL CHECK (zone IN ('fixed','rotating')),
  status          TEXT NOT NULL CHECK (status IN ('suggested','active','expired','removed')),
  score           INTEGER NOT NULL,
  reasons         TEXT NOT NULL,
  network         TEXT NOT NULL,
  source_pageview TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER,                           -- NULL = đến khi gỡ tay
  pushed          INTEGER NOT NULL DEFAULT 0,        -- đã đẩy lên Google Ads
  PRIMARY KEY (site_id, ip_key)
);
CREATE INDEX idx_blocks_status ON blocks(site_id, status);

-- Click Google tính tiền (click_view), để đối soát với lượt vào trang.
CREATE TABLE ad_clicks (
  gclid                TEXT PRIMARY KEY,
  site_id              TEXT NOT NULL,
  date                 TEXT NOT NULL,
  campaign_id          TEXT,
  keyword              TEXT,
  area_of_interest     TEXT,
  location_of_presence TEXT,
  imported_at          INTEGER NOT NULL
);
CREATE INDEX idx_ad_clicks_site_date ON ad_clicks(site_id, date);

CREATE TABLE job_state (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
