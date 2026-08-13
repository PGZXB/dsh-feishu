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
