---
name: dsh-version-track
description: Keep dsh-feishu adapted to the dsh version users install from the npm `@latest` tag, and keep that single version label honest. Diagnoses whether `main` is still compatible with dsh `@latest`, adapts the code when a run is red, and refreshes the label when a run is green. Use when the Canary (main vs dsh@latest) or Release-compat workflow is red, when dsh `@latest` moved, or when `dsh-version.json` looks stale.
when-to-use: A new dsh `@latest` landed, the Canary or Release-compat CI is red, or the maintainer asks to "adapt to the new dsh version" / "bump the version track".
---

# dsh-version-track

dsh-feishu tracks **one** DeepSeek Harness (dsh) version, recorded in a single
source of truth:

```json
// dsh-version.json  (repo root)
{
  "schema": "dsh-feishu-version-track/v2",
  "dsh": { "latest": "0.1.5-rc.1" },
  "dshFeishu": { "npmLatest": "0.3.2" },
  "lastAdapted": { "by": "…", "at": "…" }
}
```

- **`dsh.latest`** — the dsh `@latest` CLI version **both** `main` (installed from
  git) and the npm `@latest` release are adapted to. Guarded by the
  `Canary (main vs dsh@latest)` workflow.
- `dshFeishu.npmLatest` — the dsh-feishu version published as npm `@latest`
  (the live npm badge shows it; keep this field as the last known value).

Every other dsh dist-tag — the pre-release and alpha lines — is **ignored on
purpose**. Only the version a user gets from the npm `@latest` tag is a
compatibility promise. An earlier design also tracked a pre-release line for
`main`; whenever that line ran ahead of `@latest` it meant adapting the same
code twice (adapt for `@latest`, release it, then adapt again for the
pre-release) while telling users two different stories. Do not re-introduce a
second label.

Note that only the dsh **CLI** carries a meaningful npm `latest` tag: the
family's sub-packages publish only pre-release tags, and their own `latest`
still points at ancient `0.0.1-rc.x` lines. "dsh `@latest`" therefore means the CLI
version from `npm view @deepseek-ai/dsh@latest version`, with the sub-packages
resolved by the carets that CLI declares — exactly what a user's
`npm i @deepseek-ai/dsh@latest` resolves to.

README.md / README.zh.md carry a "Note" naming that version. Do not edit the
Note by hand — it is generated from `dsh-version.json` (run
`node scripts/render-version-note.mjs`), and `pnpm run check` fails if it
drifts (it also fails if the CLI pin or a harness peer range stops matching the
label).

## The one rule that matters

**Compatibility is empirical, not a number.** The Canary workflow runs the
suite against the npm `@latest` CLI and is the truth. The label is just a
record of the last version verified green.

- **Red run → adapt the code** (real compatibility break).
- **Green run on a newer dsh `@latest` → refresh the label** (bump
  `dsh.latest` in `dsh-version.json`; no code change).
- Never adapt code or refresh the label merely because the JSON looks "old" —
  a green run already proves compatibility. Do not chase version numbers, and
  never chase a pre-release dist-tag.

## Steps

### 1. Read the current state
- Read `dsh-version.json` (current `dsh.latest`, `npmLatest`).
- Read the latest conclusions of the two workflows (GitHub API; public read):
  - `Canary (main vs dsh@latest)` → is `main` compatible with the current
    `@latest`?
  - `Release compat (npm latest vs dsh@latest)` → does the published artifact
    still install/boot beside it?
- Read the current npm dist-tag: `npm view @deepseek-ai/dsh@latest version`.
- Note whether `dsh.latest` equals that dist-tag.

### 2. Decide the needed work (green/red)

| Canary (main vs @latest) | Label vs dist-tag | Action |
| --- | --- | --- |
| green | behind | refresh the label (`dsh.latest`) |
| red | any | adapt the code |

A red **Release-compat** with a green Canary means the npm release is simply
older than `main` — that resolves with the next release, not with a code change.

### 3. Adapt (code change, red run)
Do this in a worktree (never on `main`) and land it as a PR. A release can carry
the adaptation and the version bump together: prepare it on a `release/vX.Y.Z`
branch so the release PR is the thing the maintainer reviews (see
docs/development.md → "Releasing").

1. `git worktree add -b feat/dsh-adapt-<latest> _dev/dsh-feishu-adapt-<latest> main`.
2. Bump the family to the new `@latest`: `@deepseek-ai/dsh` pinned EXACT to it,
   the rest caret `^<version>`, and add any **new peer packages** the fresh CLI
   requires (e.g. `@deepseek-ai/dsh-invariants`, `dsh-scope`, `dsh-timeout`) to
   dev/peer deps.
3. Refresh the lockfile against the official registry (`pnpm install`, never
   frozen), then `pnpm dedupe` and confirm every `@deepseek-ai/*` package
   resolves to ONE version (`pnpm run check` enforces it).
4. Read the **installed** `.d.ts` for the services **and the events** the plugin
   consumes (`ctx.agents`, `sessionQuery`, `ctx.llm`, `ctx.commands`,
   `session/event`, `agent/assistant-stream`, …). Getters vs methods, renamed
   services, and moved event channels are the usual breakers; a wrong shape
   typechecks and explodes (or silently renders nothing) at runtime — see
   `docs/pitfalls.md`.
5. Adjust `src/` seams so the real shape matches, and update card labels,
   snapshots, and tests for renamed modes/commands.
6. Run the gates exactly as CI does and check every exit code:
   `node scripts/run-gates.mjs` (lint, typecheck, build, and the test gate with
   `FEISHU_INT_REQUIRED=1`).
7. If a run still fails, keep adapting; the Canary workflow is the oracle.
   Never relax a test to force green.
8. The publish itself is **human-gated**: present the release PR and stop. Only
   after the maintainer merges it is `node scripts/release.mjs tag` run on
   merged `main` to cut the `v*` tag → npm publish.

### 4. Refresh the label (green run, no code change)
Update only `dsh-version.json` (`dsh.latest` = the current
`npm view @deepseek-ai/dsh@latest version`), run
`node scripts/render-version-note.mjs` for the README Note, and land it as a
tiny `chore:` / `docs:` worktree PR.

### 5. Record provenance
`lastAdapted` records who adapted what and when (`by`, `at`) — update it in the
same PR as the adaptation (label refreshes may leave it alone).

## Limits and safety
- Working tree + PR only; never commit to `main`, never push to `main`.
- **Merge** of the adaptation/release PR and the **npm publish** (`v*` tag) are
  human decisions — present the PR and stop.
- A green Canary is proof of compatibility; a PR that merely bumps a version is
  not. Never claim compatibility unless the run is green.
- If a run looks like a **flake** (fails once, passes on re-run), re-run it once
  before treating it as a real break.
- Ignore the pre-release dist-tags: a newer one is NOT a reason to change
  anything here.

## Reference
- `dsh-version.json` — the single tracked version + provenance.
- `scripts/version-track-lib.mjs` — load / validate / README-sync helpers.
- `scripts/render-version-note.mjs` — regenerate the README Note from the JSON.
- `scripts/check-conventions.mjs` → `checkVersionTrack()` — fails when the JSON
  is missing/malformed, the README Note drifts, or the CLI pin / harness peer
  ranges stop matching the tracked version.
- `.github/workflows/canary.yml` (main vs `@latest`), `release-compat.yml`
  (published artifact vs `@latest`), `release.yml` (publish gate).
