# VeilCrawl

Crawl a website once, then let an AI agent search it through small, locally redacted snippets. Phase 1 of [PRD.md](PRD.md).

## Set up

Needs Node 22.18 or newer.

```sh
npm install
npx playwright install chromium --only-shell
npm run build
```

## Use from an agent (MCP)

Claude Code:

```sh
claude mcp add --scope user veilcrawl -- node "$PWD/dist/cli.js" mcp
```

Other clients:

```json
{ "mcpServers": { "veilcrawl": { "command": "node", "args": ["/absolute/path/to/dist/cli.js", "mcp"] } } }
```

Large crawls can outlast an MCP client's timeout. Crawl from the command line instead and give the agent the `site_id`.

The agent gets six tools: `crawl_site`, `direct_search`, `find_action`, `site_map`, `peek_chunk` and `veil_audit`.

## Use from the command line

```sh
node dist/cli.js crawl_site https://example.com --max_pages 50 --veil_level strict --redact_patterns 'acme-\d+' --redact_selectors '.internal'
node dist/cli.js direct_search <site_id> refund policy
node dist/cli.js --help
```

`--engine`, `--concurrency`, `--delay_ms`, `--timeout_ms`, `--ignore_robots` and `--engine auto|lightpanda|chromium` work only from the command line. When [Lightpanda](https://lightpanda.io) is installed (`LIGHTPANDA_PATH` or on `PATH`), `auto` uses it for ultra-low RAM crawls and falls back to Chromium otherwise. `veil_audit <site_id> --audit` shows you the redacted values and runs only in an interactive terminal.

## Browser engine

[Lightpanda](https://lightpanda.io) is used when it is installed, otherwise Chromium. Choose one with `--engine` or `VEILCRAWL_ENGINE` (`auto`, `lightpanda`, `chromium`); set `LIGHTPANDA_PATH` if it is not found.

## Privacy

Indexes live in `~/.veilcrawl` (change with `VEILCRAWL_HOME`), readable only by you. They hold redacted text, plus the original redacted values for the local audit, so treat the files as sensitive. Delete `<site_id>.db` to forget a site.

Redaction is pattern-based: it does not catch names, street addresses or deliberately disguised values, and it sometimes hides harmless numbers.

The agent chooses `veil_level` when it crawls, and an agent with shell access can read the index files directly.

## Test

```sh
npm test
```

## License

[MIT](LICENSE)
