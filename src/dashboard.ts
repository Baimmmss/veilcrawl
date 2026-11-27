import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLive, readPage } from './act.ts';
import { chunkBlocks } from './chunker.ts';
import { VeilError } from './errors.ts';
import { expandPage } from './extract.ts';
import { Redactor } from './redactor.ts';
import { homeDir, keptVeil, openSite, strongest } from './store.ts';
import { tools } from './tools.ts';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const tool = (name: string, args: object) => {
  const t = tools.find((x) => x.name === name)!;
  return t.run(t.schema.parse(args) as any) as any;
};

const CSS = `
  :root { color-scheme: light dark; --line: #8884; --muted: #888; --accent: #6e56cf; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; }
  a { color: var(--accent); } .muted { color: var(--muted); }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
  pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
  .meter { height: 12px; border-radius: 6px; background: var(--line); overflow: hidden; margin: 6px 0; }
  .meter span { display: block; height: 100%; background: var(--accent); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .cols > div { min-width: 0; }
  .block { padding: 6px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  mark { background: #f5a62366; color: inherit; border-radius: 3px; padding: 0 2px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }`;

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · VeilCrawl</title><style>${CSS}</style></head><body>${body}</body></html>`;

function sitesPage(base: string): string {
  const ids = existsSync(homeDir()) ? readdirSync(homeDir()).flatMap((f) => f.match(/^(s_[0-9a-f]{12})\.db$/)?.[1] ?? []) : [];
  const rows = ids.flatMap((id) => {
    try {
      return [openSite(id, (db, meta) => ({ id, meta, pages: (db.prepare('SELECT count(*) FROM pages').pluck().get() as number) }))];
    } catch {
      return [];
    }
  });
  const body = rows.length
    ? `<table><thead><tr><th scope="col">Site</th><th scope="col">Veil</th><th scope="col">Pages</th><th scope="col">Crawled</th></tr></thead><tbody>${rows
        .map(({ id, meta, pages }) => `<tr><td><a href="${base}site/${id}">${esc(meta.host)}</a> <span class="muted">${id}</span></td>
          <td>${esc(meta.veilLevel)}</td><td class="n">${pages}</td><td>${meta.crawledAt ? esc(new Date(meta.crawledAt).toLocaleString()) : ''}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p>No sites yet. Crawl one with <code>veilcrawl crawl_site &lt;url&gt;</code>.</p>';
  return layout('Sites', `<h1>VeilCrawl</h1><p class="muted">Indexes in ${esc(homeDir())}. Only you can open this page.</p>${body}`);
}

async function sitePage(base: string, id: string): Promise<string> {
  const { meta, pages } = openSite(id, (db, meta) => ({
    meta,
    pages: db.prepare('SELECT p.id, p.url, p.title, p.openable, count(c.id) AS chunks FROM pages p LEFT JOIN chunks c ON c.page_id = p.id GROUP BY p.id ORDER BY p.id').all() as {
      id: number; url: string; title: string; openable: number; chunks: number;
    }[],
  }));
  const audit = await tool('veil_audit', { site_id: id });
  const tree = await tool('site_map', { site_id: id, max_tokens: 2000 });
  const share = audit.raw_html_tokens ? Math.min(100, (100 * (audit.raw_html_tokens - audit.tokens_saved_per_search)) / audit.raw_html_tokens) : 100;
  const counts = Object.entries(meta.counts);
  return layout(meta.host, `<p><a href="${base}">All sites</a></p><h1>${esc(meta.host)}</h1>
    <p class="muted">${id} · ${esc(meta.veilLevel)} · ${pages.length} pages${meta.patterns.length ? ` · patterns: ${meta.patterns.map(esc).join(', ')}` : ''}${meta.selectors.length ? ` · selectors: ${meta.selectors.map(esc).join(', ')}` : ''}</p>
    <h2>Token savings</h2>
    <p>One search sends about <b>${audit.raw_html_tokens - audit.tokens_saved_per_search}</b> tokens instead of <b>${audit.raw_html_tokens}</b> for the raw HTML: ${audit.reduction_pct}% less.</p>
    <div class="meter" role="img" aria-label="${share.toFixed(1)}% of the raw HTML"><span style="width:${Math.max(share, 0.5)}%"></span></div>
    <h2>Hidden values</h2>${counts.length ? `<table><tbody>${counts.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}</tbody></table>` : '<p>None.</p>'}
    <h2>Site map</h2><pre>${esc(tree)}</pre>
    <h2>Pages</h2><table><thead><tr><th scope="col">Page</th><th scope="col">Chunks</th><th scope="col"></th></tr></thead><tbody>${pages
      .map((p) => `<tr><td>${esc(p.title || p.url)}<br><span class="muted">${esc(p.url)}</span></td><td class="n">${p.chunks}</td>
        <td>${p.openable ? `<a href="${base}site/${id}/page/${p.id}">Agent view vs real page</a>` : '<span class="muted">Address holds a hidden value</span>'}</td></tr>`)
      .join('')}</tbody></table>`);
}

/** Loads the live page again and shows what the veil hides, next to what the agent can read. Nothing is saved. */
async function comparePage(base: string, id: string, pageId: number): Promise<string> {
  const { meta, page, chunks } = openSite(id, (db, meta) => ({
    meta,
    page: db.prepare('SELECT url, title, openable FROM pages WHERE id = ?').get(pageId) as { url: string; title: string; openable: number } | undefined,
    chunks: db.prepare('SELECT heading, text FROM chunks WHERE page_id = ? ORDER BY id').all(pageId) as { heading: string; text: string }[],
  }));
  if (!page?.openable) throw new VeilError('This page cannot be opened.');
  const veil = strongest(keptVeil(meta.host), meta);
  const redactor = new Redactor(veil.veilLevel, veil.patterns);
  const { page: live, session } = await openLive(page.url);
  let real;
  try {
    await live.evaluate(expandPage, veil.selectors).catch(() => {});
    real = await readPage(live, veil.selectors);
  } finally {
    await session.close();
  }
  // Same order as the crawler: redact whole blocks, then show each placeholder's value highlighted.
  const shown = chunkBlocks(real.blocks, redactor).map((c) =>
    esc(c.text).replace(/\[[A-Z_]+_\d+\]/g, (token) => (redactor.originals.has(token) ? `<mark title="${token}">${esc(redactor.originals.get(token))}</mark>` : token)),
  );
  const hidden = Object.values(redactor.counts).reduce((a, b) => a + b, 0);
  return layout(page.title || page.url, `<p><a href="${base}site/${id}">${esc(meta.host)}</a></p><h1>${esc(page.title || page.url)}</h1>
    <p class="muted">${esc(page.url)} · loaded just now · ${hidden} values hidden${real.denied ? ` · ${real.denied} elements removed by selectors` : ''}. Placeholder numbers can differ from the index, which was numbered across the whole site.</p>
    <div class="cols"><div><h2>What the agent can read</h2>${chunks.map((c) => `<div class="block">${esc(c.text)}</div>`).join('') || '<p>Nothing.</p>'}</div>
    <div><h2>Real page, hidden values marked</h2>${shown.map((t) => `<div class="block">${t}</div>`).join('') || '<p>Nothing.</p>'}</div></div>`);
}

/** Serves the dashboard on 127.0.0.1 behind a random link. Anyone with the link can see hidden values. */
export async function startDashboard(): Promise<{ url: string; close(): void }> {
  const token = randomBytes(16).toString('hex');
  const base = `/${token}/`;
  const server = createServer((req, res) => void handle(req, res));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, html: string) =>
      res
        .writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          // No scripts at all, nothing cached, and the secret link never leaves in a Referer header.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        .end(html);
    // A web page could point another name at 127.0.0.1 (DNS rebinding); only the exact address is served.
    if (req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`) return send(403, 'Forbidden');
    if (req.method !== 'GET') return send(405, 'Method not allowed');
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith(base)) return send(404, 'Not found');
    const [, id, , pageId] = path.slice(base.length).match(/^(?:site\/(s_[0-9a-f]{12})(\/page\/(\d+))?)?$/) ?? [];
    if (id === undefined && path !== base) return send(404, 'Not found');
    try {
      send(200, !id ? sitesPage(base) : pageId ? await comparePage(base, id, Number(pageId)) : await sitePage(base, id));
    } catch (error) {
      if (!(error instanceof VeilError)) console.error(error);
      send(error instanceof VeilError ? 404 : 500, layout('Error', `<p><a href="${base}">All sites</a></p><p>${esc(error instanceof VeilError ? error.message : 'Something went wrong. Details are in the terminal.')}</p>`));
    }
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}`, close: () => server.close() };
}
