import { describe, expect, it } from 'vitest';
import { canonicalCidr, cidrContains, ipKey, isPrivate, parseIp, prefix } from '../src/shared/ip';

describe('ip', () => {
  it('chuẩn hóa IPv4 và IPv6', () => {
    expect(parseIp('203.113.1.5')?.ip).toBe('203.113.1.5');
    expect(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')?.ip).toBe('2001:db8::1');
    expect(parseIp('::ffff:203.113.1.5')).toMatchObject({ ip: '203.113.1.5', version: 4 });
    expect(parseIp('300.1.1.1')).toBeNull();
    expect(parseIp('abc')).toBeNull();
  });

  it('IPv6 được nhận diện theo tiền tố /64', () => {
    const a = parseIp('2402:800:6314:1234:aaaa:bbbb:cccc:1')!;
    const b = parseIp('2402:800:6314:1234::9')!;
    expect(ipKey(a)).toBe('2402:800:6314:1234::/64');
    expect(ipKey(a)).toBe(ipKey(b));
  });

  it('tính dải và kiểm tra CIDR', () => {
    const ip = parseIp('45.76.10.200')!;
    expect(prefix(ip, 24)).toBe('45.76.10.0/24');
    expect(cidrContains('45.76.10.0/24', ip)).toBe(true);
    expect(cidrContains('45.76.11.0/24', ip)).toBe(false);
    expect(cidrContains('45.76.10.200', ip)).toBe(true);
    expect(canonicalCidr('45.76.10.200/32')).toBe('45.76.10.200');
    expect(canonicalCidr('2402:800:6314:1234:0:0:0:0/64')).toBe('2402:800:6314:1234::/64');
  });

  it('nhận ra IP nội bộ', () => {
    expect(isPrivate(parseIp('192.168.1.10')!)).toBe(true);
    expect(isPrivate(parseIp('fe80::1')!)).toBe(true);
    expect(isPrivate(parseIp('113.161.1.1')!)).toBe(false);
  });
});
