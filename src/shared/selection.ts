/**
 * Chọn những IP được đưa vào danh sách loại trừ của một chiến dịch (tối đa 500 ô).
 *
 * - Vùng cố định: dải datacenter, đối thủ đã xác nhận (tối đa FIXED_CAP).
 * - Vùng xoay vòng: xếp theo điểm × độ mới.
 * - Vùng dự phòng: RESERVE ô luôn dành cho các IP mới nhất trong 1 giờ qua.
 * - IP bạn tự thêm tay trong Google Ads được giữ nguyên và tính vào sức chứa.
 */
export const CAMPAIGN_CAPACITY = 500;
export const FIXED_CAP = 90;
export const RESERVE = 10;
const HALF_LIFE_MS = 24 * 3600_000;
const FRESH_MS = 3600_000;

export interface Candidate {
  ipKey: string;
  zone: 'fixed' | 'rotating';
  score: number;
  updatedAt: number;
}

export function priority(c: Candidate, now: number): number {
  const age = Math.max(0, now - c.updatedAt);
  return c.score * Math.pow(0.5, age / HALF_LIFE_MS);
}

export function selectExclusions(candidates: Candidate[], manualCount: number, now: number, capacity = CAMPAIGN_CAPACITY): string[] {
  const available = Math.max(0, capacity - manualCount);
  const byPriority = (a: Candidate, b: Candidate) => priority(b, now) - priority(a, now);

  const fixed = candidates.filter((c) => c.zone === 'fixed').sort(byPriority).slice(0, Math.min(FIXED_CAP, available));
  const chosen = new Set(fixed.map((c) => c.ipKey));

  const rotating = candidates.filter((c) => c.zone === 'rotating').sort(byPriority);
  const rotatingSlots = Math.max(0, available - chosen.size - RESERVE);
  for (const c of rotating) {
    if (chosen.size >= fixed.length + rotatingSlots) break;
    chosen.add(c.ipKey);
  }

  // Ô dự phòng: các IP mới nhất chưa được chọn.
  const fresh = rotating
    .filter((c) => !chosen.has(c.ipKey) && now - c.updatedAt <= FRESH_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const c of fresh) {
    if (chosen.size >= available) break;
    chosen.add(c.ipKey);
  }

  return [...chosen];
}
