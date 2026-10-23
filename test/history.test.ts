import { describe, expect, it } from "vitest";
import { BUCKET_MS } from "../src/detect";
import { history } from "../src/history";
import { Store } from "../src/store";
import { createD1 } from "./helpers";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 7);

describe("history", () => {
  it("buckets cost by product and reports coverage", async () => {
    const store = new Store(createD1());
    const t = Date.UTC(2026, 9, 10, 11, 0);
    await store.saveBucket(t, [
      { product: "r2", resource: "b", metric: "class_a", value: 1, cost: 2 },
      { product: "workers", resource: "api", metric: "requests", value: 1, cost: 1 },
    ], []);
    await store.saveBucket(t + BUCKET_MS, [{ product: "workers", resource: "api", metric: "requests", value: 1, cost: 3 }], []);

    const h = await history(store, 24, 15 * 60_000, undefined, NOW);
    expect(h.keys).toEqual(["workers", "r2"]); // fixed product order, not by size
    expect(h.totals).toEqual({ workers: 4, r2: 2 });
    const i = h.times.indexOf(t);
    expect(h.series.workers[i]).toBe(4);
    expect(h.coverage[i]).toBeCloseTo(2 / 3);
    expect(h.end - h.start).toBe(24 * HOUR);
  });

  it("folds resources beyond the top five into Other", async () => {
    const store = new Store(createD1());
    const t = Date.UTC(2026, 9, 10, 11, 0);
    await store.saveBucket(
      t,
      Array.from({ length: 7 }, (_, i) => ({ product: "workers" as const, resource: `w${i}`, metric: "requests", value: 1, cost: 7 - i })),
      [],
    );
    const h = await history(store, 6, BUCKET_MS, "workers", NOW);
    expect(h.keys).toEqual(["w0", "w1", "w2", "w3", "w4", "Other"]);
    expect(h.totals.Other).toBe(2 + 1);
    expect(h.top[0]).toMatchObject({ resource: "w0", cost: 7 });
  });
});
