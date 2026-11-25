export interface Robots {
  allowed(url: string): boolean;
  delayMs: number;
}

export function parseRobots(text: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number }[] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    const [, field, value] = line.replace(/#.*/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/) ?? [];
    const key = field?.toLowerCase();
    if (key === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [], delay: 0 });
      groups.at(-1)!.agents.push(value.toLowerCase());
      open = true;
    } else if (key && groups.length) {
      open = false;
      const group = groups.at(-1)!;
      if ((key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', path: value });
      if (key === 'crawl-delay') group.delay = Number(value) || 0;
    }
  }
  const own = groups.filter((g) => g.agents.includes('veilcrawl'));
  const active = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  const rules = active
    .flatMap((g) => g.rules)
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return {
    delayMs: Math.max(0, ...active.map((g) => g.delay)) * 1000,
    allowed(url) {
      const { pathname, search } = new URL(url);
      return rules.find((r) => matches(r.path, pathname + search))?.allow ?? true;
    },
  };
}

// Not a RegExp: a rule with many "*" would backtrack for minutes.
function matches(rule: string, target: string): boolean {
  const anchored = rule.endsWith('$');
  const parts = (anchored ? rule.slice(0, -1) : rule).split('*');
  const first = parts.shift()!;
  if (!target.startsWith(first)) return false;
  if (anchored && !parts.length) return target === first;
  const last = anchored ? parts.pop()! : '';
  let at = first.length;
  for (const part of parts) {
    const found = target.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return target.endsWith(last) && target.length - last.length >= at;
}

export async function fetchRobots(origin: string, userAgent: string): Promise<Robots> {
  const none: Robots = { allowed: () => false, delayMs: 0 };
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(10_000) });
    // RFC 9309: a missing file allows everything, an unreachable one allows nothing.
    if (res.status >= 500) return none;
    let text = '';
    const decoder = new TextDecoder();
    if (res.ok && res.body)
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > 500_000) break;
      }
    return parseRobots(text);
  } catch {
    return none;
  }
}
