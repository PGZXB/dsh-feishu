---
name: dsh-version-track
description: Keep dsh-feishu adapted to the newest DeepSeek Harness releases and keep the A/B version labels honest. Diagnoses whether the stable release track (dsh `@latest`) and the `main` track (dsh `@next`) are still compatible, adapts code when a run is red, and refreshes the labels when a run is green. Use when a `canary` or `release-compat` workflow is red, when a new dsh `@next`/`@latest` landed, or when `dsh-version.json` looks stale.
when-to-use: A dsh-family version update landed (a new `@deepseek-ai/*@next` or `@latest`), the Canary or Release-compat CI is red, or the maintainer asks to "adapt to the new dsh version" / "bump the version track".
---

# dsh-version-track

The dsh-feishu repository tracks **two** DeepSeek Harness (dsh) versions and keeps a
single source of truth for them:

```json
// dsh-version.json  (repo root)
{
  "schema": "dsh-feishu-version-track/v1",
  "dsh": { "stable": "0.1.0-rc.7", "next": "0.1.0-rc.8" },
  "dshFeishu": { "npmLatest": "0.2.1" },
  "lastAdapted": { "track": null, "by": null, "at": null }
}
```

- **A = `dsh.stable`** — the dsh `@latest` the stable `release/*` track is verified against. Guarded by the `Release compat (npm latest vs dsh@latest)` workflow.
- **B = `dsh.next`** — the dsh `@next` the `main` branch is verified against. Guarded by the `Canary (main vs dsh@next)` workflow.
- `dshFeishu.npmLatest` — the dsh-feishu version published as npm `@latest` (the live npm badge shows it; keep this field as the last known value).

README.md / README.zh.md carry a "Note" showing A and B. Do not edit that Note by hand — it is generated from `dsh-version.json` (run `node scripts/render-version-note.mjs`), and `pnpm run check` fails if it drifts.

## The one rule that matters

**Compatibility is empirical, not a number.** The two workflows run the suite against
the newest dsh and are the truth. The A/B labels are just a record of the last version
verified green.

- **Red run → adapt the code** (real compatibility break).
- **Green run on a newer dsh → refresh the label** (bump A or B in `dsh-version.json`; no code change).
- Neither adapt code nor refresh a label merely because a number in the JSON is "old": a green run already proves compatibility. Do not chase version numbers.

## Steps

### 1. Read the current state
- Read `dsh-version.json` (current A, B, `npmLatest`).
- Read the latest conclusions of the two workflows (GitHub API, no token needed for public read):
  - `Release compat (npm latest vs dsh@latest)` → the A / stable track.
  - `Canary (main vs dsh@next)` → the B / `main` track.
  - Also read the current npm dist-tags for `@deepseek-ai/dsh`: `dsh@next` and `dsh@latest`
    (via `npm view @deepseek-ai/dsh dist-tags`, or the registry HTTP API).
- Note whether each tracked label (A, B) equals the corresponding current dist-tag.

### 2. Decide the needed work (green/red)
Build a table: per track (stable for A, `main` for B), is the latest run **green** or **red**,
and is the tracked label behind the current dist-tag?

| Track | Run | Label vs dist-tag | Action |
| --- | --- | --- | --- |
| stable (A) | green | behind | refresh A label |
| stable (A) | red | any | adapt the release branch code |
| main (B) | green | behind | refresh B label |
| main (B) | red | any | adapt `main` code |

**Ordering** — when **both** tracks need a real code adaptation, do the **stable (A)
track first**, then `main` (B): npm stable users must never get a package that is
incompatible with dsh `@latest`; `main` is not shipped on npm, so it can trail.

### 3. Adapt a track (code change, red run)
Do this in a worktree (never on `main`; release work never on `main` either) and land it as a PR.

For the **B / `main`** track:
1. `git worktree add -b feat/dsh-adapt-<next> _dev/dsh-feishu-adapt-<next> main`.
2. Lift the dsh family to the new `@next`: `@deepseek-ai/dsh` pinned EXACT to the new
   pre-release, the rest caret, and add any **new peer packages** the fresh CLI requires
   (e.g. `@deepseek-ai/dsh-invariants`, `dsh-scope`, `dsh-timeout`) to dev/peer deps.
3. Refresh the lockfile against the official registry (`pnpm install`, never frozen).
4. Read the **installed** `.d.ts` for the services the plugin uses (`ctx.agents`,
   `sessionPersistence`, `ctx.llm`, `ctx.commands`, …). Getters vs methods and renamed
   services are the usual breakers; a wrong shape typechecks and explodes at runtime.
5. Adjust `src/` seams so the real shape matches. Grep for renamed modes / commands
   (rc line moves, e.g. `commands.execute` gaining a parameter) and update card labels,
   snapshots, tests accordingly.
6. Run the gates exactly as CI does and check every exit code: `pnpm run lint`,
   `pnpm run typecheck`, `pnpm run build`, and `pnpm run test` with
   `FEISHU_INT_REQUIRED=1`.
7. If the run still fails, keep adapting; the `canary` workflow is the oracle. Never relax
   a test to force green.

For the **A / stable** track: cut a `release/*` branch from a commit adapted to the new dsh
`@latest`, apply the same adaptation, bump the version, and open a "ready to release" PR.
The actual `scripts/release.mjs` run (which pushes the branch and the `v*` tag → npm publish)
is a **human-gated** action — do not trigger it; just prepare the branch and PR.

### 4. Refresh a label (green run, no code change)
Update only `dsh-version.json`, e.g. set `dsh.next` to the current dsh `@next` / `dsh.stable`
to the current `@latest`. This is a tiny `chore:` or `docs:` change in a worktree PR.

### 5. Update the source of truth + README (after any adaptation)
- Set `dsh-version.json`'s A/B to the now-verified versions.
- Record provenance in `lastAdapted` (`track`, `by`, `at`).
- Run `node scripts/render-version-note.mjs` to regenerate the README Notes from the JSON.
- Commit the JSON, the README Notes, and any code/test changes **in the same PR** so the
  curated README stays human-reviewed and never drifts from the JSON.

## Limits and safety
- Working tree + PR only; never commit to `main`, never push to `main`.
- **Merge** of the adaptation PR and the **npm publish** (`v*` tag) are human decisions —
  present the PR and stop. Only the diagnosis and the prepared work are yours.
- A green canary / release-compat is proof of compatibility; a PR that merely bumps a
  version is not. Never claim a track is "verified" unless the run is green.
- If a run is red but looks like a **flake** (a one-off that passes on re-run), re-run it
  once before treating it as a real break.

## Reference
- `dsh-version.json` — the A/B + provenance source of truth.
- `scripts/version-track-lib.mjs` — load / validate / README-sync helpers.
- `scripts/render-version-note.mjs` — regenerate README Notes from the JSON.
- `scripts/check-conventions.mjs` → `checkVersionTrack()` — fails when the JSON is missing,
  malformed, or the README Notes drift.
- `.github/workflows/canary.yml`, `release-compat.yml`, `release.yml` — the verifiers and
  the publish gate.
