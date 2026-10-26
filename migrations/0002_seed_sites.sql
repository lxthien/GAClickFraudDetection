-- Khai báo sẵn 3 website, mỗi website một tài khoản Google Ads riêng.
-- Chế độ "log" (chỉ ghi log). Sửa tiếp trong trang quản lý /ui (ID tài khoản Google Ads, lịch, chế độ...).
-- site_key là khóa công khai (nằm trong tag GTM), không phải bí mật.
INSERT OR IGNORE INTO sites (id, name, site_key, domains, mode, share_group, created_at, updated_at) VALUES
  ('kientruckimanh', 'Kiến Trúc Kim Anh', 'kta_6wwiVEehc-JI',  '["kientruckimanh.com"]', 'log', 'kim-anh', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('xaydungkimanh',  'Xây Dựng Kim Anh',  'xdka_9_IjjvxvxB-0', '["xaydungkimanh.com"]',  'log', 'kim-anh', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('xaydungminhduy', 'Xây Dựng Minh Duy', 'xdmd_6Lkxe6VWfeRA', '["xaydungminhduy.com"]', 'log', NULL,      CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
