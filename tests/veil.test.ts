import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redactor } from '../src/redactor.ts';
import { estimateTokens, fitBudget, snippet } from '../src/budget.ts';
import { chunkBlocks } from '../src/chunker.ts';

const fake = (prefix: string, n: number) => prefix + 'a1B2c3D4'.repeat(10).slice(0, n);

const MUST_REDACT: Record<string, string[]> = {
  EMAIL: ['john@example.com', 'john.o+tag@sub.example.co.uk', 'jo​hn@example.com', 'john@example.com', 'jösé@exämple.de'],
  PHONE: ['(415) 555-2671', '415-555-2671', '415.555.2671', '(415)5552671', '+1 415 555 2671', '+14155552671', '+62 812-3456-7890', '0812-3456-7890', '081234567890', '020 7946 0958', '415‑555‑2671', '415–555–2671'],
  SSN: ['123-45-6789', '123 45 6789'],
  CREDIT_CARD: ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '378282246310005'],
  SECRET: [
    fake('sk-', 40), fake('sk-proj-', 40), fake('sk-ant-api03-', 40), fake('sk_live_', 24), fake('rk_live_', 24), fake('pk_test_', 24),
    fake('ghp_', 36), fake('github_pat_', 40), 'AKIAIOSFODNN7EXAMPLE', fake('xoxb-', 20), fake('AIza', 35), fake('glpat-', 20), fake('npm_', 36),
    `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`,
    ['BEGIN', 'END'].map((w) => `-----${w} RSA PRIVATE KEY-----`).join('\nMIIEabc123\n'),
  ],
};

for (const [category, values] of Object.entries(MUST_REDACT)) {
  for (const value of values) {
    test(`redacts ${category}: ${JSON.stringify(value).slice(0, 40)}`, () => {
      const out = new Redactor().redact(`before ${value} after`);
      assert.equal(out, `before [${category}_1] after`);
    });
  }
}

test('redacts values assigned to credential names, keeping the name', () => {
  const r = new Redactor();
  assert.equal(r.redact('api_key=zx81zx81zx81'), 'api_key=[SECRET_1]');
  assert.equal(r.redact('password: hunter2000'), 'password: [SECRET_2]');
  assert.match(r.redact('Authorization: Bearer abc.def-123456789'), /^Authorization: Bearer \[SECRET_3\]$/);
});

test('redacts a card that follows other digits', () => {
  assert.ok(!new Redactor().redact('Order 12 4111 1111 1111 1111').includes('4111'));
});

test('leaves ordinary text alone', () => {
  for (const s of ['Released 2024-01-15 at 09:30', 'version 1.2.3 of 10', 'Price $1,299.00 for 100 units', 'password: required', 'ISO 4217 and 1732456789'])
    assert.equal(new Redactor().redact(s), s);
});

test('same value keeps the same placeholder; different values differ', () => {
  const r = new Redactor();
  assert.equal(r.redact('a@x.com b@x.com a@x.com'), '[EMAIL_1] [EMAIL_2] [EMAIL_1]');
  assert.equal(r.redact('b@x.com'), '[EMAIL_2]');
  assert.deepEqual(r.counts, { EMAIL: 4 });
});

test('custom patterns win, are case-insensitive, and never touch placeholders', () => {
  const r = new Redactor('standard', ['project\\s+falcon', 'email', 'custom']);
  assert.equal(r.redact('PROJECT Falcon a@x.com'), '[CUSTOM_1] [EMAIL_1]');
});

test('overlapping matches are removed as one span', () => {
  const r = new Redactor('standard', ['bob@acme']);
  assert.ok(!r.redact('bob@acme.com').includes('.com'));
});

test('empty-matching patterns do nothing and invalid ones throw', () => {
  assert.equal(new Redactor('standard', ['z*']).redact('abc'), 'abc');
  assert.throws(() => new Redactor('standard', ['(']), /redact pattern/i);
});

test('strict mode also hides IPs, UUIDs and long numbers', () => {
  const s = 'host 10.0.0.12 id 123e4567-e89b-12d3-a456-426614174000 order 998877';
  assert.equal(new Redactor().redact('10.0.0.12 998877'), '10.0.0.12 998877');
  assert.equal(new Redactor('strict').redact(s), 'host [IP_1] id [ID_1] order [ID_2]');
});

