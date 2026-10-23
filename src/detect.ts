import type { AnomalyConfig, Match, Rule } from "./config";
import type { CostedSample, SeriesKey } from "./store";

export const BUCKET_MS = 5 * 60 * 1000;
export const BUCKETS_PER_HOUR = 12;

export function matches(m: Match | undefined, s: CostedSample): boolean {
  if (!m) return true;
  const ok = (want: string | undefined, have: string) => want === undefined || want === "*" || want === have;
  return ok(m.product, s.product) && ok(m.resource, s.resource) && ok(m.metric, s.metric);
}

export function hourlyCost(rule: Rule, samples: CostedSample[]): number {
  return samples.filter((s) => matches(rule.match, s)).reduce((sum, s) => sum + s.cost, 0) * BUCKETS_PER_HOUR;
}

export interface RuleBreach {
  rule: Rule;
  hourlyUsd: number;
  /** The matched series that cost the most this bucket, largest first. */
  top: CostedSample[];
}

/**
 * Evaluates rules against the current bucket. `previous` holds the samples for
 * the buckets before it, most recent first, and is used for sustainedBuckets.
 */
export function evaluateRules(rules: Rule[], current: CostedSample[], previous: CostedSample[][]): RuleBreach[] {
  const breaches: RuleBreach[] = [];
  for (const rule of rules) {
    const hourly = hourlyCost(rule, current);
    if (hourly <= rule.hourlyUsd) continue;
    const sustained = Math.max(1, rule.sustainedBuckets ?? 1);
    const earlier = previous.slice(0, sustained - 1);
    if (earlier.length < sustained - 1) continue;
    if (!earlier.every((bucket) => hourlyCost(rule, bucket) > rule.hourlyUsd)) continue;
    const top = current
      .filter((s) => matches(rule.match, s))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5);
    breaches.push({ rule, hourlyUsd: hourly, top });
  }
  return breaches;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface AnomalyVerdict {
  anomalous: boolean;
  value: number;
  median: number;
  /** Robust z-score: (value - median) / (1.4826 × MAD). */
  z: number;
  ratio: number;
  excessHourlyUsd: number;
}

/**
 * Robust spike test against a baseline. Missing buckets must already be
 * filled in as zeros. `unitPrice` converts the metric to USD.
 */
export function detectAnomaly(value: number, baseline: number[], unitPrice: number, cfg: AnomalyConfig): AnomalyVerdict {
  const med = median(baseline);
  const mad = median(baseline.map((v) => Math.abs(v - med)));
  // A flat baseline (MAD = 0) is common for quiet resources; fall back to 10%
  // of the median, or 1 unit, so a single tick of usage isn't infinitely surprising.
  const sigma = 1.4826 * mad || Math.max(med * 0.1, 1);
  const z = (value - med) / sigma;
  const ratio = med > 0 ? value / med : value > 0 ? Infinity : 1;
  const excessHourlyUsd = Math.max(0, value - med) * unitPrice * BUCKETS_PER_HOUR;
  return {
    anomalous: ratio >= cfg.ratio && z >= cfg.zScore && excessHourlyUsd >= cfg.minExcessHourlyUsd,
    value,
    median: med,
    z,
    ratio,
    excessHourlyUsd,
  };
}

/** Builds a dense baseline: one value per collected bucket, zero where the series had no usage. */
export function denseBaseline(collected: number[], history: Map<number, number>): number[] {
  return collected.map((b) => history.get(b) ?? 0);
}

/** Series worth testing: anything whose whole current cost could clear the excess floor. */
export function anomalyCandidates(current: CostedSample[], cfg: AnomalyConfig): SeriesKey[] {
  return current
    .filter((s) => s.cost * BUCKETS_PER_HOUR >= cfg.minExcessHourlyUsd)
    .map(({ product, resource, metric }) => ({ product, resource, metric }));
}

export interface MonthProjection {
  monthToDateUsd: number;
  projectedUsd: number;
  monthStart: number;
}

export function projectMonth(now: number, monthToDateUsd: number, currentHourlyUsd: number): MonthProjection {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const hoursLeft = (monthEnd - now) / 3_600_000;
  return { monthToDateUsd, projectedUsd: monthToDateUsd + currentHourlyUsd * hoursLeft, monthStart };
}
