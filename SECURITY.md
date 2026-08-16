# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities. Report them
privately to the maintainers:

- Open a private security advisory on GitHub (once the repository is public),
  or
- Email the maintainers at **pgzxb@qq.com**.

Please include:

- The dsh-feishu version and dsh version affected.
- A minimal reproduction (profile config, Feishu app setup, steps).
- Impact assessment and any suggested fix.

We aim to acknowledge reports within 48 hours and to release a fix as soon as
a verified reproduction exists.

## Security-relevant design notes

- The bridge only talks to chats/users on an explicit allowlist
  (`allowedChats` / `allowedUsers`); both default to unrestricted — configure
  them for anything beyond a trusted private bot.
- Feishu credentials are read from config or `FEISHU_APP_ID` /
  `FEISHU_APP_SECRET` environment variables; never commit credentials.
  **Rotate the Feishu app secret before any public release** — development
  secrets may live in e.g. `_dev/secrets.env` (git-ignored) and must be treated as
  compromised once the repository is public.
- dsh approval and user-question requests fail closed when the bridge cannot
  present them (dsh semantics: `unavailable` / `cancelled`).
- Inbound messages are deduplicated by id within the process lifetime, and
  every inbound text is treated as untrusted (shell commands go through dsh's
  own approval system).
