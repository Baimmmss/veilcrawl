import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserContext, Page, Response } from 'playwright';
import { launchBrowser, TRACKERS, type BrowserEngine } from './browser.ts';
import { chunkBlocks, jsonBlocks, type Block } from './chunker.ts';
import { embed } from './embed.ts';
import { VeilError } from './errors.ts';
import { expandPage, extractPage, type RawPage } from './extract.ts';
import { Redactor, type VeilLevel } from './redactor.ts';
import { fetchRobots, type Robots } from './robots.ts';
import { keptVeil, strongest, writeSite, type PageRecord } from './store.ts';
import { inScope, normalizeUrl, siteOf, urlKey } from './url.ts';

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
  /** Receives placeholder -> original value. They are never written to disk. */
  audit?(originals: Map<string, string>): void;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; VeilCrawl/0.2)';
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);
const NOT_A_PAGE = /\.(?:pdf|zip|gz|tar|dmg|exe|pkg|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|webp|svg|ico|mp[34]|webm|mov|woff2?|css|js|json|xml|rss)$/i;

type Skip = 'robots' | 'http_error' | 'not_html' | 'off_site' | 'failed' | 'duplicate';

export async function crawlSite(args: CrawlArgs, local: LocalCrawlOptions = {}) {
  const { concurrency = 4, delay_ms = 200, timeout_ms = 15_000, ignore_robots = false, engine, audit } = local;
  const start = normalizeUrl(args.url);
  if (!start) throw new VeilError('url must be a full http:// or https:// address.');
  // Set by the person running VeilCrawl, so an agent cannot crawl a site again with a weaker veil.
  const floor = process.env.VEILCRAWL_VEIL ?? 'standard';
  if (floor !== 'standard' && floor !== 'strict') throw new VeilError('VEILCRAWL_VEIL must be "standard" or "strict".');
  const host = siteOf(start);
  const asked = { veilLevel: floor === 'strict' ? floor : args.veil_level, patterns: args.redact_patterns, selectors: args.redact_selectors };
  const veil = strongest(keptVeil(host), asked);
  const redactor = new Redactor(veil.veilLevel, veil.patterns);

  const session = await launchBrowser(engine, timeout_ms);
  const { browser } = session;
  try {
    const context =
      session.engine === 'lightpanda'
        ? await browser.newContext()
        : await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block', acceptDownloads: false });
    if (session.engine === 'chromium') await blockAssets(context);
    await checkSelectors(context, veil.selectors);

    const robotsByOrigin = new Map<string, Promise<Robots>>();
    const robotsFor = (url: string): Promise<Robots> => {
      const { origin } = new URL(url);
      if (!robotsByOrigin.has(origin))
        robotsByOrigin.set(origin, ignore_robots ? Promise.resolve({ allowed: () => true, delayMs: 0 }) : fetchRobots(origin, USER_AGENT));
      return robotsByOrigin.get(origin)!;
    };
    if (!(await robotsFor(start)).allowed(start)) throw new VeilError('robots.txt disallows this address, or could not be reached.');

    let attempts = 0;
    let nextLoad = 0;
    const waitTurn = async (url: string) => {
      const gap = Math.max(delay_ms, Math.min((await robotsFor(url)).delayMs, 30_000));
      const at = Math.max(Date.now(), nextLoad);
      nextLoad = at + gap;
      await sleep(at - Date.now());
    };

    // A selector cannot hide a value inside JSON, and strict sites show as little as possible.
    const indexApi = veil.veilLevel === 'standard' && !veil.selectors.length;
    const replies = new Set<string>();
    const readReply = async (response: Response): Promise<Block[]> => {
      const url = response.url();
      const type = response.headers()['content-type'] ?? '';
      if (!/json/i.test(type) || response.status() >= 400 || Number(response.headers()['content-length']) > 2e6) return [];
      if (!inScope(url, start) || !(await robotsFor(url)).allowed(url)) return [];
      const text = await response.text();
      const hash = createHash('sha256').update(text).digest('hex');
      if (text.length > 2e6 || replies.has(hash)) return [];
      replies.add(hash);
      return jsonBlocks(JSON.parse(text), `API ${redactor.redactUrl(url).replace(/^\w+:\/\/[^/]+/, '').slice(0, 100)}`);
    };

    const load = async (url: string): Promise<{ url: string; data: RawPage; api: Block[] } | Skip> => {
      if (!(await robotsFor(url)).allowed(url)) return 'robots';
      attempts++;
      let page: Page | undefined;
      try {
        page = await (session.connect ? (await session.connect()).newPage() : context.newPage());
        page.on('popup', (popup) => void popup.close().catch(() => {}));
        const api: Promise<Block[]>[] = [];
        if (indexApi) page.on('response', (response) => void (api.length < 30 && api.push(readReply(response).catch(() => []))));
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
        const read = async () => {
          await page!.evaluate(expandPage, veil.selectors).catch(() => {});
          return { data: await page!.evaluate(extractPage, veil.selectors), api: (await Promise.all(api)).flat() };
        };
        const result = await Promise.race([read(), sleep(timeout_ms, null, { ref: false })]);
        if (!result) return 'failed';
        // A script, or a tab we clicked, may have navigated while we were reading.
        return normalizeUrl(page.url()) === landed ? { url: landed, ...result } : 'failed';
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
    const seenText = new Set<string>();
    const pages: (Omit<PageRecord, 'chunks'> & { blocks: Block[] })[] = [];
    const skipped: Partial<Record<Skip, number>> = {};
    const skip = (why: Skip) => (skipped[why] = (skipped[why] ?? 0) + 1);
    let rawBytes = 0;

    // shortcut: one slow page holds up its batch, use a worker pool if crawls get too long.
    while (queue.length && pages.length < args.max_pages && attempts < args.max_pages * 2) {
      const batch = queue.splice(0, Math.min(concurrency, args.max_pages - pages.length));
      const results = await Promise.all(batch.map((item) => load(item.url)));
      results.forEach((result, i) => {
        if (typeof result === 'string') return skip(result);
        const { url, data } = result;
        // Canonical links are not trusted: sites point every page of a list at its first page.
        // A page with no text and no kind of control that an earlier page lacked is a re-sorted, re-filtered or
        // out-of-range copy, and its links lead to more of the same, so they are not followed.
        const content = data.blocks.length ? createHash('sha256').update(JSON.stringify(data.blocks)).digest('hex') : url;
        const texts = [`title|${data.title}`, ...data.blocks.map((b) => `${b.heading}|${b.text}`), ...data.actions.map((a) => `${a.role}|${a.label}`)];
        const nothingNew = data.blocks.length && texts.every((t) => seenText.has(t));
        if (indexed.has(urlKey(url)) || contents.has(content) || nothingNew) return skip('duplicate');
        indexed.add(urlKey(url));
        queued.add(urlKey(url));
        contents.add(content);
        for (const t of texts) seenText.add(t);

        if (batch[i].depth < args.max_depth) {
          for (const link of data.links) {
            const next = normalizeUrl(link);
            if (!next || next.length > 2000 || !inScope(next, start) || NOT_A_PAGE.test(new URL(next).pathname) || queued.has(urlKey(next))) continue;
            queued.add(urlKey(next));
            queue.push({ url: next, depth: batch[i].depth + 1 });
          }
        }

        rawBytes += data.rawBytes;
        if (data.denied) redactor.counts.SELECTOR = (redactor.counts.SELECTOR ?? 0) + data.denied;
        const actions = data.actions.filter((a) => !actionKeys.has(a.key) && actionKeys.add(a.key));
        pages.push({
          url: redactor.redactUrl(url),
          title: redactor.redact(data.title).slice(0, 200),
          blocks: [...data.blocks, ...result.api],
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
    const vectors = await embed(records.flatMap((p) => p.chunks.map((c) => `${c.heading}\n${c.text}`)));
    const id = `s_${createHash('sha256').update(urlKey(start)).digest('hex').slice(0, 12)}`;
    writeSite({ id, host, ...veil, rawBytes, counts: redactor.counts, pages: records, vectors });
    audit?.(redactor.originals);
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
    const host = URL.canParse(request.url()) ? new URL(request.url()).hostname : '';
    const tracker = TRACKERS.some((t) => host === t || host.endsWith(`.${t}`));
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
