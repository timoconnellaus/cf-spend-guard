import type { Sample } from "./collectors";
import type { Product } from "./pricing";

export interface CostedSample extends Sample {
  cost: number;
}

export interface SeriesKey {
  product: Product;
  resource: string;
  metric: string;
}

export interface GuardEvent {
  at: number;
  severity: string;
  kind: string;
  title: string;
  detail: string | null;
}

export interface PausedScript {
  script: string;
  paused_at: number;
  reason: string;
  snapshot: string;
}

// D1 caps bound parameters per statement; keep batches well under it.
const INSERT_CHUNK = 50;

export class Store {
  constructor(private readonly db: D1Database) {}

  async saveBucket(bucket: number, samples: CostedSample[], errors: unknown[]): Promise<void> {
    const stmts: D1PreparedStatement[] = [this.db.prepare("DELETE FROM samples WHERE bucket = ?").bind(bucket)];
    const insert = this.db.prepare(
      "INSERT INTO samples (bucket, product, resource, metric, value, cost) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const s of samples) {
      if (s.value === 0) continue;
      stmts.push(insert.bind(bucket, s.product, s.resource, s.metric, s.value, s.cost));
    }
    const total = samples.reduce((sum, s) => sum + s.cost, 0);
    stmts.push(
      this.db
        .prepare(
          "INSERT OR REPLACE INTO runs (bucket, ran_at, total_cost, sample_count, errors) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(bucket, Date.now(), total, samples.length, errors.length ? JSON.stringify(errors) : null),
    );
    for (let i = 0; i < stmts.length; i += INSERT_CHUNK) {
      await this.db.batch(stmts.slice(i, i + INSERT_CHUNK));
    }
  }

  async samplesForBuckets(buckets: number[]): Promise<Map<number, CostedSample[]>> {
    const out = new Map<number, CostedSample[]>(buckets.map((b) => [b, []]));
    if (!buckets.length) return out;
    const { results } = await this.db
      .prepare(
        `SELECT bucket, product, resource, metric, value, cost FROM samples WHERE bucket IN (${buckets.map(() => "?").join(",")})`,
      )
      .bind(...buckets)
      .all<CostedSample & { bucket: number }>();
    for (const { bucket, ...s } of results) out.get(bucket)?.push(s);
    return out;
  }

  /** Buckets that were collected (successfully or partially) in [since, until). */
  async collectedBuckets(since: number, until: number): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT bucket FROM runs WHERE bucket >= ? AND bucket < ? ORDER BY bucket")
      .bind(since, until)
      .all<{ bucket: number }>();
    return results.map((r) => r.bucket);
  }

  async seriesHistory(key: SeriesKey, since: number, until: number): Promise<Map<number, number>> {
    const { results } = await this.db
      .prepare(
        "SELECT bucket, value FROM samples WHERE product = ? AND resource = ? AND metric = ? AND bucket >= ? AND bucket < ?",
      )
      .bind(key.product, key.resource, key.metric, since, until)
      .all<{ bucket: number; value: number }>();
    return new Map(results.map((r) => [r.bucket, r.value]));
  }

  async totalCostHistory(since: number, until: number): Promise<Map<number, number>> {
    const { results } = await this.db
      .prepare("SELECT bucket, total_cost FROM runs WHERE bucket >= ? AND bucket < ?")
      .bind(since, until)
      .all<{ bucket: number; total_cost: number }>();
    return new Map(results.map((r) => [r.bucket, r.total_cost]));
  }

  async costSince(since: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(total_cost), 0) AS total FROM runs WHERE bucket >= ?")
      .bind(since)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async recentRuns(limit: number) {
    const { results } = await this.db
      .prepare("SELECT bucket, ran_at, total_cost, sample_count, errors FROM runs ORDER BY bucket DESC LIMIT ?")
      .bind(limit)
      .all<{ bucket: number; ran_at: number; total_cost: number; sample_count: number; errors: string | null }>();
    return results;
  }

  async topResources(since: number, limit: number, product?: string) {
    const stmt = this.db.prepare(
      `SELECT product, resource, SUM(cost) AS cost FROM samples WHERE bucket >= ?1 ${product ? "AND product = ?3" : ""}
       GROUP BY product, resource ORDER BY cost DESC LIMIT ?2`,
    );
    const { results } = await (product ? stmt.bind(since, limit, product) : stmt.bind(since, limit)).all<{
      product: string;
      resource: string;
      cost: number;
    }>();
    return results;
  }

  /**
   * Cost per time step, keyed by product (or by resource within one product).
   * Steps are aligned to multiples of stepMs since the epoch.
   */
  async costHistory(since: number, until: number, stepMs: number, product?: string) {
    const key = product ? "resource" : "product";
    const where = product ? "AND product = ?4" : "";
    const stmt = this.db.prepare(
      `SELECT (bucket / CAST(?3 AS INTEGER)) * CAST(?3 AS INTEGER) AS t, ${key} AS key, SUM(cost) AS cost FROM samples
       WHERE bucket >= ?1 AND bucket < ?2 ${where} GROUP BY t, key ORDER BY t`,
    );
    const { results } = await (product ? stmt.bind(since, until, stepMs, product) : stmt.bind(since, until, stepMs))
      .all<{ t: number; key: string; cost: number }>();
    return results;
  }

  /** Returns true (and records the send) if `key` is outside its cooldown. */
  async claimAlert(key: string, now: number, cooldownMs: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO alert_state (key, last_sent) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET last_sent = ?2 WHERE alert_state.last_sent <= ?3
         RETURNING last_sent`,
      )
      .bind(key, now, now - cooldownMs)
      .first();
    return row !== null;
  }

  async addEvent(e: GuardEvent): Promise<void> {
    await this.db
      .prepare("INSERT INTO events (at, severity, kind, title, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(e.at, e.severity, e.kind, e.title, e.detail)
      .run();
  }

  async recentEvents(limit: number): Promise<GuardEvent[]> {
    const { results } = await this.db
      .prepare("SELECT at, severity, kind, title, detail FROM events ORDER BY at DESC LIMIT ?")
      .bind(limit)
      .all<GuardEvent>();
    return results;
  }

  async getPaused(script: string): Promise<PausedScript | null> {
    return this.db.prepare("SELECT * FROM paused WHERE script = ?").bind(script).first<PausedScript>();
  }

  async listPaused(): Promise<PausedScript[]> {
    const { results } = await this.db.prepare("SELECT * FROM paused ORDER BY paused_at DESC").all<PausedScript>();
    return results;
  }

  async savePaused(p: PausedScript): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO paused (script, paused_at, reason, snapshot) VALUES (?, ?, ?, ?)")
      .bind(p.script, p.paused_at, p.reason, p.snapshot)
      .run();
  }

  async deletePaused(script: string): Promise<void> {
    await this.db.prepare("DELETE FROM paused WHERE script = ?").bind(script).run();
  }

  async prune(before: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM samples WHERE bucket < ?").bind(before),
      this.db.prepare("DELETE FROM runs WHERE bucket < ?").bind(before),
      this.db.prepare("DELETE FROM events WHERE at < ?").bind(before),
    ]);
  }
}
