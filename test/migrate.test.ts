import { describe, expect, it } from "vitest";
import { ensureSchema, MIGRATIONS, splitStatements } from "../src/migrate";
import { createD1 } from "./helpers";

const tables = async (db: D1Database) =>
  (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);

describe("ensureSchema", () => {
  it("creates the schema on an empty database and records it the way wrangler does", async () => {
    const db = createD1({ migrate: false });
    expect(await ensureSchema(db)).toEqual(["0001_init.sql"]);
    expect(await tables(db)).toEqual(expect.arrayContaining(["samples", "runs", "alert_state", "events", "paused", "d1_migrations"]));
    const rows = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    expect(rows.results).toEqual([{ name: "0001_init.sql" }]);
  });

  it("is a no-op when run again", async () => {
    const db = createD1({ migrate: false });
    await ensureSchema(db);
    expect(await ensureSchema(db)).toEqual([]);
  });

  it("skips migrations wrangler already applied", async () => {
    // Simulates `wrangler d1 migrations apply`: schema exists and is recorded.
    const db = createD1();
    await db.prepare("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
    await db.prepare("INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')").run();
    expect(await ensureSchema(db)).toEqual([]);
  });

  it("rolls back a failed migration and reports it", async () => {
    const db = createD1({ migrate: false });
    const bad = [{ name: "0002_bad.sql", sql: "CREATE TABLE ok (x INTEGER); CREATE TABLE broken (" }];
    await expect(ensureSchema(db, bad)).rejects.toThrow(/0002_bad.sql failed/);
    expect(await tables(db)).not.toContain("ok");
  });

  it("splits statements and drops comments", () => {
    expect(splitStatements("-- a; comment\nCREATE TABLE a (x);\n\nCREATE INDEX i ON a (x);\n")).toEqual([
      "CREATE TABLE a (x)",
      "CREATE INDEX i ON a (x)",
    ]);
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init.sql"]);
  });
});
