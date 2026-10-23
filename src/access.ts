// Verifies Cloudflare Access JWTs so the dashboard and API can sit behind
// Access instead of (or as well as) ADMIN_TOKEN. The signature, audience,
// issuer and expiry are all checked: a request that reaches the Worker without
// passing through Access (e.g. via workers.dev) carries no valid token.

interface Jwk extends JsonWebKey {
  kid: string;
}

let cache: { teamDomain: string; keys: Jwk[]; fetchedAt: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export function normaliseTeamDomain(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
}

async function getKeys(teamDomain: string, fetchImpl: typeof fetch, force = false): Promise<Jwk[]> {
  if (!force && cache && cache.teamDomain === teamDomain && Date.now() - cache.fetchedAt < CACHE_MS) {
    return cache.keys;
  }
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  cache = { teamDomain, keys, fetchedAt: Date.now() };
  return keys;
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface AccessIdentity {
  email?: string;
  sub: string;
}

/** Returns the identity if `token` is a valid Access JWT for this application, otherwise null. */
export async function verifyAccessJwt(
  token: string,
  teamDomainRaw: string,
  aud: string,
  fetchImpl: typeof fetch = (i, init) => fetch(i, init),
  now = Date.now(),
): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const teamDomain = normaliseTeamDomain(teamDomainRaw);
  let jwk = (await getKeys(teamDomain, fetchImpl)).find((k) => k.kid === header.kid);
  // Access rotates keys; refetch once if the kid is new to us.
  if (!jwk) jwk = (await getKeys(teamDomain, fetchImpl, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;
  const nowSec = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return null;
  return { email: payload.email, sub: payload.sub };
}

export function resetAccessKeyCache() {
  cache = null;
}
