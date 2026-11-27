import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';

const freshHome = () => { process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-phase3-')); };
freshHome();
beforeEach(freshHome);
const { crawlSite, refreshIfStale } = await import('../src/crawler.ts');
const { launchBrowser } = await import('../src/browser.ts');
const { openSite } = await import('../src/store.ts');
const { tools } = await import('../src/tools.ts');
const { startDashboard } = await import('../src/dashboard.ts');

const escape = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
// Set to put a new control and passage first on the page, which renumbers every row of the next index.
let extra = '';
const pages: Record<string, (q: URLSearchParams) => string> = {
  '/': () => `<main>${extra}<h1>Contact</h1>
    <form action="/thanks"><label>Your name <input name="name"></label><label>Email <input name="email"></label>
    <select name="topic" aria-label="Topic"><option>Sales</option><option>Support</option></select><button>Send message</button></form>
    <button id="tip" type="button">Show tip</button><p id="out"></p><a href="/u/ann@example.com">Ann</a></main>
    <script>document.getElementById('tip').onclick = () => (document.getElementById('out').textContent = 'Tips are free on Fridays.');</script>`,
  '/thanks': (q) => `<main><p>Thanks ${escape(q.get('name') ?? '')}, we reply to ${escape(q.get('email') ?? '')} about ${escape(q.get('topic') ?? '')}.</p></main>`,
  '/mail': () => '<main><h1>Write to us</h1><p>Mail ann@example.com about &lt;script&gt;alert(1)&lt;/script&gt; bugs.</p></main>',
  '/u/ann@example.com': () => '<main><p>Profile page.</p><button type="button">Follow</button></main>',
};
let server: Server;
let url: string;
const hits: string[] = [];
before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url!);
    const { pathname, searchParams } = new URL(req.url!, 'http://x');
    const body = pages[decodeURIComponent(pathname)]?.(searchParams);
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
});
after(() => { server.closeAllConnections(); server.close(); });

const call = async (name: string, args: object): Promise<any> => {
  const tool = tools.find((t) => t.name === name)!;
  return tool.run(tool.schema.parse(args));
};
const crawl = (extra = {}) => crawlSite({ url, max_pages: 5, max_depth: 1, veil_level: 'standard', redact_patterns: [], redact_selectors: [], ...extra });
const handle = async (site_id: string, intent: string) => (await call('find_action', { site_id, intent, top_k: 1 })).actions[0].handle_id as string;

for (const engine of ['lightpanda', 'chromium'] as const) {
  test(`${engine}: run_action fills and submits a form, and returns only the redacted change`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    process.env.VEILCRAWL_ENGINE = engine;
    try {
      const { site_id } = await crawl();
      const steps = [
        { handle_id: await handle(site_id, 'your name'), value: 'Ann' },
        { handle_id: await handle(site_id, 'email'), value: 'ann@example.com' },
        { handle_id: await handle(site_id, 'topic'), value: 'Support' },
        { handle_id: await handle(site_id, 'send message') },
      ];
      const sent = await call('run_action', { site_id, steps });
      assert.equal(sent.navigated, true);
      assert.deepEqual(sent.changed, ['Thanks Ann, we reply to [EMAIL_1] about Support.']);
      assert.ok(!JSON.stringify(sent).includes('ann@example.com'));

      const tip = await call('run_action', { site_id, steps: [{ handle_id: await handle(site_id, 'show tip') }] });
      assert.deepEqual(tip, { url, title: '', navigated: false, changed: ['Tips are free on Fridays.'] });
    } finally {
      delete process.env.VEILCRAWL_ENGINE;
    }
  });
}

test('run_action refuses unknown handles and pages whose address held a hidden value', async () => {
  const { site_id } = await crawl();
  await assert.rejects(call('run_action', { site_id, steps: [{ handle_id: 'el_zzzz' }] }), /Unknown handle_id/);
  await assert.rejects(call('run_action', { site_id, steps: [{ handle_id: await handle(site_id, 'follow') }] }), /hidden value/);
});

test('a second crawl reuses unchanged chunks and says whether semantic search is on', async () => {
  const first = await crawl();
  const second = await crawl();
  assert.equal(first.unchanged_chunks, 0);
  assert.equal(second.unchanged_chunks, second.chunks_count);
  assert.equal(second.semantic_search, false);
});

test('an index a day old is crawled again in the background, at most once an hour', async () => {
  const { site_id } = await crawl();
  const file = join(process.env.VEILCRAWL_HOME!, `${site_id}.db`);
  const built = () => openSite(site_id, (_, meta) => meta.built);
  const old = built();
  const db = new Database(file);
  db.prepare("UPDATE meta SET json = json_set(json, '$.crawledAt', 0)").run();
  db.close();
  refreshIfStale(site_id);
  for (let i = 0; i < 100 && built() === old; i++) await sleep(200);
  assert.notEqual(built(), old, 'refreshed');
  const before = hits.length;
  refreshIfStale(site_id);
  await sleep(500);
  assert.equal(hits.length, before, 'a fresh index is left alone');
});

test('a site whose start address held a hidden value is never refreshed by itself', async () => {
  const { site_id } = await crawl({ url: `${url}u/ann@example.com` });
  assert.equal(openSite(site_id, (_, meta) => meta.crawl), null);
});

test('the dashboard marks hidden values on the live page, escapes page text, and refuses other links and hosts', async () => {
  const { site_id } = await crawl({ url: `${url}mail`, max_pages: 1 });
  const dash = await startDashboard();
  try {
    const get = async (path: string) => { const r = await fetch(dash.url + path); return { status: r.status, html: await r.text() }; };
    const home = await get('');
    assert.equal(home.status, 200);
    assert.ok(home.html.includes(site_id));
    const site = await get(`site/${site_id}`);
    assert.match(site.html, /Token savings[\s\S]*EMAIL/);
    const pageLink = site.html.match(/site\/s_[0-9a-f]{12}\/page\/\d+/)![0];
    const compare = await get(pageLink);
    assert.match(compare.html, /<mark title="\[EMAIL_1\]">ann@example\.com<\/mark>/);
    assert.match(compare.html, /Mail \[EMAIL_1\] about/, 'agent view');
    assert.ok(!compare.html.includes('<script>alert') && compare.html.includes('&#60;script&#62;alert(1)'), 'escaped');

    assert.equal((await fetch(dash.url.replace(/\/[0-9a-f]{32}\//, '/' + '0'.repeat(32) + '/'))).status, 404);
    const port = new URL(dash.url).port;
    const status = await new Promise<number>((resolve) =>
      request({ host: '127.0.0.1', port, path: new URL(dash.url).pathname, headers: { host: `evil.test:${port}` } }, (r) => resolve(r.statusCode!)).end(),
    );
    assert.equal(status, 403);
  } finally {
    dash.close();
  }
});

test('handles and chunk ids keep their meaning after the index is rebuilt', async () => {
  const { site_id } = await crawl();
  const tip = await handle(site_id, 'show tip');
  const hit = (await call('direct_search', { site_id, query: 'contact', top_k: 1 })).hits[0];
  extra = '<p>New banner text first.</p><button type="button">New first button</button>';
  try {
    await crawl();
    assert.deepEqual((await call('run_action', { site_id, steps: [{ handle_id: tip }] })).changed, ['Tips are free on Fridays.']);
    assert.equal((await call('peek_chunk', { site_id, chunk_id: hit.chunk_id })).chunks[0].text, hit.snippet);
  } finally {
    extra = '';
  }
});
