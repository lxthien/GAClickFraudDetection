import { describe, expect, it } from 'vitest';
import { parseIp } from '../src/shared/ip';
import { classifyNetwork } from '../src/shared/networks';
import { planBlock } from '../src/shared/policy';
import { type ScoreInput, scoreVisit } from '../src/shared/scoring';

const now = Date.UTC(2026, 10, 1, 3, 0, 0);

type Over = Partial<Omit<ScoreInput, 'visit'>> & { visit?: Partial<ScoreInput['visit']> };

function input(over: Over = {}): ScoreInput {
  return {
    network: 'vn_consumer',
    targetCountries: ['VN'],
    device: { adClicks24h: 1, distinctIps24h: 1 },
    outcome: { validConversion: false, leadStatus: null },
    now,
    ...over,
    visit: {
      botWebdriver: false, botHeadless: false, ended: true, dwellMs: 45_000, scrollPct: 60, interactions: 12,
      country: 'VN', startedAt: now - 10 * 60_000,
      ...over.visit,
    },
  };
}

const codes = (r: ReturnType<typeof scoreVisit>) => r.reasons.map((x) => x.code);

describe('chấm điểm', () => {
  it('khách đọc trang bình thường → normal, 0 điểm', () => {
    const r = scoreVisit(input());
    expect(r).toMatchObject({ score: 0, verdict: 'normal' });
  });

  it('trình duyệt tự động → block', () => {
    const r = scoreVisit(input({ visit: { botHeadless: true } }));
    expect(r.verdict).toBe('block');
    expect(codes(r)).toContain('AUTOMATION');
  });

  it('IP datacenter đơn thuần → chỉ theo dõi; thêm thoát trang nhanh → block', () => {
    expect(scoreVisit(input({ network: 'datacenter' })).verdict).toBe('watch');
    const r = scoreVisit(input({ network: 'datacenter', visit: { dwellMs: 1200, scrollPct: 0, interactions: 0 } }));
    expect(r.verdict).toBe('block');
    expect(codes(r)).toEqual(['NET_DATACENTER', 'BOUNCE']);
  });

  it('click lặp lại từ một thiết bị qua nhiều IP → block', () => {
    const r = scoreVisit(input({ device: { adClicks24h: 4, distinctIps24h: 3 } }));
    expect(codes(r)).toEqual(['DEVICE_MULTI_IP', 'REPEAT_CLICKS']);
    expect(r.verdict).toBe('block');
  });

  it('không nhận được dữ liệu kết thúc sau 30 phút → +10', () => {
    const r = scoreVisit(input({ visit: { ended: false, startedAt: now - 31 * 60_000 } }));
    expect(codes(r)).toEqual(['NO_END_SIGNAL']);
  });

  it('khách đã chuyển đổi hoặc là lead thật → miễn chặn, kể cả khi có dấu hiệu xấu', () => {
    expect(scoreVisit(input({ visit: { botHeadless: true }, outcome: { validConversion: true, leadStatus: null } })).verdict).toBe('exempt');
    expect(scoreVisit(input({ outcome: { validConversion: false, leadStatus: 'signed' } })).verdict).toBe('exempt');
  });

  it('lead bị sale đánh dấu đối thủ → block, dù từng bấm nút', () => {
    const r = scoreVisit(input({ outcome: { validConversion: true, leadStatus: 'competitor' } }));
    expect(r.verdict).toBe('block');
    expect(codes(r)).toContain('LEAD_FAKE');
  });

  it('ngưỡng riêng từng site', () => {
    const r = scoreVisit(input({ network: 'datacenter' }), { watch: 30, block: 50 });
    expect(r.verdict).toBe('block');
  });
});

describe('chính sách chặn', () => {
  const block = (over: Parameters<typeof input>[0]) => scoreVisit(input(over));

  it('nhà mạng VN: không chặn khi chỉ có tín hiệu mạng/vị trí/thoát trang', () => {
    const r = block({ visit: { country: 'KH', dwellMs: 500, scrollPct: 0, interactions: 0 } });
    expect(r.score).toBe(45);
    const strong = scoreVisit(input({ visit: { country: 'KH', dwellMs: 500, scrollPct: 0, interactions: 0 } }), { watch: 30, block: 40 });
    expect(strong.verdict).toBe('block');
    expect(planBlock(strong, parseIp('14.161.2.3')!, 'vn_consumer')).toBeNull();
  });

  it('nhà mạng VN: chặn ngắn hạn khi có bằng chứng ở mức thiết bị', () => {
    const r = block({ visit: { botWebdriver: true } });
    expect(planBlock(r, parseIp('14.161.2.3')!, 'vn_consumer')).toEqual({ ipKey: '14.161.2.3', zone: 'rotating', ttlMs: 48 * 3600_000 });
  });

  it('datacenter: chặn cả dải /24, không hết hạn', () => {
    const r = block({ network: 'datacenter', visit: { botHeadless: true } });
    expect(planBlock(r, parseIp('45.76.10.200')!, 'datacenter')).toEqual({ ipKey: '45.76.10.0/24', zone: 'fixed', ttlMs: null });
  });

  it('iCloud Private Relay: không bao giờ chặn theo IP', () => {
    const r = block({ network: 'relay', visit: { botHeadless: true } });
    expect(planBlock(r, parseIp('172.225.1.1')!, 'relay')).toBeNull();
  });
});

describe('phân loại mạng', () => {
  it('theo ASN và tên nhà mạng', () => {
    expect(classifyNetwork(16509, 'Amazon.com, Inc.')).toBe('datacenter');
    expect(classifyNetwork(36183, 'Akamai Technologies')).toBe('relay');
    expect(classifyNetwork(7552, 'Viettel Group')).toBe('vn_consumer');
    expect(classifyNetwork(45899, 'VNPT Corp')).toBe('vn_consumer');
    expect(classifyNetwork(99999, 'Some Cloud Hosting Ltd')).toBe('datacenter');
    expect(classifyNetwork(null, null, 'VN')).toBe('vn_consumer');
  });
});
