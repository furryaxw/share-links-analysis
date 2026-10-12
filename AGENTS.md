# AGENTS.md

## Build & Run

- `npx tsc` - compile `src/` to `lib/` (no `build` script in package.json)
- `npm install` - install deps (cheerio only); no lockfile committed
- No test suite, no linter, no CI

## Architecture

This is a [Koishi](https://koishi.chat) plugin that parses shared links from social/media platforms in chat messages and
returns enriched content: extracted media, metadata, and downloads.

### Entrypoints

| File           | Role                                                                          |
|----------------|-------------------------------------------------------------------------------|
| `src/index.ts` | Plugin entry: registers commands, middleware, DB tables, cache lifecycle      |
| `src/core.ts`  | Parser registry: assembles `ParserModule[]`, dispatches link resolution       |
| `src/types.ts` | All TS types; extends Koishi module declarations (`ctx.puppeteer`, DB tables) |
| `src/utils.ts` | Cookie sync, file download/cache, result sending, proxy, admin checks         |

### Parser Plugins (`src/parsers/`)

Each platform parser implements `ParserModule`:

```ts
{
    name, match, process, init ?, lc_get_cookie ?
}
```

- `match(content)` returns `Link[]` and detects relevant URLs in a message.
- `process(ctx, config, link, session)` returns `ParsedInfo | null`.

Platforms: Bilibili, Xiaohongshu, Twitter/X, Xiaoheihe, YouTube, Netease Music, QQ Music, Kugou Music, GitHub.

## Non-Obvious Facts

### YouTube Requires a Separate Python Server

`yt_server.py` is a FastAPI server that wraps `yt-dlp`. It must be running for YouTube parsing to work. It auto-updates
yt-dlp every 12h with hot reload via `os.execv`. The TypeScript side (`youtube.ts`) POSTs to it as a black box.

### Cookie Management

- CookieCloud (self-hosted) syncs cookies with AES-256-CBC decryption.
- Local fallback uses Puppeteer-based login capture for platforms like Xiaohongshu.
- All cookies are cached in `sla_cookie_cache`.

### Cache Model

- Parse history is stored in `sla_parse_timeline`.
- The legacy `sla_parse_cache` table is no longer registered during normal startup. It is only registered temporarily by
  migration/delete commands.
- `sla_file_cache` stores downloaded media by MD5 of the remote URL.
- `sla_cookie_cache` is independent from parse/file cache cleanup.

Timeline node fields matter:

- `created_at` is when this parsed version first appeared.
- `last_checked_at` is when the plugin last confirmed this version is still current.

Parse cache behavior:

- `cacheExpiration` is L1 freshness for parse results only.
- `optimisticExpiration` is L2 fallback age for parse results when parsing fails.
- If a reparse returns the same full `ParsedInfo` (ignoring private `_` fields), the latest timeline node is touched by
  updating `last_checked_at`.
- If a reparse differs, a new timeline node is created with an automatic `+`/`-` delta.
- The first timeline node uses `delta = base`.

Retention behavior:

- File cache and timeline cleanup use the effective maximum of L1 and L2.
- `0` means never expire and must be handled specially, not with a plain `Math.max()`.
- File cache hits refresh `sla_file_cache.created_at`, so actively reused files are not cleaned too early.

Output/telemetry behavior:

- Cache labels should go through `ParsedInfo._cache` and the `{cache}` format placeholder, not by appending text to
  `mainbody`.
- The `{cache}` placeholder separates parse cache status and file cache status.
- Telemetry `is_cache` means "file cache hit", not "parse cache hit".

### Implicit Dependencies

The plugin relies on Koishi built-in services, not direct npm dependencies:

- `ctx.http` for HTTP requests with optional proxy agent.
- `ctx.puppeteer` for headless browser scraping, such as Xiaohongshu note pages and cookie refresh.
- `ctx.database` for cache, group settings, and cookie storage.
- `bot.sendForwardMsg` from the OneBot adapter for forward-mode result delivery.

### `lib/` Is Committed but Gitignored

The compiled output is in-repo and `main`/`typings` point to it, but `.gitignore` lists `lib/`. New compilations will
not be tracked unless added with `--force`.

### Commands

All commands are under parent `share` unless noted.

| Command                            | Auth | Purpose                                                                    |
|------------------------------------|------|----------------------------------------------------------------------------|
| `share`                            | 1    | Show current group parser/NSFW status                                      |
| `share.parsers [name] [mode]`      | 1    | View or toggle a parser for current group; writes require group admin      |
| `share.nsfw [value]`               | 1    | View or toggle NSFW for current group; writes require group admin          |
| `share.reset`                      | 1    | Reset group to global defaults; requires group admin                       |
| `share.checkcache <url> [index]`   | 1    | Without index, list timeline nodes; with index/`l`/`latest`, send node     |
| `share.forceparse <url>`           | 2    | Parse link ignoring caches, then update timeline                           |
| `share.migratecache`               | 4    | Migrate legacy `sla_parse_cache` rows into `sla_parse_timeline` and verify |
| `share.dropoldcache`               | 4    | Clear and try to drop legacy `sla_parse_cache`                             |
| `share.directlink <url> [quality]` | 1    | Get direct video/audio URL; `high`/`low`, skips size-based degradation     |
| `share.clean`                      | 3    | Purge parse timeline, file cache records, and cached files                 |
| `share.refresh`                    | 3    | Force-refresh all platform cookies from cloud/local sources                |

### Send Modes

- `plain` sends individual messages per result item.
- `forward` sends merged forward nodes through OneBot `send_forward_msg`.
- `mixed` sends text/images in forward mode and large files as plain messages.

### Cross-Environment Path Mapping

`onebotReadDir` and `localDownloadDir` handle Docker scenarios where Koishi and the OneBot adapter, such as NapCat, have
different filesystem mounts.

## Adding a New Platform Parser

1. Create `src/parsers/<platform>.ts` implementing `ParserModule`.
2. Register it in `src/core.ts` `parsers` array.
3. Rebuild with `npx tsc`.
