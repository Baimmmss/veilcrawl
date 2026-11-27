import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright';
import { launchBrowser, type BrowserSession } from './browser.ts';
import { fitBudget, snippet } from './budget.ts';
import { chunkBlocks } from './chunker.ts';
import { keyHash, newContext } from './crawler.ts';
import { VeilError } from './errors.ts';
import { extractPage } from './extract.ts';
import { Redactor } from './redactor.ts';
import { keptVeil, openSite, strongest } from './store.ts';
import { inScope, normalizeUrl } from './url.ts';

export interface ActArgs {
  site_id: string;
  steps: { handle_id: string; value?: string }[];
  max_tokens: number;
}

const TIMEOUT = 15_000;

/** Waits for the network to go quiet and for scripts to draw the result. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await sleep(300);
}

/** Starts a browser and loads one page in it. Close the session when done. */
export async function openLive(url: string): Promise<{ page: Page; session: BrowserSession }> {
  const session = await launchBrowser(undefined, TIMEOUT);
  try {
    const page = await (session.connect ? (await session.connect()).newPage() : (await newContext(session)).newPage());
    page.on('popup', (popup) => void popup.close().catch(() => {}));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await settle(page);
    return { page, session };
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** Reads a page like the crawler does. evaluate has no timeout of its own, and a script that never ends would block it. */
export async function readPage(page: Page, deny: string[], mark?: number) {
  const data = await Promise.race([page.evaluate(extractPage, { deny, mark }), sleep(TIMEOUT, null, { ref: false })]);
  if (!data) throw new VeilError('The page stopped responding.');
  return data;
}

/**
 * Opens the page of the first control, uses each control in turn on the live page, and returns only the
 * text that changed, redacted like the index. The agent never sees the page itself.
 */
export async function runAction(args: ActArgs) {
  const { meta, steps } = openSite(args.site_id, (db, meta) => ({
    meta,
    steps: args.steps.map((step) => {
      const id = /^el_[0-9a-z]{1,10}$/.test(step.handle_id) ? parseInt(step.handle_id.slice(3), 36) : 0;
      const row = db
        .prepare('SELECT a.key_hash AS hash, a.action_type AS type, p.url, p.openable FROM actions a JOIN pages p ON p.id = a.page_id WHERE a.id = ?')
        .get(id) as { hash: string | null; type: string; url: string; openable: number } | undefined;
      if (!row?.hash) throw new VeilError(`Unknown handle_id for this site: ${step.handle_id}. Run find_action again.`);
      return { ...row, handle: step.handle_id, value: step.value };
    }),
  }));
  const first = steps[0];
  if (!first.openable) throw new VeilError('The address of this control\'s page holds a hidden value, so VeilCrawl will not open it.');
  const veil = strongest(keptVeil(meta.host), meta);
  const redactor = new Redactor(veil.veilLevel, veil.patterns);

  // robots.txt is for crawlers; this is one visit the agent asked for, like a person clicking.
  const { page, session } = await openLive(first.url);
  try {
    const read = (mark?: number) => readPage(page, veil.selectors, mark);

    const before = await read();
    for (const step of steps) {
      const index = (step === first ? before : await read()).actions.findIndex((a) => keyHash(a.key) === step.hash);
      if (index < 0) throw new VeilError(`${step.handle} is not on the page now. It may sit in a closed tab, or the site changed: run crawl_site again.`);
      await read(index);
      const target = page.locator('[data-veil-target]').first();
      const { tag, type } = await target.evaluate((el) => ({ tag: el.tagName, type: (el as HTMLInputElement).type }));
      if (step.type === 'input' && tag === 'SELECT') await target.selectOption(step.value ?? '', { timeout: 5_000 });
      else if (step.type === 'input' && type !== 'checkbox' && type !== 'radio') await target.fill(step.value ?? '', { timeout: 5_000 });
      else if (tag === 'FORM') await target.evaluate((form) => (form as HTMLFormElement).requestSubmit());
      else await target.click({ timeout: 5_000 });
      await settle(page);
    }

    const url = normalizeUrl(page.url());
    if (!url || !inScope(url, first.url)) return { url: url ? snippet(redactor.redactUrl(url), 120) : '', left_site: true, changed: [] };
    const after = await read();
    const seen = new Set(before.blocks.map((b) => b.text));
    const chunks = chunkBlocks(after.blocks.filter((b) => !seen.has(b.text)), redactor);
    return fitBudget(chunks, args.max_tokens, veil.veilLevel === 'strict' ? 120 : 280, (items, chars) => ({
      url: snippet(redactor.redactUrl(url), 120),
      title: snippet(redactor.redact(after.title), 60),
      navigated: url !== normalizeUrl(first.url),
      changed: items.map((c) => snippet(c.text, chars)),
    }));
  } finally {
    await session.close();
  }
}
