import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VeilError } from './errors.ts';
import type { VeilLevel } from './redactor.ts';

export interface PageRecord {
  url: string;
  /** True when `url` had nothing redacted, so it is the real address and run_action may open it. */
  openable?: boolean;
  title: string;
  chunks: { heading: string; text: string }[];
  /** keyHash finds the control again on the live page without storing its unredacted label. */
  actions: { role: string; label: string; actionType: string; context: string; keyHash: string }[];
}

/** What a crawl hides. */
export interface Veil {
  veilLevel: VeilLevel;
  patterns: string[];
  selectors: string[];
}

export interface SiteMeta extends Veil {
  host: string;
  /** Changes when the tables change; an index of another format is deleted when used. */
  format?: number;
  /** Unique per index file. */
  built?: string;
  rawBytes: number;
  counts: Record<string, number>;
  /** What to crawl again to refresh the index; null when the start address had a hidden value. */
  crawl?: { url: string; maxPages: number; maxDepth: number } | null;
  crawledAt?: number;
}

/** Page content in here is already redacted. */
export interface SiteRecord extends SiteMeta {
  id: string;
  pages: PageRecord[];
  /** One unit-length sentence vector per chunk, in page and chunk order, when semantic search is on. */
  vectors?: Float32Array | null;
}

const SCHEMA = `
  CREATE TABLE meta (json TEXT NOT NULL);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, openable INTEGER NOT NULL);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, ref TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL);
  CREATE INDEX chunks_page ON chunks (page_id);
  CREATE INDEX chunks_ref ON chunks (ref);
  CREATE VIRTUAL TABLE chunks_fts USING fts5 (title, heading, text, tokenize = 'porter unicode61');
  CREATE TABLE actions (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, action_type TEXT NOT NULL, key_hash TEXT NOT NULL);
  -- One blob holds every vector, one signed byte per number: row i belongs to chunk id i + 1. Reading 10k small rows is too slow.
  CREATE TABLE vectors (data BLOB NOT NULL);
  CREATE VIRTUAL TABLE actions_fts USING fts5 (label, context, title, tokenize = 'porter unicode61');
`;

/** The index splits words at spaces, which these scripts do not use, so each of their characters becomes a word. */
export function forIndex(text: string): string {
  return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]/gu, ' $& ');
}

const HOUR = 60 * 60 * 1000;
const FORMAT = 3;

/**
 * Chunk ids and action handles come from content, not row numbers, so they mean the same thing after
 * a re-crawl or a background refresh rebuilds the index while an agent is using it.
 */
export const chunkRef = (url: string, heading: string, text: string) => createHash('sha256').update(`${url}\n${heading}\n${text}`).digest('hex').slice(0, 12);
export const homeDir = () => process.env.VEILCRAWL_HOME ?? join(homedir(), '.veilcrawl');

/** Forgets sites nobody crawled or read for a week, and what a crash left behind (a save takes seconds, not an hour). */
export function deleteStale(): void {
  if (!existsSync(homeDir())) return;
  for (const name of readdirSync(homeDir())) {
    const temp = name.match(/^s_[0-9a-f]{12}\.db(\.\d+\.tmp(?:-journal)?)?$/);
    if (!temp) continue;
    const path = join(homeDir(), name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() && Date.now() - stat.mtimeMs > (temp[1] ? HOUR : 7 * 24 * HOUR)) rmSync(path, { force: true });
  }
}

const unknownSite = () => new VeilError('Unknown or expired site_id. Run crawl_site first.');

function pathFor(siteId: string): string {
  if (!/^s_[0-9a-f]{12}$/.test(siteId)) throw unknownSite();
  return join(homeDir(), `${siteId}.db`);
}

const veilPath = (host: string) => join(homeDir(), 'veils', `${encodeURIComponent(host)}.json`);

/** What earlier crawls of a site hid. Crawls only add to it, so an agent cannot crawl again to see more; a person can delete the file. */
export function keptVeil(host: string): Veil {
  return existsSync(veilPath(host)) ? JSON.parse(readFileSync(veilPath(host), 'utf8')) : { veilLevel: 'standard', patterns: [], selectors: [] };
}

export function strongest(a: Veil, b: Veil): Veil {
  return {
    veilLevel: a.veilLevel === 'strict' ? 'strict' : b.veilLevel,
    patterns: [...new Set([...a.patterns, ...b.patterns])],
    selectors: [...new Set([...a.selectors, ...b.selectors])],
  };
}

const hidesLess = (a: Veil, b: Veil) => JSON.stringify(strongest(a, b)) !== JSON.stringify(strongest(a, a));

// shortcut: two crawls of one site that finish in the same moment can lose one's additions, lock the file if that happens.
function keepVeil(host: string, veil: Veil): void {
  const kept = keptVeil(host);
  if (!hidesLess(kept, veil)) return;
  const path = veilPath(host);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(strongest(kept, veil)), { mode: 0o600 });
  renameSync(temp, path);
}

