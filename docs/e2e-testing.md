# E2E UI testing (feishu.cn web)

The real-client E2E suite drives the **actual feishu.cn web client** in a
headless browser and exercises the bot exactly like a user: open a chat,
send a slash command, click card buttons, and assert what renders. It is the
third testing layer:

| Layer | What it proves | Runs where |
| --- | --- | --- |
| Unit tests | logic (fakes) | every `pnpm test` |
| Integration tests (`tests/integration/`) | real dsh process + real agent loop, **Feishu wire mocked** (memory transport), LLM mocked | every `pnpm test` |
| **E2E UI (this suite)** | real dsh process + **real Feishu** (long connection, cards, callbacks) + real browser client | `pnpm run e2e:setup` once, then `pnpm run e2e:ui` (on demand) |

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
  (the setup creates one) and a test chat, never the production bot.

## Architecture

```
pnpm run e2e:setup  →  scripts/e2e-setup.mjs (one-time, host)
  └─ docker: copy repo (read-only mount → /app) → install → build →
     profile → create the bot app (console QR) → browser login (QR) →
     verify the chat exists  →  exports everything to _dev/e2e-exchange/
     (creds.json, console-session.json, web-session.json, report/)

pnpm run e2e:ui     →  scripts/e2e-ui.mjs (host launcher)
  └─ docker: copy repo → install → build → profile →
     reuse exported creds/session (no QR) →
     boot the mock DeepSeek server + dsh (profile e2e-dev) →
     run Playwright scenarios →
     convert recordings to mp4 → write the report + manifest.json
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

Key pieces:

- **e2e/playwright.config.ts** — Playwright config; all knobs come from the
  environment (see `e2e/lib/config.ts`).
- **e2e/lib/feishu.ts** — the feishu.cn web helpers (open app/chat, send a
  message, read the chat, click buttons, snapshots).
- **e2e/lib/assert.ts** — rule-based chat assertions.
- **e2e/scenarios/*.spec.ts** — one file per scenario.
- **Dockerfile.e2e** — the run image: Playwright's official image + full
  ffmpeg (the bundled one only encodes VP8; mp4 conversion needs H.264).

## Setup (one-time, then hands-free)

```sh
pnpm install
pnpm run build
E2E_CHAT="My Test Bot" pnpm run e2e:setup
```

The setup performs, in order:

1. builds the e2e docker image when missing;
2. inside the container: copies the repo (read-only mount), installs +
   builds, installs the plugin into profile `e2e-dev`;
3. **bot-app setup** — the README quick-setup with `--force-login`; scan the
   console QR at `_dev/e2e-exchange/setup.log` (auto-refreshes on expiry)
   with the **test account**; the app credentials are exported to
   `_dev/e2e-exchange/creds.json` (skipped when it already exists);
4. **browser login** — scan `_dev/e2e-exchange/qr.png` with the same
   account; the storageState is exported to
   `_dev/e2e-exchange/web-session.json` (skipped when it exists);
5. **chat check** — verifies the chat named `E2E_CHAT` exists in the
   messenger.

Exit codes: `0` = ready (later `e2e:ui` runs are hands-free), `3` = the
chat is missing — in the Feishu app, search the bot and send it a message
once (Feishu does not allow programmatic creation of the first user↔bot
contact), then re-run `pnpm run e2e:setup` to finish.

## Quickstart (after setup)

```sh
E2E_CHAT="My Test Bot" pnpm run e2e:ui

