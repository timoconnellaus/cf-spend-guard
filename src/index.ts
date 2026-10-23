import { verifyAccessJwt } from "./access";
import { CloudflareClient } from "./cloudflare/api";
import { collect, COLLECTORS } from "./collectors";
import { ConfigError, loadConfig, type Env } from "./config";
import dashboard from "./dashboard.html";
import { BUCKET_MS, BUCKETS_PER_HOUR } from "./detect";
import { bucketFor, monthSummary, runGuard } from "./guard";
import { pauseScript, restoreScript, SELF_SCRIPT } from "./killswitch";
import { sendAlert } from "./notify";
import { PRODUCTS } from "./pricing";
import { history } from "./history";
import { Store } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** History ranges the dashboard offers, and the step each is drawn at. */
const RANGES: Record<string, number> = { "6": 5 * 60_000, "24": 15 * 60_000, "168": HOUR };

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
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(dashboard, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "Cache-Control": "no-store",
        },
      });
    }
    if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    const auth = await authenticate(request, env);
    if (auth.status !== 200) return json({ error: auth.error, accessConfigured: accessConfigured(env) }, auth.status);
    // Access sessions ride on a cookie, so state-changing calls must also carry a
    // custom header, which a cross-site form or fetch can't send without CORS.
    if (request.method !== "GET" && auth.via === "access" && request.headers.get("X-Guard-Request") !== "1") {
      return json({ error: "missing X-Guard-Request header" }, 403);
    }

    try {
      const config = loadConfig(env.GUARD_CONFIG);
      const client = new CloudflareClient(env.CF_API_TOKEN);
      const store = new Store(env.DB);
      const route = `${request.method} ${url.pathname}`;
      const script = url.searchParams.get("script") ?? "";
      const now = Date.now();

      switch (route) {
        case "GET /api/status": {
          const runs = await store.recentRuns(BUCKETS_PER_HOUR);
          const latest = runs[0];
          const month = latest ? await monthSummary(store, now, latest.bucket) : null;
          return json({
            viewer: auth.viewer,
            lastBucket: latest ? new Date(latest.bucket).toISOString() : null,
            lastRunAt: latest ? new Date(latest.ran_at).toISOString() : null,
            currentHourlyUsd: latest ? latest.total_cost * BUCKETS_PER_HOUR : null,
            estimatedUsdLast24h: await store.costSince(now - DAY),
            month: month && {
              monthToDateUsd: month.monthToDateUsd,
              projectedUsd: month.projectedUsd,
              avgHourlyUsd: month.avgHourlyUsd,
              budgetUsd: config.monthlyBudgetUsd ?? null,
            },
            topResourcesLast24h: await store.topResources(now - DAY, 10),
            latestCollectorErrors: latest?.errors ? JSON.parse(latest.errors) : [],
            recentCollectorErrors: runs
              .filter((r) => r.errors)
              .map((r) => ({ bucket: new Date(r.bucket).toISOString(), errors: JSON.parse(r.errors!) })),
            paused: (await store.listPaused()).map((p) => ({ ...p, snapshot: JSON.parse(p.snapshot) })),
            recentEvents: await store.recentEvents(50),
            config,
          });
        }

        case "GET /api/history": {
          const hours = url.searchParams.get("hours") ?? "24";
          const stepMs = RANGES[hours];
          if (!stepMs) return json({ error: `hours must be one of ${Object.keys(RANGES).join(", ")}` }, 400);
          const product = url.searchParams.get("product") || undefined;
          if (product && !PRODUCTS.includes(product as any)) return json({ error: `unknown product ${product}` }, 400);
          return json(await history(store, Number(hours), stepMs, product, now));
        }

        case "GET /api/doctor": {
          const checks: Record<string, unknown> = {};
          try {
            checks.token = await client.request("GET", "/user/tokens/verify");
          } catch (e) {
            checks.token = { error: (e as Error).message };
          }
          const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
          const bucket = bucketFor(now, config.lagMinutes);
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
          checks.auth = { adminToken: !!env.ADMIN_TOKEN, access: accessConfigured(env) };
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
          if (!dryRun && (await store.getPaused(script))) return json({ error: `${script} is already paused` }, 409);
          const r = await pauseScript(client, store, accountId, script, `Manual pause by ${auth.viewer}`, dryRun);
          await store.addEvent({
            at: now,
            severity: "critical",
            kind: "kill_switch",
            title: `${dryRun ? "DRY RUN: would pause" : "Paused"} ${script} (manual, ${auth.viewer})`,
            detail: JSON.stringify(r),
          });
          return json(r);
        }

        case "POST /api/restore": {
          if (!script) return json({ error: "?script= is required" }, 400);
          if (!(await store.getPaused(script))) return json({ error: `${script} is not paused by cf-spend-guard` }, 404);
          const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
          const r = await restoreScript(client, store, accountId, script);
          await store.addEvent({
            at: now,
            severity: "info",
            kind: "kill_switch",
            title: `Restored ${script} (${auth.viewer})`,
            detail: JSON.stringify(r),
          });
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

type Auth = { status: 200; viewer: string; via: "token" | "access" } | { status: 401 | 503; error: string };

function accessConfigured(env: Env): boolean {
  return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/** Accepts a Cloudflare Access login (if configured) or the ADMIN_TOKEN bearer token. */
async function authenticate(request: Request, env: Env): Promise<Auth> {
  if (!env.ADMIN_TOKEN && !accessConfigured(env)) {
    return { status: 503, error: "No auth configured: set the ADMIN_TOKEN secret, or ACCESS_TEAM_DOMAIN and ACCESS_AUD" };
  }

  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (env.ADMIN_TOKEN && bearer && timingSafeEqual(bearer, env.ADMIN_TOKEN)) return { status: 200, viewer: "admin token", via: "token" };

  if (accessConfigured(env)) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
    if (jwt) {
      try {
        const id = await verifyAccessJwt(jwt, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!);
        if (id) return { status: 200, viewer: id.email ?? id.sub, via: "access" };
      } catch (e) {
        console.error("Access JWT verification failed:", (e as Error).message);
      }
    }
  }
  return { status: 401, error: "unauthorized" };
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
