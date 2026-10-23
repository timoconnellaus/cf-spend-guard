/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Minimal D1 stand-in backed by node:sqlite, with the real migrations applied. */
export function createD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));

  const prepare = (sql: string, params: unknown[] = []): any => {
    const run = () => db.prepare(sql).all(...(params as any[]));
    return {
      bind: (...p: unknown[]) => prepare(sql, p),
      all: async () => ({ results: run(), success: true, meta: {} }),
      first: async () => run()[0] ?? null,
      run: async () => {
        db.prepare(sql).run(...(params as any[]));
        return { success: true, meta: {} };
      },
      _exec: run,
    };
  };

  return {
    prepare,
    batch: async (stmts: any[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ results: s._exec(), success: true }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}

export interface Call {
  method: string;
  url: string;
  body: any;
}

type Handler = (call: Call) => unknown | Response | undefined;

/** A fetch mock that records calls and answers with the first handler that returns something. */
export function mockFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r instanceof Response) return r;
      if (r !== undefined) return Response.json(r);
    }
    return Response.json({ success: false, errors: [{ message: `unmocked ${call.method} ${call.url}` }] }, { status: 404 });
  };
  return { fn: fn as typeof fetch, calls };
}

/** Answers GraphQL collector queries from a map of dataset name → rows. */
export function graphqlRows(rowsByDataset: Record<string, any[]>): Handler {
  return (call) => {
    if (!call.url.endsWith("/graphql")) return undefined;
    const dataset = Object.keys(rowsByDataset).find((d) => call.body.query.includes(`${d}(`));
    return { data: { viewer: { accounts: [{ rows: dataset ? rowsByDataset[dataset] : [] }] } } };
  };
}

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
