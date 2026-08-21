# E2E UI testing (feishu.cn web)

The real-client E2E suite drives the **actual feishu.cn web client** in a
headless browser and exercises the bot exactly like a user: open a group
chat, send a slash command, click card buttons, and assert what renders. It
is the third testing layer:

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
- **One group chat per test case.** Every case runs in its own group chat
  named `<caseId>-<runId>` (globally unique per run), created through the
  backend — the same `im.v1.chat.create` call the plugin's `/group` command
  wraps. Cases never share a chat page, so parallel runs cannot race each
  other's messages.
- **The bot under test runs against a dedicated app.** Use a test Feishu app
  (the setup creates one, named `DSH-E2E-TESTBOT`) and the dedicated test
  account, never the production bot.

## Architecture

```
pnpm run e2e:setup  →  scripts/e2e-setup.mjs (one-time, host, idempotent)
  └─ docker: copy repo (read-only mount → /app) → install → build →
     profile → create the bot app (open-platform QR) → browser login (QR) →
     extract the test-user open_id → probe backend group create+delete →
     exports everything to e2e/.state/
     (creds.json, console-session.json, web-session.json, user.json)

pnpm run e2e:ui     →  scripts/e2e-ui.mjs (host launcher)
  └─ docker: copy repo → install → build → profile →
     reuse exported creds/session/user (no QR) →
     boot the mock DeepSeek server + dsh (profile e2e-dev) →
     run Playwright scenarios (each case creates its own backend group) →
     convert recordings to mp4 →
     generate the single-entry run report into e2e/.output/<runId>/
     (summary.html → cases/<caseId>/report.html + JSON; `latest` symlinks to it)
```

Everything runs inside the container following the README install-from-source
flow. The host mounts the repo **read-only** and two git-ignored directories:

- **`e2e/.state/`** — durable setup state (QR files during setup,
  `creds.json`, `console-session.json`, `web-session.json`, `user.json`).
  Setup exports it from the container; runs import it back.
- **`e2e/.output/`** — run reports: one timestamped directory per run
  (`<runId>/`) with the single-entry report layout, plus a `latest` symlink
  to the newest run.

Build artifacts (node_modules, lib, the pnpm store, the dsh home) exist only
in the container and vanish when it exits.

**Use a dedicated test account.** The bot app and the browser session are
created under whatever account scans the QR — scan with the dedicated
test account, never the production one.

**Setup is idempotent.** Re-running `e2e:setup` never re-scans a login that
is already exported: app credentials in `creds.json` skip the open-platform
scan, `web-session.json` skips the browser scan, `user.json` skips the
open-id extraction. Only the missing pieces are (re)created.

Key pieces:

- **e2e/playwright.config.ts** — Playwright config; all knobs come from the
  environment (see `e2e/lib/config.ts`).
- **e2e/lib/feishu.ts** — the feishu.cn web helpers (open app/chat, send a
  message, read the chat, click buttons, snapshots).
- **e2e/lib/group.ts** — backend group creation/removal (`im.v1.chat.create`
  / `im.v1.chat.delete`, the same calls `/group` wraps) + the unique group
  name builder.
