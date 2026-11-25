#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { VeilError } from './errors.ts';
import { runMcpServer } from './mcp.ts';
import { tools } from './tools.ts';

const localOptions = z.object({
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  delay_ms: z.coerce.number().int().min(0).optional(),
  timeout_ms: z.coerce.number().int().min(1000).optional(),
  ignore_robots: z.boolean().optional(),
  engine: z.enum(['auto', 'lightpanda', 'chromium']).optional(),
});

function usage(): string {
  const lines = tools.map((t) => {
    const flags = Object.keys(t.schema.shape).filter((k) => !t.positional.includes(k));
    return `  veilcrawl ${t.name} ${t.positional.map((p) => `<${p}>`).join(' ')} ${flags.map((f) => `[--${f}]`).join(' ')}`.trimEnd();
  });
  return [
    'Usage:', ...lines, '  veilcrawl mcp', '',
    `crawl_site also takes ${Object.keys(localOptions.shape).map((k) => `--${k}`).join(' ')}`,
    'crawl_site --audit shows the redacted values themselves (terminal only, never saved)',
  ].join('\n');
}

function printAudit(originals: Map<string, string>): void {
  // Values come from web pages: control characters could drive the terminal.
  for (const [placeholder, value] of originals) console.log(`${placeholder}\t${value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
}

async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help') return console.log(usage());
  if (name === 'mcp') return runMcpServer();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new VeilError(`Unknown command: ${name}\n${usage()}`);

  const isCrawl = name === 'crawl_site';
  const flags: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const key of Object.keys(tool.schema.shape)) if (!tool.positional.includes(key)) flags[key] = { type: 'string', multiple: key.startsWith('redact_') };
  if (isCrawl) for (const key of Object.keys(localOptions.shape)) flags[key] = { type: key === 'ignore_robots' ? 'boolean' : 'string' };
  if (isCrawl) flags.audit = { type: 'boolean' };

  const { values, positionals } = parseArgs({ args: rest, options: flags, allowPositionals: true });
  const input: Record<string, unknown> = { ...values };
  // The last positional takes the remaining words, so search queries need no quotes.
  tool.positional.forEach((key, i) => {
    const last = i === tool.positional.length - 1;
    const value = last ? positionals.slice(i).join(' ') : positionals[i];
    if (value) input[key] = value;
  });
  const args = tool.schema.parse(input) as any;
  // Keeps piped agent shells out; it is not an access control.
  if (values.audit && !(process.stdin.isTTY && process.stdout.isTTY)) throw new VeilError('--audit shows private values and only runs in an interactive terminal.');
  const local = { ...localOptions.parse(input), audit: values.audit ? printAudit : undefined };
  const result = await tool.run(args, isCrawl ? local : undefined);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch((error) => {
  const text = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  console.error(text);
  process.exitCode = 1;
});
