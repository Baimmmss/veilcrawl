import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser, type BrowserEngine } from './browser.ts';
import { chunkBlocks, type Block } from './chunker.ts';
import { VeilError } from './errors.ts';
import { extractPage, type RawPage } from './extract.ts';
import { Redactor, type VeilLevel } from './redactor.ts';
import { fetchRobots, type Robots } from './robots.ts';
import { writeSite, type PageRecord } from './store.ts';
import { inScope, normalizeUrl, urlKey } from './url.ts';

export interface CrawlArgs {
  url: string;
  max_pages: number;
  max_depth: number;
  veil_level: VeilLevel;
  redact_patterns: string[];
  redact_selectors: string[];
}

/** Settings a person may change from the CLI. They are not offered to agents. */
export interface LocalCrawlOptions {
  concurrency?: number;
  delay_ms?: number;
  timeout_ms?: number;
  ignore_robots?: boolean;
  engine?: BrowserEngine;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; VeilCrawl/0.1)';
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);
const TRACKERS = /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|hotjar\.com|segment\.(?:io|com)|mixpanel\.com|amplitude\.com|fullstory\.com|clarity\.ms|googlesyndication\.com|intercom\.io|newrelic\.com|nr-data\.net)$/;
const NOT_A_PAGE = /\.(?:pdf|zip|gz|tar|dmg|exe|pkg|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|webp|svg|ico|mp[34]|webm|mov|woff2?|css|js|json|xml|rss)$/i;
const MAX_ACTIONS_PER_PAGE = 500;

type Skip = 'robots' | 'http_error' | 'not_html' | 'off_site' | 'failed' | 'duplicate';

export async function crawlSite(args: CrawlArgs, local: LocalCrawlOptions = {}) {
  const { concurrency = 4, delay_ms = 200, timeout_ms = 15_000, ignore_robots = false, engine } = local;
  const start = normalizeUrl(args.url);
  if (!start) throw new VeilError('url must be a full http:// or https:// address.');
  const redactor = new Redactor(args.veil_level, args.redact_patterns);

  const session = await launchBrowser(engine, timeout_ms);
  const { browser } = session;
  try {
    const context =
      session.engine === 'lightpanda'
        ? await browser.newContext()
        : await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block', acceptDownloads: false });
    if (session.engine === 'chromium') await blockAssets(context);
    await checkSelectors(context, args.redact_selectors);

    const robotsByOrigin = new Map<string, Promise<Robots>>();
    const robotsFor = (url: string): Promise<Robots> => {
      const { origin } = new URL(url);
      if (!robotsByOrigin.has(origin))
        robotsByOrigin.set(origin, ignore_robots ? Promise.resolve({ allowed: () => true, delayMs: 0 }) : fetchRobots(origin, USER_AGENT));
      return robotsByOrigin.get(origin)!;
    };
    if (!(await robotsFor(start)).allowed(start)) throw new VeilError('robots.txt disallows this address, or could not be reached.');

    let nextLoad = 0;
    const waitTurn = async (url: string) => {
      const gap = Math.max(delay_ms, Math.min((await robotsFor(url)).delayMs, 30_000));
      const at = Math.max(Date.now(), nextLoad);
      nextLoad = at + gap;
      await sleep(at - Date.now());
    };

    const load = async (url: string): Promise<{ url: string; data: RawPage } | Skip> => {
      if (!(await robotsFor(url)).allowed(url)) return 'robots';
      let page: Page | undefined;
      try {
        page = await (session.connect ? (await session.connect()).newPage() : context.newPage());
        page.on('popup', (popup) => void popup.close().catch(() => {}));
        // After the tab exists: its startup time must not eat into the gap between loads.
        await waitTurn(url);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout_ms });
        if (response && response.status() >= 400) return 'http_error';
        if (response && !/html/i.test(response.headers()['content-type'] ?? 'html')) return 'not_html';
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        const landed = normalizeUrl(page.url());
        if (!landed || !inScope(landed, start)) return 'off_site';
        if (!(await robotsFor(landed)).allowed(landed)) return 'robots';
        // evaluate has no timeout of its own, and a script that never ends would block it forever.
        const data = await Promise.race([page.evaluate(extractPage, args.redact_selectors), sleep(timeout_ms, null, { ref: false })]);
        if (!data) return 'failed';
        // A script may have navigated while we were reading.
        return normalizeUrl(page.url()) === landed ? { url: landed, data } : 'failed';
      } catch {
        return 'failed';
      } finally {
        // Not awaited: Lightpanda cannot close a tab while its script is running.
        void (session.connect ? page?.context().browser() : page)?.close().catch(() => {});
      }
    };

    const queue = [{ url: start, depth: 0 }];
    const queued = new Set([urlKey(start)]);
    const indexed = new Set<string>();
    const contents = new Set<string>();
    const actionKeys = new Set<string>();
    const pages: (Omit<PageRecord, 'chunks'> & { blocks: Block[] })[] = [];
    const skipped: Partial<Record<Skip, number>> = {};
    const skip = (why: Skip) => (skipped[why] = (skipped[why] ?? 0) + 1);
    let rawBytes = 0;
    let attempts = 0;

    // shortcut: one slow page holds up its batch, use a worker pool if crawls get too long.
    while (queue.length && pages.length < args.max_pages && attempts < args.max_pages * 2) {
      const batch = queue.splice(0, Math.min(concurrency, args.max_pages - pages.length));
      attempts += batch.length;
      const results = await Promise.all(batch.map((item) => load(item.url)));
      results.forEach((result, i) => {
        if (typeof result === 'string') return skip(result);
        const { data } = result;
        if (batch[i].depth < args.max_depth) {
          for (const link of data.links) {
            const url = normalizeUrl(link);
            if (!url || url.length > 2000 || !inScope(url, start) || NOT_A_PAGE.test(new URL(url).pathname) || queued.has(urlKey(url))) continue;
            queued.add(urlKey(url));
            queue.push({ url, depth: batch[i].depth + 1 });
          }
        }

        const url = canonicalUrl(result.url, data.canonical);
        const content = data.blocks.length ? createHash('sha256').update(JSON.stringify(data.blocks)).digest('hex') : url;
        if (indexed.has(urlKey(url)) || contents.has(content)) return skip('duplicate');
        indexed.add(urlKey(url));
        queued.add(urlKey(url));
        contents.add(content);

        rawBytes += data.rawBytes;
        if (data.denied) redactor.counts.SELECTOR = (redactor.counts.SELECTOR ?? 0) + data.denied;
        const actions = data.actions.filter((a) => !actionKeys.has(a.key) && actionKeys.add(a.key)).slice(0, MAX_ACTIONS_PER_PAGE);
        pages.push({
          url: redactor.redactUrl(url),
          title: redactor.redact(data.title).slice(0, 200),
          blocks: data.blocks,
          actions: actions.map((a) => ({
            role: redactor.redact(a.role).slice(0, 40),
            label: redactor.redact(a.label).slice(0, 120),
            actionType: a.actionType,
            context: redactor.redact(a.context).slice(0, 120),
          })),
        });
      });
    }
    if (!pages.length) throw new VeilError(`No pages could be indexed (${JSON.stringify(skipped)}).`);

    dropRepeatedBlocks(pages);
    const records: PageRecord[] = pages.map(({ blocks, ...page }) => ({ ...page, chunks: chunkBlocks(blocks, redactor) }));
    const id = `s_${createHash('sha256').update(urlKey(start)).digest('hex').slice(0, 12)}`;
    writeSite({ id, startUrl: redactor.redactUrl(start), veilLevel: args.veil_level, rawBytes, counts: redactor.counts, originals: redactor.originals, pages: records });
    return {
      site_id: id,
      pages_indexed: records.length,
      chunks_count: records.reduce((n, p) => n + p.chunks.length, 0),
      actions_count: records.reduce((n, p) => n + p.actions.length, 0),
      redactions_applied: redactor.counts,
      skipped,
    };
  } finally {
    await session.close();
  }
}

