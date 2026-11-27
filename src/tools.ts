import { z } from 'zod';
import { runAction } from './act.ts';
import { estimateTokens, fitBudget, snippet } from './budget.ts';
import { crawlSite, type LocalCrawlOptions } from './crawler.ts';
import { VeilError } from './errors.ts';
import { embed } from './embed.ts';
import { forIndex, nearest, openSite } from './store.ts';

const SEARCH_TOKENS = 250;
const FIND_ACTION_TOKENS = 250;
const PEEK_TOKENS = 300;
/** How many results of each search are fused. */
const FUSE_DEPTH = 50;
/** all-MiniLM-L6-v2 puts unrelated text below about 0.2 and paraphrases above 0.4. */
const MIN_SIMILARITY = 0.35;

const siteId = z.string().describe('site_id returned by crawl_site');
const topK = z.coerce.number().int().min(1).max(20).default(5);
const maxTokens = (fallback: number) => z.coerce.number().int().min(50).max(2000).default(fallback).describe('Hard cap on response size');

const STOPWORDS = new Set('a an and are as at be by can do does for from how i in is it my of on or that the this to was what when where which who why will with you your'.split(' '));

function termsOf(query: string): string[] {
  const all = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  const useful = all.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return useful.length ? useful : all;
}

const ftsQuery = (terms: string[], operator: 'AND' | 'OR') => terms.map((t) => `"${forIndex(t)}"`).join(` ${operator} `);
const chunkId = (id: number) => `c_${id.toString(36)}`;

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  positional: string[],
  schema: S,
  run: (args: z.output<S>, local?: LocalCrawlOptions) => unknown,
) {
  return { name, description, positional, schema, run };
}

