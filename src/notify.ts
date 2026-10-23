import type { Env } from "./config";

export type Severity = "info" | "warning" | "critical";

export interface Alert {
  /** Deduplication key; alerts with the same key respect the cooldown. */
  key: string;
  severity: Severity;
  kind: "rule" | "anomaly" | "budget" | "kill_switch" | "guard";
  title: string;
  /** Plain-text lines with the details. */
  lines: string[];
  /** Overrides alerts.cooldownMinutes for this alert. */
  cooldownMinutes?: number;
}

const ICON: Record<Severity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

/** Sends an alert to every configured channel. Returns the channels that failed. */
export async function sendAlert(env: Env, alert: Alert, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const text = `${ICON[alert.severity]} *${alert.title}*\n${alert.lines.join("\n")}`;
  const sends: [string, Promise<Response>][] = [];
  const post = (url: string, body: unknown) =>
    fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (env.SLACK_WEBHOOK_URL) sends.push(["slack", post(env.SLACK_WEBHOOK_URL, { text })]);
  if (env.DISCORD_WEBHOOK_URL) {
    sends.push(["discord", post(env.DISCORD_WEBHOOK_URL, { content: text.replaceAll("*", "**").slice(0, 2000) })]);
  }
  if (env.ALERT_WEBHOOK_URL) {
    sends.push(["webhook", post(env.ALERT_WEBHOOK_URL, { source: "cf-spend-guard", ...alert, text })]);
  }
  if (env.PAGERDUTY_ROUTING_KEY && alert.severity === "critical") {
    sends.push([
      "pagerduty",
      post("https://events.pagerduty.com/v2/enqueue", {
        routing_key: env.PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        dedup_key: `cf-spend-guard:${alert.key}`,
        payload: {
          summary: alert.title.slice(0, 1024),
          source: "cf-spend-guard",
          severity: "critical",
          custom_details: { details: alert.lines },
        },
      }),
    ]);
  }

  const failed: string[] = [];
  const results = await Promise.allSettled(sends.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === "rejected" || !r.value.ok) failed.push(sends[i][0]);
  });
  if (!sends.length) console.warn("No alert channel configured; alert only logged:", text);
  return failed;
}

export const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
