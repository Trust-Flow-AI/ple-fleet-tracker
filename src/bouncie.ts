/**
 * Bouncie API client.
 *
 * Two things about this API will bite you if you forget them:
 *
 *  1. The Authorization header takes the RAW access token with NO "Bearer "
 *     prefix. This is the single most common first-attempt failure.
 *
 *  2. There is no client_credentials grant and (in practice) no usable refresh
 *     token. Instead the authorization code you copy out of the developer
 *     portal never expires, and you re-exchange it for a fresh access token
 *     whenever the current one 401s. That is the documented, intended pattern
 *     for a headless integration. The catch: re-running the browser authorize
 *     flow invalidates the old code, so don't do that without updating the
 *     BOUNCIE_AUTH_CODE secret.
 */

import type { Env } from './config';

const AUTH_TOKEN_URL = 'https://auth.bouncie.com/oauth/token';
const API_BASE = 'https://api.bouncie.dev/v1';

export interface BouncieVehicle {
  vin?: string;
  imei?: string;
  nickName?: string;
  standardEngine?: string;
  model?: { make?: string; name?: string; year?: number };
  stats?: {
    localTimeZone?: string;
    lastUpdated?: string;
    odometer?: number;
    // Sometimes an object, sometimes a bare address string. Yes, really.
    location?: { lat?: number; lon?: number; heading?: number; address?: string } | string;
    fuelLevel?: number;
    isRunning?: boolean;
    speed?: number;
    mil?: {
      milOn?: boolean;
      lastUpdated?: string;
      qualifiedDtcList?: Array<{ code?: string; name?: string[] }>;
    };
    battery?: { status?: string; lastUpdated?: string };
  };
}

export interface BouncieWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
}

/**
 * Every field under `stats` is routinely absent in real responses, and
 * `location` can arrive as a plain string. Treat the whole subtree as optional
 * and never index into it without a guard.
 */
export function readOdometer(v: BouncieVehicle): number | null {
  const o = v.stats?.odometer;
  return typeof o === 'number' && Number.isFinite(o) ? o : null;
}