export const tools = [
  tool(
    'crawl_site',
    'Crawl and privately index a whole website on this machine. Returns a site_id and statistics, never page content. Redaction set by earlier crawls of the site stays on.',
    ['url'],
    z.object({
      url: z.string(),
      max_pages: z.coerce.number().int().min(1).max(5000).default(50),
      max_depth: z.coerce.number().int().min(0).max(20).default(3),
      veil_level: z.enum(['standard', 'strict']).default('standard'),
      redact_patterns: z.array(z.string()).default([]).describe('Extra regular expressions to redact'),
      redact_selectors: z.array(z.string()).default([]).describe('CSS selectors of elements that must never be indexed'),
    }),
    crawlSite,
  ),

  tool(
    'direct_search',
    'Search every indexed page of a site in one call, by words and by meaning. Returns short redacted snippets.',
    ['site_id', 'query'],
    z.object({ site_id: siteId, query: z.string(), top_k: topK, max_tokens: maxTokens(SEARCH_TOKENS) }),
    async (args) => {
      const terms = termsOf(args.query);
      // Checked first: loading the model for a site crawled without it would be wasted.
      const semantic = terms.length && openSite(args.site_id, (db) => !!db.prepare('SELECT 1 FROM vectors').get());
      const query = semantic ? await embed([args.query]) : null;
      return openSite(args.site_id, (db, meta) => {
        if (!terms.length) return { full_matches: 0, hits: [] };
        const keyword = db
          .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 3, 2, 1) LIMIT ${FUSE_DEPTH}`)
          .pluck()
          .all(ftsQuery(terms, 'OR')) as number[];
        const similar = query ? nearest(db, meta, query, FUSE_DEPTH, MIN_SIMILARITY) : [];
        // Reciprocal rank fusion: near the top of either list ranks high, in both lists ranks higher.
        const scores = new Map<number, number>();
        for (const list of [keyword, similar]) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + rank)));
        const get = db.prepare('SELECT p.url, p.title, c.text FROM chunks c JOIN pages p ON p.id = c.page_id WHERE c.id = ?');
        const rows = [...scores]
          .sort((a, b) => b[1] - a[1])
          .slice(0, args.top_k)
          .map(([id, score]) => ({ id, score, ...(get.get(id) as { url: string; title: string; text: string }) }));
        const { n } = db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?').get(ftsQuery(terms, 'AND')) as { n: number };
        return fitBudget(rows, args.max_tokens, meta.veilLevel === 'strict' ? 120 : 280, (items, chars) => ({
          full_matches: n,
          hits: items.map((r) => ({
            chunk_id: chunkId(r.id),
            url: snippet(r.url, 120),
            title: snippet(r.title, 60),
            snippet: snippet(r.text, chars, terms),
            score: Math.round(r.score * 1e4) / 1e4,
          })),
        }));
      });
    },
  ),

  tool(
    'find_action',
    'Find buttons, links, forms and downloads across every indexed page, e.g. "export CSV".',
    ['site_id', 'intent'],
    z.object({ site_id: siteId, intent: z.string(), top_k: topK }),
    (args) =>
      openSite(args.site_id, (db, meta) => {
        const terms = termsOf(args.intent);
        const rows = terms.length
          ? (db
              .prepare(
                `SELECT a.id, p.url, a.role, a.label, a.action_type
                 FROM actions_fts JOIN actions a ON a.id = actions_fts.rowid JOIN pages p ON p.id = a.page_id
                 WHERE actions_fts MATCH ? ORDER BY bm25(actions_fts, 5, 1, 1) LIMIT ?`,
              )
              .all(ftsQuery(terms, 'OR'), args.top_k) as { id: number; url: string; role: string; label: string; action_type: string }[])
          : [];
        return fitBudget(rows, FIND_ACTION_TOKENS, meta.veilLevel === 'strict' ? 60 : 80, (items, chars) => ({
          actions: items.map((r) => ({
            handle_id: `el_${r.id.toString(36)}`,
            url: snippet(r.url, 120),
            role: r.role,
            label: snippet(r.label, chars, terms),
            action_type: r.action_type,
          })),
        }));
      }),
  ),

  tool(
    'run_action',
    'Use controls from find_action, in order, on the live page: click, type a value, pick an option or submit. Acts as a visitor without a login. Returns only the redacted text that changed.',
    ['site_id'],
    z.object({
      site_id: siteId,
      steps: z
        .array(z.object({ handle_id: z.string(), value: z.string().max(2000).optional().describe('Text to type or option to pick') }))
        .min(1)
        .max(10)
        .describe('All on one page visit, e.g. type a name, then press Send'),
      max_tokens: maxTokens(SEARCH_TOKENS),
    }),
    runAction,
  ),

  tool(
    'site_map',
    'Compact tree of the indexed routes with page titles and chunk counts.',
    ['site_id'],
    z.object({ site_id: siteId, max_tokens: maxTokens(200) }),
    (args) =>
      openSite(args.site_id, (db, meta) => {
        const pages = db
          .prepare('SELECT p.id, p.url, p.title, count(c.id) AS chunks FROM pages p LEFT JOIN chunks c ON c.page_id = p.id GROUP BY p.id ORDER BY p.id')
          .all() as MapPage[];
        const headings = new Map<number, string[]>();
        for (const h of db.prepare("SELECT DISTINCT page_id, heading FROM chunks WHERE heading <> '' ORDER BY id").all() as { page_id: number; heading: string }[]) {
          const list = headings.get(h.page_id) ?? headings.set(h.page_id, []).get(h.page_id)!;
          if (list.length < 3) list.push(h.heading);
        }
        const withTitles = (p: MapPage) => ` ${snippet(p.title, 50)}`;
        const withHeadings = (p: MapPage) => `${withTitles(p)} [${(headings.get(p.id) ?? []).map((h) => snippet(h, 30)).join('; ')}]`;
        const details = meta.veilLevel === 'strict' ? [() => ''] : [withHeadings, withTitles, () => ''];
        for (const detail of details) {
          const tree = renderTree(pages, pages.length, detail);
          if (estimateTokens(tree) <= args.max_tokens) return tree;
        }
        // Too big even as bare routes: keep the pages nearest the start, which were crawled first.
        let low = 0;
        let high = pages.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (estimateTokens(renderTree(pages, mid, () => '')) <= args.max_tokens) low = mid;
          else high = mid - 1;
        }
        return renderTree(pages, low, () => '');
      }),
  ),

  tool(
    'peek_chunk',
    'Read one redacted chunk from a search hit, optionally with one neighbour on each side.',
    ['site_id', 'chunk_id'],
    z.object({ site_id: siteId, chunk_id: z.string(), window: z.coerce.number().int().min(0).max(1).default(0) }),
    (args) =>
      openSite(args.site_id, (db, meta) => {
        const id = /^c_[0-9a-z]{1,10}$/.test(args.chunk_id) ? parseInt(args.chunk_id.slice(2), 36) : 0;
        const target = db.prepare('SELECT page_id, heading FROM chunks WHERE id = ?').get(id) as { page_id: number; heading: string } | undefined;
        if (!target) throw new VeilError('Unknown chunk_id for this site.');
        const rows = db
          .prepare('SELECT id, text FROM chunks WHERE page_id = ? AND id BETWEEN ? AND ? ORDER BY id = ? DESC, id')
          .all(target.page_id, id - args.window, id + args.window, id) as { id: number; text: string }[];
        return fitBudget(rows, PEEK_TOKENS, meta.veilLevel === 'strict' ? 120 : 300, (items, chars) => ({
          heading: snippet(target.heading, 80),
          chunks: items.toSorted((a, b) => a.id - b.id).map((r) => ({ chunk_id: chunkId(r.id), text: snippet(r.text, chars) })),
        }));
      }),
  ),

  tool(
    'veil_audit',
    'Redaction counts by category and tokens a default search saves compared with raw HTML. Never includes redacted values.',
    ['site_id'],
    z.object({ site_id: siteId }),
    (args) =>
      openSite(args.site_id, (_, meta) => {
        const raw = Math.ceil(meta.rawBytes / 3);
        return {
          veil_level: meta.veilLevel,
          redactions: meta.counts,
          raw_html_tokens: raw,
          tokens_saved_per_search: raw - SEARCH_TOKENS,
          reduction_pct: raw ? Math.round((1 - SEARCH_TOKENS / raw) * 1000) / 10 : 0,
        };
      }),
  ),
];

interface MapPage {
  id: number;
  url: string;
  title: string;
  chunks: number;
}

function renderTree(all: MapPage[], count: number, detail: (page: MapPage) => string): string {
  const rows = all.slice(0, count).map((page) => {
    const [, host, path] = page.url.match(/^(\w+:\/\/[^/]+)(.*)$/) ?? ['', '', page.url];
    return { page, host, parts: path.split('/').filter(Boolean) };
  });
  rows.sort((a, b) => (a.parts.join('\0') < b.parts.join('\0') ? -1 : 1));
  const lines = [snippet(rows[0]?.host ?? '', 80)];
  let previous: string[] = [];
  for (const { page, parts } of rows) {
    let shared = 0;
    while (shared < parts.length - 1 && parts[shared] === previous[shared]) shared++;
    for (let i = shared; i < parts.length - 1; i++) lines.push(`${'  '.repeat(i + 1)}${snippet(parts[i], 60)}/`);
    const depth = Math.max(1, parts.length);
    lines.push(`${'  '.repeat(depth)}${snippet(parts.at(-1) ?? '/', 60)}${detail(page)} (${page.chunks})`);
    previous = parts;
  }
  if (count < all.length) lines.push(`… +${all.length - count} more pages`);
  return lines.join('\n');
}
