import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareClient } from "../src/cloudflare/api";
import { loadConfig, type Env } from "../src/config";
import { BUCKET_MS } from "../src/detect";
import { bucketFor, runGuard } from "../src/guard";
import { restoreScript } from "../src/killswitch";
import { Store } from "../src/store";
import { ACCOUNT, createD1, graphqlRows, mockFetch, type Call } from "./helpers";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 30);
const SLACK = "https://hooks.slack.test/x";
const ok = (result: unknown) => ({ success: true, result });

const workersRows = (requests: number, script = "api") => ({
  workersInvocationsAdaptive: [{ sum: { requests, cpuTimeUs: 0 }, dimensions: { scriptName: script } }],
});

function makeEnv(): Env {
  return { DB: createD1(), CF_API_TOKEN: "token", CF_ACCOUNT_ID: ACCOUNT, SLACK_WEBHOOK_URL: SLACK };
}

const slackPosts = (calls: Call[]) => calls.filter((c) => c.url === SLACK).map((c) => c.body.text as string);

/** Seeds `hours` of steady history ending just before the bucket the guard will collect at NOW. */
async function seedHistory(env: Env, hours: number, requestsPerBucket: number) {
  const store = new Store(env.DB);
  const current = bucketFor(NOW, 10);
  for (let i = hours * 12; i >= 1; i--) {
    const cost = requestsPerBucket * (0.3 / 1e6);
    await store.saveBucket(current - i * BUCKET_MS, [{ product: "workers", resource: "api", metric: "requests", value: requestsPerBucket, cost }], []);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("runGuard: alerts", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  it("collects quietly when nothing is wrong", async () => {
    const { fn, calls } = mockFetch(graphqlRows(workersRows(10_000)), (c) => (c.url === SLACK ? new Response("ok") : undefined));
    vi.stubGlobal("fetch", fn);
    await seedHistory(env, 25, 10_000);

    const report = await runGuard(env, loadConfig({}), NOW);
    expect(report.bucket).toBe("2026-10-10T11:45:00.000Z");
    expect(report.collectorErrors).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(slackPosts(calls)).toEqual([]);
  });

  it("alerts on a spike, then holds off during the cooldown", async () => {
    // 50M requests in 5 minutes ≈ $15 per bucket ≈ $180/hour.
    const { fn, calls } = mockFetch(graphqlRows(workersRows(50_000_000)), (c) => (c.url === SLACK ? new Response("ok") : undefined));
    vi.stubGlobal("fetch", fn);
    await seedHistory(env, 25, 10_000);

    const report = await runGuard(env, loadConfig({ monthlyBudgetUsd: 50 }), NOW);
    expect(report.alerts.map((a) => a.kind).sort()).toEqual(["anomaly", "budget", "rule"]);
    const posts = slackPosts(calls);
    expect(posts).toHaveLength(3);
    expect(posts.find((p) => p.includes("Usage spike"))).toContain("workers api (requests)");
    expect(posts.find((p) => p.includes("Spend rule breached"))).toContain("$180/hour");

    // Next bucket: still spiking, but every alert is inside its cooldown.
    await runGuard(env, loadConfig({ monthlyBudgetUsd: 50 }), NOW + BUCKET_MS);
    expect(slackPosts(calls)).toHaveLength(3);
  });

  it("doesn't flag anomalies until there is enough history", async () => {
    const { fn } = mockFetch(graphqlRows(workersRows(50_000_000)), () => new Response("ok"));
    vi.stubGlobal("fetch", fn);
    await seedHistory(env, 2, 10_000);
    const report = await runGuard(env, loadConfig({ rules: [] }), NOW);
    expect(report.alerts).toEqual([]);
  });
});

describe("kill switch", () => {
  const routes = [
    { id: "r1", pattern: "api.example.com/*", script: "api" },
    { id: "r2", pattern: "www.example.com/*", script: "web" },
  ];
  const restApi = (c: Call) => {
    const u = new URL(c.url);
    const path = u.pathname.replace("/client/v4", "");
    const scripts = `/accounts/${ACCOUNT}/workers/scripts/api`;
    if (c.method === "GET" && path === "/zones") return ok([{ id: "z1" }]);
    if (c.method === "GET" && path === "/zones/z1/workers/routes") return ok(routes);
    if (c.method === "PUT" && path.startsWith("/zones/z1/workers/routes/")) return ok({});
    if (c.method === "GET" && path === `${scripts}/subdomain`) return ok({ enabled: true });
    if (c.method === "POST" && path === `${scripts}/subdomain`) return ok({});
    if (c.method === "GET" && path === `/accounts/${ACCOUNT}/workers/domains`) {
      return ok([{ id: "d1", hostname: "api.example.com", service: "api", zone_id: "z1", environment: "production" }]);
    }
    if (path.startsWith(`/accounts/${ACCOUNT}/workers/domains`)) return ok({});
    if (c.method === "GET" && path === `${scripts}/schedules`) return ok({ schedules: [{ cron: "*/10 * * * *" }] });
    if (c.method === "PUT" && path === `${scripts}/schedules`) return ok({ schedules: [] });
    return undefined;
  };
  const mutations = (calls: Call[]) =>
    calls.filter((c) => c.method !== "GET" && c.url.includes("api.cloudflare.com") && !c.url.endsWith("/graphql"));

  const pauseConfig = (dryRun: boolean) =>
    loadConfig({
      rules: [{ name: "api runaway", match: { product: "workers", resource: "api" }, hourlyUsd: 20, action: "pause" }],
      killSwitch: { enabled: true, dryRun },
      anomaly: { enabled: false },
    });

  it("pauses the Worker when a pause rule fires, and restore undoes it", async () => {
    const env = makeEnv();
    const { fn, calls } = mockFetch(graphqlRows(workersRows(50_000_000)), restApi, () => new Response("ok"));
    vi.stubGlobal("fetch", fn);

    const report = await runGuard(env, pauseConfig(false), NOW);
    expect(report.paused).toEqual(["api"]);
    expect(mutations(calls).map((c) => [c.method, new URL(c.url).pathname.replace("/client/v4", ""), c.body])).toEqual([
      ["PUT", "/zones/z1/workers/routes/r1", { pattern: "api.example.com/*" }],
      ["POST", `/accounts/${ACCOUNT}/workers/scripts/api/subdomain`, { enabled: false }],
      ["DELETE", `/accounts/${ACCOUNT}/workers/domains/d1`, undefined],
      ["PUT", `/accounts/${ACCOUNT}/workers/scripts/api/schedules`, []],
    ]);
    expect(slackPosts(calls).join("\n")).toContain("Paused api: 1 route(s), workers.dev URL, 1 custom domain(s), 1 cron trigger(s)");

    // A second breach while paused doesn't pause again (and doesn't lose the snapshot).
    calls.length = 0;
    await runGuard(env, pauseConfig(false), NOW + BUCKET_MS);
    expect(mutations(calls)).toEqual([]);

    const store = new Store(env.DB);
    const r = await restoreScript(new CloudflareClient("token"), store, ACCOUNT, "api");
    expect(r.errors).toEqual([]);
    expect(mutations(calls).map((c) => [c.method, new URL(c.url).pathname.replace("/client/v4", ""), c.body])).toEqual([
      ["PUT", "/zones/z1/workers/routes/r1", { pattern: "api.example.com/*", script: "api" }],
      ["POST", `/accounts/${ACCOUNT}/workers/scripts/api/subdomain`, { enabled: true }],
      ["PUT", `/accounts/${ACCOUNT}/workers/domains`, { hostname: "api.example.com", service: "api", zone_id: "z1", environment: "production" }],
      ["PUT", `/accounts/${ACCOUNT}/workers/scripts/api/schedules`, [{ cron: "*/10 * * * *" }]],
    ]);
    expect(await store.listPaused()).toEqual([]);
  });

  it("changes nothing in dry-run mode", async () => {
    const env = makeEnv();
    const { fn, calls } = mockFetch(graphqlRows(workersRows(50_000_000)), restApi, () => new Response("ok"));
    vi.stubGlobal("fetch", fn);

    const report = await runGuard(env, pauseConfig(true), NOW);
    expect(report.paused).toEqual([]);
    expect(mutations(calls)).toEqual([]);
    expect(slackPosts(calls).join("\n")).toContain("DRY RUN: would pause api");
  });

  it("never pauses the guard itself", async () => {
    const env = makeEnv();
    const { fn, calls } = mockFetch(graphqlRows(workersRows(50_000_000, "cf-spend-guard")), restApi, () => new Response("ok"));
    vi.stubGlobal("fetch", fn);
    const config = loadConfig({
      rules: [{ name: "all", match: { product: "workers" }, hourlyUsd: 1, action: "pause", pause: ["cf-spend-guard"] }],
      killSwitch: { enabled: true, dryRun: false },
    });
    await runGuard(env, config, NOW);
    expect(mutations(calls)).toEqual([]);
    expect(slackPosts(calls).join("\n")).toContain("cf-spend-guard is protected");
  });
});
