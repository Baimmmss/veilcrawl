import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Joined at run time so secret scanners do not flag this fake key.
const STRIPE_KEY = 'sk_live_' + 'a1B2c3D4'.repeat(3);

/** Every one of these appears somewhere on the fixture site and must never reach an agent. */
export const SECRETS = [
  'john@example.com', 'split@example.com', 'title@example.com', 'heading@example.com', 'aria@example.com', 'holder@example.com',
  'urlpath@example.com', 'urlquery@example.com', 'shadow@example.com', 'cell@example.com', '415-555-2671', '123-45-6789',
  '4111 1111 1111 1111', STRIPE_KEY, 'typed-value-777', 'csrf-value-888', 'INTERNAL NOTE', 'hunter2000',
  'Project Falcon', 'cookie-value-999', 'script-value-555', 'query-secret-444', 'frame-value-333',
];

const filler = '<!--' + 'x'.repeat(20_000) + '-->';
const layout = (title: string, body: string, head = '') => `<!doctype html><html><head><title>${title}</title>${head}
  <script>const s = "script-value-555"</script><link rel=stylesheet href=/font.css></head><body>${filler}
  <nav><a href="/">Home</a> <a href="/about">About us</a> NAVBOILERPLATE</nav>
  ${body.replace('<main>', '<main><div>Repeated promo banner sentence appears on every page.</div><div>In stock</div>')}<footer>FOOTERBOILERPLATE</footer></body></html>`;

export async function startFixture() {
  const hits: { path: string; at: number; ua?: string }[] = [];
  const state = { down: false, robots: 'User-agent: *\nDisallow: /private' };
  const pages: Record<string, () => string> = {
    '/': () => layout('Home title@example.com', `<main><h1>Welcome heading@example.com</h1>
      <p>Contact john@example.com or 415-555-2671. SSN 123-45-6789. Card 4111 1111 1111 1111.</p>
      <p>Key ${STRIPE_KEY} and password: hunter2000 for Project Falcon.</p>
      <p><span>split</span><span>@example.com</span> writes docs.</p>
      <div class="internal-notes">INTERNAL NOTE <a href="/from-denied">x</a></div><div style="display:none">HIDDENTEXT</div>
      <table><thead><tr><th>Plan</th><th>Price</th><th>Owner</th></tr></thead>
      <tbody><tr><td>Pro</td><td>$20</td><td>cell@example.com</td></tr><tr><td>Max</td><td>$99</td><td>none</td></tr></tbody></table>
      <div id=late></div><my-card></my-card><img src=/img.png><iframe src=/frame></iframe></main>
      <form action=/search aria-label="Search docs"><input type=hidden name=csrf value=csrf-value-888>
      <label>Work email <input name=e value=typed-value-777></label><input placeholder="holder@example.com">
      <button aria-label="Message aria@example.com">M</button><button type=button>Export CSV</button><input type=submit value="Run report"></form>
      <a href="/about?utm_source=n">About</a> <a href="/about/">About</a> <a href="/about#team">About</a>
      <a href="/private/x">Private</a> <a href="/login">Login</a> <a href="/alias">Alias</a> <a href="/off">Off</a> <a href="/gone">Gone</a>
      <a href="/u/urlpath@example.com">User</a> <a href="/q?email=urlquery%40example.com&amp;token=query-secret-444">Q</a>
      <a href="/file.pdf">Download the handbook</a> <a href="/data">Data</a> <a href="/d1">Deep</a> <a href="https://elsewhere.invalid/">Ext</a> <a href="mailto:john@example.com">Mail</a>
      <script>document.cookie="sid=cookie-value-999";setTimeout(()=>{late.textContent="Rendered by JavaScript zebra.";},150);
      customElements.define('my-card',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<p>Shadow walrus shadow@example.com</p><button>Shadow launch</button>'}});</script>`),
    '/about': () => layout('About', '<main><h1>About</h1><p>Our refund window is thirty days. We ship worldwide.</p></main>'),
    '/alias': () => layout('About alias', '<main><h1>About</h1><p>Our refund window is thirty days. We ship worldwide.</p></main>', '<link rel=canonical href="/about">'),
    '/u/urlpath@example.com': () => layout('User', '<main><p>User profile giraffe content.</p></main>'),
    '/q': () => layout('Q', '<main><p>Query page pelican content.</p></main>'),
    '/offsite': () => layout('Offsite', '<main><p>Offsite content ostrich.</p></main>'),
    '/frame': () => '<p>frame-value-333</p>',
    '/from-denied': () => layout('Denied', '<p>denied link target</p>'),
    ...Object.fromEntries([1, 2, 3, 4].map((n) => [`/d${n}`, () => layout(`Deep ${n}`, `<main><p>Depth level ${n} content.</p><a href="/d${n + 1}">next</a></main>`)])),
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url!.split('?')[0]).replace(/(.)\/$/, '$1');
    hits.push({ path, at: Date.now(), ua: req.headers['user-agent'] });
    const send = (status: number, type: string, body = '', headers = {}) => res.writeHead(status, { 'content-type': type, ...headers }).end(body);
    if (state.down) return send(500, 'text/plain', 'down');
    if (path === '/robots.txt') return send(200, 'text/plain', state.robots);
    if (path === '/font.css') return send(200, 'text/css', '@font-face{font-family:f;src:url(/f.woff2)} body{font-family:f}');
    if (path === '/login') return send(401, 'text/html', 'no');
    if (path === '/data') return send(200, 'application/json', '{"a":1}');
    if (path === '/off') return send(302, 'text/html', '', { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/offsite` });
    const page = pages[path];
    return page ? send(200, 'text/html', page(), { 'set-cookie': 'auth=cookie-value-999' }) : send(404, 'text/html', 'missing');
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}/`, hits, state, close: () => server.close() };
}
