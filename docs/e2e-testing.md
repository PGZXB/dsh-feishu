# E2E UI testing (feishu.cn web)

The real-client E2E suite drives the **actual feishu.cn web client** in a
headless browser and exercises the bot exactly like a user: open a chat,
send a slash command, click card buttons, and assert what renders. It is the
third testing layer:

| Layer | What it proves | Runs where |
| --- | --- | --- |
| Unit tests | logic (fakes) | every `pnpm test` |
| Integration tests (`tests/integration/`) | real dsh process + real agent loop, **Feishu wire mocked** (memory transport), LLM mocked | every `pnpm test` |
| **E2E UI (this suite)** | real dsh process + **real Feishu** (long connection, cards, callbacks) + real browser client | `pnpm run e2e:ui` (on demand) |

## Constraints

- **Rule-based assertions only.** Every assertion reads the rendered DOM
  (message texts, buttons, panels) or the Feishu Open API. The suite never
  calls a paid vision service — tests must stay free and deterministic.
- **The `modlens` CLI is developer-side verification only.** Use it while
  building or debugging a scenario to inspect what a screenshot actually
  shows; it is not part of any test, and it costs provider quota — keep calls
  few.
- **One real chat at a time.** Scenarios run with a single worker and share
  the bot chat; parallel scenarios would race each other's messages.
- **The bot under test runs against a dedicated app.** Use a test Feishu app
  (the quick-setup tool can create one) and a test chat, never the production
  bot.

## Architecture

```
pnpm run e2e:ui  →  scripts/e2e-ui.mjs (host launcher)
                     ├─ prepares the exchange dir (_dev/e2e-exchange): QR
                     │    files for the user to scan, sessions/credentials
                     │    for reuse, the final report
                     └─ runs the whole stack in the e2e docker image
                          └─ scripts/e2e-container.mjs (orchestrates inside)
                               ├─ copies the READ-ONLY-mounted repo to the
                               │    container-local /app (no build artifacts
                               │    ever touch the host)
                               ├─ pnpm install → build (container-local)
                               ├─ installs the plugin into profile e2e-dev
                               ├─ first run: README quick-setup
                               │    (pnpm run setup:feishu --new --force-login
                               │    — QR teed to _dev/e2e-exchange/setup.log;
                               │    creates the bot app under the account you
                               │    scan with; exports creds + console session)
                               ├─ first run: browser login (QR →
                               │    _dev/e2e-exchange/qr.png; reused after)
                               ├─ boots the mock DeepSeek server + dsh
                               ├─ runs Playwright scenarios
                               ├─ converts recordings to mp4 (E2E_VIDEO=mp4)
                               └─ writes the report + manifest.json
                                   into _dev/e2e-exchange/report/
```

Everything runs inside the container following the README install-from-source
flow. The host mounts the repo **read-only** and an **exchange** directory —
only the exchange survives the container: the QR codes you scan, the
sessions and app credentials for reuse, and the final report. Build artifacts
(node_modules, lib, the pnpm store, the dsh home) exist only in the
container and vanish when it exits.

**Use a dedicated test account.** The bot app and the browser session are
created under whatever account scans the QR — scan with the dedicated
test account, never the production one. The setup runs with `--force-login`,
so a cached console session is never reused across accounts.

- **e2e/playwright.config.ts** — Playwright config; all knobs come from the
  environment (see `e2e/lib/config.ts`).
- **e2e/lib/feishu.ts** — the feishu.cn web helpers (open app/chat, send a
  message, read the chat, click buttons).
