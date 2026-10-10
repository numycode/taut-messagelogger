# Taut MessageLogger (personal plugin)

An importable, GPL-3.0-only port of Slick MessageLogger. The runtime is a single self-contained `src/MessageLogger.ts`; no Taut core changes, server or deployment.

## Install and build

Import **`dist/MessageLogger.js`** through Taut's personal/user-plugin settings, then enable **Message Logger**. It ships disabled. Keep the corresponding source and LICENSE with the JS if redistributing.

Node **22.18+** is required. From this repo:

```sh
npm ci --ignore-scripts
npm run build
# Same compiler/interface as Taut's build:user-plugin:
npm run build:user-plugin -- src/MessageLogger.ts dist/MessageLogger.js
npm run typecheck
npm test
npm run bench
BENCH_MODE=max-text BENCH_RUNS=1 npm run bench
```

Build and ordinary fixture tests need only this repo's dependencies. Typechecking against the actual Taut API, the storage integration test and benchmark additionally require the reference Taut checkout at `../taut` (commit in PROVENANCE.md), with its dependencies resolvable. In this container, a tooling-only `../taut/node_modules` symlink points to this repo's dependencies; no Taut tracked source was changed. The copied Taut compiler builds the same IIFE-returning-class format as its import UI expects. All dependency installation here used `--ignore-scripts`; there are no install/postinstall hooks in this repo.

## Behavior and defaults

- Capture channel, thread and DM message/edit/deletion events **actually delivered to Taut's RTM router**, including your messages and bots. Uses its wildcard subscription, handling routed edit/delete subtypes, tombstones and admin-hidden threads.
- Preserve Slick's exact inline layout: each stored old text is `<s>old text</s> (edited)` above the current message body, not a separate history window.
- Deleted rows are red by default; choose 50% opacity instead. Overflow menu actions are **Hide edit history** and **Accept deletion**. They change only this local archive, never Slack.
- Save up to **3 raster previews/message**, **128 archived messages**, **48 KiB/preview** (encoded bytes are larger). Recent previews: 64 messages; attempted signatures: 400; retained keys: 1,000; concurrent downloads: 8. Downloads are at most 2 MiB and have a 10-second timeout; large images use Slick's canvas downscale path.
- Defaults: `saveImages=true`, `retentionDays=30`, `deletedStyle=red`, `ignoreSelf=false`, `ignoreEditsFrom=''`, `ignoreAnchors=off`. Retention 0 disables age expiry, not count limits. Taut restarts the plugin on settings changes.
- At most **1,000 entries**, **20 edits/message**, **4,000 characters/edit text**, and **32 KiB UTF-8/message payload**. Large blocks/attachments/files/metadata are removed before truncating text; unknown oversized fields fall back to a bounded message representation. Entry retention is applied on restore and received edit/delete events, not by a periodic background sweep.
- Per-workspace Taut `storage.store` values merge batched changes with the latest saved value under Taut's Web Lock and synchronize across tabs. Persistence batches at 200 ms, repaint at 50 ms; stop cancels downloads/timers and flushes pending storage. No DOM polling, subtree observers, Slack API writes or backfill requests.

## Security and image limitations

Image requests use browser `fetch`, **`credentials: 'omit'`**, **`redirect: 'error'`**, no authorization headers and no referrer. Only HTTPS on exact `files.slack.com`, `slack-files.com`, or `a.slack-edge.com` hosts at the default/443 port is allowed; userinfo, arbitrary hosts and all IP literals/private-network URLs are rejected. No arbitrary image URL is requested, even if it appears in a Slack attachment. Trusted-host DNS resolution is left to the browser/OS; this plugin cannot inspect resolved IP addresses.

This intentionally differs from Slick's credentialed arbitrary-HTTPS fetch: private images requiring cookies/auth, redirects, third-party hosts or blocked by CORS **will not be saved**. It never escalates to Taut's privileged fetch bridge or obtains credentials to bypass that failure. Browser image decoding/canvas resizing, CORS and actual saved-image rendering remain unverified. Local archives contain potentially sensitive messages; they are not encrypted by this plugin. Use Taut's data controls to remove persisted data; Accept deletion removes that entry and its archived previews.

## Verification and performance

Focused tests load the **built importable artifact**, not a separate implementation. Fixtures are explicitly offline; React/RTM and storage boundaries are simulated. A separate integration test uses the actual Taut ScopedStorage with in-memory BlobStore/Web Locks fixtures and native BroadcastChannel. No live Slack messages, credentials or network responses are represented by the fixtures.

`reports/checks.txt`, `reports/benchmark.json` and `reports/stress.json` contain real local execution output. The benchmark preloads 1,000 entries with 20 edits each and 128 archived messages with 3 maximum-size encoded previews each, then sends 2,000 edits. It exercises actual Taut store JSON/locking but **not browser rendering, host IPC/disk or network**. The max-text run is a storage/memory stress case, not an interactive UI claim. Full-archive blob persistence rewrites one bounded workspace log per batch: extreme text payloads can still cause noticeable pauses and large memory use. Backend storage quotas are platform-dependent; persistence errors are logged and retained dirty for a later retry/stop, not silently reported as saved.

An initial six-run combined benchmark was killed with exit 137; cgroup evidence recorded an OOM kill. Its Web Locks fixture retained completed promise results across namespaces; that fixture leak was fixed. Representative three-run and separate one-run stress checks subsequently completed. Heap deltas include garbage collection and are not peak/resident-memory measurements.

## Required user validation / known limitations

**No live Slack UI was accessible in this container. All platform support is unverified**, including desktop, browser extension and userscript. Import/build compatibility is locally checked, not end-to-end platform compatibility. Validate on each target:

1. Enable on an already-open view, cold boot, disable/re-enable, change settings, and stop during image download.
2. Self/bot/channel/thread/DM edits and deletes, admin-hidden threads, search/activity rows; retained messages only appear in history slices Taut's injector covers.
3. Exact inline history, red/opacity styling, both overflow actions, saved previews in file slots and fallback previews.
4. Two tabs editing/logging/dismissing, reload persistence and workspace isolation.

Slack component names/private module contracts can change; the plugin warns once after 20 seconds if no expected row rendered. Missing original payloads cannot recover deleted content; no content is invented. Capturing all **delivered** events is not access to unread, inaccessible, missed-while-disabled or server-withheld messages. Unknown workspace IDs fail closed. In-page switching to another workspace disables the old instance's capture/injection; reload or re-enable for the new workspace. This does not migrate Slick's old archive. Cross-tab overlapping history is merged by shared prefix/suffix; conflicting/out-of-order edits without event identities are ordered by local arrival/locked persistence, not a claimed authoritative server chronology. Crashing within a batching window can lose the unflushed changes.
