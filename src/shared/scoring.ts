import type { NetworkClass } from './networks';

export type LeadStatus = 'new' | 'real' | 'unreachable' | 'fake' | 'competitor' | 'signed';
export type Verdict = 'normal' | 'watch' | 'block' | 'exempt';

export type ReasonCode =
  | 'NET_DATACENTER'      // IP máy chủ / hosting
  | 'NET_VPN'             // VPN, proxy
  | 'NET_RELAY'           // iCloud Private Relay (chỉ ghi nhận, rất ít điểm)
  | 'OUT_OF_AREA'         // ngoài quốc gia nhắm mục tiêu
  | 'AUTOMATION'          // trình duyệt tự động (webdriver, headless)
  | 'DEVICE_MULTI_IP'     // một thiết bị dùng từ 3 IP trong 24 giờ
  | 'BOUNCE'              // hiển thị dưới 3 giây, không cuộn, không chạm
  | 'NO_END_SIGNAL'       // không nhận được dữ liệu kết thúc sau 30 phút
  | 'REPEAT_CLICKS'       // cùng thiết bị click quảng cáo từ 3 lần trong 24 giờ
  | 'LEAD_FAKE'           // sale đánh dấu lead giả / đối thủ
  | 'EXEMPT_CONVERSION';  // đã chuyển đổi thật → miễn chặn

export interface Reason {
  code: ReasonCode;
  points: number;
  detail?: string;
}

export interface ScoreInput {
  visit: {
    botWebdriver: boolean;
    botHeadless: boolean;
    ended: boolean;
    dwellMs: number | null;
    scrollPct: number | null;
    interactions: number | null;
    country: string | null;
    startedAt: number;
  };
  network: NetworkClass;
  targetCountries: string[];
  device: {
    adClicks24h: number;     // gồm cả lượt đang chấm
    distinctIps24h: number;
  };
  outcome: {
    validConversion: boolean;
    leadStatus: LeadStatus | null;
  };
  now: number;
}

export interface ScoreResult {
  score: number;
  verdict: Verdict;
  reasons: Reason[];
}

export interface Thresholds {
  watch: number;
  block: number;
}

/** Điểm khởi đầu — sẽ chỉnh lại theo dữ liệu thật sau 2 tuần ghi log. */
export const DEFAULT_WEIGHTS: Record<Exclude<ReasonCode, 'EXEMPT_CONVERSION'>, number> = {
  NET_DATACENTER: 60,
  NET_VPN: 30,
  NET_RELAY: 5,
  OUT_OF_AREA: 20,
  AUTOMATION: 70,
  DEVICE_MULTI_IP: 30,
  BOUNCE: 25,
  NO_END_SIGNAL: 10,
  REPEAT_CLICKS: 40,
  LEAD_FAKE: 80,
};

export const BOUNCE_MS = 3000;
export const NO_END_AFTER_MS = 30 * 60 * 1000;

export function scoreVisit(
  input: ScoreInput,
  thresholds: Thresholds = { watch: 40, block: 70 },
  weights = DEFAULT_WEIGHTS,
): ScoreResult {
  const { visit, outcome } = input;
  const reasons: Reason[] = [];
  const add = (code: Exclude<ReasonCode, 'EXEMPT_CONVERSION'>, detail?: string) =>
    reasons.push({ code, points: weights[code], ...(detail ? { detail } : {}) });

  const fakeLead = outcome.leadStatus === 'fake' || outcome.leadStatus === 'competitor';
  const realLead = outcome.leadStatus === 'real' || outcome.leadStatus === 'signed';

  // Khách thật đã được xác nhận → không bao giờ chặn.
  if (!fakeLead && (realLead || outcome.validConversion)) {
    return {
      score: 0,
      verdict: 'exempt',
      reasons: [{ code: 'EXEMPT_CONVERSION', points: 0, detail: realLead ? `lead:${outcome.leadStatus}` : 'conversion' }],
    };
  }

  if (input.network === 'datacenter') add('NET_DATACENTER');
  else if (input.network === 'vpn') add('NET_VPN');
  else if (input.network === 'relay') add('NET_RELAY');

  if (visit.country && input.targetCountries.length > 0 && !input.targetCountries.includes(visit.country)) {
    add('OUT_OF_AREA', visit.country);
  }

  if (visit.botWebdriver || visit.botHeadless) add('AUTOMATION', visit.botWebdriver ? 'webdriver' : 'headless');

  if (input.device.distinctIps24h >= 3) add('DEVICE_MULTI_IP', `${input.device.distinctIps24h} IP`);

  if (visit.ended) {
    const shortStay = (visit.dwellMs ?? 0) < BOUNCE_MS;
    const noScroll = (visit.scrollPct ?? 0) === 0;
    const noTouch = (visit.interactions ?? 0) === 0;
    if (shortStay && noScroll && noTouch) add('BOUNCE', `${visit.dwellMs ?? 0} ms`);
  } else if (input.now - visit.startedAt >= NO_END_AFTER_MS) {
    add('NO_END_SIGNAL');
  }

  if (input.device.adClicks24h >= 3) add('REPEAT_CLICKS', `${input.device.adClicks24h} click`);

  if (fakeLead) add('LEAD_FAKE', `lead:${outcome.leadStatus}`);

  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  const verdict: Verdict = score >= thresholds.block ? 'block' : score >= thresholds.watch ? 'watch' : 'normal';
  return { score, verdict, reasons };
}