async function blockAssets(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const frame = request.isNavigationRequest() && request.resourceType() === 'document' ? parentFrameOf(request) : null;
    const tracker = URL.canParse(request.url()) && TRACKERS.test(new URL(request.url()).hostname);
    return BLOCKED_TYPES.has(request.resourceType()) || tracker || frame ? route.abort() : route.continue();
  });
}

function parentFrameOf(request: import('playwright').Request) {
  try {
    return request.frame().parentFrame();
  } catch {
    return null; // Playwright throws when the page does not exist yet; that is never an iframe.
  }
}

async function checkSelectors(context: BrowserContext, selectors: string[]): Promise<void> {
  const page = await context.newPage();
  for (const selector of selectors) {
    const valid = await page.evaluate((s) => { try { document.querySelector(s); return true; } catch { return false; } }, selector);
    if (!valid) throw new VeilError(`Invalid redact selector: ${selector}`);
  }
  await page.close();
}

/** Sites often point every page's canonical link at the home page by mistake, so that case is ignored. */
function canonicalUrl(url: string, canonical: string | null): string {
  const target = canonical && normalizeUrl(canonical);
  if (!target || !inScope(target, url)) return url;
  return new URL(target).pathname === '/' && new URL(url).pathname !== '/' ? url : target;
}

/**
 * A sentence repeated on most pages is page chrome: keep it once. Short text ("In stock") and table rows
 * are facts about their own page, so they stay. Runs before chunking, which merges neighbouring blocks.
 */
function dropRepeatedBlocks(pages: { blocks: Block[] }[]): void {
  const uses = new Map<string, number>();
  for (const page of pages) for (const text of new Set(page.blocks.map((b) => b.text))) uses.set(text, (uses.get(text) ?? 0) + 1);
  const threshold = Math.max(3, pages.length / 2);
  const kept = new Set<string>();
  for (const page of pages)
    page.blocks = page.blocks.filter((b) => b.row || b.text.length < 40 || uses.get(b.text)! < threshold || (!kept.has(b.text) && kept.add(b.text)));
}
