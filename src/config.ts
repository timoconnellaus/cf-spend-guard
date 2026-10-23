import { DEFAULT_PRICES, PRODUCTS, type PriceTable, type Product } from "./pricing";

export interface Env {
  DB: D1Database;
  GUARD_CONFIG?: unknown;
  CF_API_TOKEN: string;
  ADMIN_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_URL?: string;
  PAGERDUTY_ROUTING_KEY?: string;
  /** Cloudflare Access team domain, e.g. "acme" or "acme.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Audience (AUD) tag. */
  ACCESS_AUD?: string;
}

/** Selects usage series. Omitted fields (or "*") match everything. */
export interface Match {
  product?: Product | "*";
  /** Script name, bucket name, namespace/database/queue id. */
  resource?: string;
  metric?: string;
}

export interface Rule {
  name: string;
  match?: Match;
  /** Fires when the matched usage costs more than this per hour (extrapolated from one 5-minute bucket). */
  hourlyUsd: number;
  /** "pause" also runs the kill switch on the scripts in `pause` (requires killSwitch.enabled). */
  action?: "alert" | "pause";
  /** Worker scripts to pause. Defaults to match.resource when match.product is "workers". */
  pause?: string[];
  /** How many consecutive buckets must breach before the rule fires. Default 1. */
  sustainedBuckets?: number;
}

export interface AnomalyConfig {
  enabled: boolean;
  /** Days of history used as the baseline. */
  baselineDays: number;
  /** Don't flag anomalies until the guard has collected this much history. */
  minHistoryHours: number;
  /** Current bucket must be at least this many times the baseline median... */
  ratio: number;
  /** ...and this many robust standard deviations (MAD × 1.4826) above it... */
  zScore: number;
  /** ...and the excess must cost at least this much per hour. Filters out noise on cheap metrics. */
  minExcessHourlyUsd: number;
}

export interface GuardConfig {
  accountId?: string;
  products: Product[];
  /** Analytics lag: each run collects the 5-minute bucket that ended this many minutes ago. */
  lagMinutes: number;
  monthlyBudgetUsd?: number;
  prices: PriceTable;
  rules: Rule[];
  anomaly: AnomalyConfig;
  alerts: { cooldownMinutes: number };
  killSwitch: {
    enabled: boolean;
    /** Log and alert what would be paused without changing anything. */
    dryRun: boolean;
    /** Scripts that are never paused. The guard itself is always protected. */
    protect: string[];
  };
  retentionDays: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
  products: PRODUCTS,
  lagMinutes: 10,
  prices: DEFAULT_PRICES,
  rules: [{ name: "Account burn rate", hourlyUsd: 2, action: "alert" }],
  anomaly: {
    enabled: true,
    baselineDays: 7,
    minHistoryHours: 24,
    ratio: 5,
    zScore: 6,
    minExcessHourlyUsd: 0.5,
  },
  alerts: { cooldownMinutes: 60 },
  killSwitch: { enabled: false, dryRun: true, protect: [] },
  retentionDays: 35,
};

export class ConfigError extends Error {}

export function loadConfig(raw: unknown): GuardConfig {
  let input: Record<string, any> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError(`GUARD_CONFIG is not valid JSON: ${(e as Error).message}`);
    }
  } else if (raw && typeof raw === "object") {
    input = raw as Record<string, any>;
  }

  const config: GuardConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    prices: { ...DEFAULT_PRICES, ...(input.prices ?? {}) },
    anomaly: { ...DEFAULT_CONFIG.anomaly, ...(input.anomaly ?? {}) },
    alerts: { ...DEFAULT_CONFIG.alerts, ...(input.alerts ?? {}) },
    killSwitch: { ...DEFAULT_CONFIG.killSwitch, ...(input.killSwitch ?? {}) },
  };

  for (const p of config.products) {
    if (!PRODUCTS.includes(p)) throw new ConfigError(`Unknown product "${p}". Use one of: ${PRODUCTS.join(", ")}`);
  }
  if (!Array.isArray(config.rules)) throw new ConfigError("rules must be an array");
  for (const rule of config.rules) {
    if (!rule.name) throw new ConfigError("Every rule needs a name");
    if (typeof rule.hourlyUsd !== "number" || rule.hourlyUsd < 0) {
      throw new ConfigError(`Rule "${rule.name}": hourlyUsd must be a non-negative number`);
    }
    if (rule.action && rule.action !== "alert" && rule.action !== "pause") {
      throw new ConfigError(`Rule "${rule.name}": action must be "alert" or "pause"`);
    }
    if (rule.action === "pause" && pauseTargets(rule).length === 0) {
      throw new ConfigError(
        `Rule "${rule.name}": action "pause" needs a "pause" list, or match.product "workers" with a match.resource`,
      );
    }
  }
  if (config.lagMinutes < 0) throw new ConfigError("lagMinutes must be >= 0");
  return config;
}

export function pauseTargets(rule: Rule): string[] {
  if (rule.pause?.length) return rule.pause;
  if (rule.match?.product === "workers" && rule.match.resource && rule.match.resource !== "*") {
    return [rule.match.resource];
  }
  return [];
}
