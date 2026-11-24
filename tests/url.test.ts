import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inScope, normalizeUrl, urlKey } from '../src/url.ts';
import { parseRobots } from '../src/robots.ts';

test('normalizes tracking params, param order, fragments and credentials', () => {
  assert.equal(normalizeUrl('HTTPS://U:p@Example.com:443/a?utm_source=x&b=2&a=1&fbclid=9#top'), 'https://example.com/a?a=1&b=2');
});
test('keeps hash routes', () => {
  assert.equal(normalizeUrl('https://x.com/#/settings'), 'https://x.com/#/settings');
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