- **e2e/lib/assert.ts** — rule-based chat assertions.
- **e2e/scenarios/*.spec.ts** — one file per scenario.
- **Dockerfile.e2e** — the run image: Playwright's official image + full
  ffmpeg (the bundled one only encodes VP8; mp4 conversion needs H.264).

## Setup (one-time, then hands-free)

```sh
pnpm install
pnpm run build
pnpm run e2e:setup
```

The setup performs, in order:

1. builds the e2e docker image when missing;
2. inside the container: copies the repo (read-only mount), installs +
   builds, installs the plugin into profile `e2e-dev`;
3. **bot-app setup** — the README quick-setup; scan the open-platform QR at
   `e2e/.state/setup.log` (auto-refreshes on expiry) with the **test
   account**; the app is created as `DSH-E2E-TESTBOT` (`E2E_BOT_NAME`
   overrides) and its credentials are exported to `e2e/.state/creds.json`
   (skipped when the file already exists, or when `E2E_APP_ID` /
   `E2E_APP_SECRET` are set);
4. **browser login** — scan `e2e/.state/qr.png` with the same
   account; the storageState is exported to
   `e2e/.state/web-session.json` (skipped when it exists);
5. **test-user open_id** — the browser sends the bot a one-time private
   message (creating the p2p chat), then the app's own credentials (the
   manifest's `im:chat` / `im:chat.members:read`, no extra scope) resolve
   the test user's open_id from that chat's members into
   `e2e/.state/user.json` — the backend group creation invites this user
   (skipped when it exists);
6. **group probe** — creates and deletes a probe group through the backend
   to verify the app can manage group chats.

Exit codes: `0` = ready (later `e2e:ui` runs are hands-free), other = failed
(see the output).

## Quickstart (after setup)

```sh
pnpm run e2e:ui

# options
E2E_VIDEO=off            # no video (default mp4 — webm is also kept)
E2E_SCREENSHOTS=failure  # screenshots only on failure (default on)
E2E_BOT_NAME="DSH-E2E-TESTBOT"  # the bot app name (default DSH-E2E-TESTBOT)
E2E_APP_ID / E2E_APP_SECRET # optional override of the bot app
```

No chat name is needed: every case creates its own group chat
(`<caseId>-<runId>`) through the backend and opens it.

## Report

Every run writes a timestamped directory under `e2e/.output/<runId>/`
(`latest` symlinks to the newest run). The report has a **single entry
point** — `summary.html` — styled like the Playwright HTML report (dark
sidebar with the case list and status dots, light main panel), linking into
one self-contained page per case:

```
<runId>/
  summary.html      single entry: run stats + every case (sidebar), links
                    into cases/<caseId>/report.html
  summary.json      machine-readable run + per-case summary
  cases/<caseId>/
    report.html     one case, self-contained (status, error, annotations,
                    screenshots, <video> recording, artifacts, stdout)
    report.json     one case, everything we know about it
    screenshots/    the case's key screenshots (scenario-chosen via
                    snapshot(page, cfg, label)) + Playwright captures
    video.mp4       the case's full recording (mp4; webm kept as video.webm)
  report.json       Playwright's raw JSON (the generator's source of truth)
  manifest.json     flat artifact list (path + kind + size)
```

The per-case `report.json` is exhaustive: status, duration, start time,
retry count, error message + location, annotations, stdout/stderr,
artifacts, plus the run environment (node/playwright/plugin versions,
video/screenshot policy).

## Adding a scenario

1. Create `e2e/scenarios/<name>.spec.ts` — the shared helpers cover the
   plumbing, so a scenario is a few lines of intent. **Every case creates
   its own backend group** (`<caseId>-<runId>`, unique per run) and opens
   it; **choose the key screenshots yourself** with
   `snapshot(page, cfg, label)` at the moments that matter (chat open,
   mid-stream, final state):

   ```ts
   import { test } from '@playwright/test';
   import { loadE2eConfig } from '../lib/config.js';
   import { waitForBotReplyContaining } from '../lib/assert.js';
   import { openApp, openChat, sendMessage, snapshot } from '../lib/feishu.js';
   import { caseIdFromTitle } from '../lib/report.js';
   import { createGroup, groupNameFor } from '../lib/group.js';

   const cfg = loadE2eConfig();

   test('send /model → model picker card', async ({ page }, testInfo) => {
     const groupName = groupNameFor(caseIdFromTitle(testInfo.title), cfg.runId);
     await createGroup(cfg, groupName, [cfg.userOpenId!]);
     await openApp(page, cfg);
     await openChat(page, groupName, cfg.timeoutMs);
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
| `groupNameFor(caseId, runId)` | unique group name `<caseId>-<runId>`, truncated to ≤ 60 chars |
| `createGroup(cfg, name, memberOpenIds)` / `deleteGroup(cfg, chatId)` | backend group create/delete (`im.v1.chat.create` / `im.v1.chat.delete`) |

## Selectors (captured from a real client session)

These are the feishu.cn web DOM anchors the helpers rely on. Feishu's web
client can change them; when a selector breaks, update it here and in the
helper together.

| What | Selector |
| --- | --- |
| App shell URL | path matches `/(messenger\|home\|space\|contact\|drive)/` (any tenant subdomain) |
| Chat message item | `.js-message-item`; `.message-self` marks the user's own |
| Chat input (composer) | `.innerdocbody` / `.zone-container.editor-kit-container` (visible) |
| Card buttons | `<button>` elements; match by accessible name |
| Login QR | a `canvas` inside `[class*="scan-QR-code"]` on the accounts login page (expires — the login helper reloads for a fresh one) |

## Troubleshooting

- **"feishu app did not open"** — the browser session expired; re-run
  `pnpm run e2e:setup` (one QR scan) to refresh it.
- **setup fails at the group probe** — the app cannot create group chats
  through the backend; check the app's permissions/scopes (see
  `docs/feishu-setup.md`) and that `E2E_USER_OPEN_ID` resolved to the test
  account.
- **"setup state missing"** — run `pnpm run e2e:setup` first; the run mode
  refuses to guess credentials.
- **dsh never reports "long connection ready"** — wrong app credentials,
  or the app has no long-connection event mode configured (see
  `docs/feishu-setup.md`).
- **docker build fails** — the build writes buildx state under
  `~/.docker`; make sure that is writable (`DOCKER_CONFIG` can redirect it).
- **mp4 conversion skipped** — the image's bundled ffmpeg has no H.264; the
  container uses the full ffmpeg from `Dockerfile.e2e` (rebuild the image
  after pulling a new Playwright base).
