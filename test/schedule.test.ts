import { describe, expect, it } from 'vitest';
import { effectiveMode, inSchedule } from '../src/shared/schedule';

// 2026-11-01 10:00 giờ Việt Nam = 03:00 UTC
const t = Date.UTC(2026, 10, 1, 3, 0, 0);
const base = { mode: 'auto' as const, schedule: null, followCampaigns: true, adsActive: true, warmupUntil: null };

describe('lịch và chế độ từng site', () => {
  it('lịch theo ngày và khung giờ Việt Nam', () => {
    expect(inSchedule({ start: '2026-11-01' }, t)).toBe(true);
    expect(inSchedule({ start: '2026-11-02' }, t)).toBe(false);
    expect(inSchedule({ end: '2026-10-31' }, t)).toBe(false);
    expect(inSchedule({ hours: [8, 22] }, t)).toBe(true);
    expect(inSchedule({ hours: [12, 22] }, t)).toBe(false);
    expect(inSchedule({ hours: [22, 6] }, t)).toBe(false);
  });

  it('site tự "ngủ" khi mọi chiến dịch tạm dừng', () => {
    expect(effectiveMode({ ...base, adsActive: false }, t)).toBe('off');
    expect(effectiveMode({ ...base, adsActive: false, followCampaigns: false }, t)).toBe('auto');
  });

  it('sau khi chạy lại quảng cáo: chỉ ghi log tới hết thời gian làm nóng', () => {
    expect(effectiveMode({ ...base, warmupUntil: t + 1 }, t)).toBe('log');
    expect(effectiveMode({ ...base, warmupUntil: t - 1 }, t)).toBe('auto');
  });
});
