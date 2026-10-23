import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare/api";
import { collect } from "../src/collectors";
import { PRODUCTS } from "../src/pricing";
import { ACCOUNT, graphqlRows, mockFetch } from "./helpers";

const START = Date.UTC(2026, 9, 1, 12, 0);
const END = START + 5 * 60_000;

describe("collect", () => {
  it("normalises every product into samples", async () => {
    const { fn, calls } = mockFetch(
      graphqlRows({
        workersInvocationsAdaptive: [{ sum: { requests: 1000, cpuTimeUs: 5_000_000 }, dimensions: { scriptName: "api" } }],
        r2OperationsAdaptiveGroups: [
          { sum: { requests: 10 }, dimensions: { bucketName: "b", actionType: "PutObject" } },
          { sum: { requests: 5 }, dimensions: { bucketName: "b", actionType: "ListObjects" } },
          { sum: { requests: 7 }, dimensions: { bucketName: "b", actionType: "GetObject" } },
          { sum: { requests: 99 }, dimensions: { bucketName: "b", actionType: "DeleteObject" } },
        ],
        kvOperationsAdaptiveGroups: [{ sum: { requests: 3 }, dimensions: { namespaceId: "ns", actionType: "write" } }],
        d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 100, rowsWritten: 2 }, dimensions: { databaseId: "db" } }],
        durableObjectsPeriodicGroups: [{ sum: { activeTime: 10_000_000 }, dimensions: { namespaceId: "do" } }],
      }),
    );
    const r = await collect(new CloudflareClient("t", fn), ACCOUNT, PRODUCTS, START, END);

    expect(r.errors).toEqual([]);
    const get = (p: string, m: string) => r.samples.find((s) => s.product === p && s.metric === m)?.value;
    expect(get("workers", "requests")).toBe(1000);
    expect(get("workers", "cpu_ms")).toBe(5000);
    expect(get("r2", "class_a")).toBe(15); // PutObject + ListObjects merged
    expect(get("r2", "class_b")).toBe(7);
    expect(r.samples.some((s) => s.product === "r2" && s.value === 99)).toBe(false); // deletes are free
    expect(get("kv", "write")).toBe(3);
    expect(get("d1", "rows_written")).toBe(2);
    expect(get("durable_objects", "gb_s")).toBeCloseTo(1.28);

    const q = calls[0].body.query as string;
    expect(q).toContain(`accountTag: "${ACCOUNT}"`);
    expect(q).toContain(`datetime_geq: "${new Date(START).toISOString()}"`);
    expect(q).toContain(`datetime_lt: "${new Date(END).toISOString()}"`);
  });

  it("keeps going when one collector fails", async () => {
    const { fn } = mockFetch(
      (c) => (c.body?.query?.includes("kvOperationsAdaptiveGroups(") ? { errors: [{ message: "unknown field" }] } : undefined),
      graphqlRows({ workersInvocationsAdaptive: [{ sum: { requests: 1, cpuTimeUs: 0 }, dimensions: { scriptName: "api" } }] }),
    );
    const r = await collect(new CloudflareClient("t", fn), ACCOUNT, PRODUCTS, START, END);
    expect(r.errors).toEqual([{ collector: "kv.operations", message: "GraphQL: unknown field" }]);
    expect(r.samples.find((s) => s.product === "workers")?.value).toBe(1);
  });

  it("rejects a malformed account id before building a query", async () => {
    const { fn } = mockFetch();
    await expect(collect(new CloudflareClient("t", fn), 'x" }', PRODUCTS, START, END)).rejects.toThrow(/Invalid account/);
  });
});
