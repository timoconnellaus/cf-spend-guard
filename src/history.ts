import { BUCKET_MS } from "./detect";
import { PRODUCTS } from "./pricing";
import type { Store } from "./store";

const HOUR = 3_600_000;
const TOP_RESOURCES = 5;

/** Cost over time for the dashboard chart, plus coverage and the top resources. */
export async function history(store: Store, hours: number, stepMs: number, product: string | undefined, now: number) {
  const end = Math.floor(now / stepMs) * stepMs + stepMs;
  const start = end - hours * HOUR;
  const times: number[] = [];
  for (let t = start; t < end; t += stepMs) times.push(t);
  const index = new Map(times.map((t, i) => [t, i]));

  const rows = await store.costHistory(start, end, stepMs, product);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + r.cost);

  // Products keep a fixed order so each always gets the same colour. Within a
  // product, the top resources get their own series and the rest fold into "Other".
  let keys: string[];
  let keyOf: (k: string) => string = (k) => k;
  if (product) {
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = new Set(ranked.slice(0, TOP_RESOURCES));
    keys = ranked.slice(0, TOP_RESOURCES);
    if (ranked.length > TOP_RESOURCES) keys.push("Other");
    keyOf = (k) => (top.has(k) ? k : "Other");
  } else {
    keys = PRODUCTS.filter((p) => totals.has(p));
  }

  const series: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, new Array(times.length).fill(0)]));
  for (const r of rows) {
    const i = index.get(r.t);
    if (i !== undefined) series[keyOf(r.key)][i] += r.cost;
  }

  const perStep = stepMs / BUCKET_MS;
  const coverage = new Array(times.length).fill(0);
  for (const b of await store.collectedBuckets(start, end)) {
    const i = index.get(Math.floor(b / stepMs) * stepMs);
    if (i !== undefined) coverage[i] += 1 / perStep;
  }

  const summed = Object.fromEntries(keys.map((k) => [k, series[k].reduce((a, b) => a + b, 0)]));
  const top = await store.topResources(start, 10, product);
  return { hours, stepMs, start, end, product: product ?? null, times, keys, series, totals: summed, coverage, top };
}
