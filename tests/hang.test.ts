import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.VEILCRAWL_HOME = mkdtempSync(join(tmpdir(), 'veil-hang-'));
const { crawlSite } = await import('../src/crawler.ts');
const { launchBrowser } = await import('../src/browser.ts');

for (const engine of ['lightpanda', 'chromium'] as const) {
  for (const [name, script] of [['while loading', 'while(true){}'], ['after loading', "addEventListener('load',()=>setTimeout(()=>{while(true){}},0))"]]) {
    test(`${engine}: a script that never ends ${name} does not hang the crawl`, { timeout: 40_000 }, async (t) => {
      const probe = await launchBrowser(engine).catch(() => null);
      if (!probe) return t.skip(`${engine} is not installed`);
      await probe.close();
      const server = createServer((req, res) => {
        const good = `<p>Good page ${req.url} text.</p>${['/spin', '/a', '/b', '/c', '/d', '/e', '/f'].map((u) => `<a href="${u}">x</a>`).join('')}`;
        const body = req.url === '/spin' ? `<p>Spin page text.</p><script>${script}</script>` : good;
        res.writeHead(req.url === '/robots.txt' ? 404 : 200, { 'content-type': 'text/html' }).end(body);
      });
      await new Promise<void>((r) => server.listen(0, r));
      try {
        const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
        const result = await crawlSite({ url, max_pages: 20, max_depth: 1, veil_level: 'standard', redact_patterns: [], redact_selectors: [] }, { engine, timeout_ms: 2000 });
        assert.equal(result.pages_indexed, 7);
        assert.deepEqual(result.skipped, { failed: 1 });
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  }
}
