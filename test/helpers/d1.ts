/**
 * D1 giả lập bằng SQLite trong bộ nhớ, chạy đúng file migration thật.
 * Đủ cho prepare/bind/first/all/run/batch mà Worker dùng.
 */
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Param = string | number | bigint | Buffer | null;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));

class Stmt {
  constructor(private db: Database.Database, private sql: string, private params: Param[] = []) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p.map(norm));
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (s.reader) return { results: s.all(...this.params) as Record<string, unknown>[], success: true, meta: {} };
    const info = s.run(...this.params);
    return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = (this.exec().results[0] ?? null) as Record<string, unknown> | null;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T>() {
    return this.exec() as unknown as { results: T[]; success: true; meta: object };
  }
  async run() {
    return this.exec();
  }
}

export function createD1(opts: { keepSeed?: boolean } = {}): D1Database {
  const db = new Database(':memory:');
  const dir = join(import.meta.dirname, '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  if (!opts.keepSeed) db.exec('DELETE FROM sites'); // kiểm thử tự tạo site của mình
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => db.transaction(() => stmts.map((s) => s.exec()))(),
    exec: async (sql: string) => db.exec(sql),
    _raw: db,
  };
  return d1 as unknown as D1Database;
}

export function raw(d1: D1Database): Database.Database {
  return (d1 as unknown as { _raw: Database.Database })._raw;
}

export const SITE_KEY = 'kimanh_test_key';

export function seedSite(d1: D1Database, over: Record<string, unknown> = {}) {
  const now = Date.now();
  const row = {
    id: 'kim-anh',
    name: 'Kim Anh',
    site_key: SITE_KEY,
    domains: JSON.stringify(['kientruckimanh.com', 'xaydungkimanh.com']),
    mode: 'log',
    follow_campaigns: 0,
    created_at: now,
    updated_at: now,
    ...over,
  };
  const cols = Object.keys(row);
  raw(d1).prepare(`INSERT INTO sites (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row).map(norm));
}
