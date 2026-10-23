// List prices (USD) for the usage the guard tracks, per single unit.
// Source: Cloudflare pricing pages for the Workers Paid plan. Included
// allowances (e.g. the first 10M Worker requests) are deliberately ignored, so
// estimates are an upper bound on marginal cost — which is what you want when
// looking for a runaway. Override any value with GUARD_CONFIG.prices.

export type Product = "workers" | "r2" | "kv" | "d1" | "durable_objects" | "queues";

export const PRODUCTS: Product[] = ["workers", "r2", "kv", "d1", "durable_objects", "queues"];

export type PriceTable = Record<string, number>;

const PER_MILLION = 1 / 1_000_000;

export const DEFAULT_PRICES: PriceTable = {
  "workers.requests": 0.3 * PER_MILLION,
  "workers.cpu_ms": 0.02 * PER_MILLION,
  "r2.class_a": 4.5 * PER_MILLION,
  "r2.class_b": 0.36 * PER_MILLION,
  "kv.read": 0.5 * PER_MILLION,
  "kv.write": 5 * PER_MILLION,
  "kv.delete": 5 * PER_MILLION,
  "kv.list": 5 * PER_MILLION,
  "d1.rows_read": 0.001 * PER_MILLION,
  "d1.rows_written": 1 * PER_MILLION,
  "durable_objects.requests": 0.15 * PER_MILLION,
  // $12.50 per million GB-seconds; objects are billed at 128 MB.
  "durable_objects.gb_s": 12.5 * PER_MILLION,
  "queues.operations": 0.4 * PER_MILLION,
};

export function priceOf(prices: PriceTable, product: Product, metric: string): number {
  return prices[`${product}.${metric}`] ?? 0;
}

// R2 operation classes: https://developers.cloudflare.com/r2/pricing/
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

/** Maps an R2 actionType to its billing class. Unknown actions count as Class A (the expensive one). */
export function r2Class(actionType: string): "class_a" | "class_b" | "free" {
  if (R2_FREE.has(actionType)) return "free";
  if (R2_CLASS_B.has(actionType)) return "class_b";
  return "class_a";
}
