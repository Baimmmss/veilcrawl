import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VeilError } from './errors.ts';
import type { VeilLevel } from './redactor.ts';

export interface PageRecord {
  url: string;
  title: string;
  chunks: { heading: string; text: string }[];
  actions: { role: string; label: string; actionType: string; context: string }[];
}

/** What a crawl hides. */
export interface Veil {
  veilLevel: VeilLevel;
  patterns: string[];
  selectors: string[];
}

export interface SiteMeta extends Veil {
  host: string;
  rawBytes: number;
  counts: Record<string, number>;
}

/** Page content in here is already redacted. */
export interface SiteRecord extends SiteMeta {
  id: string;
  pages: PageRecord[];
}

const SCHEMA = `
  CREATE TABLE meta (json TEXT NOT NULL);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL);
  CREATE INDEX chunks_page ON chunks (page_id);
  CREATE VIRTUAL TABLE chunks_fts USING fts5 (title, heading, text, tokenize = 'porter unicode61');
  CREATE TABLE actions (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, action_type TEXT NOT NULL);
  CREATE VIRTUAL TABLE actions_fts USING fts5 (label, context, title, tokenize = 'porter unicode61');
`;

/** The index splits words at spaces, which these scripts do not use, so each of their characters becomes a word. */
export function forIndex(text: string): string {
  return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]/gu, ' $& ');
}

const HOUR = 60 * 60 * 1000;
const homeDir = () => process.env.VEILCRAWL_HOME ?? join(homedir(), '.veilcrawl');

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
      page: db.prepare('INSERT INTO pages (url, title) VALUES (?, ?)'),
      chunk: db.prepare('INSERT INTO chunks (page_id, heading, text) VALUES (?, ?, ?)'),
      chunkFts: db.prepare('INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (?, ?, ?, ?)'),
      action: db.prepare('INSERT INTO actions (page_id, role, label, action_type) VALUES (?, ?, ?, ?)'),
      actionFts: db.prepare('INSERT INTO actions_fts (rowid, label, context, title) VALUES (?, ?, ?, ?)'),
    };
    db.transaction(() => {
      const { id, pages, ...meta } = site;
      db.prepare('INSERT INTO meta (json) VALUES (?)').run(JSON.stringify(meta));
      for (const page of pages) {
        const pageId = insert.page.run(page.url, page.title).lastInsertRowid;
        for (const c of page.chunks) insert.chunkFts.run(insert.chunk.run(pageId, c.heading, c.text).lastInsertRowid, forIndex(page.title), forIndex(c.heading), forIndex(c.text));
        for (const a of page.actions)
          insert.actionFts.run(insert.action.run(pageId, a.role, a.label, a.actionType).lastInsertRowid, forIndex(a.label), forIndex(a.context), forIndex(page.title));
      }
    })();
    db.close();
    keepVeil(site.host, site);
    renameSync(temp, path);
  } finally {
    db.close();
    rmSync(temp, { force: true });
  }
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
    // No host: made by a version that also stored the redacted values.
    if (!meta.host || hidesLess(meta, keptVeil(meta.host))) {
      rmSync(path, { force: true });
      throw unknownSite();
    }
    const now = new Date();
    utimesSync(path, now, now);
    return use(db, meta);
  } finally {
    db.close();
  }
}
