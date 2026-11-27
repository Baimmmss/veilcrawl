import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

// Veils stick to a host, so every test starts from an empty home.
const freshHome = () => { process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-phase2-')); };
freshHome();
beforeEach(freshHome);
const { crawlSite } = await import('../src/crawler.ts');
const { launchBrowser } = await import('../src/browser.ts');
const { openSite, writeSite } = await import('../src/store.ts');
const { tools } = await import('../src/tools.ts');

const tabs = `<main><h1>Plans</h1>
  <div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1">Monthly</button><button role="tab" aria-selected="false" aria-controls="p2">Yearly</button></div>
  <div role="tabpanel" id="p1"><p>Monthly costs ten dollars.</p></div><div role="tabpanel" id="p2" hidden></div>
  <button aria-expanded="false" aria-controls="acc">Shipping</button><div id="acc" hidden><p>Parcels leave within two days.</p></div>
  <details><summary>Warranty</summary><p>Every kettle has a lifetime warranty.</p></details>
  <nav><button aria-expanded="false" aria-controls="menu">Menu</button></nav><div id="menu" hidden><p>MENUTEXT</p></div></main>
  <script>
  document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((o) => o.setAttribute('aria-selected', String(o === t)));
    document.querySelectorAll('[role=tabpanel]').forEach((p) => (p.hidden = p.id !== t.getAttribute('aria-controls')));
    if (t.textContent === 'Yearly') document.getElementById('p2').innerHTML = '<p>Yearly costs ninety dollars.</p><p class="deny">YEARLYSECRET</p>';
  }));
  document.querySelectorAll('[aria-expanded]').forEach((b) => b.addEventListener('click', () => (document.getElementById(b.getAttribute('aria-controls')).hidden = false)));
  </script>`;

const api = `<main><h1>Catalog</h1><p>Loading the catalog.</p></main><script>
  fetch('/api/items').then((r) => r.json());
  fetch('/private/api').then((r) => r.json());
  fetch('/graphql', { method: 'POST', body: '{}' }).then((r) => r.json());
  </script>`;

const hashTabs = `<main><h1>Hash tabs</h1><div role="tablist"><a role="tab" href="#/one" aria-selected="true" aria-controls="h1">One</a><a role="tab" href="#/two" aria-selected="false" aria-controls="h2">Two</a></div>
  <div role="tabpanel" id="h1"><p>First hash panel.</p></div><div role="tabpanel" id="h2" hidden><p>Second hash panel.</p></div></main>
  <script>document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => document.querySelectorAll('[role=tabpanel]').forEach((p) => (p.hidden = p.id !== t.getAttribute('aria-controls')))));</script>`;
const live = '<main><p>Live dashboard text.</p></main><script>fetch("/live").then((r) => r.body.getReader().read())</script>';
const shell = (n: number) => `<main><p>Loading the shop.</p><a href="/shell/${3 - n}">other</a></main><script>fetch("/api/shell/${n}").then((r) => r.json())</script>`;

const json: Record<string, unknown> = {
  '/api/shell/1': { product: 'Iron teapot' },
  '/api/shell/2': { product: 'Glass teapot' },
  '/api/items': { items: [{ name: 'Copper kettle', price: 49, owner: 'ann@example.com', api_key: 'APIKEYVALUE', blob: 'Z'.repeat(300) }] },
  '/private/api': { note: 'ROBOTSBLOCKED' },
  '/graphql': { data: { shop: { motto: 'Tea for everyone' } } },
};

const list = (order: string) => {
  const items = ['Alpha widget is red.', 'Beta widget is blue.', 'Gamma widget is green.'];
  return `<main><h1>Widgets</h1>${(order === 'desc' ? items.toReversed() : items).map((i) => `<p>${i}</p>`).join('')}
    <a href="/list?sort=${order === 'desc' ? 'asc' : 'desc'}">sort</a> <a href="/list?sort=${order}&amp;next=${order}">trap</a></main>`;
};

let server: Server;
let url: string;
const hits: string[] = [];
before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url!);
    const path = req.url!.split('?')[0];
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private');
    if (path === '/live') return void res.writeHead(200, { 'content-type': 'application/x-ndjson' }).write('{"tick":1}\n');
    if (json[path]) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json[path]));
    const kettle = (colour: string) => `<main><h1>${colour} kettle</h1><p>Boils a litre in two minutes.</p><a href="/kettle/blue">blue</a></main>`;
    const body = { '/tabs': tabs, '/api': api, '/list': list(new URL(req.url!, 'http://x').searchParams.get('sort') ?? 'asc'), '/kettle/red': kettle('Red'), '/kettle/blue': kettle('Blue'),
      '/hashtabs': hashTabs, '/stream': live, '/shell/1': shell(1), '/shell/2': shell(2) }[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
});
after(() => { server.closeAllConnections(); server.close(); });

const crawl = (path: string, extra = {}, local = {}) =>
  crawlSite({ url: url + path, max_pages: 10, max_depth: 3, veil_level: 'standard', redact_patterns: [], redact_selectors: [], ...extra }, local);
const text = (id: string) => openSite(id, (db) => JSON.stringify(db.prepare('SELECT heading, text FROM chunks').raw().all()));