/** Builds the index beside the live one and swaps it in, so a failed crawl never destroys an index. */
export function writeSite(site: SiteRecord): void {
  const path = pathFor(site.id);
  deleteStale();
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  const db = new Database(temp);
  try {
    chmodSync(temp, 0o600);
    db.exec(SCHEMA);
    const insert = {
      page: db.prepare('INSERT INTO pages (url, title, openable) VALUES (?, ?, ?)'),
      chunk: db.prepare('INSERT INTO chunks (page_id, ref, heading, text) VALUES (?, ?, ?, ?)'),
      chunkFts: db.prepare('INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (?, ?, ?, ?)'),
      action: db.prepare('INSERT INTO actions (page_id, role, label, action_type, key_hash) VALUES (?, ?, ?, ?, ?)'),
      actionFts: db.prepare('INSERT INTO actions_fts (rowid, label, context, title) VALUES (?, ?, ?, ?)'),
    };
    db.transaction(() => {
      const { id, pages, vectors, ...meta } = site;
      db.prepare('INSERT INTO meta (json) VALUES (?)').run(JSON.stringify({ ...meta, format: FORMAT, built: randomUUID(), crawledAt: Date.now() }));
      for (const page of pages) {
        const pageId = insert.page.run(page.url, page.title, page.openable ? 1 : 0).lastInsertRowid;
        for (const c of page.chunks) insert.chunkFts.run(insert.chunk.run(pageId, chunkRef(page.url, c.heading, c.text), c.heading, c.text).lastInsertRowid, forIndex(page.title), forIndex(c.heading), forIndex(c.text));
        for (const a of page.actions)
          insert.actionFts.run(insert.action.run(pageId, a.role, a.label, a.actionType, a.keyHash).lastInsertRowid, forIndex(a.label), forIndex(a.context), forIndex(page.title));
      }
      if (vectors) db.prepare('INSERT INTO vectors VALUES (?)').run(Buffer.from(Int8Array.from(vectors, (x) => Math.round(x * 127)).buffer));
    })();
    db.close();
    keepVeil(site.host, site);
    renameSync(temp, path);
  } finally {
    db.close();
    rmSync(temp, { force: true });
  }
}

/** Vectors of recently searched sites by index build: reading them takes longer than the search. */
const vectorCache = new Map<string, Int8Array>();

// shortcut: scans every vector (about 20 ms per 10k chunks), switch to sqlite-vec if sites grow past ~100k chunks.
/** Chunk ids closest in meaning to `query`, best first, at least `minSimilarity` alike. Empty without vectors. */
export function nearest(db: Database.Database, meta: SiteMeta, query: Float32Array, limit: number, minSimilarity: number): number[] {
  let vectors = vectorCache.get(meta.built!);
  if (!vectors) {
    const blob = db.prepare('SELECT data FROM vectors').pluck().get() as Buffer | undefined;
    vectors = blob ? new Int8Array(blob) : new Int8Array(0);
    vectorCache.set(meta.built!, vectors);
    if (vectorCache.size > 8) vectorCache.delete(vectorCache.keys().next().value!);
  }
  const dims = query.length;
  const best: { id: number; sim: number }[] = [];
  for (let row = 0; row * dims < vectors.length; row++) {
    let sum = 0;
    for (let i = 0, at = row * dims; i < dims; i++) sum += vectors[at + i] * query[i];
    if (sum / 127 >= minSimilarity) best.push({ id: row + 1, sim: sum });
  }
  return best.sort((a, b) => b.sim - a.sim).slice(0, limit).map((b) => b.id);
}

/** Chunks of the current index of a site as "heading\ntext", with their vector if it has one. Empty when there is none. */
export function previousChunks(siteId: string): Map<string, Float32Array | null> {
  const chunks = new Map<string, Float32Array | null>();
  try {
    openSite(siteId, (db) => {
      const blob = db.prepare('SELECT data FROM vectors').pluck().get() as Buffer | undefined;
      const rows = db.prepare('SELECT id, heading, text FROM chunks ORDER BY id').all() as { id: number; heading: string; text: string }[];
      const dims = blob && rows.length ? blob.length / rows.length : 0;
      for (const r of rows) {
        const at = (r.id - 1) * dims;
        chunks.set(`${r.heading}\n${r.text}`, blob ? Float32Array.from(new Int8Array(blob.buffer, blob.byteOffset + at, dims), (x) => x / 127) : null);
      }
    });
  } catch {
    // No usable index yet: everything is new.
  }
  return chunks;
}

export function openSite<T>(siteId: string, use: (db: Database.Database, meta: SiteMeta) => T): T {
  const path = pathFor(siteId);
  deleteStale();
  if (!existsSync(path)) throw unknownSite();
  // Read-only: another process may swap the file at any moment, and writing to a swapped file corrupts it.
  const db = new Database(path, { fileMustExist: true, readonly: true });
  try {
    const row = db.prepare('SELECT json FROM meta').get() as { json: string };
    const meta = JSON.parse(row.json) as SiteMeta;
    // Made by another version: some stored the redacted values, and none has the tables this one reads.
    if (meta.format !== FORMAT) rmSync(path, { force: true });
    // Not deleted: another process may have just swapped a stronger index into this path.
    if (meta.format !== FORMAT || hidesLess(meta, keptVeil(meta.host))) throw unknownSite();
    const now = new Date();
    utimesSync(path, now, now);
    return use(db, meta);
  } finally {
    db.close();
  }
}
