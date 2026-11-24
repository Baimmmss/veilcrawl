import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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

/** Everything here is already redacted, except `originals`, which only the local audit reads. */
export interface SiteRecord {
  id: string;
  startUrl: string;
  veilLevel: VeilLevel;
  rawBytes: number;
  counts: Record<string, number>;
  originals: Map<string, string>;
  pages: PageRecord[];
}

export interface SiteMeta {
  startUrl: string;
  veilLevel: VeilLevel;
  rawBytes: number;
  counts: Record<string, number>;
}

const SCHEMA = `
  CREATE TABLE meta (json TEXT NOT NULL, served INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL);
  CREATE INDEX chunks_page ON chunks (page_id);
  CREATE VIRTUAL TABLE chunks_fts USING fts5 (title, heading, text, tokenize = 'porter unicode61');
  CREATE TABLE actions (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, action_type TEXT NOT NULL);
  CREATE VIRTUAL TABLE actions_fts USING fts5 (label, context, title, tokenize = 'porter unicode61');
  CREATE TABLE originals (placeholder TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function pathFor(siteId: string): string {
  if (!/^s_[0-9a-f]{12}$/.test(siteId)) throw new VeilError('Unknown site_id. Run crawl_site first.');
  return join(process.env.VEILCRAWL_HOME ?? join(homedir(), '.veilcrawl'), `${siteId}.db`);
}

/** Builds the index beside the live one and swaps it in, so a failed crawl never destroys an index. */
export function writeSite(site: SiteRecord): void {
  const path = pathFor(site.id);
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
      original: db.prepare('INSERT INTO originals VALUES (?, ?)'),
    };
    db.transaction(() => {
      const meta: SiteMeta = { startUrl: site.startUrl, veilLevel: site.veilLevel, rawBytes: site.rawBytes, counts: site.counts };
      db.prepare('INSERT INTO meta (json) VALUES (?)').run(JSON.stringify(meta));
      for (const page of site.pages) {
        const pageId = insert.page.run(page.url, page.title).lastInsertRowid;
        for (const c of page.chunks) insert.chunkFts.run(insert.chunk.run(pageId, c.heading, c.text).lastInsertRowid, page.title, c.heading, c.text);
        for (const a of page.actions)
          insert.actionFts.run(insert.action.run(pageId, a.role, a.label, a.actionType).lastInsertRowid, a.label, a.context, page.title);
      }
      for (const [placeholder, value] of site.originals) insert.original.run(placeholder, value);
    })();
    db.close();
    renameSync(temp, path);
  } finally {
    db.close();
    rmSync(temp, { force: true });
  }
}

export function openSite<T>(siteId: string, use: (db: Database.Database, meta: SiteMeta) => T): T {
  const path = pathFor(siteId);
  if (!existsSync(path)) throw new VeilError('Unknown site_id. Run crawl_site first.');
  const db = new Database(path, { fileMustExist: true });
  try {
    const row = db.prepare('SELECT json FROM meta').get() as { json: string };
    return use(db, JSON.parse(row.json));
  } finally {
    db.close();
  }
}
