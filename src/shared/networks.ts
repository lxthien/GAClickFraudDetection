/**
 * Phân loại mạng theo ASN và tên nhà mạng (Cloudflare gửi kèm mỗi request, không tốn thêm lệnh gọi).
 *
 * - datacenter: máy chủ, hosting, cloud → khách xây nhà không truy cập từ đây.
 * - vpn: dịch vụ VPN/proxy thương mại, Cloudflare WARP.
 * - relay: iCloud Private Relay → nhiều người dùng iPhone thật chung IP, KHÔNG BAO GIỜ chặn theo IP.
 * - vn_consumer: nhà mạng dân dụng/di động VN → IP dùng chung và đổi liên tục, chặn ngắn hạn, không chặn dải.
 */
export type NetworkClass = 'datacenter' | 'vpn' | 'relay' | 'vn_consumer' | 'other';

const DATACENTER_ASN = new Set<number>([
  16509, 14618,        // Amazon AWS
  396982, 19527,       // Google Cloud
  8075,                // Microsoft Azure
  14061,               // DigitalOcean
  16276,               // OVH
  24940,               // Hetzner
  63949,               // Linode / Akamai Connected Cloud
  20473,               // Vultr (Choopa)
  45102, 37963,        // Alibaba Cloud
  132203, 45090,       // Tencent Cloud
  31898,               // Oracle Cloud
  51167,               // Contabo
  60781, 28753,        // Leaseweb
  12876,               // Scaleway
  36352,               // ColoCrossing
]);

const VPN_ASN = new Set<number>([
  9009,                // M247 (nhiều VPN thương mại)
  212238,              // Datacamp (CDN77 / VPN)
  13335,               // Cloudflare (WARP)
]);

const RELAY_ASN = new Set<number>([
  36183,               // Akamai — iCloud Private Relay
  54113,               // Fastly — iCloud Private Relay
]);

const DATACENTER_WORDS = /\b(hosting|host|datacenter|data center|data-center|server|vps|cloud|colo|dedicated)\b/i;
const VN_CONSUMER_WORDS = /(viettel|vnpt|vietnam posts|mobifone|vinaphone|vietnamobile|fpt telecom|cmc telecom|sctv|hai tele|gtel)/i;

export function classifyNetwork(asn: number | null | undefined, asOrg: string | null | undefined, country?: string | null): NetworkClass {
  if (asn != null) {
    if (RELAY_ASN.has(asn)) return 'relay';
    if (VPN_ASN.has(asn)) return 'vpn';
    if (DATACENTER_ASN.has(asn)) return 'datacenter';
  }
  const org = asOrg ?? '';
  if (VN_CONSUMER_WORDS.test(org)) return 'vn_consumer';
  if (DATACENTER_WORDS.test(org)) return 'datacenter';
  if (country === 'VN') return 'vn_consumer';
  return 'other';
}
