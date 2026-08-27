#!/usr/bin/env node
/**
 * package-portable.mjs
 *
 * Build a self-contained, "green" deployment directory for dsh-feishu on
 * Linux (x86_64, glibc): a bundled Node runtime, a real DSH CLI install
 * (the harness family it ships plus every bundle/service a Feishu profile
 * needs), the dsh-feishu bundle built from `main`, a credential-free
 * profile-home template, and per-instance launchers. Deploying = copying
 * the produced directory to a host and running `bin/start` (or
 * `bin/init-instance` for a fresh instance) — no system Node, no network.
 *
 * Model (see docs/portable-deployment.md):
 *  - One instance = one copy of the produced directory, with its own
 *    DSH_HOME (`home/`), its own Feishu app (appId/appSecret from
 *    `instance.env`), own dataDir, API key, and model.
 *  - dsh resolves bundle layers from INSTALL_ANCHOR (the vendored dsh app
 *    install) first, then the profile's own node_modules. We vendor a REAL
 *    `npm install @deepseek-ai/dsh@<pin>` tree as the anchor and supplement
 *    it with every bundle/service a Feishu profile requires, so boot is
 *    fully offline (no pnpm, no registry). The harness family lives ONCE
 *    (in the anchor); the profile layer only ships the dsh-feishu bundle
 *    plus its non-harness runtime deps, with harness peers symlinked from
 *    the anchor — never a second copy (double-install breaks module state).
 *  - The build host must be Linux x86_64 glibc (vendored native prebuilds
 *    — sharp, node-pty, rollup, koffi, … — are platform-selected).
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_OUT_DIR = join(REPO_ROOT, '_dev', 'portable');
const NAME_BASE = 'dsh-feishu-portable-linux-x64';

/* ── helpers ────────────────────────────────────────────────────────────── */

/** Spawn a command, resolve on exit 0, reject with captured stderr otherwise. */
function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => rejectPromise(e));
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ out, err })
        : rejectPromise(new Error(`${basename(cmd)} ${args.join(' ')} exited ${code}\n${err}`)),
    );
  });
}

/** The npm CLI shipped inside the bundled node, invoked via that node. */
function npmArgs(nodeBin, args) {
  const nodeDir = dirname(nodeBin); // <runtime>/node/bin
  const npmCli = join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [npmCli, ...args];
}

