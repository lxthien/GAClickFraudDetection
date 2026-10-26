export type Mode = 'off' | 'log' | 'suggest' | 'auto';

export interface Schedule {
  start?: string;          // 'YYYY-MM-DD' theo giờ Việt Nam
  end?: string;            // 'YYYY-MM-DD', tính cả ngày cuối
  hours?: [number, number]; // [từ giờ, đến giờ) theo giờ Việt Nam, ví dụ [7, 22]
}

export interface SiteModeState {
  mode: Mode;
  schedule: Schedule | null;
  followCampaigns: boolean;
  adsActive: boolean;
  warmupUntil: number | null;
}

const VN_OFFSET_MS = 7 * 3600_000; // Việt Nam không đổi giờ theo mùa

export function vnDate(now: number): { date: string; hour: number } {
  const d = new Date(now + VN_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export function inSchedule(schedule: Schedule | null, now: number): boolean {
  if (!schedule) return true;
  const { date, hour } = vnDate(now);
  if (schedule.start && date < schedule.start) return false;
  if (schedule.end && date > schedule.end) return false;
  if (schedule.hours) {
    const [from, to] = schedule.hours;
    const inside = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!inside) return false;
  }
  return true;
}

/** Chế độ thực sự áp dụng lúc này cho một site. */
export function effectiveMode(s: SiteModeState, now: number): Mode {
  if (s.mode === 'off') return 'off';
  if (!inSchedule(s.schedule, now)) return 'off';
  if (s.followCampaigns && !s.adsActive) return 'off';
  if (s.warmupUntil && now < s.warmupUntil && s.mode !== 'log') return 'log';
  return s.mode;
}
