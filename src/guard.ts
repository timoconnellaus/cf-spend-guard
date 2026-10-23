import { CloudflareClient } from "./cloudflare/api";
import { collect, type CollectResult } from "./collectors";
import { pauseTargets, type Env, type GuardConfig } from "./config";
import {
  anomalyCandidates,
  BUCKET_MS,
  BUCKETS_PER_HOUR,
  denseBaseline,
  detectAnomaly,
  evaluateRules,
  projectMonth,
} from "./detect";
import { pauseScript, SELF_SCRIPT } from "./killswitch";
import { sendAlert, usd, type Alert } from "./notify";
import { priceOf } from "./pricing";
import { Store, type CostedSample } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Consecutive runs with collector errors before the guard warns that it may be blind. */
const BLIND_AFTER_RUNS = 3;

export interface RunReport {
  bucket: string;
  accountId: string;
  hourlyUsd: number;
  samples: number;
  collectorErrors: CollectResult["errors"];
  alerts: Alert[];
  paused: string[];
}

export function bucketFor(now: number, lagMinutes: number): number {
  return Math.floor((now - lagMinutes * 60_000) / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
}

export async function runGuard(env: Env, config: GuardConfig, now = Date.now()): Promise<RunReport> {
  const client = new CloudflareClient(env.CF_API_TOKEN);
  const store = new Store(env.DB);
  const accountId = await client.resolveAccountId(env.CF_ACCOUNT_ID || config.accountId);
  const bucket = bucketFor(now, config.lagMinutes);

  const result = await collect(client, accountId, config.products, bucket, bucket + BUCKET_MS);
  const current: CostedSample[] = result.samples.map((s) => ({
    ...s,
    cost: s.value * priceOf(config.prices, s.product, s.metric),
  }));
  await store.saveBucket(bucket, current, result.errors);
  for (const e of result.errors) console.error(`collector ${e.collector} failed: ${e.message}`);

  const alerts: Alert[] = [];
  const paused: string[] = [];
  const hourlyUsd = current.reduce((sum, s) => sum + s.cost, 0) * BUCKETS_PER_HOUR;
  const when = new Date(bucket).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  // 1. Hard rules.
  const maxSustained = Math.max(1, ...config.rules.map((r) => r.sustainedBuckets ?? 1));
  const prevBuckets = Array.from({ length: maxSustained - 1 }, (_, i) => bucket - (i + 1) * BUCKET_MS);
  const prevMap = await store.samplesForBuckets(prevBuckets);
  const collectedPrev = new Set(await store.collectedBuckets(bucket - maxSustained * BUCKET_MS, bucket));
  const previous = prevBuckets.filter((b) => collectedPrev.has(b)).map((b) => prevMap.get(b) ?? []);

  for (const breach of evaluateRules(config.rules, current, previous)) {
    const { rule } = breach;
    const wantsPause = rule.action === "pause";
    const lines = [
      `Burning ~${usd(breach.hourlyUsd)}/hour (limit ${usd(rule.hourlyUsd)}/hour) in the bucket starting ${when}.`,
      ...breach.top.map((s) => `• ${s.product} ${s.resource} ${s.metric}: ${fmt(s.value)} → ${usd(s.cost * BUCKETS_PER_HOUR)}/h`),
    ];
    if (wantsPause) {
      for (const script of pauseTargets(rule)) {
        lines.push(await runKillSwitch(client, store, config, accountId, script, rule.name, paused));
      }
    }
    alerts.push({ key: `rule:${rule.name}`, severity: "critical", kind: "rule", title: `Spend rule breached: ${rule.name}`, lines });
  }

  // 2. Anomalies against the recent baseline.
  if (config.anomaly.enabled) {
    const since = bucket - config.anomaly.baselineDays * DAY;
    const collected = await store.collectedBuckets(since, bucket);
    if (collected.length * BUCKET_MS >= config.anomaly.minHistoryHours * HOUR) {
      for (const key of anomalyCandidates(current, config.anomaly)) {
        const s = current.find((c) => c.product === key.product && c.resource === key.resource && c.metric === key.metric)!;
        const history = await store.seriesHistory(key, since, bucket);
        const v = detectAnomaly(s.value, denseBaseline(collected, history), priceOf(config.prices, s.product, s.metric), config.anomaly);
        if (!v.anomalous) continue;
        alerts.push({
          key: `anomaly:${key.product}:${key.resource}:${key.metric}`,
          severity: "warning",
          kind: "anomaly",
          title: `Usage spike: ${key.product} ${key.resource} (${key.metric})`,
          lines: [
            `${fmt(v.value)} ${key.metric} in the bucket starting ${when}; the usual is ${fmt(v.median)}` +
              (Number.isFinite(v.ratio) ? ` (${v.ratio.toFixed(1)}×).` : "."),
            `Extra spend if it keeps up: ~${usd(v.excessHourlyUsd)}/hour, ~${usd(v.excessHourlyUsd * 24)}/day.`,
          ],
        });
      }
    }
  }

  // 3. Monthly budget, projected from the last 24 hours' average.
  if (config.monthlyBudgetUsd) {
    const { monthStart } = projectMonth(now, 0, 0);
    const mtd = await store.costSince(monthStart);
    const dayCollected = await store.collectedBuckets(bucket - DAY + BUCKET_MS, bucket + BUCKET_MS);
    const dayCost = await store.costSince(bucket - DAY + BUCKET_MS);
    const avgHourly = dayCollected.length ? (dayCost / dayCollected.length) * BUCKETS_PER_HOUR : 0;
    const p = projectMonth(now, mtd, avgHourly);
    if (p.projectedUsd > config.monthlyBudgetUsd) {
      alerts.push({
        key: `budget:${new Date(monthStart).toISOString().slice(0, 7)}`,
        severity: mtd > config.monthlyBudgetUsd ? "critical" : "warning",
        kind: "budget",
        cooldownMinutes: 24 * 60,
        title: `On track to exceed the ${usd(config.monthlyBudgetUsd)} monthly budget`,
        lines: [
          `Estimated usage so far this month: ${usd(mtd)}. Projected: ${usd(p.projectedUsd)} at the last 24h average (${usd(avgHourly)}/hour).`,
        ],
      });
    }
  }

  // 4. Warn if collectors keep failing; a guard that can't see is worse than none.
  if (result.errors.length) {
    const runs = await store.recentRuns(BLIND_AFTER_RUNS);
    if (runs.length >= BLIND_AFTER_RUNS && runs.every((r) => r.errors)) {
      alerts.push({
        key: "guard:collector-errors",
        severity: "warning",
        kind: "guard",
        title: "cf-spend-guard can't read some usage data",
        lines: result.errors.map((e) => `• ${e.collector}: ${e.message}`),
      });
    }
  }

  await deliver(env, store, config, alerts, now);
  await store.prune(now - config.retentionDays * DAY);

  return {
    bucket: new Date(bucket).toISOString(),
    accountId,
    hourlyUsd,
    samples: current.length,
    collectorErrors: result.errors,
    alerts,
    paused,
  };
}

async function runKillSwitch(
  client: CloudflareClient,
  store: Store,
  config: GuardConfig,
  accountId: string,
  script: string,
  ruleName: string,
  paused: string[],
): Promise<string> {
  if (!config.killSwitch.enabled) return `Kill switch is disabled; would pause ${script}.`;
  if (script === SELF_SCRIPT || config.killSwitch.protect.includes(script)) return `${script} is protected; not paused.`;
  if (!config.killSwitch.dryRun && (await store.getPaused(script))) return `${script} is already paused.`;
  const r = await pauseScript(client, store, accountId, script, `Rule: ${ruleName}`, config.killSwitch.dryRun);
  const what = [
    r.snapshot.routes.length && `${r.snapshot.routes.length} route(s)`,
    r.snapshot.workersDev && "workers.dev URL",
    r.snapshot.domains.length && `${r.snapshot.domains.length} custom domain(s)`,
    r.snapshot.schedules.length && `${r.snapshot.schedules.length} cron trigger(s)`,
  ].filter(Boolean);
  const verb = r.dryRun ? "DRY RUN: would pause" : "Paused";
  if (!r.dryRun) paused.push(script);
  await store.addEvent({
    at: Date.now(),
    severity: "critical",
    kind: "kill_switch",
    title: `${verb} ${script}`,
    detail: JSON.stringify({ rule: ruleName, ...r }),
  });
  return (
    `🛑 ${verb} ${script}: ${what.join(", ") || "nothing attached"}.` +
    (r.errors.length ? ` Errors: ${r.errors.join("; ")}` : "") +
    (r.dryRun ? "" : ` Restore with POST /api/restore?script=${encodeURIComponent(script)}`)
  );
}

async function deliver(env: Env, store: Store, config: GuardConfig, alerts: Alert[], now: number) {
  for (const alert of alerts) {
    // Kill-switch actions always notify; everything else respects the cooldown.
    const force = alert.lines.some((l) => l.startsWith("🛑"));
    if (!force && !(await store.claimAlert(alert.key, now, (alert.cooldownMinutes ?? config.alerts.cooldownMinutes) * 60_000))) continue;
    await store.addEvent({ at: now, severity: alert.severity, kind: alert.kind, title: alert.title, detail: alert.lines.join("\n") });
    const failed = await sendAlert(env, alert);
    if (failed.length) console.error(`Alert "${alert.title}" failed to send via: ${failed.join(", ")}`);
  }
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n % 1 ? 2 : 0);
}