/** Read the package.json of a package dir. */
function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** dsh family version (from dsh's dep spec on dsh-base), as a caret range. */
function familyVersion(dshDir) {
  return readPkg(dshDir).dependencies?.['@deepseek-ai/dsh-base'] ?? '^0.1.1-rc.2';
}

/** The `@deepseek-ai/*` package names referenced by the dsh-feishu bundle
 *  patch (its `cordis.patch.yml`), extracted from the `name:` fields. A regex
 *  is used because the patch carries `!!js` expressions (a dsh home-path
 *  tag) that a plain YAML parse rejects; we only ever need the names. */
function patchPackages(bundleDir) {
  const text = readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8');
  const names = new Set();
  for (const match of text.matchAll(/\bname:\s*['"]?@deepseek-ai\/([a-z0-9-]+)['"]?/g)) {
    names.add(`@deepseek-ai/${match[1]}`);
  }
  return [...names];
}

/** Every `@deepseek-ai/*` name a Feishu profile must resolve at boot: the
 *  bundle-layer packages referenced by `cordis.patch.yml` plus the plugin's
 *  peer dependencies (the harness services/libraries it imports). */
function requiredHostPackages(bundleDir) {
  const names = new Set(['@deepseek-ai/dsh-base', ...patchPackages(bundleDir)]);
  for (const peer of Object.keys(readPkg(bundleDir).peerDependencies ?? {})) {
    if (peer.startsWith('@deepseek-ai/')) names.add(peer);
  }
  return [...names];
}

/** The profile `dsh.profile.bundles` layer list: ONLY the packages that are
 *  actual bundles (export a `dsh.bundle.patch`). For the Feishu surface that
 *  is dsh-base and the dsh-feishu plugin; the patch's other referenced
 *  service packages (storage-family, workspace, schedule, tool-ask-user) are
 *  resolved from the anchor, not bundle layers. Listing a non-bundle here
 *  fails loud in loadProfile ("declares no dsh.bundle"). */
function profileLayers(bundleDir) {
  return ['@deepseek-ai/dsh-base', readPkg(bundleDir).name];
}

/** The dsh-feishu plugin's non-harness runtime dependencies (installed into
 *  the bundle's own node_modules so the bundle resolves its libs offline —
 *  both when booted in dsh and when run standalone via `bin/setup`). */
function pluginRuntimeDeps(bundleDir) {
  return Object.entries(readPkg(bundleDir).dependencies ?? {})
    .filter(([name]) => !name.startsWith('@deepseek-ai/'))
    .map(([name, spec]) => `${name}@${spec}`);
}

/** Install the plugin's non-harness runtime deps into the bundle directory. */
export async function installBundleRuntimeDeps(bundleDir, nodeBin, opts = {}) {
  const deps = pluginRuntimeDeps(bundleDir);
  if (deps.length === 0) return;
  await npmInstall(nodeBin, bundleDir, deps, { ...opts, extra: ['--legacy-peer-deps'] });
}

/* ── build steps ────────────────────────────────────────────────────────── */

/** Latest LTS patch within a major, from the official nodejs dist index. */
export async function resolveNodeVersion(major = '22') {
  const { out } = await run('curl', ['-sL', '-m', '40', 'https://nodejs.org/dist/index.json']);
  const versions = JSON.parse(out);
  const hit = versions.find((v) => v.version.startsWith(`v${major}.`) && v.lts !== false);
  if (hit === undefined) throw new Error(`no LTS release for node major ${major}`);
  return hit.version;
}

/** Download (or reuse) a node tarball and extract `bin/node` into `dest`.
 *  The tarball is cached in the checkout's `_dev/portable/.cache` (writable
 *  and reused on a rebuild of the same checkout). Set PORTABLE_NODE_CACHE /
 *  PORTABLE_NODE_TARBALL to a shared path to reuse one download across
 *  worktrees/hosts — the ~30 MB archive is the slow part; extraction is cheap. */
export async function provideNode(dest, version) {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(join(dest, 'bin', 'node'))) {
    const cache = process.env.PORTABLE_NODE_CACHE ?? join(DEFAULT_OUT_DIR, '.cache');
    mkdirSync(cache, { recursive: true });
    const tarball =
      process.env.PORTABLE_NODE_TARBALL ?? join(cache, `node-${version}-linux-x64.tar.xz`);
    if (!existsSync(tarball)) {
      const url = `https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.xz`;
      process.stderr.write(`[portable] downloading ${url}\n`);
      await run('curl', ['-sL', '-m', '600', '-o', tarball, url], {
        maxBuffer: 1024 * 1024 * 1024,
      });
    } else {
      process.stderr.write(`[portable] using cached node tarball ${tarball}\n`);
    }
    await run('tar', ['-xJf', tarball, '-C', dest, '--strip-components=1'], {
      maxBuffer: 1024 * 1024 * 1024,
    });
  }
  return (await run(join(dest, 'bin', 'node'), ['--version'])).out.trim();
}

/** npm install (via the bundled node's npm) a spec list into a prefix. The
 *  official registry + a writable per-build cache are forced (the harness
 *  family is not fully mirrored on npmmirror, and `~/.npm` may be read-only). */
async function npmInstall(nodeBin, prefix, specs, opts = {}) {
  const cache = opts.cache ?? join(tmpdir(), 'dsh-portable-npm-cache');
  await run(
    nodeBin,
    npmArgs(nodeBin, [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'error',
      '--registry',
      'https://registry.npmjs.org/',
      '--cache',
      cache,
      '--userconfig',
      '/dev/null',
      '--fetch-retries',
      '5',
      ...(opts.extra ?? []),
      ...specs,
    ]),
    { maxBuffer: 512 * 1024 * 1024 },
  );
}

/** Build the dsh-feishu bundle from the current checkout into `bundleDir`. */
export async function buildBundle(bundleDir) {
  const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  await run(tsc, ['-p', join(REPO_ROOT, 'tsconfig.build.json')]);
  // Copy the npm `files` whitelist plus the manifest (npm ships package.json
  // automatically, but we copy the bundle by hand). LICENSE too.
  const entries = new Set(readPkg(REPO_ROOT).files ?? []);
  for (const must of ['package.json', 'LICENSE']) entries.add(must);
  for (const entry of entries) {
    const src = join(REPO_ROOT, entry);
    if (existsSync(src)) cpSync(src, join(bundleDir, entry), { recursive: true });
  }
  for (const must of ['lib', 'cordis.patch.yml', 'package.json', 'README.md']) {
    if (!existsSync(join(bundleDir, must))) {
      throw new Error(`bundle build did not produce required part: ${must}`);
    }
  }
}

/** Vendor the DSH CLI plus every service/bundle a Feishu profile needs into
 *  an app prefix (the INSTALL_ANCHOR), so bundle resolution is offline. */
export async function installDshAnchor(anchorDir, nodeBin, dshVersion, bundleDir, opts = {}) {
  await npmInstall(nodeBin, anchorDir, [`@deepseek-ai/dsh@${dshVersion}`], opts);
  const dshDir = join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh');
  if (!existsSync(dshDir)) throw new Error(`@deepseek-ai/dsh@${dshVersion} did not install`);
  const family = familyVersion(dshDir);
  const need = requiredHostPackages(bundleDir);
  const missing = need.filter((n) => !existsSync(join(anchorDir, 'node_modules', n)));
  if (missing.length > 0) {
    process.stderr.write(
      `[portable] supplementing anchor with ${missing.length} package(s): ${missing.join(', ')}\n`,
    );
    await npmInstall(
      nodeBin,
      anchorDir,
      missing.map((n) => `${n}@${family}`),
      opts,
    );
  }
  const still = need.filter((n) => !existsSync(join(anchorDir, 'node_modules', n)));
  if (still.length > 0) {
    throw new Error(
      `cannot resolve Feishu host packages: ${still.join(', ')} — install \`` +
        'npm i <pkg>@<family>` into the anchor and rebuild',
    );
  }
  return dshDir;
}

/** Write the credential-free DSH-HOME template used by deployed instances. */
export async function writeTemplateHome(homeDir, bundleDir, anchorDir) {
  const profileDir = join(homeDir, 'profiles', 'feishu');
  mkdirSync(profileDir, { recursive: true });
  const pluginName = readPkg(bundleDir).name;
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      { private: true, dsh: { profile: { bundles: profileLayers(bundleDir) } } },
      null,
      2,
    ) + '\n',
  );

  const nm = join(profileDir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  // Every @deepseek-ai peer must resolve from the ANCHOR (one copy only) —
  // never a real duplicate in the profile (double-install breaks cordis
  // module identity). npm may have planted a real cordis/dsh-* during the
  // runtime-deps install; clear the subtree and RE-LINK from the anchor with
  // package-relative symlinks, so the assembled tree stays relocatable (no
  // absolute temp paths survive the build).
  rmSync(join(nm, '@deepseek-ai'), { recursive: true, force: true });
  const linkRelative = (linkPath, target) => {
    rmSync(linkPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      symlinkSync(relative(dirname(linkPath), target), linkPath);
    } catch {
      cpSync(target, linkPath, { recursive: true });
    }
  };
  // The bundle itself, then every harness peer, both as package-relative
  // links into their real location (bundle/ + runtime/app/node_modules).
  linkRelative(join(nm, '@dsh-feishu', pluginName.split('/').pop() ?? pluginName), bundleDir);
  for (const peer of Object.keys(readPkg(bundleDir).peerDependencies ?? {})) {
    if (!peer.startsWith('@deepseek-ai/')) continue;
    const anchorPkg = join(anchorDir, 'node_modules', peer);
    if (existsSync(anchorPkg)) linkRelative(join(nm, peer), anchorPkg);
  }
  // The user-layer patch: feishu row with no credentials (env fallback).
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    `# dsh-feishu user layer for this instance.
# Credentials and surface options come from instance.env by default (config
# wins over env); set them here instead to pin them in the patch.
- id: feishu
  name: '${pluginName}'
  config: {}
`,
  );
}

