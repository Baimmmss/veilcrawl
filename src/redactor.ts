import { isIPv6 } from 'node:net';
import { createContext, Script } from 'node:vm';
import { VeilError } from './errors.ts';

export type VeilLevel = 'standard' | 'strict';

const SEP = '[-.\\s\\u2010-\\u2015]';

// Earlier rules win when matches overlap. SELECTOR is counted by the crawler, not matched here.
// Values are often joined to a word ("Phone4155552671"), so letters never protect a match, and
// repeats are bounded because page text is hostile.
const RULES: { category: string; regex: RegExp; strict?: boolean; accept?: (match: string) => boolean }[] = [
  { category: 'SECRET', regex: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:.{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----|.{0,8000})/gs },
  { category: 'SECRET', regex: /eyJ[\w-]{10,1000}\.[\w-]{10,}(?:\.[\w-]+)?/g },
  {
    category: 'SECRET',
    regex:
      /(?:\bsk-[\w-]{16,}|sk-(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[A-Z])[\w-]{16,}|[srp]k_(?:live|test)_\w{16,}|whsec_\w{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[a-z]-[\w-]{10,}|AIza[\w-]{30,}|glpat-[\w-]{16,}|npm_\w{30,}|hf_\w{30,})/g,
  },
  { category: 'SECRET', regex: /(?<=Bearer\s{1,5})(?=\S{0,200}\d)[\w.~+/=-]{8,}/gi },
  {
    category: 'SECRET',
    regex: /(?<=(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s{0,5}[:=]\s{0,5}["']?)(?=[^\s"',;]{0,200}\d)[^\s"',;]{8,}/gi,
  },
  { category: 'EMAIL', regex: /[\p{L}\p{N}._%+-][\p{L}\p{N}._%+'-]{0,63}@[\p{L}\p{N}.-]{1,253}\.\p{L}{2,}/gu },
  { category: 'CREDIT_CARD', regex: /\d(?:[ \-·‐-―]{0,3}\d){12,}/g, accept: containsCard },
  { category: 'SSN', regex: new RegExp(`(?<!\\d)\\d{3}${SEP}\\d{2}${SEP}\\d{4}(?!\\d)`, 'g') },
  { category: 'PHONE', regex: /\+\d(?:[-.\s‐-―()]{0,2}\d){6,14}(?!\d)/g },
  { category: 'PHONE', regex: new RegExp(`(?<!\\d)\\(?[2-9]\\d{2}\\)?${SEP}{0,2}[2-9]\\d{2}${SEP}?\\d{4}(?!\\d)`, 'g'), accept: (m) => /\D/.test(m) },
  {
    category: 'PHONE',
    regex: new RegExp(`(?<![\\d.])\\(?0\\d{1,4}\\)?(?:${SEP}?\\d{2,4}){2,4}(?!\\d)`, 'g'),
    accept: (m) => digitsOf(m).length >= (/\D/.test(m) ? 9 : 11),
  },
  // Bare digits are usually not a phone (2147483647, an ISBN), so a word nearby has to say so.
  { category: 'PHONE', regex: /(?<=(?:phone|telp|telepon|mobile|fax|whatsapp|\b(?:tel|sms)\b).{0,40}|\bcall(?: (?:us|me|now))?(?: (?:at|on))?\W{0,3})(?<!\d)\d{9,13}(?!\d)/gis },
  { category: 'IP', regex: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, strict: true },
  { category: 'IP', regex: /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi, strict: true, accept: (m) => /\w/.test(m) && isIPv6(m) },
  { category: 'ID', regex: /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, strict: true },
  { category: 'ID', regex: /\d{6,}/g, strict: true },
];

// Runs a person's or agent's own pattern where it can be interrupted: regular expressions cannot time out by themselves.
const sandbox = createContext({});
const findAll = new Script('[...text.matchAll(regex)].map((m) => [m.index, m[0].length])');

function matchCustom(text: string, regex: RegExp): [number, number][] {
  try {
    return findAll.runInContext(Object.assign(sandbox, { text, regex }), { timeout: 1000 });
  } catch {
    throw new VeilError(`Redact pattern is too slow: ${regex.source}`);
  }
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d > 4 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// A card can sit next to unrelated numbers, so every run of whole digit groups in a real card layout is checked.
function containsCard(match: string): boolean {
  const groups = match.split(/\D+/);
  return groups.some((_, i) =>
    [1, 3, 4, 5].some((n) => {
      const card = groups.slice(i, i + n);
      const digits = card.join('');
      return (
        /^(?:1[3-9]|4,6,[45]|4,4,4,[1-4]|4,4,4,4,[1-3])$/.test(card.map((g) => g.length).join()) &&
        /^(?:22[2-9]|2[3-6]|27[01]|2720|[3-6])/.test(digits) &&
        luhn(digits)
      );
    }),
  );
}

const SENSITIVE_PARAM = /token|secret|passw|pwd|signature|session|api_?key|jwt|(?:^|[_-])(?:key|auth|sig|sid|code)$/i;

/** One instance per crawl, so a value keeps the same placeholder across the whole site. */
export class Redactor {
  readonly counts: Record<string, number> = {};
  /** placeholder -> original value. Local audit only: never serialize to an agent. */
  readonly originals = new Map<string, string>();
  private readonly placeholders = new Map<string, string>();
  private readonly seen: Record<string, number> = {};
  private readonly rules: typeof RULES;

  constructor(level: VeilLevel = 'standard', patterns: string[] = []) {
    const custom = patterns.map((p) => {
      // Escapes such as "\-" are only valid without the u flag; \p{L} only with it.
      for (const flags of ['giu', 'gi']) {
        try {
          return { category: 'CUSTOM', regex: new RegExp(p, flags) };
        } catch {
          continue;
        }
      }
      throw new VeilError(`Invalid redact pattern: ${p}`);
    });
    this.rules = [...custom, ...RULES.filter((r) => level === 'strict' || !r.strict)];
  }

  redact(input: string): string {
    const text = input.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '');
    const spans: { start: number; end: number; priority: number }[] = [];
    this.rules.forEach((rule, priority) => {
      const matches = rule.category === 'CUSTOM' ? matchCustom(text, rule.regex) : Array.from(text.matchAll(rule.regex), (m) => [m.index, m[0].length]);
      for (const [start, length] of matches)
        if (length && (rule.accept?.(text.slice(start, start + length)) ?? true)) spans.push({ start, end: start + length, priority });
    });
    spans.sort((a, b) => a.start - b.start);

    let out = '';
    let pos = 0;
    for (let i = 0; i < spans.length; ) {
      const span = { ...spans[i] };
      for (i++; i < spans.length && spans[i].start < span.end; i++) {
        span.end = Math.max(span.end, spans[i].end);
        span.priority = Math.min(span.priority, spans[i].priority);
      }
      out += text.slice(pos, span.start) + this.placeholder(this.rules[span.priority].category, text.slice(span.start, span.end));
      pos = span.end;
    }
    return out + text.slice(pos);
  }

  redactUrl(raw: string): string {
    const url = new URL(raw);
    url.username = url.password = '';
    const mask = (all: string, sep: string, key: string, value: string) =>
      SENSITIVE_PARAM.test(decode(key)) ? `${sep}${key}=${this.placeholder('SECRET', decode(value))}` : all;
    const masked = url.href.replace(/([?&])([^=&#]+)=([^&#]+)/g, mask).replace(/(;)([^=;?&#/]+)=([^;?&#/]+)/g, mask);
    const decoded = decode(decode(masked));
    const redacted = this.redact(decoded);
    return redacted === decoded ? masked : redacted;
  }

  private placeholder(category: string, value: string): string {
    this.counts[category] = (this.counts[category] ?? 0) + 1;
    const key = `${category}:${value}`;
    let token = this.placeholders.get(key);
    if (!token) {
      this.seen[category] = (this.seen[category] ?? 0) + 1;
      token = `[${category}_${this.seen[category]}]`;
      this.placeholders.set(key, token);
      this.originals.set(token, value);
    }
    return token;
  }
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