- **e2e/lib/assert.ts** — rule-based chat assertions.
- **e2e/scenarios/*.spec.ts** — one file per scenario.
- **Dockerfile.e2e** — the run image: Playwright's official image + full
  ffmpeg (the bundled one only encodes VP8; mp4 conversion needs H.264).

## Prerequisites

- Docker.
- The dsh CLI on `PATH` (or `DSH_BIN`) — inside the container it resolves
  from the checkout's `node_modules` (the repo pins `@deepseek-ai/dsh`).
- A **dedicated test account** (never the production one) and a chat where
  that account and the bot are members — set `E2E_CHAT` to the chat's display
  name.
- Three one-time human actions, all on the test account: the bot-app setup
  QR (`_dev/e2e-exchange/setup.log`), the browser login QR
  (`_dev/e2e-exchange/qr.png`), and messaging the bot once (creates the
  chat). Every later run reuses the exported sessions and credentials.

## Quickstart

```sh
pnpm install
pnpm run build

# run the suite. First run scans TWO QRs (bot-app setup at
# _dev/e2e-exchange/setup.log, then browser login at
# _dev/e2e-exchange/qr.png) — both with the TEST account — and then needs
# one message to the bot in the Feishu app to create the chat.
E2E_CHAT="My Test Bot" pnpm run e2e:ui

# options
E2E_VIDEO=mp4     # also convert recordings to mp4
E2E_VIDEO=off     # no video
E2E_SCREENSHOTS=failure  # screenshots only on failure
E2E_BOT_NAME="My Test Bot"   # the bot app name (default "DSH Agent (e2e)")
```

Put the chat name in `_dev/e2e.env` (git-ignored) and
`set -a; source _dev/e2e.env; set +a` before running, so it never lands in
shell history or the repo.

## Report

Every run writes into the report dir (`E2E_REPORT_DIR`, default
`_dev/e2e-report`):

- `html/` — Playwright HTML report
- `report.json` — Playwright JSON report
- `screenshots/` — scenario evidence screenshots
- `*.webm` / `*.mp4` — session recordings (per Playwright policy)
- `manifest.json` — machine-readable artifact list (path + kind + size)

## Adding a scenario

1. Create `e2e/scenarios/<name>.spec.ts` — the shared helpers cover the
   plumbing, so a scenario is a few lines of intent:

   ```ts
   import { test } from '@playwright/test';
   import { loadE2eConfig } from '../lib/config.js';
   import { waitForBotReplyContaining } from '../lib/assert.js';
   import { openApp, openChat, sendMessage, clickButton } from '../lib/feishu.js';

   const cfg = loadE2eConfig();

   test('send /model → model picker card', async ({ page }) => {
     await openApp(page, cfg);
     await openChat(page, cfg.chatName, cfg.timeoutMs);
     await sendMessage(page, '/model');
     await waitForBotReplyContaining(page, 'Model', cfg.timeoutMs);
   });
   ```

2. Assert only what the DOM shows (message text, button labels, panel
   content) — rule-based, free, deterministic.
3. When a new interaction needs a helper (a panel open, a picker choice),
   add it to `e2e/lib/feishu.ts` with the selector it targets, and note the
   selector in the list below.

## Selectors (captured from a real client session)

These are the feishu.cn web DOM anchors the helpers rely on. Feishu's web
client can change them; when a selector breaks, update it here and in the
helper together.

| What | Selector |
| --- | --- |
| App shell URL | path matches `/(messenger\|home\|space\|contact\|drive)/` (any tenant subdomain) |
| Chat message item | `.js-message-item`; `.message-self` marks the user's own |
| Chat input | `[contenteditable="true"]` (`.zone-container.editor-kit-container`) |
| Card buttons | `<button>` elements; match by accessible name |
| Login QR | a `canvas` element on the accounts login page (rotates — re-capture) |

## Troubleshooting

- **"feishu app did not open"** — the browser session expired; run
  `pnpm run e2e:login` again (one QR scan).
- **dsh never reports "long connection ready"** — wrong app credentials,
  or the app has no long-connection event mode configured (see
  `docs/feishu-setup.md`).
- **docker build fails** — the build writes buildx state under
  `~/.docker`; make sure that is writable (`DOCKER_CONFIG` can redirect it).
- **mp4 conversion skipped** — the image's bundled ffmpeg has no H.264; the
  launcher uses the full ffmpeg from `Dockerfile.e2e` (rebuild the image
  after pulling a new Playwright base).
