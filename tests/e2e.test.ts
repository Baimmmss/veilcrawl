import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { SECRETS, startFixture } from './fixture.ts';

const HOME = (process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-e2e-')));
const { createMcpServer } = await import('../src/mcp.ts');
const { estimateTokens } = await import('../src/budget.ts');
const { crawlSite } = await import('../src/crawler.ts');

let site: Awaited<ReturnType<typeof startFixture>>;
let client: Client;
let crawl: any;
const transcript: string[] = [];

async function call(name: string, args: object): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args as any });
  transcript.push(JSON.stringify(result));
  const text = result.content[0].text;
  if (result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}
const cli = (...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(process.execPath, ['src/cli.ts', ...args], { env: { ...process.env, VEILCRAWL_HOME: HOME } }, (e, out, err) => resolve({ code: e ? Number(e.code) : 0, out, err })));
const rows = (id: string, sql: string) => { const db = new Database(join(HOME, `${id}.db`), { readonly: true }); try { return db.prepare(sql).all() as any[]; } finally { db.close(); } };
const visited = (path: string) => site.hits.filter((h) => h.path === path).length;

before(async () => {
  site = await startFixture();
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  crawl = await call('crawl_site', { url: site.url, redact_patterns: ['project\\s+falcon'], redact_selectors: ['.internal-notes'] });
});
after(async () => { await client.close(); site.close(); });

test('crawl_site returns statistics only', () => {
  assert.deepEqual(Object.keys(crawl).sort(), ['actions_count', 'chunks_count', 'pages_indexed', 'redactions_applied', 'semantic_search', 'site_id', 'skipped', 'unchanged_chunks']);
  assert.equal(crawl.pages_indexed, rows(crawl.site_id, 'SELECT * FROM pages').length);
  assert.ok(crawl.redactions_applied.EMAIL >= 7 && crawl.redactions_applied.CUSTOM >= 1 && crawl.redactions_applied.SELECTOR >= 1);
});

test('indexes JavaScript-rendered and shadow-DOM content', async () => {
  assert.match((await call('direct_search', { site_id: crawl.site_id, query: 'zebra' })).hits[0].snippet, /zebra/);
  assert.match((await call('direct_search', { site_id: crawl.site_id, query: 'walrus' })).hits[0].snippet, /walrus/);
});

test('table rows carry their column names', async () => {
  assert.match((await call('direct_search', { site_id: crawl.site_id, query: 'Max price' })).hits[0].snippet, /Plan: Max \| Price: \$99/);
});

test('boilerplate, hidden text and repeated chrome are not indexed', () => {
  const text = JSON.stringify(rows(crawl.site_id, 'SELECT text FROM chunks'));
  for (const s of ['NAVBOILERPLATE', 'FOOTERBOILERPLATE', 'HIDDENTEXT']) assert.ok(!text.includes(s), s);
  assert.equal(text.split('Repeated promo banner').length - 1, 1);
  assert.ok(text.split('In stock').length - 1 > 3, 'short facts shared by pages must survive');
});

test('find_action finds buttons, submits, inputs and downloads once each', async () => {
  for (const [intent, label, type] of [['export csv', 'Export CSV', 'click'], ['run report', 'Run report', 'submit'], ['work email', 'Work email', 'input'], ['handbook', 'Download the handbook', 'download'], ['launch', 'Shadow launch', 'click'], ['search docs', 'Search docs', 'submit']]) {
    const { actions } = await call('find_action', { site_id: crawl.site_id, intent });
    assert.ok(actions.some((a: any) => a.label === label && a.action_type === type), `${intent}: ${JSON.stringify(actions)}`);
  }
  assert.equal(rows(crawl.site_id, "SELECT * FROM actions WHERE label = 'About us'").length, 1);
});

test('duplicate URLs and canonical aliases are indexed once', () => {
  assert.equal(visited('/about'), 1);
  assert.equal(rows(crawl.site_id, "SELECT * FROM pages WHERE url LIKE '%alias%'").length, 0);
});

test('stays on site, obeys robots, depth, auth walls and file types', () => {
  for (const p of ['/private/x', '/d4', '/file.pdf', '/from-denied']) assert.equal(visited(p), 0, p);
  assert.ok(visited('/d3') === 1);
  const urls = JSON.stringify(rows(crawl.site_id, 'SELECT url FROM pages'));
  for (const s of ['offsite', '127.0.0.1', 'login', 'gone', '/data']) assert.ok(!urls.includes(s), s);
  assert.equal(crawl.skipped.robots, 1);
  assert.equal(crawl.skipped.off_site, 1);
});

test('images, fonts and frames are never downloaded', () => {
  for (const p of ['/img.png', '/f.woff2', '/frame']) assert.equal(visited(p), 0, p);
});

test('identifies itself honestly', () => {
  assert.match(site.hits.find((h) => h.path === '/about')!.ua!, /VeilCrawl/);
});

