import type { CloudflareClient } from "./cloudflare/api";
import type { Store } from "./store";

/** The guard never pauses itself, whatever the config says. */
export const SELF_SCRIPT = "cf-spend-guard";

interface Route {
  id: string;
  pattern: string;
  script?: string;
}
interface CustomDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  environment?: string;
}

/** Everything detached from a script, so restore can put it back exactly. */
export interface Snapshot {
  routes: { zoneId: string; id: string; pattern: string }[];
  workersDev: boolean;
  domains: { hostname: string; service: string; zone_id: string; environment?: string }[];
  schedules: string[];
}

export interface PauseResult {
  script: string;
  dryRun: boolean;
  snapshot: Snapshot;
  errors: string[];
}

/**
 * Stops traffic to a Worker without deleting it: detaches its zone routes,
 * disables its workers.dev URL, removes its custom domains and clears its cron
 * triggers. Queue consumers and service bindings from other Workers are not
 * touched. Everything removed is saved so `restore` can undo it.
 */
export async function pauseScript(
  client: CloudflareClient,
  store: Store,
  accountId: string,
  script: string,
  reason: string,
  dryRun: boolean,
): Promise<PauseResult> {
  const errors: string[] = [];
  const snapshot: Snapshot = { routes: [], workersDev: false, domains: [], schedules: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  const base = `/accounts/${accountId}/workers`;
  const scriptPath = `${base}/scripts/${encodeURIComponent(script)}`;

  await step("routes", async () => {
    const zones = await client.list<{ id: string }>(`/zones?account.id=${accountId}`);
    for (const zone of zones) {
      const routes = await client.request<Route[]>("GET", `/zones/${zone.id}/workers/routes`);
      for (const r of routes.filter((r) => r.script === script)) {
        // Omitting `script` keeps the route but runs no Worker on it.
        if (!dryRun) await client.request("PUT", `/zones/${zone.id}/workers/routes/${r.id}`, { pattern: r.pattern });
        snapshot.routes.push({ zoneId: zone.id, id: r.id, pattern: r.pattern });
      }
    }
  });

  await step("workers.dev", async () => {
    const sub = await client.request<{ enabled: boolean }>("GET", `${scriptPath}/subdomain`);
    if (sub.enabled) {
      if (!dryRun) await client.request("POST", `${scriptPath}/subdomain`, { enabled: false });
      snapshot.workersDev = true;
    }
  });

  await step("custom domains", async () => {
    const domains = await client.request<CustomDomain[]>("GET", `${base}/domains?service=${encodeURIComponent(script)}`);
    for (const d of domains.filter((d) => d.service === script)) {
      if (!dryRun) await client.request("DELETE", `${base}/domains/${d.id}`);
      snapshot.domains.push({ hostname: d.hostname, service: d.service, zone_id: d.zone_id, environment: d.environment });
    }
  });

  await step("cron triggers", async () => {
    const res = await client.request<{ schedules: { cron: string }[] }>("GET", `${scriptPath}/schedules`);
    const crons = res.schedules.map((s) => s.cron);
    if (crons.length) {
      if (!dryRun) await client.request("PUT", `${scriptPath}/schedules`, []);
      snapshot.schedules = crons;
    }
  });

  if (!dryRun) {
    // Merge with an earlier pause so a second pause can't lose the original snapshot.
    const existing = await store.getPaused(script);
    const merged = existing ? mergeSnapshots(JSON.parse(existing.snapshot), snapshot) : snapshot;
    await store.savePaused({ script, paused_at: Date.now(), reason, snapshot: JSON.stringify(merged) });
  }
  return { script, dryRun, snapshot, errors };
}

export async function restoreScript(
  client: CloudflareClient,
  store: Store,
  accountId: string,
  script: string,
): Promise<{ restored: Snapshot; errors: string[] }> {
  const paused = await store.getPaused(script);
  if (!paused) throw new Error(`${script} is not paused by cf-spend-guard`);
  const snap: Snapshot = JSON.parse(paused.snapshot);
  const base = `/accounts/${accountId}/workers`;
  const scriptPath = `${base}/scripts/${encodeURIComponent(script)}`;
  const errors: string[] = [];
  const left: Snapshot = { routes: [], workersDev: false, domains: [], schedules: [] };

  for (const r of snap.routes) {
    try {
      await client.request("PUT", `/zones/${r.zoneId}/workers/routes/${r.id}`, { pattern: r.pattern, script });
    } catch (e) {
      errors.push(`route ${r.pattern}: ${(e as Error).message}`);
      left.routes.push(r);
    }
  }
  if (snap.workersDev) {
    try {
      await client.request("POST", `${scriptPath}/subdomain`, { enabled: true });
    } catch (e) {
      errors.push(`workers.dev: ${(e as Error).message}`);
      left.workersDev = true;
    }
  }
  for (const d of snap.domains) {
    try {
      await client.request("PUT", `${base}/domains`, d);
    } catch (e) {
      errors.push(`domain ${d.hostname}: ${(e as Error).message}`);
      left.domains.push(d);
    }
  }
  if (snap.schedules.length) {
    try {
      await client.request("PUT", `${scriptPath}/schedules`, snap.schedules.map((cron) => ({ cron })));
    } catch (e) {
      errors.push(`cron triggers: ${(e as Error).message}`);
      left.schedules = snap.schedules;
    }
  }

  if (errors.length) await store.savePaused({ ...paused, snapshot: JSON.stringify(left) });
  else await store.deletePaused(script);
  return { restored: snap, errors };
}

export function mergeSnapshots(a: Snapshot, b: Snapshot): Snapshot {
  const routeIds = new Set(a.routes.map((r) => r.id));
  const hosts = new Set(a.domains.map((d) => d.hostname));
  return {
    routes: [...a.routes, ...b.routes.filter((r) => !routeIds.has(r.id))],
    workersDev: a.workersDev || b.workersDev,
    domains: [...a.domains, ...b.domains.filter((d) => !hosts.has(d.hostname))],
    schedules: [...new Set([...a.schedules, ...b.schedules])],
  };
}
