import { describe, expect, it } from 'vitest';
import { type Candidate, FIXED_CAP, RESERVE, selectExclusions } from '../src/shared/selection';

const now = 1_800_000_000_000;
const HOUR = 3600_000;
const mk = (i: number, zone: Candidate['zone'], score: number, ageH: number): Candidate => ({
  ipKey: `${zone}-${i}`, zone, score, updatedAt: now - ageH * HOUR,
});

describe('chọn IP cho 500 ô', () => {
  it('không vượt sức chứa sau khi trừ IP thêm tay, chừa 10 ô dự phòng trống', () => {
    const c = [...Array(600)].map((_, i) => mk(i, 'rotating', 80, 5));
    expect(selectExclusions(c, 30, now)).toHaveLength(500 - 30 - RESERVE);
  });

  it('vùng cố định tối đa 90 ô và được ưu tiên', () => {
    const c = [...[...Array(120)].map((_, i) => mk(i, 'fixed', 90, 1)), ...[...Array(600)].map((_, i) => mk(i, 'rotating', 100, 0))];
    const sel = selectExclusions(c, 0, now);
    expect(sel.filter((x) => x.startsWith('fixed'))).toHaveLength(FIXED_CAP);
    expect(sel).toHaveLength(500);
  });

  it('IP mới trong 1 giờ luôn có chỗ ở vùng dự phòng dù điểm thấp hơn', () => {
    const old = [...Array(600)].map((_, i) => mk(i, 'rotating', 100, 2));
    const fresh = [...Array(5)].map((_, i) => ({ ...mk(i, 'rotating', 70, 0), ipKey: `fresh-${i}` }));
    const sel = selectExclusions([...old, ...fresh], 0, now);
    expect(sel).toHaveLength(500 - RESERVE + fresh.length);
    expect(fresh.every((f) => sel.includes(f.ipKey))).toBe(true);
  });

  it('IP cũ mất ưu tiên so với IP mới cùng điểm', () => {
    const c = [mk(1, 'rotating', 80, 72), mk(2, 'rotating', 80, 3)];
    const sel = selectExclusions(c, 0, now, 11); // 11 ô - 10 dự phòng = 1 ô xoay vòng
    expect(sel[0]).toBe('rotating-2');
  });
});
