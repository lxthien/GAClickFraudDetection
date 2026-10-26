export type Beacon =
  | {
      e: 'load';
      s: string; v: string; p: string;
      g: string | null; gb: string | null; wb: string | null;
      fp: string | null; wd: boolean; hl: boolean;
      u: string; r: string;
    }
  | { e: 'end'; s: string; v: string; p: string; t: number; sc: number; it: number; ft: number }
  | { e: 'conv'; s: string; v: string; p: string; ct: string; ok: boolean; why: string };

export const MAX_BODY_BYTES = 4096;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLICK_ID = /^[A-Za-z0-9_-]{8,256}$/;
const FP = /^[0-9a-f]{1,8}$/;
const CONV_TYPES = new Set(['call', 'zalo', 'mess', 'form']);

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const optClickId = (v: unknown): string | null => (typeof v === 'string' && CLICK_ID.test(v) ? v : null);
const int = (v: unknown, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(max, Math.max(min, n));
};

export function parseBeacon(text: string): Beacon | null {
  if (text.length > MAX_BODY_BYTES) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = o.s, v = o.v, p = o.p;
  if (typeof s !== 'string' || !ID.test(s) || typeof v !== 'string' || !ID.test(v) || typeof p !== 'string' || !ID.test(p)) {
    return null;
  }
  switch (o.e) {
    case 'load': {
      const g = optClickId(o.g), gb = optClickId(o.gb), wb = optClickId(o.wb);
      if (!g && !gb && !wb) return null; // chỉ nhận lượt có mã click quảng cáo
      return {
        e: 'load', s, v, p, g, gb, wb,
        fp: typeof o.fp === 'string' && FP.test(o.fp) ? o.fp : null,
        wd: o.wd === 1 || o.wd === true,
        hl: o.hl === 1 || o.hl === true,
        u: str(o.u, 200),
        r: str(o.r, 120),
      };
    }
    case 'end':
      return {
        e: 'end', s, v, p,
        t: int(o.t, 0, 24 * 3600_000),
        sc: int(o.sc, 0, 100),
        it: int(o.it, 0, 100_000),
        ft: int(o.ft, -1, 24 * 3600_000),
      };
    case 'conv': {
      const ct = str(o.ct, 10);
      if (!CONV_TYPES.has(ct)) return null;
      return { e: 'conv', s, v, p, ct, ok: o.ok === 1 || o.ok === true, why: str(o.why, 20) };
    }
    default:
      return null;
  }
}
