import type { Block } from './chunker.ts';

export interface RawAction {
  role: string;
  label: string;
  actionType: string;
  context: string;
  /** Same key on several pages means the same control. */
  key: string;
}

export interface RawPage {
  title: string;
  canonical: string | null;
  rawBytes: number;
  denied: number;
  blocks: Block[];
  actions: RawAction[];
  links: string[];
}

/** Runs inside the page, so it must not reference anything outside its own body. Output is NOT redacted. */
export function extractPage(denySelectors: string[]): RawPage {
  const rawBytes = new Blob([document.documentElement.outerHTML]).size;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const deepAll = (selector: string, root: Document | ShadowRoot = document): HTMLElement[] => [
    ...root.querySelectorAll<HTMLElement>(selector),
    ...[...root.querySelectorAll('*')].flatMap((el) => (el.shadowRoot ? deepAll(selector, el.shadowRoot) : [])),
  ];

  let denied = 0;
  for (const selector of denySelectors) {
    for (const el of deepAll(selector)) {
      el.remove();
      denied++;
    }
  }

  const CHROME = 'nav, aside, [role=navigation], [role=banner], [role=contentinfo], [role=search], header, footer';
  const inChrome = (el: Element) => {
    const chrome = el.closest(CHROME);
    return !!chrome && !(chrome.matches('header, footer') && chrome.closest('main, article, [role=main]'));
  };

  const links = deepAll('a[href]').map((a) => (a as HTMLAnchorElement).href);

  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent);
    // What a person typed into a field is never a label; only button captions come from `value`.
    const caption = el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(input.type) ? input.value || input.type : '';
    const own = ['INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(el.tagName) ? '' : el.textContent;
    return (
      [
        el.getAttribute('aria-label'),
        labelledBy.join(' '),
        'labels' in el ? [...(input.labels ?? [])].map((l) => [...l.childNodes].filter((n) => n !== el && !(n instanceof HTMLSelectElement) && !(n instanceof HTMLTextAreaElement)).map((n) => n.textContent).join(' ')).join(' ') : '',
        caption,
        own,
        el.querySelector('img[alt]')?.getAttribute('alt'),
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.getAttribute('name'),
      ]
        .map(clean)
        .find(Boolean) ?? ''
    );
  };

  const headingFor = (el: Element): string => clean(el.closest('section, article, form, fieldset, main')?.querySelector('h1, h2, h3, h4, legend')?.textContent);

  const actions: RawAction[] = [];
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, form, [role=button], [role=link], [role=tab], [role=menuitem]';
  for (const el of deepAll(selector)) {
    const label = labelOf(el);
    if (!label) continue;
    const tag = el.tagName;
    const type = (el as HTMLInputElement).type;
    const href = tag === 'A' ? (el as HTMLAnchorElement).href : '';
    let actionType = 'click';
    if (tag === 'FORM' || (type === 'submit' && (el as HTMLInputElement).form)) actionType = 'submit';
    else if (tag === 'A') actionType = el.hasAttribute('download') || /\.(?:pdf|zip|csv|xlsx?|docx?|pptx?|dmg|exe|pkg|tar|gz)(?:[?#]|$)/i.test(href) ? 'download' : 'navigate';
    else if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !['submit', 'button', 'reset', 'image'].includes(type))) actionType = 'input';
    const role = el.getAttribute('role') ?? { A: 'link', BUTTON: 'button', FORM: 'form', SELECT: 'combobox', SUMMARY: 'button' }[tag] ?? (actionType === 'input' ? 'textbox' : 'button');
    // Links and page chrome repeat on every page; other controls belong to the page they are on.
    const scope = href || (inChrome(el) ? 'chrome' : location.href);
    actions.push({ role, label, actionType, context: headingFor(el), key: [role, label, scope].join('|') });
  }

  const SKIP = `script, style, noscript, template, svg, iframe, object, button, input, select, textarea, option, [aria-hidden=true], [role=button], [role=dialog], dialog`;
  const blocks: Block[] = [];
  let heading = '';
  let buffer = '';
  const flush = () => {
    const text = clean(buffer);
    buffer = '';
    if (text) blocks.push({ heading, text, row: false });
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent;
      return;
    }
    if (!(node instanceof Element) || node.matches(SKIP) || (node.matches(CHROME) && inChrome(node))) return;
    const display = typeof getComputedStyle === 'function' ? getComputedStyle(node).display : '';
    const isHiddenStyle = display === 'none' || (typeof getComputedStyle === 'function' && getComputedStyle(node).visibility === 'hidden');
    if (isHiddenStyle || node.hasAttribute('hidden')) return;
    if (display !== 'contents' && typeof node.checkVisibility === 'function' && !node.checkVisibility({ visibilityProperty: true })) return;

    if (/^H[1-6]$/.test(node.tagName)) {
      flush();
      heading = clean(node.textContent);
      return;
    }
    if (node instanceof HTMLTableRowElement && !node.querySelector('table')) {
      flush();
      const cells = [...node.cells];
      if (cells.length && cells.every((c) => c.tagName === 'TH')) return;
      const headers = [...(node.closest('table')?.querySelector('tr')?.cells ?? [])];
      const named = headers.length === cells.length && headers.every((c) => c.tagName === 'TH');
      const text = cells.map((c, i) => [named ? clean(headers[i].textContent) : '', clean(cellText(c))].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
      if (text) blocks.push({ heading, text, row: true });
      return;
    }

    const isBlock = node.tagName === 'BR' || !(display.startsWith('inline') || display === 'contents');
    if (isBlock) flush();
    const children = node instanceof HTMLSlotElement && node.assignedNodes().length ? node.assignedNodes() : (node.shadowRoot ?? node).childNodes;
    for (const child of children) visit(child);
    if (isBlock) flush();
  };

  const cellText = (cell: Element): string => {
    const copy = cell.cloneNode(true) as Element;
    copy.querySelectorAll(SKIP).forEach((el) => el.remove());
    return copy.textContent ?? '';
  };

  const main = document.querySelectorAll<HTMLElement>('main, [role=main]');
  const root = main.length === 1 && clean(main[0].textContent) ? main[0] : document.body;
  if (root) visit(root);
  flush();

  const canonical = document.querySelector<HTMLLinkElement>('link[rel=canonical]')?.href ?? null;
  return { title: document.title, canonical, rawBytes, denied, blocks, actions, links };
}
