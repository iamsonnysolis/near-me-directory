/**
 * D1 Database client wrapper
 * Replaces Supabase client for Cloudflare D1
 * Provides a resilient data-fetching layer with graceful error handling
 *
 * During `astro dev`, if the Worker runtime hasn't set the `DB` global
 * (e.g. platformProxy in the adapter didn't wire up the binding), we
 * fall back to the Cloudflare D1 HTTP API using the REST endpoint.
 */

import type { D1Database } from '@cloudflare/workers-types';

let d1: D1Database | null = null;
let d1InitPromise: Promise<D1Database> | null = null;

/**
 * Minimal D1Database stub backed by the Cloudflare D1 HTTP API.
 * Only implements the methods used by runQuery/runQuerySingle/runCount.
 */
class D1HttpDatabase {
  private accountId: string;
  private dbId: string;
  private token: string;

  constructor(accountId: string, dbId: string, token: string) {
    this.accountId = accountId;
    this.dbId = dbId;
    this.token = token;
  }

  prepare(sql: string) {
    const self = this;
    return {
      bind(...params: any[]) {
        return {
          async all() {
            const resp = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${self.accountId}/d1/database/${self.dbId}/query`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${self.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ sql, params }),
              }
            );
            const data = await resp.json() as any;
            if (data.success) {
              return { results: data.result?.[0]?.results ?? [] };
            }
            throw new Error(data.errors?.[0]?.message || 'D1 query failed');
          },
          async first() {
            const result = await this.all();
            return result.results?.[0] ?? null;
          },
          async raw() {
            const result = await this.all();
            return result.results ?? [];
          },
        };
      },
    };
  }

  batch(_queries: any[]): Promise<any[]> { throw new Error('batch not implemented'); }
  exec(_sql: string): Promise<any> { throw new Error('exec not implemented'); }
  withSession(): any { return this; }
  dump(): Promise<string> { throw new Error('dump not implemented'); }
}

/**
 * Initialise the D1 client via the Cloudflare D1 HTTP API.
 * Used as a fallback when the Worker runtime's DB binding is unavailable
 * (e.g. in `astro dev` without platformProxy wiring).
 */
async function initViaHttpApi(): Promise<D1Database> {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const dbId = 'c46d5f2f-5be0-4a4c-aee6-bbf63bd713b0'; // d1-directory-factory-89

  if (!accountId || !token) {
    throw new Error('CF_ACCOUNT_ID / CF_API_TOKEN not set in environment');
  }

  return new D1HttpDatabase(accountId, dbId, token) as unknown as D1Database;
}

/**
 * Get the D1 database binding (async because HTTP fallback is async).
 * Resolution order:
 *   1. Explicit env passed by caller (SSR/API routes)
 *   2. Cached singleton (already initialised)
 *   3. Global binding (Cloudflare Workers runtime — set automatically by adapter)
 *   4. D1 HTTP API fallback (astro dev without platformProxy wiring)
 */
export async function getD1Client(env?: { DB?: D1Database }): Promise<D1Database> {
  // 1. Explicit env passed by caller
  if (env?.DB) {
    return env.DB;
  }
  // 2. Cached singleton
  if (d1) {
    return d1;
  }
  // 3. Global binding (Cloudflare Workers runtime)
  // @ts-ignore
  if (typeof DB !== 'undefined' && DB) {
    // @ts-ignore
    d1 = DB;
    return d1;
  }
  // 4. Fallback: initialise via D1 HTTP API
  if (!d1InitPromise) {
    d1InitPromise = initViaHttpApi().then((db) => {
      d1 = db;
      return db;
    }).catch((err) => {
      d1InitPromise = null;
      throw err;
    });
  }
  return d1InitPromise;
}

/**
 * Set the D1 client manually (for non-Astro contexts or testing)
 */
export function setD1Client(db: D1Database): void {
  d1 = db;
}

/**
 * Run a query with automatic JSON result parsing
 */
export async function runQuery(
  db: D1Database,
  sql: string,
  params: any[] = []
): Promise<any[]> {
  const stmt = db.prepare(sql);
  const result = await stmt.bind(...params).all();
  return result.results || [];
}

/**
 * Run a query expecting a single row
 */
export async function runQuerySingle(
  db: D1Database,
  sql: string,
  params: any[] = []
): Promise<any | null> {
  const rows = await runQuery(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Run a count query
 */
export async function runCount(
  db: D1Database,
  sql: string,
  params: any[] = []
): Promise<number> {
  const rows = await runQuery(db, sql, params);
  if (rows.length > 0) {
    const val = Object.values(rows[0])[0] as number;
    return val || 0;
  }
  return 0;
}