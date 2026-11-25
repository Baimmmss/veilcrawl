import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-extract-'));
const { crawlSite } = await import('../src/crawler.ts');
const { findLightpanda, launchBrowser } = await import('../src/browser.ts');
const { openSite } = await import('../src/store.ts');

const pages: Record<string, string> = {
  '/': `<main><h1>Title <span style="display:none">HIDDENHEAD</span><span hidden>HIDDENATTR</span></h1>
    <table><tr><th>Name</th><th>Info</th></tr><tr><td>Ann<span style="display:none">HIDDENCELL</span><span style="visibility:hidden">HIDDENVIS</span></td><td><div>Phone</div><div>4155552671</div></td></tr></table>
    <a href="/x"><div>Call</div><div>2125552671</div></a>
    <form aria-label="Profile"><label>Bio <div><textarea>PRIVATEBIO</textarea></div></label><label>Country <div><select><option>OPTIONTEXT</option></select></div></label><span id=lb>Notes <textarea>PRIVATENOTE</textarea></span><input aria-labelledby=lb></form>
    <div style="visibility:hidden"><button><span>Hidden menu item</span></button></div>
    <a href="/list?page=1">1</a> <a href="/list?page=2">2</a> <a href="/list?page=3">3</a></main>`,
  ...Object.fromEntries([1, 2, 3].map((n) => [`/list?page=${n}`, `<link rel=canonical href="/list?page=1"><main><p>Item ${['', 'apple', 'banana', 'cherry'][n]} is listed here.</p></main>`])),
  '/faq': `<main><h3><button>How do refunds work?</button></h3><p>They take thirty days here.</p><aside class="note"><p>Warning: never delete the walrus folder.</p></aside>
    <a href="/t"><button>Buy ticket</button></a><table><tr><td>Ann</td><td><button>Remove Ann</button></td></tr></table></main><aside><p>Page sidebar ostrich.</p></aside>`,
  '/clobber': '<main><p>Clobber zebra text.</p><form class="deny">DENIEDFORM<input name="remove"></form><form id="f" aria-label="Issue">' + ['labels', 'matches', 'childNodes', 'closest', 'getAttribute', 'hasAttribute', 'querySelector', 'parentElement', 'shadowRoot', 'checkVisibility', 'tagName', 'nodeType', 'textContent', 'ownerDocument'].map((n) => `<input name="${n}"><input id="${n}">`).join('') + '<label for="title">Title field</label><input id="title"></form></main>',
  '/links': `<main>${Array.from({ length: 700 }, (_, i) => `<a href="/l${i}">Link number ${i}</a> `).join('')}</main>`,
  '/few': `<p>few</p>${Array.from({ length: 10 }, (_, i) => `<a href="/private/${i}">x</a>`).join('')}${Array.from({ length: 6 }, (_, i) => `<a href="/ok${i}">x</a>`).join('')}`,
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/ok${i}`, `<p>Allowed page ${i}.</p>`])),
  '/audit': '<main><p>Write to ann@example.com.</p><p>x\u009b2Jy</p></main>',
  '/robots.txt': 'User-agent: *\nDisallow: /private',
};
let server: Server;
let url: string;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/never') return;
    if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(pages['/robots.txt']);
    const body = req.url === '/hold' ? '<p>hold</p><a href="/never">n</a>' : pages[req.url!];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
});
after(() => { server.closeAllConnections(); server.close(); });

const crawl = (extra: { url?: string; max_pages?: number; max_depth?: number; veil_level?: 'strict'; redact_selectors?: string[] } = {}, local = {}) => crawlSite({ url, max_pages: 9, max_depth: 2, veil_level: 'standard', redact_patterns: [], redact_selectors: [], ...extra }, local);
const rows = (id: string, sql: string) => openSite(id, (db) => db.prepare(sql).raw().all()) as string[][];

for (const engine of ['lightpanda', 'chromium'] as const) {
  test(`${engine}: reads only visible text, keeps blocks apart, and indexes every list page`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    const { site_id } = await crawl({}, { engine });
    const chunks = rows(site_id, 'SELECT heading, text FROM chunks');
    const labels = rows(site_id, 'SELECT label FROM actions').flat();
    const all = JSON.stringify([chunks, labels]);
    for (const s of ['HIDDENHEAD', 'HIDDENATTR', 'HIDDENCELL', 'HIDDENVIS', 'PRIVATEBIO', 'PRIVATENOTE', 'OPTIONTEXT', '4155552671', '2125552671']) assert.ok(!all.includes(s), `indexed: ${s}`);
    assert.ok(chunks.some(([heading, text]) => heading === 'Title' && text === 'Name: Ann | Info: Phone [PHONE_2]' || text === 'Name: Ann | Info: Phone [PHONE_1]'), all);
    for (const label of ['Bio', 'Country', 'Notes', 'Hidden menu item']) assert.ok(labels.includes(label), `${label}: ${labels}`);
    assert.ok(labels.some((l) => /^Call \[PHONE_\d\]$/.test(l)), String(labels));
    for (const item of ['apple', 'banana', 'cherry']) assert.ok(all.includes(`Item ${item}`), item);
  });
}

for (const engine of ['lightpanda', 'chromium'] as const) {
  test(`${engine}: keeps headings in buttons and notes in the text, survives odd form fields, keeps every link`, async (t) => {
    const probe = await launchBrowser(engine).catch(() => null);
    if (!probe) return t.skip(`${engine} is not installed`);
    await probe.close();
    const one = async (path: string) => (await crawl({ url: url + path, max_pages: 1, redact_selectors: ['.deny'] }, { engine })).site_id;
    const faq = rows(await one('faq'), 'SELECT heading, text FROM chunks');
    assert.ok(faq.every(([h]) => h === 'How do refunds work?'), JSON.stringify(faq));
    const text = JSON.stringify(faq);
    assert.ok(/thirty days/.test(text) && /walrus/.test(text) && !/ostrich/.test(text) && !/Remove Ann/.test(text), text);
    const clobber = await one('clobber');
    const shown = JSON.stringify(rows(clobber, 'SELECT text FROM chunks'));
    assert.ok(/zebra/.test(shown) && !/DENIEDFORM/.test(shown), shown);
    const labels = rows(clobber, 'SELECT label FROM actions').flat();
    assert.ok(labels.includes('Issue') && labels.includes('Title field'), String(labels));
    assert.equal(rows(await one('links'), 'SELECT 1 FROM actions').length, 700);
  });
}

test('links blocked by robots.txt do not use up the page limit', async () => {
  const result = await crawl({ url: `${url}few`, max_pages: 5, max_depth: 1 });
  assert.equal(result.pages_indexed, 5);
});

test('a broken Lightpanda falls back to Chromium, and errors name the real cause', async (t) => {
  const saved = process.env.LIGHTPANDA_PATH;
  try {
    for (const bad of [tmpdir(), '/usr/bin/false']) {
      process.env.LIGHTPANDA_PATH = bad;
      await assert.rejects(launchBrowser('lightpanda'), /Lightpanda did not start/);
      const none = spawnSync(process.execPath, ['src/cli.ts', 'crawl_site', url], { env: { ...process.env, VEILCRAWL_ENGINE: 'auto', PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), 'no-browsers-here') } });
      assert.equal(none.status, 1);
      assert.match(none.stderr.toString(), /Lightpanda did not start.*Chromium/);
      assert.ok(!none.stderr.toString().includes('    at '));
      const session = await launchBrowser('auto').catch(() => null);
      if (!session) return t.skip('chromium is not installed');
      assert.equal(session.engine, 'chromium');
      await session.close();
    }
  } finally {
    if (saved === undefined) delete process.env.LIGHTPANDA_PATH;
    else process.env.LIGHTPANDA_PATH = saved;
  }
});

test('a mistyped VEILCRAWL_ENGINE is an error', async () => {
  const saved = process.env.VEILCRAWL_ENGINE;
  process.env.VEILCRAWL_ENGINE = 'chrome';
  try { await assert.rejects(launchBrowser(), /VEILCRAWL_ENGINE/); } finally {
    if (saved === undefined) delete process.env.VEILCRAWL_ENGINE;
    else process.env.VEILCRAWL_ENGINE = saved;
  }
});

test('the audit view shows a person the originals without terminal control codes', async () => {
  const asTerminal = 'data:text/javascript,process.stdin.isTTY=process.stdout.isTTY=true';
  const audit = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', asTerminal, 'src/cli.ts', ...args]);
  const { stdout } = await audit('crawl_site', `${url}audit`, '--max_pages', '1', '--audit', '--redact_patterns', 'x.{1,9}y');
  assert.ok(stdout.startsWith('[EMAIL_1]\tann@example.com\n[CUSTOM_1]\tx 2Jy\n{'), JSON.stringify(stdout));
});

test('VEILCRAWL_VEIL=strict overrides a weaker request, and a typo is an error', async () => {
  try {
    process.env.VEILCRAWL_VEIL = 'strict';
    const { site_id } = await crawl({ max_pages: 1 });
    assert.equal(openSite(site_id, (_, meta) => meta.veilLevel), 'strict');
    process.env.VEILCRAWL_VEIL = 'Strict';
    await assert.rejects(crawl({ max_pages: 1 }), /VEILCRAWL_VEIL/);
    process.env.VEILCRAWL_VEIL = 'standard';
    const again = await crawl({ max_pages: 1, veil_level: 'strict' });
    assert.equal(openSite(again.site_id, (_, meta) => meta.veilLevel), 'strict');
  } finally {
    delete process.env.VEILCRAWL_VEIL;
  }
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`Lightpanda stops when VeilCrawl gets ${signal}`, { skip: !findLightpanda(), timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, ['src/cli.ts', 'crawl_site', `${url}hold`, '--engine', 'lightpanda'], { stdio: 'ignore' });
    const exited = new Promise((r) => child.on('exit', (_, s) => r(s)));
    let pid = 0;
    while (!pid) {
      await sleep(200);
      try { pid = Number(execFileSync('pgrep', ['-P', String(child.pid), 'lightpanda']).toString()); } catch { /* not started yet */ }
    }
    await sleep(500);
    child.kill(signal);
    assert.equal(await exited, signal);
    await sleep(300);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
}
