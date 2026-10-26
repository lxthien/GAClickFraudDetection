-- Lượt thử nghiệm: gclid/gbraid/wbraid bắt đầu bằng "TEST_".
-- Vẫn được chấm điểm (để kiểm tra bộ phát hiện) nhưng không bao giờ tạo lệnh chặn, whitelist,
-- và không tính vào thống kê hay hồ sơ hoàn tiền.
ALTER TABLE visits ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
UPDATE visits SET is_test = 1
 WHERE gclid LIKE 'TEST\_%' ESCAPE '\' OR gbraid LIKE 'TEST\_%' ESCAPE '\' OR wbraid LIKE 'TEST\_%' ESCAPE '\';
CREATE INDEX idx_visits_site_test ON visits(site_id, is_test, started_at);
