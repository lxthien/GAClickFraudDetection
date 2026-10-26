import { type ParsedIp, ipKey, prefix } from './ip';
import type { NetworkClass } from './networks';
import type { Reason, ScoreResult } from './scoring';

const HOUR = 3600_000;

/** Tín hiệu đủ mạnh để chặn IP của nhà mạng dân dụng VN (IP dùng chung, đổi liên tục). */
const DEVICE_LEVEL: ReadonlySet<Reason['code']> = new Set(['AUTOMATION', 'REPEAT_CLICKS', 'DEVICE_MULTI_IP', 'LEAD_FAKE']);

export interface BlockPlan {
  ipKey: string;              // IP hoặc CIDR gửi lên Google Ads
  zone: 'fixed' | 'rotating';
  ttlMs: number | null;       // null = đến khi gỡ tay
}

/**
 * Quyết định có chặn không, chặn theo khóa nào và trong bao lâu.
 * Trả về null nếu không nên chặn dù điểm cao.
 */
export function planBlock(result: ScoreResult, ip: ParsedIp, network: NetworkClass): BlockPlan | null {
  if (result.verdict !== 'block') return null;

  // iCloud Private Relay: hàng nghìn người dùng iPhone thật chung IP.
  if (network === 'relay') return null;

  // Nhà mạng VN: không chặn chỉ vì đếm click hay vị trí; cần bằng chứng ở mức thiết bị/hành vi.
  if (network === 'vn_consumer' && !result.reasons.some((r) => DEVICE_LEVEL.has(r.code))) return null;

  if (network === 'datacenter') {
    // Khách xây nhà không truy cập từ máy chủ → chặn cả dải ngay từ lần đầu.
    return { ipKey: ip.version === 4 ? prefix(ip, 24) : prefix(ip, 48), zone: 'fixed', ttlMs: null };
  }

  if (network === 'vn_consumer') return { ipKey: ipKey(ip), zone: 'rotating', ttlMs: 48 * HOUR };

  return { ipKey: ipKey(ip), zone: 'rotating', ttlMs: 7 * 24 * HOUR };
}
