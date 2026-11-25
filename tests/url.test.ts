import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { inScope, normalizeUrl, urlKey } from '../src/url.ts';
import { fetchRobots, parseRobots } from '../src/robots.ts';

test('normalizes tracking params, param order, fragments and credentials', () => {
  assert.equal(normalizeUrl('HTTPS://U:p@Example.com:443/a?utm_source=x&b=2&a=1&fbclid=9#top'), 'https://example.com/a?a=1&b=2');
});
test('keeps hash routes', () => {
  assert.equal(normalizeUrl('https://x.com/#/settings'), 'https://x.com/#/settings');
});
test('a final dot on the host is the same site', () => {
  assert.equal(urlKey('https://x.com./a'), urlKey('https://x.com/a'));
  assert.ok(inScope('https://x.com.:8080/', 'https://www.x.com:8080/') && !inScope('https://x.com.evil.io/', 'https://x.com/'));
});
test('rejects non-web URLs', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'not a url']) assert.equal(normalizeUrl(u), null);
});
test('key ignores trailing slash, www and scheme', () => {
  assert.equal(urlKey('http://www.x.com/a/'), urlKey('https://x.com/a'));
  assert.notEqual(urlKey('https://x.com/a'), urlKey('https://x.com/b'));
});
test('scope is the same host and port only', () => {
  assert.ok(inScope('https://www.x.com/a', 'http://x.com/'));
  for (const u of ['https://evil.com/', 'https://x.com.evil.com/', 'https://sub.x.com/', 'https://x.com:8443/']) assert.ok(!inScope(u, 'https://x.com/'), u);
});

test('robots: longest match wins, allow beats disallow on ties, wildcards work', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 2');
  assert.equal(r.allowed('https://x.com/private/a'), false);
  assert.equal(r.allowed('https://x.com/private/ok/1'), true);
  assert.equal(r.allowed('https://x.com/f.pdf'), false);
  assert.equal(r.allowed('https://x.com/f.pdf?x=1'), true);
  assert.equal(r.delayMs, 2000);
});
test('robots: our own group overrides *', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: VeilCrawl\nUser-agent: other\nDisallow: /no');
  assert.equal(r.allowed('https://x.com/yes'), true);
  assert.equal(r.allowed('https://x.com/no'), false);
});
test('robots: empty disallow and empty file allow everything', () => {
  assert.equal(parseRobots('User-agent: *\nDisallow:').allowed('https://x.com/a'), true);
  assert.equal(parseRobots('').allowed('https://x.com/a'), true);
});
test('robots: wildcards match in order, and anchors hold', () => {
  const r = parseRobots('User-agent: *\nDisallow: /a*b*c$\nDisallow: /x$\nDisallow: /*aa$');
  for (const [path, allowed] of [['/a1b2c', false], ['/a1c2b', true], ['/abcd', true], ['/abc', false], ['/x', false], ['/xy', true], ['/aaa', false]] as const)
    assert.equal(r.allowed(`https://x.com${path}`), allowed, path);
});
test('robots: many wildcards cannot hang the crawl', () => {
  const start = performance.now();
  parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(30)}b`).allowed(`https://x.com/${'a'.repeat(1900)}`);
  assert.ok(performance.now() - start < 500);
});
test('robots: an endless file is cut off, and its rules still apply', { timeout: 20_000 }, async () => {
  const server = createServer((_, res) => {
    res.writeHead(200).write('User-agent: *\nDisallow: /no\n');
    const push = () => { while (!res.destroyed && res.write(Buffer.alloc(1 << 20, '#'))); };
    res.on('drain', push).on('error', () => {});
    push();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const before = process.memoryUsage().rss;
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const robots = await fetchRobots(origin, 'x');
  assert.ok(process.memoryUsage().rss - before < 300e6);
  assert.equal(robots.allowed(`${origin}/no`), false);
  assert.equal(robots.allowed(`${origin}/yes`), true);
  server.closeAllConnections();
  server.close();
});