/** Static files installed into the package (launchers + per-instance docs). */
export function bootstrapFiles() {
  return {
    'bin/dsh-feishu': `#!/usr/bin/env bash
# dsh-feishu launcher: run THIS deployed instance. Each copy of the package
# is its own instance (own home, app, api key, model).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/runtime/node/bin:$PATH"
if [ -f "$ROOT/instance.env" ]; then
  set -a; . "$ROOT/instance.env"; set +a
fi
export DSH_HOME="\${DSH_HOME:-$ROOT/home}"
export DSH_FEISHU_SESSION="\${DSH_FEISHU_SESSION:-$DSH_HOME/feishu-session.json}"
export NODE="$ROOT/runtime/node/bin/node"
exec "$NODE" "$ROOT/runtime/app/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile feishu "$@"
`,
    'bin/start': `#!/usr/bin/env bash
# Start this deployed dsh-feishu instance.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/dsh-feishu" "$@"
`,
    'bin/setup': `#!/usr/bin/env bash
# One QR scan: create + configure the Feishu app for THIS instance and write
# appId/appSecret into its home/profiles/feishu/cordis.patch.yml. Re-run
# against an existing app with --app-id <cli_...> to reconfigure it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/runtime/node/bin:$PATH"
if [ -f "$ROOT/instance.env" ]; then
  set -a; . "$ROOT/instance.env"; set +a
fi
export DSH_HOME="\${DSH_HOME:-$ROOT/home}"
export DSH_FEISHU_SESSION="\${DSH_FEISHU_SESSION:-$DSH_HOME/feishu-session.json}"
exec "$ROOT/runtime/node/bin/node" "$ROOT/bundle/dsh-feishu/lib/setup/cli.js" \
  --dsh-home "$DSH_HOME" --profile feishu "$@"
`,
    'bin/init-instance': `#!/usr/bin/env bash
# Create a NEW isolated instance as a full copy of this package, with a fresh
# instance.env to fill in.  Usage:  bin/init-instance <name> [dest-dir]
set -euo pipefail
NAME="\${1:?usage: bin/init-instance <name> [dest-dir]}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="\${2:-"$(dirname "$SRC")/$NAME"}"
if [ -e "$DEST" ]; then echo "error: $DEST already exists" >&2; exit 1; fi
echo "copying $SRC -> $DEST"
cp -a "$SRC" "$DEST"
cp "$DEST/instance.env.example" "$DEST/instance.env"
echo "instance created at $DEST"
echo "1) edit $DEST/instance.env (FEISHU_APP_ID/SECRET, DEEPSEEK_API_KEY, …)"
echo "2) run:  $DEST/bin/start"
`,
    'instance.env.example': `# Per-instance credentials & options. Config in the profile patch wins over these.
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=yyyyyyyyyyyyyyyyyyyyyyyy
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
# Comma-separated Feishu user open ids allowed to use this bot (empty = all).
# FEISHU_ALLOWED_USERS=
# The chat must have a working directory pinned (via /repo or /cd).
# defaultCwd=/path/to/workspace
# model=deepseek-v4-flash
# Unset the ambient proxy so the Feishu long connection is not sandboxed.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
`,
    'README-PORTABLE.md': `# dsh-feishu portable deployment (Linux x64)

A self-contained dsh-feishu deployment: bundled Node, DSH CLI + harness, the
dsh-feishu bundle, a credential-free profile home, and per-instance launchers.
Copy the directory to a Linux x86_64 (glibc) host and run it — no system Node,
no network, no pnpm.

**One copy = one instance.** Each copy has its own home, Feishu app
(appId/appSecret), API key, and model. Run separate copies (or
\`bin/init-instance\`) to serve multiple users on one server with isolation.

## First deployment
\`\`\`sh
cp dsh-feishu-portable-linux-x64-* yourinstance
cd yourinstance
cp instance.env.example instance.env
#  edit instance.env: FEISHU_APP_ID/SECRET, DEEPSEEK_API_KEY, …
./bin/start
\`\`\`

## Create + configure the Feishu app (one QR scan)
\`\`\`sh
cd yourinstance
./bin/setup            # one QR scan creates + configures the app, writes
                       # appId/appSecret into home/profiles/feishu/cordis.patch.yml
\`\`\`
Re-run \`./bin/setup --app-id cli_xxx\` to reconfigure an existing app.

## Another instance on the same server
\`\`\`sh
cd path/to/yourfirstinstance
./bin/init-instance second   # creates ./second as a fresh isolated copy
cd second
#  edit instance.env with the second instance's own app + key
./bin/setup                  # create + configure the second instance's app
./bin/start
\`\`\`

## Verify
- \`./bin/start --dump-config\` prints the composed dsh-feishu row (no
  credentials needed to compose; booting needs a real app + api key).
- With credentials set, \`./bin/start\` logs \`[feishu] bridge ready\`.

## Notes
- Target is glibc x86_64 Linux; musl/Alpine needs a musl Node build.
- Each instance needs its own Feishu app (separate appId/appSecret/bot/team).
- The chat must have a working directory pinned (choose via /repo or /cd).
- \`bin/start\` sources \`instance.env\`; config in
  \`<instance>/home/profiles/feishu/cordis.patch.yml\` wins over env.
`,
  };
}

