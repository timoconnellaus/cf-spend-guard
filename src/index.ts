import { CloudflareClient } from "./cloudflare/api";
import { collect, COLLECTORS } from "./collectors";
import { ConfigError, loadConfig, type Env } from "./config";
import { BUCKET_MS, BUCKETS_PER_HOUR } from "./detect";
import { bucketFor, runGuard } from "./guard";
import { pauseScript, restoreScript, SELF_SCRIPT } from "./killswitch";
import { sendAlert } from "./notify";
import { Store } from "./store";

const DAY = 86_400_000;

export default {
  async scheduled(_controller, env) {
    const config = loadConfig(env.GUARD_CONFIG);
    const report = await runGuard(env, config);
    console.log(
      JSON.stringify({
        bucket: report.bucket,
        hourlyUsd: report.hourlyUsd,
        samples: report.samples,
        alerts: report.alerts.length,
        errors: report.collectorErrors.length,
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(
        "cf-spend-guard is running.\nAPI (Authorization: Bearer <ADMIN_TOKEN>): GET /api/status, GET /api/doctor, POST /api/run, POST /api/test-alert, POST /api/pause?script=, POST /api/restore?script=\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN secret is not set" }, 503);
    if (!authorized(request, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);

    try {
      const config = loadConfig(env.GUARD_CONFIG);
      const client = new CloudflareClient(env.CF_API_TOKEN);
      const store = new Store(env.DB);
      const route = `${request.method} ${url.pathname}`;
      const script = url.searchParams.get("script") ?? "";

      switch (route) {
        case "GET /api/status": {
          const now = Date.now();
          const runs = await store.recentRuns(BUCKETS_PER_HOUR);
          const last24h = await store.costSince(now - DAY);
          return json({
            lastBucket: runs[0] ? new Date(runs[0].bucket).toISOString() : null,
            lastRunAt: runs[0] ? new Date(runs[0].ran_at).toISOString() : null,
            currentHourlyUsd: runs[0] ? runs[0].total_cost * BUCKETS_PER_HOUR : null,
            estimatedUsdLast24h: last24h,
            topResourcesLast24h: await store.topResources(now - DAY, 10),
            recentCollectorErrors: runs.filter((r) => r.errors).map((r) => ({ bucket: new Date(r.bucket).toISOString(), errors: JSON.parse(r.errors!) })),
            paused: (await store.listPaused()).map((p) => ({ ...p, snapshot: JSON.parse(p.snapshot) })),
            recentEvents: await store.recentEvents(25),
            config,
          });
        }

        case "GET /api/doctor": {
          const checks: Record<string, unknown> = {};
          try {
            checks.token = await client.request("GET", "/user/tokens/verify");
          } catch (e) {
            checks.token = { error: (e as Error).message };
          }
          const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
          const bucket = bucketFor(Date.now(), config.lagMinutes);
          const result = await collect(client, accountId, config.products, bucket - 11 * BUCKET_MS, bucket + BUCKET_MS);
          checks.accountId = accountId;
          checks.window = `last hour ending ${new Date(bucket + BUCKET_MS).toISOString()}`;
          checks.collectors = COLLECTORS.filter((c) => config.products.includes(c.product)).map((c) => ({
            id: c.id,
            ok: !result.errors.some((e) => e.collector === c.id),
            error: result.errors.find((e) => e.collector === c.id)?.message,
          }));
          checks.samples = result.samples.length;
          checks.channels = {
            slack: !!env.SLACK_WEBHOOK_URL,
            discord: !!env.DISCORD_WEBHOOK_URL,
            webhook: !!env.ALERT_WEBHOOK_URL,
            pagerduty: !!env.PAGERDUTY_ROUTING_KEY,
          };
          return json(checks);
        }

        case "POST /api/run":
          return json(await runGuard(env, config));

        case "POST /api/test-alert": {
          const failed = await sendAlert(env, {
            key: "test",
            severity: "info",
            kind: "guard",
            title: "cf-spend-guard test alert",
            lines: ["If you can read this, alerts are wired up."],
          });
          return json({ ok: failed.length === 0, failed });
        }

        case "POST /api/pause": {
          if (!script) return json({ error: "?script= is required" }, 400);
          if (script === SELF_SCRIPT || config.killSwitch.protect.includes(script)) {
            return json({ error: `${script} is protected` }, 400);
          }
          const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
          const dryRun = url.searchParams.get("dryRun") === "1";
          const r = await pauseScript(client, store, accountId, script, "Manual pause via API", dryRun);
          await store.addEvent({ at: Date.now(), severity: "critical", kind: "kill_switch", title: `${dryRun ? "DRY RUN: would pause" : "Paused"} ${script} (manual)`, detail: JSON.stringify(r) });
          return json(r);
        }

        case "POST /api/restore": {
          if (!script) return json({ error: "?script= is required" }, 400);
          const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
          const r = await restoreScript(client, store, accountId, script);
          await store.addEvent({ at: Date.now(), severity: "info", kind: "kill_switch", title: `Restored ${script}`, detail: JSON.stringify(r) });
          return json(r, r.errors.length ? 207 : 200);
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const status = e instanceof ConfigError ? 400 : 500;
      return json({ error: (e as Error).message }, status);
    }
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const given = new TextEncoder().encode(header.replace(/^Bearer\s+/i, ""));
  const want = new TextEncoder().encode(token);
  if (given.byteLength !== want.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, want);
}