test('redacts URLs: userinfo, encoded PII, credential params', () => {
  const r = new Redactor();
  assert.equal(r.redactUrl('https://x.com/docs?page=2&keyword=a'), 'https://x.com/docs?page=2&keyword=a');
  for (const u of ['https://u:hunter2@x.com/', 'https://x.com/?accessToken=hunter2', 'https://x.com/?key=hunter2', 'https://x.com/#/a?session_id=hunter2'])
    assert.ok(!r.redactUrl(u).includes('hunter2'), u);
  for (const u of ['https://x.com/u/john%40example.com', 'https://x.com/?e=john%2540example.com'])
    assert.ok(!/john/.test(r.redactUrl(u)), u);
});

test('token estimate counts non-Latin text as heavier', () => {
  assert.ok(estimateTokens('日本語日本語') >= 6);
  assert.equal(estimateTokens(''), 0);
});

test('snippet centres on the match and respects the cap', () => {
  const s = snippet('x '.repeat(200) + 'needle here ' + 'y '.repeat(200), 80, ['needle']);
  assert.ok(s.length <= 80 && s.includes('needle'), s);
  assert.equal(snippet('short', 80, []), 'short');
});

test('fitBudget never exceeds max tokens, even for one oversized item', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ i, t: 'word '.repeat(200) }));
  for (const max of [50, 100, 250]) {
    const out = fitBudget(items, max, 280, (xs, cap) => ({ hits: xs.map((x) => ({ i: x.i, t: x.t.slice(0, cap) })) }));
    assert.ok(estimateTokens(JSON.stringify(out)) <= max);
  }
});

test('fitBudget prefers more items with shorter text', () => {
  const items = Array.from({ length: 4 }, () => 'word '.repeat(100));
  const out = fitBudget(items, 250, 280, (xs, cap) => xs.map((x) => x.slice(0, cap)));
  assert.equal(out.length, 4);
});

test('chunks are 1-3 sentences; rows stay whole', () => {
  const chunks = chunkBlocks([
    { heading: 'H', text: 'One is here. Two is here. Three is here. Four is here. Five is here.', row: false },
    { heading: 'H', text: 'Plan: Pro | Price: $20', row: true },
    { heading: 'H', text: 'Plan: Max | Price: $99', row: true },
  ], new Redactor());
  assert.deepEqual(chunks.map((c) => c.text), [
    'One is here. Two is here. Three is here.', 'Four is here. Five is here.', 'Plan: Pro | Price: $20', 'Plan: Max | Price: $99',
  ]);
});

test('tiny neighbouring blocks under one heading merge', () => {
  const chunks = chunkBlocks([{ heading: 'A', text: 'Pro', row: false }, { heading: 'A', text: '$20', row: false }, { heading: 'B', text: 'Other', row: false }], new Redactor());
  assert.deepEqual(chunks, [{ heading: 'A', text: 'Pro · $20' }, { heading: 'B', text: 'Other' }]);
});

test('redaction happens before splitting, so long text cannot cut a secret in half', () => {
  const text = 'w'.repeat(290) + ' ' + fake('sk-', 60) + ' ' + 'z '.repeat(300);
  const chunks = chunkBlocks([{ heading: 'a@x.com', text, row: false }], new Redactor());
  assert.ok(chunks.every((c) => c.text.length <= 300 && !c.text.includes('a1B2') && c.heading === '[EMAIL_1]'));
  assert.ok(chunks.some((c) => c.text.includes('[SECRET_1]')));
});

test('patterns that are only valid without the unicode flag still work', () => {
  assert.equal(new Redactor('standard', ['foo\\-bar']).redact('x foo-bar y'), 'x [CUSTOM_1] y');
});

test('a long integer is not a card just because some digits inside it look like one', () => {
  for (const s of ['max 9223372036854775807 end', 'min 9223372036854775808 end']) assert.equal(new Redactor().redact(s), s);
});

test('redacts a card with digits on both sides', () => {
  for (const s of ['12 4111 1111 1111 1111 2027', '4111111111111111 12-27', '99 4111111111111111'])
    assert.ok(!/4111|1111/.test(new Redactor().redact(s)), s);
});

test('redacts values joined to a word', () => {
  for (const value of ['415-555-2671', '0812-3456-7890', '081234567890', fake('sk_live_', 24), fake('sk-proj-', 40), fake('ghp_', 36), `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.cc`])
    for (const s of [`Label${value}`, `id_${value}`]) assert.ok(!new Redactor().redact(s).includes(value.slice(-6)), s);
  for (const s of ['Phone4155552671', 'Call2125552671', 'phone 4155552671ext']) assert.ok(!/\d{4}/.test(new Redactor().redact(s)), s);
});

