// Applies the D1 migrations from the Worker itself, so the guard works however
// it was deployed: `npm run deploy`, plain `npx wrangler deploy` (which the
// dashboard's "Import a repository" flow uses), or the Deploy to Cloudflare
// button. Applied migrations are recorded in wrangler's own `d1_migrations`
// table, so `wrangler d1 migrations apply` and this never run one twice.
import m0001 from "../migrations/0001_init.sql";

export const MIGRATIONS: { name: string; sql: string }[] = [{ name: "0001_init.sql", sql: m0001 }];

const TABLE = "d1_migrations";

/** Splits a migration into statements. Migrations must not use `;` inside strings or triggers. */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Once an isolate has checked the schema, later requests skip the query.
const ready = new WeakSet<D1Database>();

export async function ensureSchema(db: D1Database, migrations = MIGRATIONS): Promise<string[]> {
  if (ready.has(db)) return [];
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
    )
    .run();
  const { results } = await db.prepare(`SELECT name FROM ${TABLE}`).all<{ name: string }>();
  const done = new Set(results.map((r) => r.name));

  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    // One batch = one transaction: the migration and its record land together.
    const stmts = [
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare(`INSERT INTO ${TABLE} (name) VALUES (?)`).bind(m.name),
    ];
    try {
      await db.batch(stmts);
      applied.push(m.name);
    } catch (e) {
      // A concurrent invocation may have applied it first; that's fine.
      const row = await db.prepare(`SELECT 1 FROM ${TABLE} WHERE name = ?`).bind(m.name).first();
      if (!row) throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  ready.add(db);
  return applied;
}
