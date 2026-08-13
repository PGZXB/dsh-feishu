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