test('hyphenated words that contain "sk-" are not keys', () => {
  for (const s of ['task-management-system-overview', 'disk-encryption-and-recovery', 'risk-based-authentication-v2']) assert.equal(new Redactor().redact(s), s);
});

test('strict mode hides IPv6 addresses but not times or code', () => {
  for (const ip of ['2001:db8:85a3::8a2e:370:7334', 'fe80::1', '::1', '2001:0db8:0000:0000:0000:ff00:0042:8329'])
    assert.equal(new Redactor('strict').redact(`host ${ip}.`), 'host [IP_1].', ip);
  for (const s of ['at 12:34:56 today', 'std::add and foo::bar', 'a :: b']) assert.equal(new Redactor('strict').redact(s), s);
});

test('redacts whole emails with an apostrophe, keeping surrounding quotes', () => {
  assert.equal(new Redactor().redact("o'brien@example.com"), '[EMAIL_1]');
  assert.equal(new Redactor().redact("mail 'ann@example.com' now"), "mail '[EMAIL_1]' now");
});

test('redacts a card split into neighbouring boxes', () => {
  const [chunk] = chunkBlocks(['4111', '1111', '1111', '1111'].map((text) => ({ heading: '', text, row: false })), new Redactor());
  assert.equal(chunk.text, '[CREDIT_CARD_1]');
});

test('hostile text cannot make redaction slow', () => {
  const n = 200_000;
  for (const part of ['a', '1', '1 ', '1 · ', 'eyJ', 'sk-', 'token=', 'a@', 'a.', '+1', '(0', 'Bearer ', ':a', '-----BEGIN PRIVATE KEY-----', "a'"]) {
    const start = performance.now();
    new Redactor('strict').redact(part.repeat(n / part.length));
    assert.ok(performance.now() - start < 3000, `${part}: ${Math.round(performance.now() - start)}ms`);
  }
});

test('a custom pattern that runs away is stopped, not skipped', () => {
  const start = performance.now();
  assert.throws(() => new Redactor('standard', ['(a+)+$']).redact('a'.repeat(40) + '!'), (e: Error) => /too slow/.test(e.message) && !e.message.includes('(a+)'));
  assert.ok(performance.now() - start < 5000);
});

test('hides a private key whose end marker is missing or far away', () => {
  const out = new Redactor().redact(`-----BEGIN PRIVATE KEY-----\n${'MIIEabc '.repeat(500)}\n${'later text '.repeat(3000)}`);
  assert.ok(!out.includes('MIIEabc'));
});

test('a bare number is a phone only next to a word that says so', () => {
  for (const s of ['Phone: 4155552671', 'phone numbers 4155552671, 4155552672', 'Mobile · 4155552671', 'Call us at 4155552671', 'Telp 0215551234', 'Fax 4155552671'])
    assert.ok(!/\d{9}/.test(new Redactor().redact(s)), s);
  for (const s of ['max is 2147483647', 'uint 4294967295', 'ISBN 0306406152', 'the syscall returns 2147483647', 'cell value 4294967295'])
    assert.equal(new Redactor().redact(s), s);
});

test('rows of ordinary numbers are not cards', () => {
  let seed = 7;
  const next = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  for (let i = 0; i < 2000; i++) {
    const small = Array.from({ length: 12 }, () => 1 + next(99)).join(' ');
    const years = Array.from({ length: 5 }, () => 1990 + next(40)).join(' ');
    for (const s of [small, years]) assert.ok(!new Redactor().redact(s).includes('CREDIT'), s);
  }
});

test('redacts every real card layout, even after a year', () => {
  for (const card of ['4111111111111111', '4111 1111 1111 1111', '3782 822463 10005', '3056 930902 5904', '5555-5555-5555-4444', '2223 0031 2200 3222', '6011000990139424', '4222222222222'])
    for (const s of [`Card ${card} end`, `2020 ${card} 12`, `Card${card}`]) assert.match(new Redactor().redact(s), /\[CREDIT_CARD_1\]/, s);
});

test('hides session codes in paths without shortening other secrets', () => {
  const r = new Redactor();
  assert.ok(!r.redactUrl('https://x.com/a;jsessionid=1A2B3C4D?x=1').includes('1A2B'));
  for (const u of ['https://x.com/?token=aaa;bbb', 'https://x.com/?token=aaa?bbb', 'https://x.com/a;session=aaa;v=1']) assert.ok(!/aaa|bbb/.test(r.redactUrl(u)), u);
  assert.equal(r.redactUrl('https://x.com/a;v=1/b?x=1'), 'https://x.com/a;v=1/b?x=1');
});
