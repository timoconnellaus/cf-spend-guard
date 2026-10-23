import { beforeEach, describe, expect, it } from "vitest";
import { normaliseTeamDomain, resetAccessKeyCache, verifyAccessJwt } from "../src/access";
import { mockFetch } from "./helpers";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 9, 10, 12, 0);

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function setup() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const { fn, calls } = mockFetch((c) => (c.url === `https://${TEAM}/cdn-cgi/access/certs` ? { keys: [jwk] } : undefined));
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { fn, calls, sign };
}

const good = { aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, email: "me@example.com", sub: "u1" };

describe("verifyAccessJwt", () => {
  beforeEach(() => resetAccessKeyCache());

  it("accepts a valid token and caches the keys", async () => {
    const { fn, calls, sign } = await setup();
    const token = await sign(good);
    expect(await verifyAccessJwt(token, "acme", AUD, fn, NOW)).toEqual({ email: "me@example.com", sub: "u1" });
    await verifyAccessJwt(token, "acme", AUD, fn, NOW);
    expect(calls).toHaveLength(1);
  });

  it("rejects the wrong audience, issuer, expiry or kid", async () => {
    const { fn, sign } = await setup();
    expect(await verifyAccessJwt(await sign({ ...good, aud: ["other"] }), TEAM, AUD, fn, NOW)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD, fn, NOW)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good, exp: NOW / 1000 - 1 }), TEAM, AUD, fn, NOW)).toBeNull();
    expect(await verifyAccessJwt(await sign(good, "unknown"), TEAM, AUD, fn, NOW)).toBeNull();
  });

  it("rejects a tampered or unsigned token", async () => {
    const { fn, sign } = await setup();
    const [h, , s] = (await sign(good)).split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...good, email: "attacker@example.com" }))}.${s}`;
    expect(await verifyAccessJwt(forged, TEAM, AUD, fn, NOW)).toBeNull();
    const none = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(good))}.`;
    expect(await verifyAccessJwt(none, TEAM, AUD, fn, NOW)).toBeNull();
    expect(await verifyAccessJwt("garbage", TEAM, AUD, fn, NOW)).toBeNull();
  });

  it("normalises team domains", () => {
    expect(normaliseTeamDomain("acme")).toBe(TEAM);
    expect(normaliseTeamDomain(`https://${TEAM}/`)).toBe(TEAM);
  });
});
