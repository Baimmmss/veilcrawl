import { VeilError } from './errors.ts';

export type VeilLevel = 'standard' | 'strict';

const SEP = '[-.\\s\\u2010-\\u2015]';

// Earlier rules win when matches overlap. SELECTOR is counted by the crawler, not matched here.
const RULES: { category: string; regex: RegExp; strict?: boolean; accept?: (match: string) => boolean }[] = [
  { category: 'SECRET', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gs },
  { category: 'SECRET', regex: /\beyJ[\w-]{10,}\.[\w-]{10,}(?:\.[\w-]+)?/g },
  {
    category: 'SECRET',
    regex:
      /\b(?:sk-[\w-]{16,}|[srp]k_(?:live|test)_\w{16,}|whsec_\w{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[a-z]-[\w-]{10,}|AIza[\w-]{30,}|glpat-[\w-]{16,}|npm_\w{30,}|hf_\w{30,})/g,
  },
  { category: 'SECRET', regex: /(?<=\bBearer\s+)(?=\S*\d)[\w.~+/=-]{8,}/gi },
  {
    category: 'SECRET',
    regex: /(?<=(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?)(?=[^\s"',;]*\d)[^\s"',;]{8,}/gi,
  },
  { category: 'EMAIL', regex: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu },
  { category: 'CREDIT_CARD', regex: /\d(?:[ \-‐-―]?\d){12,}/g, accept: containsCard },
  { category: 'SSN', regex: new RegExp(`(?<!\\d)\\d{3}${SEP}\\d{2}${SEP}\\d{4}(?!\\d)`, 'g') },
  { category: 'PHONE', regex: /\+\d(?:[-.\s‐-―()]{0,2}\d){6,14}(?!\d)/g },
  { category: 'PHONE', regex: new RegExp(`(?<!\\w)\\(?[2-9]\\d{2}\\)?${SEP}{0,2}[2-9]\\d{2}${SEP}?\\d{4}(?!\\w)`, 'g') },
  {
    category: 'PHONE',
    regex: new RegExp(`(?<![\\w.])\\(?0\\d{1,4}\\)?(?:${SEP}?\\d{2,4}){2,4}(?!\\w)`, 'g'),
    accept: (m) => digitsOf(m).length >= 9,
  },
  { category: 'IP', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, strict: true },
  { category: 'ID', regex: /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, strict: true },
  { category: 'ID', regex: /\d{6,}/g, strict: true },
];

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

// A card can sit next to unrelated numbers, so every run of whole digit groups is checked.
function containsCard(match: string): boolean {
  const groups = match.split(/\D+/);
  return groups.some((_, i) => {
    let digits = '';
    return groups.slice(i).some((group) => {
      digits += group;
      return /^[2-6]\d{12,18}$/.test(digits) && luhn(digits);
    });
  });
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
      for (const m of text.matchAll(rule.regex))
        if (m[0] && (rule.accept?.(m[0]) ?? true)) spans.push({ start: m.index, end: m.index + m[0].length, priority });
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
    const masked = url.href.replace(/([?&])([^=&#]+)=([^&#]+)/g, (all, sep, key, value) =>
      SENSITIVE_PARAM.test(decode(key)) ? `${sep}${key}=${this.placeholder('SECRET', decode(value))}` : all,
    );
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
