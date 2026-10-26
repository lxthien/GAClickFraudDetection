/**
 * Google Ads API qua REST (thư viện Node chính thức dùng gRPC, không chạy được trên Workers).
 * Từ 09/09/2026 không còn cần developer token; quyền truy cập gắn với Google Cloud project của OAuth client.
 */
import type { Env } from './env';

export interface AdsCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  apiVersion: string;
}

export function credsFromEnv(env: Env): AdsCreds | null {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN) return null;
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
    apiVersion: env.GOOGLE_ADS_API_VERSION || 'v26',
  };
}

type FetchLike = typeof fetch;

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(creds: AdsCreds, f: FetchLike): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function call<T>(creds: AdsCreds, path: string, payload: unknown, f: FetchLike): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken(creds, f)}`,
    'Content-Type': 'application/json',
  };
  if (creds.loginCustomerId) headers['login-customer-id'] = creds.loginCustomerId;
  const res = await f(`https://googleads.googleapis.com/${creds.apiVersion}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Google Ads ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

/** GAQL qua searchStream; trả về mọi dòng kết quả. */
export async function search<Row = Record<string, any>>(creds: AdsCreds, customerId: string, query: string, f: FetchLike = fetch): Promise<Row[]> {
  const batches = await call<Array<{ results?: Row[] }>>(creds, `customers/${customerId}/googleAds:searchStream`, { query }, f);
  return batches.flatMap((b) => b.results ?? []);
}

export type CriterionOp =
  | { create: { campaign: string; negative: true; ipBlock: { ipAddress: string } } }
  | { remove: string };

export async function mutateCampaignCriteria(creds: AdsCreds, customerId: string, operations: CriterionOp[], f: FetchLike = fetch) {
  if (operations.length === 0) return { results: [] };
  return call<{ results?: Array<{ resourceName?: string }>; partialFailureError?: unknown }>(
    creds,
    `customers/${customerId}/campaignCriteria:mutate`,
    { operations, partialFailure: true },
    f,
  );
}

export const Q = {
  enabledSearchCampaigns: `SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'`,
  ipBlocks: `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.ip_block.ip_address FROM campaign_criterion WHERE campaign_criterion.type = 'IP_BLOCK' AND campaign.status = 'ENABLED'`,
  clickView: (date: string) =>
    `SELECT click_view.gclid, segments.date, campaign.id, click_view.keyword_info.text, click_view.area_of_interest.city, click_view.location_of_presence.city FROM click_view WHERE segments.date = '${date}'`,
};

export function _resetTokenCache(): void {
  tokenCache = null;
}
