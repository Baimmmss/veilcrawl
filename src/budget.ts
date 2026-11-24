// shortcut: bytes/3 over-estimates English and roughly matches CJK; swap in a real tokenizer if exact counts matter.
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 3);
}

/** Cuts text to maxChars around the first matching term. */
export function snippet(text: string, maxChars: number, terms: string[] = []): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 2) return '';
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  const first = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, Math.min(first - Math.floor(maxChars / 3), text.length - maxChars + 2));
  const cut = text.slice(start, start + maxChars - 2).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + maxChars - 2 < text.length ? '…' : ''}`;
}

/** Keeps as many items as fit in maxTokens, shortening their text before dropping any. */
export function fitBudget<T, R>(items: T[], maxTokens: number, maxChars: number, build: (items: T[], chars: number) => R): R {
  const caps = [maxChars, 200, 140, 100, 70].filter((c) => c <= maxChars);
  for (let n = items.length; n > 0; n--) {
    for (const chars of n === 1 ? [...caps, 40, 0] : caps) {
      const result = build(items.slice(0, n), chars);
      if (estimateTokens(JSON.stringify(result)) <= maxTokens) return result;
    }
  }
  return build([], 0);
}
