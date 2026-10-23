import type { CloudflareClient } from "./cloudflare/api";
import { r2Class, type Product } from "./pricing";

/** One usage number for one resource in one 5-minute bucket. */
export interface Sample {
  product: Product;
  resource: string;
  metric: string;
  value: number;
}

interface Window {
  start: string; // ISO, inclusive
  end: string; // ISO, exclusive
}

interface Collector {
  /** Identifies the collector in errors and /api/doctor output. */
  id: string;
  product: Product;
  /** GraphQL selection inside `accounts { ... }`. */
  selection(w: Window): string;
  parse(rows: any[]): Sample[];
}

const adaptiveFilter = (w: Window) => `filter: { datetime_geq: "${w.start}", datetime_lt: "${w.end}" }`;

// Each collector runs as its own query so a schema change or missing permission
// on one product doesn't blind the guard to the others.
export const COLLECTORS: Collector[] = [
  {
    id: "workers.invocations",
    product: "workers",
    selection: (w) => `
      rows: workersInvocationsAdaptive(limit: 10000, ${adaptiveFilter(w)}) {
        sum { requests cpuTimeUs }
        dimensions { scriptName }
      }`,
    parse: (rows) =>
      rows.flatMap((r) => [
        sample("workers", r.dimensions.scriptName, "requests", r.sum.requests),
        sample("workers", r.dimensions.scriptName, "cpu_ms", r.sum.cpuTimeUs / 1000),
      ]),
  },
  {
    id: "r2.operations",
    product: "r2",
    selection: (w) => `
      rows: r2OperationsAdaptiveGroups(limit: 10000, ${adaptiveFilter(w)}) {
        sum { requests }
        dimensions { bucketName actionType }
      }`,
    parse: (rows) =>
      rows.flatMap((r) => {
        const cls = r2Class(r.dimensions.actionType);
        return cls === "free" ? [] : [sample("r2", r.dimensions.bucketName, cls, r.sum.requests)];
      }),
  },
  {
    id: "kv.operations",
    product: "kv",
    selection: (w) => `
      rows: kvOperationsAdaptiveGroups(limit: 10000, ${adaptiveFilter(w)}) {
        sum { requests }
        dimensions { namespaceId actionType }
      }`,
    parse: (rows) => rows.map((r) => sample("kv", r.dimensions.namespaceId, kvMetric(r.dimensions.actionType), r.sum.requests)),
  },
  {
    id: "d1.queries",
    product: "d1",
    selection: (w) => `
      rows: d1AnalyticsAdaptiveGroups(limit: 10000, ${adaptiveFilter(w)}) {
        sum { rowsRead rowsWritten }
        dimensions { databaseId }
      }`,
    parse: (rows) =>
      rows.flatMap((r) => [
        sample("d1", r.dimensions.databaseId, "rows_read", r.sum.rowsRead),
        sample("d1", r.dimensions.databaseId, "rows_written", r.sum.rowsWritten),
      ]),
  },
  {
    id: "durable_objects.invocations",
    product: "durable_objects",
    selection: (w) => `
      rows: durableObjectsInvocationsAdaptiveGroups(limit: 10000, ${adaptiveFilter(w)}) {
        sum { requests }
        dimensions { namespaceId }
      }`,
    parse: (rows) => rows.map((r) => sample("durable_objects", r.dimensions.namespaceId, "requests", r.sum.requests)),
  },
  {
    id: "durable_objects.duration",
    product: "durable_objects",
    selection: (w) => `
      rows: durableObjectsPeriodicGroups(limit: 10000, filter: { datetimeMinute_geq: "${w.start}", datetimeMinute_lt: "${w.end}" }) {
        sum { activeTime }
        dimensions { namespaceId }
      }`,
    // activeTime is in microseconds; Durable Objects are billed at 128 MB.
    parse: (rows) =>
      rows.map((r) => sample("durable_objects", r.dimensions.namespaceId, "gb_s", (r.sum.activeTime / 1e6) * 0.128)),
  },
  {
    id: "queues.operations",
    product: "queues",
    selection: (w) => `
      rows: queueMessageOperationsAdaptiveGroups(limit: 10000, ${adaptiveFilter(w)}) {
        sum { billableOperations }
        dimensions { queueId }
      }`,
    parse: (rows) => rows.map((r) => sample("queues", r.dimensions.queueId, "operations", r.sum.billableOperations)),
  },
];

function sample(product: Product, resource: string | undefined, metric: string, value: unknown): Sample {
  return { product, resource: resource || "(unknown)", metric, value: Number(value) || 0 };
}

function kvMetric(actionType: string): string {
  const a = String(actionType).toLowerCase();
  if (a === "read" || a === "delete" || a === "list") return a;
  return "write"; // write, and anything unknown, at the write price
}

export interface CollectResult {
  samples: Sample[];
  errors: { collector: string; message: string }[];
}

export async function collect(
  client: CloudflareClient,
  accountId: string,
  products: Product[],
  bucketStart: number,
  bucketEnd: number,
): Promise<CollectResult> {
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error(`Invalid account id: ${accountId}`);
  const w: Window = { start: new Date(bucketStart).toISOString(), end: new Date(bucketEnd).toISOString() };
  const active = COLLECTORS.filter((c) => products.includes(c.product));

  const results = await Promise.allSettled(
    active.map(async (c) => {
      const data = await client.graphql<any>(
        `{ viewer { accounts(filter: { accountTag: "${accountId}" }) { ${c.selection(w)} } } }`,
      );
      return c.parse(data?.viewer?.accounts?.[0]?.rows ?? []);
    }),
  );

  const out: CollectResult = { samples: [], errors: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out.samples.push(...r.value);
    else out.errors.push({ collector: active[i].id, message: String(r.reason?.message ?? r.reason) });
  });
  out.samples = mergeSamples(out.samples);
  return out;
}

/** Sums samples that share product/resource/metric (e.g. several R2 actions of the same class). */
export function mergeSamples(samples: Sample[]): Sample[] {
  const map = new Map<string, Sample>();
  for (const s of samples) {
    const key = `${s.product}\u0000${s.resource}\u0000${s.metric}`;
    const existing = map.get(key);
    if (existing) existing.value += s.value;
    else map.set(key, { ...s });
  }
  return [...map.values()];
}