# options
E2E_VIDEO=off            # no video (default mp4 — webm is also kept)
E2E_SCREENSHOTS=failure  # screenshots only on failure (default on)
E2E_BOT_NAME="My Test Bot"   # the bot app name (default "DSH Agent (e2e)")
E2E_APP_ID / E2E_APP_SECRET # optional override of the bot app
```

Put the chat name in `_dev/e2e.env` (git-ignored) and
`set -a; source _dev/e2e.env; set +a` before running, so it never lands in
shell history or the repo.

## Report

Every run writes into `_dev/e2e-exchange/report/`:

- `html/` — Playwright HTML report
- `report.json` — Playwright JSON report
- `screenshots/` — the scenario's key screenshots (chosen by each scenario
  via `snapshot(page, cfg, label)`) + Playwright's automatic captures
- `*.webm` / `*.mp4` — the full session recording (mp4 by default; the
  webm source is kept)
- `manifest.json` — machine-readable artifact list (path + kind + size)

## Adding a scenario

1. Create `e2e/scenarios/<name>.spec.ts` — the shared helpers cover the
   plumbing, so a scenario is a few lines of intent. **Choose the key
   screenshots yourself** with `snapshot(page, cfg, label)` at the moments
   that matter (chat open, mid-stream, final state):

   ```ts
   import { test } from '@playwright/test';
   import { loadE2eConfig } from '../lib/config.js';
   import { waitForBotReplyContaining } from '../lib/assert.js';
   import { openApp, openChat, sendMessage, snapshot } from '../lib/feishu.js';

   const cfg = loadE2eConfig();

   test('send /model → model picker card', async ({ page }) => {
     await openApp(page, cfg);
     await openChat(page, cfg.chatName, cfg.timeoutMs);
     await snapshot(page, cfg, 'model-chat-open');
     await sendMessage(page, '/model');
     await waitForBotReplyContaining(page, 'Model', cfg.timeoutMs);
     await snapshot(page, cfg, 'model-picker');
   });
   ```

2. Assert only what the DOM shows (message text, button labels, panel
   content) — rule-based, free, deterministic.
3. When a new interaction needs a helper (a panel open, a picker choice),
   add it to `e2e/lib/feishu.ts` with the selector it targets, and note the
   selector in the list below.

## Helper API (`e2e/lib/`)

| Helper | Purpose |
| --- | --- |
| `openApp(page, cfg)` | open the messenger and wait for the app shell |
| `openChat(page, name, timeoutMs)` | open a chat by name (polls the lazy list; search fallback) |
| `sendMessage(page, text)` | type into the chat composer and send |
| `chatMessages(page)` | read the rendered messages `{text, isSelf}[]` |
| `clickButton(page, label)` / `clickCardText(page, label)` | click a card button / card text |
| `snapshot(page, cfg, label)` | save a key screenshot into `report/screenshots/` |
| `waitForBotReplyContaining(page, text, timeoutMs)` | wait for a bot reply containing text (rule-based) |

## Selectors (captured from a real client session)

These are the feishu.cn web DOM anchors the helpers rely on. Feishu's web
client can change them; when a selector breaks, update it here and in the
helper together.

| What | Selector |
| --- | --- |
| App shell URL | path matches `/(messenger\|home\|space\|contact\|drive)/` (any tenant subdomain) |
| Chat message item | `.js-message-item`; `.message-self` marks the user's own |
| Chat input (composer) | `[contenteditable="true"]` (`.zone-container.editor-kit-container.innerdocbody`) |
| Card buttons | `<button>` elements; match by accessible name |
| Login QR | a `canvas` inside `[class*="scan-QR-code"]` on the accounts login page (expires — the login helper reloads for a fresh one) |

## Troubleshooting

- **"feishu app did not open"** — the browser session expired; re-run
  `pnpm run e2e:setup` (one QR scan) to refresh it.
- **`e2e:setup` exits 3** — the chat does not exist yet; message the bot in
  the Feishu app once, then re-run `e2e:setup`.
- **dsh never reports "long connection ready"** — wrong app credentials,
  or the app has no long-connection event mode configured (see
  `docs/feishu-setup.md`).
- **docker build fails** — the build writes buildx state under
  `~/.docker`; make sure that is writable (`DOCKER_CONFIG` can redirect it).
- **mp4 conversion skipped** — the image's bundled ffmpeg has no H.264; the
  container uses the full ffmpeg from `Dockerfile.e2e` (rebuild the image
  after pulling a new Playwright base).