/* ── orchestration ──────────────────────────────────────────────────────── */

/** Assemble the package directory (and, unless `skipTarball`, a .tar.gz). */
export async function buildPortablePackage(opts = {}) {
  const outRoot = resolve(opts.outDir ?? process.env.PORTABLE_OUT_DIR ?? DEFAULT_OUT_DIR);
  const nodeMajor = opts.nodeMajor ?? process.env.PORTABLE_NODE_MAJOR ?? '22';
  const dshVersion =
    opts.dshVersion ??
    process.env.PORTABLE_DSH_VERSION ??
    readPkg(REPO_ROOT).devDependencies['@deepseek-ai/dsh'];
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `portable package requires linux x64 (glibc); got ${process.platform}/${process.arch}`,
    );
  }
  const nodeVersion = opts.nodeVersion ?? (await resolveNodeVersion(nodeMajor));
  const pluginVersion = readPkg(REPO_ROOT).version;
  let sourceSha = 'unknown';
  try {
    sourceSha = (await run('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'])).out.trim();
  } catch {}

  const packageName = opts.packageName ?? `${NAME_BASE}-v${pluginVersion}-${sourceSha}`;
  const outDir = join(outRoot, packageName);
  // Build into a sibling `.part` dir on the SAME filesystem, then rename —
  // atomic and, crucially, preserves the package-relative symlinks (a
  // cross-device cpSync could dereference them or leave dangling temp links).
  const partDir = join(outRoot, `.${packageName}.part`);
  rmSync(partDir, { recursive: true, force: true });
  mkdirSync(partDir, { recursive: true });
  const npmOpts = { cache: process.env.PORTABLE_NPM_CACHE ?? join(outRoot, '.npm-cache') };

  // 1) Build the bundle from the checkout.
  const bundleDir = join(partDir, 'bundle', 'dsh-feishu');
  await buildBundle(bundleDir);

  // 2) Bundled Node runtime.
  const nodeDir = join(partDir, 'runtime', 'node');
  const nodeBin = join(nodeDir, 'bin', 'node');
  const actualNode = await provideNode(nodeDir, nodeVersion);

  // 3) DSH CLI install anchor (+ supplements).
  const appDir = join(partDir, 'runtime', 'app');
  await installDshAnchor(appDir, nodeBin, dshVersion, bundleDir, npmOpts);

  // 4) Credential-free profile-home template.
  await writeTemplateHome(join(partDir, 'home'), bundleDir, appDir);

  // 5) Bundle self-contained runtime deps (for dsh boot AND `bin/setup`).
  await installBundleRuntimeDeps(bundleDir, nodeBin, npmOpts);

  // 6) Launchers + docs.
  for (const [rel, content] of Object.entries(bootstrapFiles())) {
    const p = join(partDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
    if (rel.startsWith('bin/')) chmodSync(p, 0o755);
  }

  // 7) Provenance manifest.
  writeFileSync(
    join(partDir, 'portable.json'),
    JSON.stringify(
      {
        product: 'dsh-feishu',
        pluginVersion,
        dsh: dshVersion,
        node: actualNode,
        platform: 'linux-x64',
        libc: 'glibc',
        source: { branch: 'main', sha: sourceSha },
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  // Atomic publish: rename the finished part dir into place.
  mkdirSync(outRoot, { recursive: true });
  rmSync(outDir, { recursive: true, force: true });
  renameSync(partDir, outDir);

  let tarPath;
  if (!opts.skipTarball) {
    tarPath = join(outRoot, `${packageName}.tar.gz`);
    rmSync(tarPath, { force: true });
    await run('tar', ['-czf', tarPath, '-C', outRoot, packageName]);
  }

  return { dir: outDir, tarPath, packageName, nodeVersion: actualNode, sourceSha };
}

/** CLI entry. */
export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  try {
    const result = await buildPortablePackage({
      skipTarball: args.has('--no-tarball'),
      nodeVersion: process.env.PORTABLE_NODE_VERSION,
      nodeMajor: process.env.PORTABLE_NODE_MAJOR,
      dshVersion: process.env.PORTABLE_DSH_VERSION,
      outDir: process.env.PORTABLE_OUT_DIR,
      packageName: process.env.PORTABLE_PACKAGE_NAME,
    });
    process.stdout.write(
      `[portable] built ${result.packageName} (node ${result.nodeVersion}, source ${result.sourceSha})\n` +
        `  dir:   ${result.dir}\n` +
        (result.tarPath ? `  tarball: ${result.tarPath}\n` : ''),
    );
  } catch (error) {
    process.stderr.write(`[portable] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// Direct execution (the bin entry runs main); imported modules just export.
if (import.meta.main) {
  void main();
}
