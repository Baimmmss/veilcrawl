import { SENSITIVE_PARAM, type Redactor } from './redactor.ts';

export interface Block {
  heading: string;
  text: string;
  row: boolean;
}

const MAX_CHARS = 300;
const MAX_API_ROWS = 300;
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Turns page blocks into redacted micro-chunks. Redaction runs on whole blocks, before any splitting. */
export function chunkBlocks(blocks: Block[], redactor: Redactor): { heading: string; text: string }[] {
  const merged: Block[] = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    const small = last && !last.row && !block.row && last.heading === block.heading && block.text.length < 80;
    if (small && last.text.length + block.text.length < 200) last.text += ` · ${block.text}`;
    else merged.push({ ...block });
  }

  const chunks: { heading: string; text: string }[] = [];
  let heading = { raw: '', redacted: '' };
  for (const block of merged) {
    if (block.heading !== heading.raw) heading = { raw: block.heading, redacted: redactor.redact(block.heading).slice(0, 120) };
    for (const text of split(redactor.redact(block.text), block.row)) chunks.push({ heading: heading.redacted, text });
  }
  return chunks;
}

function split(text: string, row: boolean): string[] {
  const sentences = row ? [text] : Array.from(segmenter.segment(text), (s) => s.segment.trim());
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current.join(' '));
    current = [];
  };
  for (const part of sentences.filter(Boolean).flatMap(hardWrap)) {
    if (current.length === 3 || [...current, part].join(' ').length > MAX_CHARS) flush();
    current.push(part);
  }
  flush();
  return out;
}

function hardWrap(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const space = rest.lastIndexOf(' ', MAX_CHARS);
    const at = space > 0 ? space : MAX_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return [...parts, rest];
}

/**
 * Text fields of a JSON reply, one row per object as "key: value | key: value". Not redacted yet.
 * Fields named like a secret are dropped, and so are long strings without spaces (ids, hashes, base64).
 */
export function jsonBlocks(value: unknown, heading: string): Block[] {
  const blocks: Block[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (blocks.length >= MAX_API_ROWS || depth > 20 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item) => visit(item, depth + 1));
    const fields: string[] = [];
    for (const [key, field] of Object.entries(node)) {
      if (SENSITIVE_PARAM.test(key)) continue;
      if (field && typeof field === 'object') visit(field, depth + 1);
      else if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
        const text = String(field).replace(/\s+/g, ' ').trim();
        if (text && !(text.length > 200 && !text.includes(' '))) fields.push(`${key}: ${text}`);
      }
    }
    if (fields.length) blocks.push({ heading, text: fields.join(' | '), row: true });
  };
  visit(value, 0);
  return blocks;
}
