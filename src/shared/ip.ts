export type IpVersion = 4 | 6;

export interface ParsedIp {
  ip: string;          // dạng chuẩn hóa
  version: IpVersion;
  value: bigint;       // giá trị số, dùng để so CIDR
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const last = groups[groups.length - 1];
    if (last !== undefined && last.includes('.')) {
      const v4 = parseV4(last);
      if (v4 === null) return null;
      groups.splice(groups.length - 1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

function formatV4(v: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => ((v >> s) & 0xffn).toString()).join('.');
}

function formatV6(v: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  // nén chuỗi số 0 dài nhất
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(':');
  const left = groups.slice(0, best).join(':');
  const right = groups.slice(best + bestLen).join(':');
  return `${left}::${right}`;
}

export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.includes(':')) {
    const v = parseV6(s);
    if (v === null) return null;
    // IPv4-mapped (::ffff:a.b.c.d) → coi như IPv4
    if (v >> 32n === 0xffffn) {
      const v4 = v & 0xffffffffn;
      return { ip: formatV4(v4), version: 4, value: v4 };
    }
    return { ip: formatV6(v), version: 6, value: v };
  }
  const v = parseV4(s);
  if (v === null) return null;
  return { ip: formatV4(v), version: 4, value: v };
}

/** Khóa nhận diện IP: IPv4 giữ nguyên, IPv6 theo tiền tố /64 (một thuê bao thường được cấp cả /64). */
export function ipKey(p: ParsedIp): string {
  if (p.version === 4) return p.ip;
  return prefix(p, 64);
}

/** Trả về CIDR chứa IP với độ dài tiền tố cho trước. */
export function prefix(p: ParsedIp, bits: number): string {
  const total = p.version === 4 ? 32 : 128;
  const shift = BigInt(total - bits);
  const net = (p.value >> shift) << shift;
  return `${p.version === 4 ? formatV4(net) : formatV6(net)}/${bits}`;
}

export function parseCidr(cidr: string): { version: IpVersion; net: bigint; bits: number } | null {
  const [addr, bitsRaw] = cidr.split('/');
  const p = parseIp(addr);
  if (!p) return null;
  const total = p.version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? total : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > total) return null;
  const shift = BigInt(total - bits);
  return { version: p.version, net: (p.value >> shift) << shift, bits };
}

/** Dạng chuẩn để so sánh: IP đơn trả về địa chỉ, dải trả về "mạng/bits". */
export function canonicalCidr(s: string): string | null {
  const c = parseCidr(s);
  if (!c) return null;
  const total = c.version === 4 ? 32 : 128;
  const addr = c.version === 4 ? formatV4(c.net) : formatV6(c.net);
  return c.bits === total ? addr : `${addr}/${c.bits}`;
}

export function cidrContains(cidr: string, ip: ParsedIp): boolean {
  const c = parseCidr(cidr);
  if (!c || c.version !== ip.version) return false;
  const shift = BigInt((ip.version === 4 ? 32 : 128) - c.bits);
  return (ip.value >> shift) << shift === c.net;
}

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];

export function isPrivate(ip: ParsedIp): boolean {
  return PRIVATE.some((c) => cidrContains(c, ip));
}