test('no secret reaches the agent through any tool, and none is searchable', async () => {
  const id = crawl.site_id;
  for (const { ref } of rows(id, 'SELECT ref FROM chunks')) await call('peek_chunk', { site_id: id, chunk_id: `c_${ref}`, window: 1 });
  for (const s of SECRETS) {
    await call('direct_search', { site_id: id, query: s, top_k: 20, max_tokens: 2000 });
    await call('find_action', { site_id: id, intent: s, top_k: 20 });
  }
  for (const q of ['contact', 'email', 'user', 'message']) await call('find_action', { site_id: id, intent: q, top_k: 20 });
  await call('site_map', { site_id: id, max_tokens: 2000 });
  await call('veil_audit', { site_id: id });
  const seen = transcript.join('\n');
  for (const s of SECRETS) assert.ok(!seen.includes(s), `leaked: ${s}`);
  for (const s of ['urlpath', 'urlquery', '<p>', '<div', 'set-cookie']) assert.ok(!seen.includes(s), `leaked: ${s}`);
  const index = JSON.stringify(['pages', 'chunks', 'chunks_fts', 'actions', 'actions_fts', 'meta'].map((t) => rows(id, `SELECT * FROM ${t}`)));
  for (const s of SECRETS) assert.ok(!index.includes(s), `indexed: ${s}`);
});

test('search costs at least 95% fewer tokens than the raw HTML', async () => {
  const r = await call('direct_search', { site_id: crawl.site_id, query: 'refund window' });
  const { raw_html_tokens } = await call('veil_audit', { site_id: crawl.site_id });
  assert.ok(estimateTokens(JSON.stringify(r)) <= raw_html_tokens * 0.05);
});

test('MCP offers the seven tools and no way to disable robots', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties!), ['url', 'max_pages', 'max_depth', 'veil_level', 'redact_patterns', 'redact_selectors']);
});

test('bad input gives a clear error', async () => {
  await assert.rejects(call('crawl_site', { url: 'file:///etc/passwd' }), /http/);
  await assert.rejects(call('crawl_site', { url: site.url, redact_patterns: ['('] }), /redact pattern/);
  await assert.rejects(call('crawl_site', { url: site.url, redact_selectors: ['..bad'] }), /redact selector/);
});

test('max_pages is a hard limit', async () => {
  assert.equal(((await crawlSite({ url: `${site.url}about`, max_pages: 2, max_depth: 3, veil_level: 'standard', redact_patterns: [], redact_selectors: [] })) as any).pages_indexed, 2);
});

test('waits politely between page loads', async () => {
  site.hits.length = 0;
  await crawlSite({ url: `${site.url}d1`, max_pages: 3, max_depth: 1, veil_level: 'standard', redact_patterns: [], redact_selectors: [] }, { delay_ms: 400 });
  const at = site.hits.filter((h) => ['/d1', '/d2', '/', '/about'].includes(h.path)).map((h) => h.at);
  assert.ok(at.length >= 3);
  at.slice(1).forEach((t, i) => assert.ok(t - at[i] >= 350, `${t - at[i]}ms`));
});

test('a failed re-crawl keeps the existing index', async () => {
  site.state.down = true;
  await assert.rejects(call('crawl_site', { url: site.url }), /robots|No pages/);
  site.state.down = false;
  assert.ok((await call('direct_search', { site_id: crawl.site_id, query: 'refund' })).hits.length);
});

test('CLI crawls, searches and lets a human override robots', async () => {
  const made = await cli('crawl_site', `${site.url}private/x`, '--ignore_robots', '--max_pages', '1');
  assert.match(made.err, /No pages/);
  const ok = await cli('crawl_site', `${site.url}about`, '--max_pages', '1', '--redact_patterns', 'ship', '--redact_patterns', 'worldwide');
  assert.equal(ok.code, 0, ok.err);
  const { site_id } = JSON.parse(ok.out);
  const found = JSON.parse((await cli('direct_search', site_id, 'refund', 'window', '--top_k', '1')).out);
  assert.match(found.hits[0].snippet, /refund window/);
  assert.match(found.hits[0].snippet, /\[CUSTOM_1\] \[CUSTOM_2\]/);
});

test('CLI rejects unknown tools, flags and bad values with a non-zero exit', async () => {
  for (const args of [['nope'], ['site_map'], ['site_map', 's_x', '--bogus'], ['direct_search', crawl.site_id, 'a', '--top_k', 'many']]) {
    const r = await cli(...args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.ok(r.err && !r.err.includes('    at '), r.err);
  }
});

test('the local audit view refuses to run without a human terminal', async () => {
  site.hits.length = 0;
  const r = await cli('crawl_site', site.url, '--audit');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /terminal/);
  assert.equal(site.hits.length, 0);
  for (const s of SECRETS) assert.ok(!(r.out + r.err).includes(s));
});
