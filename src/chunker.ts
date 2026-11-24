import type { Redactor } from './redactor.ts';

export interface Block {
  heading: string;
  text: string;
  row: boolean;
}

const MAX_CHARS = 300;
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
