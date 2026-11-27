import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { SECRETS, startFixture } from './fixture.ts';

const { crawlSite } = await import('../src/crawler.ts');
const { deleteStale, openSite } = await import('../src/store.ts');

let site: Awaited<ReturnType<typeof startFixture>>;
before(async () => { site = await startFixture(); });
after(() => site.close());
const freshHome = () => { process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-keep-')); };
beforeEach(freshHome);

const home = () => process.env.VEILCRAWL_HOME!;
const file = (id: string) => join(home(), `${id}.db`);
const crawl = async (path = '', extra: { veil_level?: 'strict'; redact_patterns?: string[]; redact_selectors?: string[]; url?: string } = {}) =>
  (await crawlSite({ url: site.url + path, max_pages: 1, max_depth: 0, veil_level: 'standard', redact_patterns: [], redact_selectors: [], ...extra })).site_id;
const level = (id: string) => openSite(id, (_, meta) => meta.veilLevel);
const text = (id: string) => openSite(id, (db) => JSON.stringify(db.prepare('SELECT text FROM chunks').all()));

test('a strict site stays strict when crawled again, from any page', async () => {
  await crawl('', { veil_level: 'strict' });
  assert.equal(level(await crawl()), 'strict');
  assert.equal(level(await crawl('about')), 'strict');
});

test('redact patterns and selectors stay on when crawled again without them', async () => {
  assert.match(text(await crawl()), /Project Falcon.*INTERNAL NOTE/);
  await crawl('about', { redact_patterns: ['project\\s+falcon'] });
  await crawl('about', { redact_selectors: ['.internal-notes'] });
  assert.doesNotMatch(text(await crawl()), /Project Falcon|INTERNAL NOTE/);
});

test('a veil outlives the index that the weekly cleanup deletes', async () => {
  const id = await crawl('', { veil_level: 'strict' });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(file(id), old, old);
  deleteStale();
  assert.ok(!existsSync(file(id)));
  assert.equal(level(await crawl()), 'strict');
});

test('an index made before its site got a stronger veil is refused, not served', async () => {
  for (const stronger of [{ veil_level: 'strict' as const }, { redact_patterns: ['refund'] }, { redact_selectors: ['h1'] }]) {
    freshHome();
    const weak = await crawl('about');
    const strong = await crawl('', stronger);
    assert.throws(() => level(weak), /Unknown or expired site_id/);
    level(strong);
  }
});

test('a weaker index is replaced by the next crawl of the same address', async () => {
  const id = await crawl();
  await crawl('about', { veil_level: 'strict' });
  assert.throws(() => level(id), /Unknown or expired site_id/);
  assert.equal(level(await crawl()), 'strict');
});

test('one site does not change the veil of another', async () => {
  await crawl('', { veil_level: 'strict' });
  assert.equal(level(await crawl('', { url: site.url.replace('localhost', '127.0.0.1') })), 'standard');
});

test('a crawl that fails does not change the veil', async () => {
  await assert.rejects(crawl('gone', { veil_level: 'strict', redact_patterns: ['x'] }), /No pages/);
  assert.equal(level(await crawl()), 'standard');
});

test('an ordinary crawl leaves nothing behind but its index', async () => {
  const id = await crawl();
  assert.deepEqual(readdirSync(home()), [`${id}.db`]);
});

test('a saved veil is private to the user, and deleting it lets a person start over', async () => {
  await crawl('', { veil_level: 'strict' });
  const veils = join(home(), 'veils');
  assert.equal(statSync(veils).mode & 0o077, 0);
  for (const f of readdirSync(veils)) assert.equal(statSync(join(veils, f)).mode & 0o077, 0);
  assert.equal(readdirSync(veils).length, 1);
  rmSync(veils, { recursive: true });
  assert.equal(level(await crawl()), 'standard');
});

test('the index file holds no redacted value', async () => {
  const id = await crawl('', { redact_patterns: ['project\\s+falcon'], redact_selectors: ['.internal-notes'] });
  const bytes = readFileSync(file(id)).toString('latin1');
  for (const s of SECRETS) assert.ok(!bytes.includes(s), `stored: ${s}`);
});

test('an index from an older version, which holds redacted values, is deleted on use', async () => {
  const id = await crawl();
  const db = new Database(file(id));
  db.prepare("UPDATE meta SET json = json_remove(json, '$.host', '$.patterns', '$.selectors', '$.built')").run();
  db.close();
  assert.throws(() => level(id), /Unknown or expired site_id/);
  assert.ok(!existsSync(file(id)));
});