export function readDtcCodes(v: BouncieVehicle): string[] {
  const list = v.stats?.mil?.qualifiedDtcList;
  if (!Array.isArray(list)) return [];
  return list.map((d) => d?.code).filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export function vehicleLabel(v: BouncieVehicle): string {
  if (v.nickName && v.nickName.trim()) return v.nickName.trim();
  const m = v.model;
  const parts = [m?.year, m?.make, m?.name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return v.vin ?? v.imei ?? 'Unknown vehicle';
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

async function mintAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.BOUNCIE_CLIENT_ID,
    client_secret: env.BOUNCIE_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: env.BOUNCIE_AUTH_CODE,
    redirect_uri: env.BOUNCIE_REDIRECT_URI,
  });

  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Bouncie token exchange failed (${res.status}). ` +
        `If this is a 400, the BOUNCIE_AUTH_CODE secret is probably stale — someone ` +
        `re-ran the authorize flow in the portal, which invalidates the previous code. ` +
        `Response: ${text.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Bouncie token response contained no access_token');

  // The docs never state the token lifetime, so trust expires_in and keep a
  // 5-minute safety margin. Fall back to 45 minutes if the field is missing.
  const ttl = typeof json.expires_in === 'number' ? json.expires_in : 2700;
  const expiresAt = new Date(Date.now() + Math.max(60, ttl - 300) * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO kv (k, v, expires_at) VALUES ('bouncie_token', ?1, ?2)
     ON CONFLICT(k) DO UPDATE SET v = ?1, expires_at = ?2`,
  )
    .bind(json.access_token, expiresAt)
    .run();

  return json.access_token;
}

async function getAccessToken(env: Env, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const row = await env.DB.prepare(`SELECT v, expires_at FROM kv WHERE k = 'bouncie_token'`).first<{
      v: string;
      expires_at: string;
    }>();
    if (row?.v && row.expires_at && new Date(row.expires_at) > new Date()) return row.v;
  }
  return mintAccessToken(env);
}

/** GET against the Bouncie API, retrying once on 401 with a freshly minted token. */
async function apiGet<T>(env: Env, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const attempt = async (token: string) =>
    fetch(url.toString(), {
      // NO "Bearer " prefix. See the header comment.
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });

  let res = await attempt(await getAccessToken(env));
  if (res.status === 401) res = await attempt(await getAccessToken(env, true));

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bouncie GET ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function listVehicles(env: Env): Promise<BouncieVehicle[]> {
  const out = await apiGet<BouncieVehicle[] | BouncieVehicle>(env, '/vehicles');
  return Array.isArray(out) ? out : [out];
}

export async function listWebhooks(env: Env): Promise<BouncieWebhook[]> {
  const out = await apiGet<BouncieWebhook[] | BouncieWebhook>(env, '/webhooks');
  return Array.isArray(out) ? out : [out];
}

/**
 * Re-enable a webhook Bouncie deactivated on us. Multiple developers report
 * webhooks silently flipping to active:false every few days, which is exactly
 * the kind of failure that goes unnoticed until someone asks why no oil change
 * has been scheduled in a month. The 6-hourly cron checks for this.
 */
export async function reactivateWebhook(env: Env, wh: BouncieWebhook): Promise<void> {
  const attempt = async (token: string) =>
    fetch(`${API_BASE}/webhooks/${wh.id}`, {
      method: 'PUT',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: wh.name, url: wh.url, events: wh.events, active: true }),
    });

  let res = await attempt(await getAccessToken(env));
  if (res.status === 401) res = await attempt(await getAccessToken(env, true));
  if (!res.ok) throw new Error(`Failed to reactivate webhook ${wh.id} (${res.status})`);
}

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

export type BouncieEventType =
  | 'connect' | 'disconnect' | 'battery' | 'mil' | 'vinChange'
  | 'tripStart' | 'tripData' | 'tripEnd' | 'tripMetrics'
  | 'applicationGeozone' | 'userGeozone';

export interface BouncieEvent {
  eventType: BouncieEventType;
  imei: string;
  vin?: string;
  transactionId?: string;
  connect?: { timestamp?: string };
  disconnect?: { timestamp?: string };
  battery?: { timestamp?: string; value?: string };
  // Note: the webhook MIL shape differs from the REST one — `value`/`codes`
  // (strings) here vs `milOn`/`qualifiedDtcList` (bool/array) from /vehicles.
  mil?: { timestamp?: string; value?: string; codes?: string };
  vinChange?: { timestamp?: string; oldVin?: string | null; newVin?: string | null };
  start?: { timestamp?: string; odometer?: number };
  end?: { timestamp?: string; odometer?: number; fuelConsumed?: number };
  metrics?: {
    timestamp?: string; tripTime?: number; tripDistance?: number;
    totalIdlingTime?: number; maxSpeed?: number; averageDriveSpeed?: number;
    hardBrakingCounts?: number; hardAccelerationCounts?: number;
  };
  data?: Array<{ timestamp?: string; speed?: number }>;
}

/**
 * Bouncie authenticates webhooks with a shared secret echoed back in a header —
 * there is no HMAC signature, no timestamp, no body digest. So all we can do is
 * compare the key in constant time and lean on HTTPS.
 *
 * The key arrives in BOTH `Authorization` and `X-Bouncie-Authorization`,
 * duplicated because some platforms consume or strip `Authorization`.
 */
export function verifyWebhookAuth(req: Request, expected: string): boolean {
  const presented = req.headers.get('x-bouncie-authorization') ?? req.headers.get('authorization') ?? '';
  return timingSafeEqual(presented.replace(/^Bearer\s+/i, '').trim(), expected.trim());
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare a fixed-length digest so differing lengths don't leak via timing.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && a.length > 0;
}

/** Stable dedupe key. Retries and out-of-order delivery are both normal here. */
export function eventKey(e: BouncieEvent): string {
  const ts =
    e.end?.timestamp ?? e.start?.timestamp ?? e.metrics?.timestamp ?? e.mil?.timestamp ??
    e.battery?.timestamp ?? e.connect?.timestamp ?? e.disconnect?.timestamp ??
    e.vinChange?.timestamp ?? '';
  return [e.eventType, e.imei, e.transactionId ?? '', ts].join('|');
}
