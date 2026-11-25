import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-'));
const { writeSite } = await import('../src/store.ts');
const { tools } = await import('../src/tools.ts');
const { estimateTokens } = await import('../src/budget.ts');

const tokens = (v: unknown) => estimateTokens(typeof v === 'string' ? v : JSON.stringify(v));
const call = async (name: string, args: object): Promise<any> => {
  const tool = tools.find((t) => t.name === name)!;
  return tool.run(tool.schema.parse(args));
};
const site = (id: string, veilLevel: 'standard' | 'strict', pages: number, perPage: number) => ({
  id, veilLevel, rawBytes: pages * 50_000, counts: { EMAIL: 3 }, host: `${id}.com`, patterns: [], selectors: [],
  pages: Array.from({ length: pages }, (_, p) => ({
    url: `https://x.com/docs/section-${p % 20}/page-${p}`, title: `Guide ${p}`,
    chunks: Array.from({ length: perPage }, (_, c) => ({ heading: `Topic ${c}`, text: `Passage ${c} of guide ${p} explains widget configuration and limits. ${'Extra filler words follow here. '.repeat(7)}` })),
    actions: [{ role: 'button', label: `Export CSV ${p}`, actionType: 'click', context: 'Reports' }],
  })),
});
const A = 's_aaaaaaaaaaaa', S = 's_bbbbbbbbbbbb', BIG = 's_cccccccccccc';

before(() => {
  const a = site(A, 'standard', 3, 4);
  a.pages[1].chunks[2].text = 'Refunds are issued within thirty days. Contact [EMAIL_1] for help.';
  writeSite(a); writeSite(site(S, 'strict', 30, 4)); writeSite(site(BIG, 'standard', 500, 20));
});