for (const engine of ['lightpanda', 'chromium'] as const) {
  test(`${engine}: opens tabs, accordions and details, but not menus, and keeps denied parts out`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    const all = text((await crawl('tabs', { max_pages: 1, redact_selectors: ['.deny'] }, { engine })).site_id);
    for (const s of ['Monthly costs ten', 'Yearly costs ninety', 'within two days', 'lifetime warranty']) assert.ok(all.includes(s), `${s}: ${all}`);
    assert.ok(all.includes('"Yearly"'), 'a copied panel is headed by its tab');
    for (const s of ['MENUTEXT', 'YEARLYSECRET']) assert.ok(!all.includes(s), s);
  });

  test(`${engine}: indexes the site's own JSON replies, redacted, without secret fields or robots-blocked ones`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    const all = text((await crawl('api', { max_pages: 1 }, { engine })).site_id);
    for (const s of ['name: Copper kettle | price: 49 | owner: [EMAIL_1]', 'motto: Tea for everyone', 'API /api/items']) assert.ok(all.includes(s), `${s}: ${all}`);
    for (const s of ['ann@example.com', 'APIKEYVALUE', 'ZZZZ', 'ROBOTSBLOCKED']) assert.ok(!all.includes(s), s);
  });
}

for (const engine of ['lightpanda', 'chromium'] as const) {
  test(`${engine}: tabs that change the address, and JSON streams that never end, do not lose the page`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    assert.match(text((await crawl('hashtabs', { max_pages: 1 }, { engine })).site_id), /First hash panel.*Second hash panel/);
    const started = performance.now();
    assert.match(text((await crawl('stream', { max_pages: 1 }, { engine, timeout_ms: 8000 })).site_id), /Live dashboard text/);
    assert.ok(performance.now() - started < 7000, 'waited for the stream');
  });
}

test('pages that differ only in their API data are both kept', async () => {
  const { site_id, pages_indexed } = await crawl('shell/1');
  assert.equal(pages_indexed, 2);
  assert.match(text(site_id), /Iron teapot.*Glass teapot|Glass teapot.*Iron teapot/);
});

test('JSON replies are left out on strict sites and sites with redact selectors', async () => {
  for (const [path, extra] of [['api?strict', { veil_level: 'strict' }], ['api?selectors', { redact_selectors: ['.none'] }]] as const) {
    freshHome();
    assert.ok(!text((await crawl(path, { max_pages: 1, ...extra })).site_id).includes('Copper kettle'), path);
  }
});

test('a re-sorted copy of a page is skipped, and its links are not followed', async () => {
  hits.length = 0;
  const result = await crawl('list');
  assert.equal(result.pages_indexed, 1);
  assert.ok(result.skipped.duplicate! >= 1);
  assert.ok(!hits.some((h) => h.includes('next=desc')), String(hits));
});

test('pages that differ only in their heading are both kept', async () => {
  assert.equal((await crawl('kettle/red')).pages_indexed, 2);
});

test('direct_search finds a passage by meaning and stays under 100 ms P95 with vectors', { timeout: 600_000 }, async (t) => {
  // A cache that outlives the test home, so the model is downloaded once per checkout.
  const models = resolve('node_modules/.cache/veilcrawl-models');
  mkdirSync(models, { recursive: true });
  symlinkSync(models, join(process.env.VEILCRAWL_HOME!, 'models'));
  delete process.env.VEILCRAWL_SEMANTIC;
  try {
    const search = tools.find((t) => t.name === 'direct_search')!;
    const ask = async (site_id: string, query: string, top_k = 5) => (await search.run(search.schema.parse({ site_id, query, top_k }))) as any;
    const { site_id } = await crawl('tabs', { max_pages: 1 });
    const found = await ask(site_id, 'guarantee on teapots', 1);
    assert.match(found.hits[0]?.snippet ?? '', /warranty/, JSON.stringify(found));
    assert.equal(found.full_matches, 0, 'no keyword matched');

    const unit = (seed: number) => {
      const v = Float32Array.from({ length: 384 }, (_, i) => Math.sin(seed * 7.1 + i * 1.3));
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
    const vectors = new Float32Array(10_000 * 384);
    for (let i = 0; i < 10_000; i++) vectors.set(unit(i), i * 384);
    writeSite({
      id: 's_feedfeedfeed', host: 'big.test', veilLevel: 'standard', patterns: [], selectors: [], rawBytes: 1, counts: {},
      pages: Array.from({ length: 500 }, (_, p) => ({
        url: `https://big.test/p${p}`, title: `Guide ${p}`, actions: [],
        chunks: Array.from({ length: 20 }, (_, c) => ({ heading: `Topic ${c}`, text: `Passage ${c} of guide ${p} about widget limits.` })),
      })),
      vectors,
    });
    await ask('s_feedfeedfeed', 'warmup');
    // A machine running more than it has cores measures its own load, not VeilCrawl.
    if (loadavg()[0] > cpus().length) return t.skip(`machine too busy to time (load ${loadavg()[0].toFixed(0)})`);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const at = performance.now();
      await ask('s_feedfeedfeed', `widget limits ${i}`);
      times.push(performance.now() - at);
    }
    const p95 = times.toSorted((a, b) => a - b)[Math.floor(times.length * 0.95)];
    assert.ok(p95 < 100, `P95 ${p95.toFixed(1)} ms`);
  } finally {
    process.env.VEILCRAWL_SEMANTIC = 'off';
  }
});
