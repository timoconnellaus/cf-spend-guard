import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Rule } from "../src/config";
import { detectAnomaly, evaluateRules, median, projectMonth } from "../src/detect";
import type { CostedSample } from "../src/store";

const s = (resource: string, cost: number, product: any = "workers", metric = "requests"): CostedSample => ({
  product,
  resource,
  metric,
  value: cost * 1e6,
  cost,
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("detectAnomaly", () => {
  const cfg = DEFAULT_CONFIG.anomaly;
  const price = 0.3 / 1e6; // Worker requests
  const baseline = Array.from({ length: 2000 }, (_, i) => 10_000 + (i % 10) * 100);

  it("ignores normal traffic", () => {
    expect(detectAnomaly(11_000, baseline, price, cfg).anomalous).toBe(false);
  });

  it("flags a large, expensive spike", () => {
    // 50M requests in 5 minutes ≈ $180/hour.
    const v = detectAnomaly(50_000_000, baseline, price, cfg);
    expect(v.anomalous).toBe(true);
    expect(v.excessHourlyUsd).toBeGreaterThan(150);
  });

  it("ignores a relative spike that is too cheap to matter", () => {
    // 100× the baseline, but only ~$3.6/hour... raise the floor to $5.
    const v = detectAnomaly(1_000_000, baseline, price, { ...cfg, minExcessHourlyUsd: 5 });
    expect(v.ratio).toBeGreaterThan(50);
    expect(v.anomalous).toBe(false);
  });

  it("works when the baseline is all zeros", () => {
    const v = detectAnomaly(10_000_000, new Array(500).fill(0), price, cfg);
    expect(v.ratio).toBe(Infinity);
    expect(v.anomalous).toBe(true);
  });
});

describe("evaluateRules", () => {
  const accountRule: Rule = { name: "account", hourlyUsd: 10 };
  const apiRule: Rule = { name: "api", match: { product: "workers", resource: "api" }, hourlyUsd: 5, sustainedBuckets: 2 };

  it("sums matching series and extrapolates to an hour", () => {
    // ($0.5 + $0.4) × 12 = $10.80/hour
    const breaches = evaluateRules([accountRule], [s("api", 0.5), s("bucket", 0.4, "r2", "class_a")], []);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].hourlyUsd).toBeCloseTo(10.8);
    expect(breaches[0].top[0].resource).toBe("api");
  });

  it("does not fire under the limit", () => {
    expect(evaluateRules([accountRule], [s("api", 0.8)], [])).toHaveLength(0);
  });

  it("respects match filters", () => {
    expect(evaluateRules([{ ...apiRule, sustainedBuckets: 1 }], [s("other", 5)], [])).toHaveLength(0);
  });

  it("requires sustained breaches when configured", () => {
    const hot = [s("api", 1)];
    expect(evaluateRules([apiRule], hot, [])).toHaveLength(0);
    expect(evaluateRules([apiRule], hot, [[s("api", 0.1)]])).toHaveLength(0);
    expect(evaluateRules([apiRule], hot, [[s("api", 1)]])).toHaveLength(1);
  });
});

describe("projectMonth", () => {
  it("adds the hourly rate for the rest of the month", () => {
    const now = Date.UTC(2026, 9, 31, 0, 0); // 24h left in October
    const p = projectMonth(now, 100, 2);
    expect(p.projectedUsd).toBeCloseTo(148);
    expect(p.monthStart).toBe(Date.UTC(2026, 9, 1));
  });
});
