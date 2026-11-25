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
    ...[...root.querySelectorAll('*')].flatMap((el) => (el.shadowRoot instanceof ShadowRoot ? deepAll(selector, el.shadowRoot) : [])),
  ];

  let denied = 0;
  for (const selector of denySelectors) {
    for (const el of deepAll(selector)) {
      Element.prototype.remove.call(el);
      denied++;
    }
  }

  // A form exposes its fields as properties, so a field with one of these names would replace what we call.
  const used = new Set('labels matches childNodes closest getAttribute hasAttribute querySelector querySelectorAll parentElement shadowRoot checkVisibility tagName nodeType textContent ownerDocument assignedNodes'.split(' '));
  for (const el of deepAll(':not(form)[name], :not(form)[id]')) for (const attr of ['name', 'id']) if (used.has(el.getAttribute(attr) ?? '')) el.removeAttribute(attr);

  const CHROME = 'nav, aside, [role=navigation], [role=banner], [role=contentinfo], [role=search], header, footer';
  const inChrome = (el: Element) => {
    const chrome = el.closest(CHROME);
    return !!chrome && !(chrome.matches('header, footer, aside') && chrome.closest('main, article, [role=main]'));
  };

  const links = deepAll('a[href]').map((a) => (a as HTMLAnchorElement).href);

  const NOT_TEXT = 'script, style, noscript, template, svg, iframe, object, input, select, textarea, option, [aria-hidden=true]';
  const SKIP = `${NOT_TEXT}, button, [role=button], [role=dialog], dialog`;
  const displayOf = (el: Element) => getComputedStyle(el).display;
  const isBlock = (el: Element, display: string) => el.tagName === 'BR' || !(display.startsWith('inline') || display === 'contents');
  // Visibility is compared with the parent so the label of a control inside a closed menu can still be read.
  const isHidden = (el: Element, display: string) =>
    display === 'none' ||
    el.hasAttribute('hidden') ||
    (getComputedStyle(el).visibility === 'hidden' && (!el.parentElement || getComputedStyle(el.parentElement).visibility !== 'hidden'));
  const childrenOf = (el: Element): Iterable<Node> =>
    el instanceof HTMLSlotElement && el.assignedNodes().length ? el.assignedNodes() : (el.shadowRoot ?? el).childNodes;

  /** Visible text inside an element, with a space between blocks and without form fields. */
  const textOf = (el: Element | null | undefined, skip = NOT_TEXT): string => {
    if (!el) return '';
    const read = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof Element) || node.matches(skip)) return '';
      const display = displayOf(node);
      if (isHidden(node, display)) return '';
      const inner = [...childrenOf(node)].map(read).join('');
      return isBlock(node, display) ? ` ${inner} ` : inner;
    };
    return clean([...childrenOf(el)].map(read).join(''));
  };

  const labelOf = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => textOf(document.getElementById(id)));
    // What a person typed into a field is never a label; only button captions come from `value`.
    const caption = el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(input.type) ? input.value || input.type : '';
    const own = ['INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(el.tagName) ? '' : textOf(el);
    return (
      [
        el.getAttribute('aria-label'),
        labelledBy.join(' '),
        'labels' in el ? [...(input.labels ?? [])].map((l) => textOf(l)).join(' ') : '',
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

  const headingFor = (el: Element): string => textOf(el.closest('section, article, form, fieldset, main')?.querySelector('h1, h2, h3, h4, legend'));

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
    const display = displayOf(node);
    if (isHidden(node, display)) return;
    if (display !== 'contents' && typeof node.checkVisibility === 'function' && !node.checkVisibility({ visibilityProperty: true })) return;

    if (/^H[1-6]$/.test(node.tagName)) {
      flush();
      heading = textOf(node);
      return;
    }
    if (node instanceof HTMLTableRowElement && !node.querySelector('table')) {
      flush();
      const cells = [...node.cells];
      if (cells.length && cells.every((c) => c.tagName === 'TH')) return;
      const headers = [...(node.closest('table')?.querySelector('tr')?.cells ?? [])];
      const named = headers.length === cells.length && headers.every((c) => c.tagName === 'TH');
      const text = cells.map((c, i) => [named ? textOf(headers[i]) : '', textOf(c, SKIP)].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
      if (text) blocks.push({ heading, text, row: true });
      return;
    }

    const block = isBlock(node, display);
    if (block) flush();
    for (const child of childrenOf(node)) visit(child);
    if (block) flush();
  };

  const main = document.querySelectorAll<HTMLElement>('main, [role=main]');
  const root = main.length === 1 && clean(main[0].textContent) ? main[0] : document.body;
  if (root) visit(root);
  flush();

  return { title: document.title, rawBytes, denied, blocks, actions, links };
}
