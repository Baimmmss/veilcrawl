const TRACKING = /^(?:utm_.+|gclid|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid|igshid|_ga)$/i;

/** Canonical form of a web URL, or null when it is not one. */
export function normalizeUrl(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = url.password = '';
  // "#/route" and "#!route" are client-side pages; any other fragment is a position on the same page.
  if (!/^#[/!]/.test(url.hash)) url.hash = '';
  if (url.search) {
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
  }
  return url.href;
}

function site(url: URL): string {
  return url.host.replace(/^www\./, '');
}

/** Identity used for deduplication. */
export function urlKey(url: string): string {
  const u = new URL(url);
  return site(u) + u.pathname.replace(/\/+$/, '') + u.search + u.hash;
}

export function inScope(url: string, start: string): boolean {
  return site(new URL(url)) === site(new URL(start));
}
