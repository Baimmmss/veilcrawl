import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
import { VeilError } from './errors.ts';

export type BrowserEngine = 'auto' | 'lightpanda' | 'chromium';

export interface BrowserSession {
  browser: Browser;
  engine: 'lightpanda' | 'chromium';
  /** Lightpanda only: a page that hangs freezes its whole connection, so each page gets its own. */
  connect?(): Promise<Browser>;
  close(): Promise<void>;
}

export const TRACKERS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net', 'hotjar.com', 'segment.io', 'segment.com', 'mixpanel.com',
  'amplitude.com', 'fullstory.com', 'clarity.ms', 'googlesyndication.com', 'intercom.io', 'newrelic.com', 'nr-data.net',
];

const LIGHTPANDA_BLOCK_URLS = [
  ...TRACKERS.flatMap((t) => [`*://${t}/*`, `*://*.${t}/*`]),
  '*://*/*.png',
  '*://*/*.png?*',
  '*://*/*.jpg',
  '*://*/*.jpeg',
  '*://*/*.gif',
  '*://*/*.webp',
  '*://*/*.ico',
  '*://*/*.woff',
  '*://*/*.woff2',
  '*://*/*.ttf',
  '*://*/*.otf',
  '*://*/*.mp4',
  '*://*/*.webm',
  '*://*/*.mp3',
];

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findLightpanda(): string | null {
  const candidates = [
    process.env.LIGHTPANDA_PATH,
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'lightpanda')),
    join(homedir(), '.local', 'bin', 'lightpanda'),
    '/usr/local/bin/lightpanda',
    '/opt/homebrew/bin/lightpanda',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(endpoint: string, proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`lightpanda exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // still starting
    }
    await sleep(50);
  }
  throw new Error('lightpanda CDP server timed out starting');
}

async function launchLightpanda(timeoutMs: number): Promise<BrowserSession> {
  const bin = findLightpanda();
  if (!bin) throw new VeilError('Lightpanda binary not found. Install lightpanda or set LIGHTPANDA_PATH.');

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const args = [
    'serve',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--disable-metrics',
    '--log-level', 'error',
    '--http-timeout', String(timeoutMs),
    '--http-max-response-size', '20000000',
    '--user-agent-suffix', 'VeilCrawl/0.3',
    ...LIGHTPANDA_BLOCK_URLS.flatMap((pattern) => ['--block-urls', pattern]),
  ];

  const proc = spawn(bin, args, { stdio: 'ignore' });
  // Lightpanda would outlive us. After killing it, the signal is sent again for its normal effect.
  const onSignal = (signal: NodeJS.Signals) => {
    proc.kill('SIGKILL');
    process.kill(process.pid, signal);
  };
  const onExit = () => void proc.kill('SIGKILL');
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, onSignal);
  process.once('exit', onExit);
  const killProc = async () => {
    for (const signal of signals) process.off(signal, onSignal);
    process.off('exit', onExit);
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => proc.once('exit', () => resolve())),
      sleep(1500).then(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }),
    ]);
  };

  try {
    // Without this listener a path that cannot run would crash the whole program.
    const spawnFailed = once(proc, 'error').then(([error]) => Promise.reject(error));
    await Promise.race([waitForCdp(endpoint, proc), spawnFailed]);
    const browser = await chromium.connectOverCDP(endpoint);
    return {
      browser,
      engine: 'lightpanda',
      connect: () => chromium.connectOverCDP(endpoint),
      async close() {
        await browser.close().catch(() => {});
        await killProc();
      },
    };
  } catch (error) {
    await killProc();
    throw new VeilError(`Lightpanda did not start (${(error as Error).message}).`);
  }
}

async function launchChromium(reason = ''): Promise<BrowserSession> {
  try {
    const browser = await chromium.launch();
    return {
      browser,
      engine: 'chromium',
      async close() {
        await browser.close().catch(() => {});
      },
    };
  } catch (error) {
    if (/Executable doesn't exist/.test(String(error))) {
      throw new VeilError(`${reason}Chromium is missing. Install Lightpanda (https://lightpanda.io) or run: npx playwright install chromium --only-shell`);
    }
    throw error;
  }
}

export async function launchBrowser(
  requested?: BrowserEngine,
  timeoutMs = 15_000,
): Promise<BrowserSession> {
  const choice = requested ?? process.env.VEILCRAWL_ENGINE ?? 'auto';
  if (!['auto', 'lightpanda', 'chromium'].includes(choice)) throw new VeilError('VEILCRAWL_ENGINE must be "auto", "lightpanda" or "chromium".');

  if (choice === 'chromium') return launchChromium();
  if (choice === 'lightpanda') return launchLightpanda(timeoutMs);

  // auto: prefer Lightpanda when available for low RAM & fast startup; fall back to Chromium
  if (findLightpanda()) {
    try {
      return await launchLightpanda(timeoutMs);
    } catch (error) {
      return launchChromium(`${(error as Error).message} `);
    }
  }
  return launchChromium();
}
