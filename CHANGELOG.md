# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffold: bundle manifest (`dsh.bundle.patch`), `cordis.patch.yml`,
  strict TypeScript build, Biome lint/format, Vitest unit tests, CI workflow,
  English documentation set (README, AGENTS.md, CONTRIBUTING, SECURITY,
  docs/development.md), MIT license.
- Iteration-0 plugin entry (`src/index.ts`): mounts into a dsh profile,
  idles in not-configured mode until `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
  are supplied, and registers the `feishu-status` diagnostic slash command.
- Console log exporter (`src/console-exporter.ts`): routes structured
  `ctx.logger` records to the console, since dsh surfaces mount no console
  exporter by default (bridge operators need visible logs).
- **Core identity: DSH-native — born for dsh, not bridged to it** (README,
  AGENTS.md, docs/architecture.md).
- Iteration-1 private-chat loop:
  - `src/feishu/types.ts` — transport seam types (normalized message,
    transport contract, card JSON).
  - `src/transport.ts` — lark-oapi implementation: WS long connection
    (`WSClient` + `EventDispatcher`) receive, `message.create` / `message.patch`
    send/update, pure `normalizeMessageEvent`, `FeishuApiError`.
  - `src/message-dedup.ts` — bounded in-memory message-id dedup.
  - `src/session-map.ts` — durable chat ↔ session mapping (atomic writes).
  - `src/cards/render.ts` — pure session-event → card rendering, markdown
    escaping, tail truncation.
  - `src/cards/streaming.ts` — one card per turn: open, throttled/coalesced
    patches, terminal finalize.
  - `src/bridge.ts` — orchestrator: message → session → `agent.followup`;
    `session/event` → card patches; turn end → final answer as a fresh
    message (Feishu patches are silent and cannot notify).
  - `src/index.ts` — config (cwd, data dir, provider/model, card throttle),
    credential resolution, wiring, transport factory injection for tests.
  - docs/feishu-setup.md (app creation, scopes, long connection) and
    docs/architecture.md.
  - 59 unit tests across all modules.
- Iteration-1 hardening:
  - `src/memory-transport.ts` — file-channel in-memory transport behind the
    `FEISHU_TRANSPORT=memory` seam (integration tests and manual debugging:
    `inbox/` delivers messages, `outbox/` records every send/update).
  - Restart-safe session resolution in `src/bridge.ts`: live agent → resume
    the mapped persisted session → create fresh → rebind a fresh id when the
    mapped id collides with an on-disk log; agents always receive
    provider/model (config overrides or the deployment default selection).
  - Turn-failure logging: `turn/end` errors are logged with code + message.
  - **Real-composition integration test**
    (`tests/integration/real-composition.spec.ts`): a real dsh process
    booted from a real profile runs a real agent turn against a mock LLM
    server (`tests/integration/mock-llm-server.ts`), with Feishu swapped for
    the memory transport; asserts the full private-chat loop (card posted +
    patched, completion notice as a fresh message). Self-skips when
    prerequisites are missing.
  - 68 tests total (67 unit + 1 real-composition integration).
- Iteration-2 slice — streaming-card controls + minimal completion notice:
  - Card button callbacks (`card.action.trigger`) over the WS long
    connection: `normalizeCardAction` in the transport, routed by the bridge.
  - Streaming card carries a status button row: ⏹ Stop while working;
    📋 Copy / 🔁 Retry / ⚙️ Panel when done (Retry/Panel on error).
  - Control-panel card (`buildPanelCard`): a standing operation surface so
    actions do not require typing slash messages.
  - The final answer is kept in the finalized card; the fresh message is now
    a minimal completion notice (`✅ Done` / failure notice), removing the
    duplicate full-text bubble.
  - 81 tests total.
- Iteration-2 UX refinements:
  - Card layout switched to the v1 root-`elements` form (no `schema` field):
    schema-2.0 cards reject the interactive `action` tag (ErrCode 200861),
    so the button-capable v1 layout is used (the layout botmux uses).
  - A completed turn sends **no second bubble** — the card finalizes green in
    place and the initial card send already notified. Failure turns keep a
    `⚠️` notice.
  - docs/feishu-setup.md: card callbacks must be switched to long connection
    separately from events (card actions are callbacks, not events).