test('exposes exactly the six PRD tools', () => {
  assert.deepEqual(tools.map((t) => t.name), ['crawl_site', 'direct_search', 'find_action', 'site_map', 'peek_chunk', 'veil_audit']);
});
test('direct_search ranks the right chunk first with the documented fields', async () => {
  const r = await call('direct_search', { site_id: A, query: 'what is the refund policy' });
  assert.match(r.hits[0].snippet, /Refunds are issued/);
  assert.deepEqual(Object.keys(r.hits[0]), ['chunk_id', 'url', 'title', 'snippet', 'score']);
});
test('direct_search reports how many chunks contain every term', async () => {
  assert.equal((await call('direct_search', { site_id: A, query: 'refunds thirty' })).full_matches, 1);
  assert.equal((await call('direct_search', { site_id: A, query: 'nonexistentword' })).full_matches, 0);
});
test('search syntax from the agent is data, not FTS operators', async () => {
  for (const query of ['"', 'a OR', 'NEAR(', '* ^', "x'; DROP TABLE pages;--", '???']) await call('direct_search', { site_id: A, query });
  assert.ok((await call('direct_search', { site_id: A, query: 'refund' })).hits.length);
});
test('every tool response stays inside its hard token budget', async () => {
  for (const id of [A, S, BIG]) {
    for (const max_tokens of [50, 100, 250]) {
      assert.ok(tokens(await call('direct_search', { site_id: id, query: 'widget configuration', max_tokens, top_k: 20 })) <= max_tokens);
      assert.ok(tokens(await call('site_map', { site_id: id, max_tokens })) <= max_tokens);
    }
    assert.ok(tokens(await call('find_action', { site_id: id, intent: 'export csv', top_k: 20 })) <= 250);
    const { hits } = await call('direct_search', { site_id: id, query: 'widget' });
    assert.ok(tokens(await call('peek_chunk', { site_id: id, chunk_id: hits[0].chunk_id, window: 1 })) <= 300);
  }
});
test('default budget returns several hits, not one', async () => {
  assert.ok((await call('direct_search', { site_id: BIG, query: 'widget configuration' })).hits.length >= 3);
});
test('find_action returns opaque handles with the documented fields', async () => {
  const { actions } = await call('find_action', { site_id: A, intent: 'export csv' });
  assert.deepEqual(Object.keys(actions[0]), ['handle_id', 'url', 'role', 'label', 'action_type']);
  assert.match(actions[0].handle_id, /^el_/);
});
test('peek_chunk returns neighbours only from the same page', async () => {
  const { hits } = await call('direct_search', { site_id: A, query: 'refunds' });
  const near = await call('peek_chunk', { site_id: A, chunk_id: hits[0].chunk_id, window: 1 });
  assert.ok(near.chunks.length >= 2 && near.chunks.length <= 3);
  assert.ok(near.chunks.some((c: any) => /Refunds/.test(c.text)));
  assert.equal((await call('peek_chunk', { site_id: A, chunk_id: 'c_1', window: 1 })).chunks.every((c: any) => /guide 0/.test(c.text)), true);
});
test('strict mode caps text at 120 chars and hides titles in the map', async () => {
  const r = await call('direct_search', { site_id: S, query: 'widget', max_tokens: 1000 });
  assert.ok(r.hits.every((h: any) => h.snippet.length <= 120));
  const peek = await call('peek_chunk', { site_id: S, chunk_id: r.hits[0].chunk_id });
  assert.ok(peek.chunks.every((c: any) => c.text.length <= 120));
  const map = await call('site_map', { site_id: S, max_tokens: 2000 });
  assert.ok(!/Guide|Topic/.test(map) && /section-1/.test(map));
});
test('site_map is an indented route tree with titles and chunk counts', async () => {
  assert.match(await call('site_map', { site_id: A, max_tokens: 1000 }), /\n {2,}\S*page-1 .*Guide 1.*\(4\)/);
});
test('unknown or malicious ids give a clear error', async () => {
  for (const site_id of ['s_dddddddddddd', '../../etc/passwd', 's_aaaaaaaaaaaa/../x'])
    await assert.rejects(async () => call('direct_search', { site_id, query: 'a' }), /site_id/);
  for (const chunk_id of ['c_zzzz', 'nope', "c_1' OR 1"]) await assert.rejects(async () => call('peek_chunk', { site_id: A, chunk_id }), /chunk_id/);
});
test('searches languages written without spaces', async () => {
  const id = 's_eeeeeeeeeeee';
  const texts = ['退款政策为三十天。', '返金ポリシーは三十日です。', 'นโยบายการคืนเงินสามสิบวัน', '환불은 삼십일 이내에 가능합니다.', 'Plain English refunds.'];
  writeSite({ ...site(id, 'standard', 1, 0), pages: texts.map((text, i) => ({ url: `https://x.com/${i}`, title: `T${i}`, chunks: [{ heading: '', text }], actions: [{ role: 'button', label: text, actionType: 'click', context: '' }] })) });
  for (const [query, expected] of [['退款', 0], ['三十天', 0], ['ポリシー', 1], ['คืนเงิน', 2], ['환불', 3], ['refund', 4]] as const) {
    const r = await call('direct_search', { site_id: id, query });
    assert.equal(r.hits[0]?.snippet, texts[expected], query);
    assert.equal(r.full_matches, 1, query);
    assert.equal((await call('find_action', { site_id: id, intent: query })).actions[0]?.label, texts[expected], query);
  }
  assert.equal((await call('direct_search', { site_id: id, query: '款退' })).hits.length, 0);
});
test('veil_audit reports redaction counts and tokens saved, never values', async () => {
  const r = await call('veil_audit', { site_id: A });
  assert.deepEqual(r.redactions, { EMAIL: 3 });
  assert.ok(r.tokens_saved_per_search === r.raw_html_tokens - 250 && r.reduction_pct >= 95);
  assert.ok(!JSON.stringify(r).includes('john'));
});
test('index files are private to the user and replaced atomically', () => {
  const dir = process.env.VEILCRAWL_HOME!;
  for (const f of readdirSync(dir).filter((f) => f !== 'veils')) { assert.match(f, /\.db$/); assert.equal(statSync(join(dir, f)).mode & 0o077, 0); }
});
test('P95 direct_search latency is under 100ms on a 500-page site', async () => {
  const times: number[] = [];
  for (let i = 0; i < 100; i++) { const t = performance.now(); await call('direct_search', { site_id: BIG, query: `widget configuration limits guide ${i}` }); times.push(performance.now() - t); }
  const p95 = times.sort((x, y) => x - y)[94];
  console.log(`p95 ${p95.toFixed(1)}ms`);
  assert.ok(p95 < 100, `${p95}`);
});

