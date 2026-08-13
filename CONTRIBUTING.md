# Contributing

Thanks for helping with dsh-feishu. This page is short on purpose; the
[AGENTS.md](AGENTS.md) file carries the operational rules (conventions,
commands, style), and the [development guide](docs/development.md) carries
setup and workflow details.

## Ground rules

- Code comments, documentation, and commit messages are **English only**.
- **Every feature module ships unit tests**; bug fixes ship a failing test
  first.
- **Features ship with their docs**: update the relevant `docs/` page and the
  CHANGELOG in the same change.
- All gates must pass: `pnpm run lint`, `pnpm run typecheck`,
  `pnpm run test`, `pnpm run build`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`).

## Workflow

1. Open an issue or comment on an existing one to claim the work.
2. Create a branch from `main`; keep changes focused on one feature.
3. Implement, test, document, and run the gates.
4. Open a pull request describing what changed and why, with the CHANGELOG
   entry included.
5. A maintainer reviews; address feedback; merge.

## Reporting issues

Include the dsh version (`dsh --version`), Node version, profile name, the
`cordis.patch.yml` / config involved, and any relevant logs. See
[SECURITY.md](SECURITY.md) for vulnerability reporting.
