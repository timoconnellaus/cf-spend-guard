import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, loadConfig, pauseTargets } from "../src/config";

describe("loadConfig", () => {
  it("returns defaults for missing config", () => {
    expect(loadConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("accepts a JSON string and merges nested sections", () => {
    const c = loadConfig(JSON.stringify({ anomaly: { ratio: 3 }, prices: { "workers.requests": 1 } }));
    expect(c.anomaly.ratio).toBe(3);
    expect(c.anomaly.zScore).toBe(DEFAULT_CONFIG.anomaly.zScore);
    expect(c.prices["workers.requests"]).toBe(1);
    expect(c.prices["kv.read"]).toBe(DEFAULT_CONFIG.prices["kv.read"]);
  });

  it("rejects bad input", () => {
    expect(() => loadConfig("{not json")).toThrow(ConfigError);
    expect(() => loadConfig({ products: ["stream"] })).toThrow(/Unknown product/);
    expect(() => loadConfig({ rules: [{ name: "x", hourlyUsd: -1 }] })).toThrow(/hourlyUsd/);
    expect(() => loadConfig({ rules: [{ name: "x", hourlyUsd: 1, action: "pause" }] })).toThrow(/pause/);
  });
});

describe("pauseTargets", () => {
  it("uses an explicit list or the matched Worker", () => {
    expect(pauseTargets({ name: "a", hourlyUsd: 1, pause: ["x", "y"] })).toEqual(["x", "y"]);
    expect(pauseTargets({ name: "a", hourlyUsd: 1, match: { product: "workers", resource: "api" } })).toEqual(["api"]);
    expect(pauseTargets({ name: "a", hourlyUsd: 1, match: { product: "r2", resource: "b" } })).toEqual([]);
  });
});
