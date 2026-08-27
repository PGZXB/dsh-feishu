# Portable deployment (green package)

`scripts/package-portable.mjs` builds a self-contained, "green" deployment
directory for dsh-feishu on Linux **x86_64 (glibc)**: a bundled Node runtime,
the DSH CLI + harness family, the dsh-feishu bundle built from `main`, a
credential-free profile-home template, and per-instance launchers. Deploying
is copying the directory to a host and running `bin/start` — no system Node,
no network, no pnpm.

The use case is **many instances on one server**: each deployed copy is its
own isolated dsh-feishu instance (own home, own Feishu app, own API key,
own model), so a single host can serve several users without the instances
touching one another's state.

## Build

```sh
pnpm install                      # once, in the repo
pnpm run build                    # produces lib/ (the bundle is built below)
node scripts/package-portable.mjs
```

The script runs a real `npm install @deepseek-ai/dsh@<pin>` into a staging
app prefix (the `INSTALL_ANCHOR`) and supplements it with every
`@deepseek-ai/*` package a Feishu profile needs (the `cordis.patch.yml`
bundle-layer names plus the plugin's peer dependencies), so bundle
resolution is fully offline. It then builds the dsh-feishu bundle from the
checkout, vendors a Node LTS runtime, writes a profile-home template, and
emits:

```
_dev/portable/dsh-feishu-portable-linux-x64-v<version>-<sha>/   # the package
_dev/portable/dsh-feishu-portable-linux-x64-v<version>-<sha>.tar.gz
```

Output is git-ignored (`_dev/`), never committed. The precedence checks are:

- **Host must be Linux x86_64 glibc** — the vendored native prebuilds
  (sharp, node-pty, rollup, koffi, …) are platform-selected. musl/Alpine is
  out of scope (a musl Node build would be needed).
- Build machine needs outbound network (nodejs.org + the npm registry); the
  *deployed* package never does.

### Environment overrides

| Variable | Meaning |
| --- | --- |
| `PORTABLE_NODE_CACHE` | persistent dir caching the downloaded Node tarball (default `_dev/portable/.cache`) |
| `PORTABLE_NODE_VERSION` | pin a Node version (defaults to the latest LTS patch of the major below) |
| `PORTABLE_NODE_MAJOR` | Node major to auto-pick (default `22`) |
| `PORTABLE_NODE_TARBALL` | path to a pre-downloaded `.tar.xz` for offline builds |
| `PORTABLE_DSH_VERSION` | pin the DSH version (defaults to the repo's `devDependencies["@deepseek-ai/dsh"]`) |
| `PORTABLE_OUT_DIR` | output dir (default `_dev/portable`) |
| `PORTABLE_PACKAGE_NAME` | override the package dir name |

### Layout

```
runtime/node/         bundled Node (bin/node + npm-cli)
runtime/app/          DSH CLI install anchor: node_modules/@deepseek-ai/{dsh,dsh-base,…}
bundle/dsh-feishu/    the bundle built from main (lib/, cordis.patch.yml, package.json, + its runtime deps)
home/                 credential-free DSH_HOME template (profiles/feishu/**)
bin/dsh-feishu        launcher: sets PATH, sources instance.env, DSH_HOME, execs dsh
bin/start             convenience wrapper around bin/dsh-feishu
bin/setup             one QR scan: create + configure the Feishu app (the bundle's quick-setup wizard)
bin/init-instance     copy this package into a fresh isolated instance
instance.env.example  per-instance credentials & options
README-PORTABLE.md    per-instance deployment instructions (also shipped in the package)
portable.json         provenance: versions, source sha, libc
```

## First deploy and per-instance app setup

```sh
cp -r dsh-feishu-portable-linux-x64-* yourinstance
cd yourinstance
cp instance.env.example instance.env          # FEISHU_APP_ID/SECRET, DEEPSEEK_API_KEY, …
./bin/setup                                    # one QR scan: create + configure the Feishu app
./bin/start
```

`bin/setup` runs the bundle's quick-setup wizard with `--dsh-home <instance
home> --profile feishu`, writing app credentials into the instance's
`home/profiles/feishu/cordis.patch.yml`. Re-run with `--app-id cli_xxx` to
reconfigure an existing app.

## How the harness resolves offline

Boot loads bundle layers from `INSTALL_ANCHOR` (the vendored dsh app
install) first, then the profile's own `node_modules`. The profile's
`dsh.profile.bundles` lists `@deepseek-ai/dsh-base`, the bundle-layer
packages referenced by the dsh-feishu patch, and the dsh-feishu bundle. The
harness family lives **once** (in the anchor); the profile layer ships only
the dsh-feishu bundle plus its non-harness runtime deps, with harness peers
symlinked from the anchor — never a second copy (a duplicate would break
module-identity state, the double-install bug family).

## Multi-instance model

- **One copy = one instance.** Deploy N users by copying the package N
  times; each copy has its own `home/` (its DSH_HOME and `dataDir`), its own
  `instance.env` (Feishu app, API key, model), so there is no cross-instance
  session, log, or model state.
- Per-instance identity is pinned to **its own Feishu app** (separate
  appId/appSecret/bot/team). A single Feishu chat maps to one agent session;
  instances should not share one app if you need isolation.
- No ports are bound (the surface uses the Feishu long connection, a
  WebSocket, not HTTP), so multiple instances on one host do not conflict.
- `bin/start` sources `instance.env`; keys in the instance's
  `home/profiles/feishu/cordis.patch.yml` win over the environment.

### Serve a second user on the same server

```sh
cd path/to/firstinstance
./bin/init-instance second          # fresh isolated copy at ./second
cd second
#  edit instance.env with the second user's appId/appSecret/api key
./bin/start
```

## Verification

- `bin/start --dump-config` composes the dsh-feishu row (no credentials
  needed to compose; booting needs a real app + API key).
- With credentials set, `bin/start` logs `[feishu] bridge ready`.
- The end-to-end bot path (a real turn in a group) must be verified by the
  operator against a real Feishu app — CI does not drive a real bot.

## Notes / limits

- Target is **glibc x86_64 Linux**; musl/Alpine needs a musl Node build.
- Each instance needs its own Feishu app (separate appId/appSecret/bot/team).
- The chat must have a working directory pinned (choose via `/repo` or
  `/cd`); `defaultCwd` is a fallback, never an implicit choice.
- The package builds the bundle from the current working tree; build from a
  clean `main` checkout so shipped code matches the release.