const DAY = 24 * 60 * 60 * 1000;
const age = (file: string, days: number) => { const at = new Date(Date.now() - days * DAY); utimesSync(join(process.env.VEILCRAWL_HOME!, file), at, at); };
const exists = (file: string) => existsSync(join(process.env.VEILCRAWL_HOME!, file));
const make = (id: string, days: number) => { writeSite(site(id, 'standard', 1, 1)); age(`${id}.db`, days); };

test('an index untouched for a week is deleted, and one used within the week is kept', async () => {
  make('s_111111111111', 7.1); make('s_222222222222', 6.9);
  await assert.rejects(async () => call('direct_search', { site_id: 's_111111111111', query: 'widget' }), /site_id/);
  assert.ok(!exists('s_111111111111.db') && exists('s_222222222222.db'));
});
test('every way of reading a site counts as touching it', async () => {
  for (const [name, args] of [['direct_search', { query: 'widget' }], ['find_action', { intent: 'export' }], ['site_map', {}], ['peek_chunk', { chunk_id: 'c_1' }], ['veil_audit', {}]] as const) {
    make('s_333333333333', 6.9);
    await call(name, { site_id: 's_333333333333', ...args });
    assert.ok(Date.now() - statSync(join(process.env.VEILCRAWL_HOME!, 's_333333333333.db')).mtimeMs < 60_000, name);
  }
});
test('using one site clears other stale ones and crash leftovers, but nothing else in the folder', async () => {
  const dir = process.env.VEILCRAWL_HOME!;
  make('s_444444444444', 8); make('s_555555555555', 0);
  const leftovers = ['s_666666666666.db.123.tmp', 's_666666666666.db.123.tmp-journal'];
  writeFileSync(join(dir, 's_666666666666.db.124.tmp'), 'x'); age('s_666666666666.db.124.tmp', 2 / 24);
  writeFileSync(join(dir, 's_666666666666.db.125.tmp'), 'x');
  const mine = ['notes.txt', 'other.db', 's_666666666666.db.bak', 'xs_666666666666.db', 's_66666666666.db'];
  for (const f of [...leftovers, ...mine]) { writeFileSync(join(dir, f), 'x'); age(f, 30); }
  mkdirSync(join(dir, 's_777777777777.db')); age('s_777777777777.db', 30);
  await call('veil_audit', { site_id: 's_555555555555' });
  for (const f of ['s_444444444444.db', ...leftovers, 's_666666666666.db.124.tmp']) assert.ok(!exists(f), f);
  assert.ok(exists('s_666666666666.db.125.tmp'), 'another process may be writing it');
  rmSync(join(dir, 's_666666666666.db.125.tmp'));
  for (const f of [...mine, 's_777777777777.db']) assert.ok(exists(f), f);
  for (const f of [...mine, 's_777777777777.db']) rmSync(join(dir, f), { recursive: true });
});
test('crawling clears stale sites too', () => {
  make('s_888888888888', 8);
  writeSite(site('s_999999999999', 'standard', 1, 1));
  assert.ok(!exists('s_888888888888.db'));
});
test('starting the MCP server clears stale sites', () => {
  make('s_888888888888', 8);
  execFileSync(process.execPath, ['src/cli.ts', 'mcp'], { input: '', timeout: 20_000 });
  assert.ok(!exists('s_888888888888.db'));
});
test('the MCP server starts when nothing was ever crawled', () => {
  execFileSync(process.execPath, ['src/cli.ts', 'mcp'], { input: '', timeout: 20_000, env: { ...process.env, VEILCRAWL_HOME: join(process.env.VEILCRAWL_HOME!, 'missing') } });
});
test('searching while another process rewrites the index never fails', { timeout: 60_000 }, async () => {
  const id = 's_121212121212';
  const page = { ...site(id, 'standard', 15, 10) };
  writeSite(page);
  const script = `const { tools } = await import('./src/tools.ts'); const t = tools.find((t) => t.name === 'direct_search'); const end = Date.now() + 4000;
    while (Date.now() < end) t.run(t.schema.parse({ site_id: '${id}', query: 'widget' }));`;
  const readers = [1, 2].map(() => new Promise<void>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], (e) => (e ? reject(e) : resolve()))));
  let running = true;
  const done = Promise.all(readers).finally(() => { running = false; });
  while (running) { writeSite(page); await new Promise((r) => setTimeout(r, 1)); }
  await done;
});
