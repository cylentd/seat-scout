# Status

One line per active thread. Update the moment you stop working on something — captured now beats remembered later. Git already answers "what changed and why" (commit messages); this answers "why does it matter" and "what's next", the two things memory drops first.

| Thread | Branch | Status | Next action | Touched |
|---|---|---|---|---|
| _(none active)_ | | | | |

## Test backlog

Mutation score per file (2026-10-06, `mutate.py --files`, 30 mutants per file). Survivors: rerun `python $HOME/.agents/skills/testing/scripts/mutate.py --files <file>`.

| Date | Mutants | Killed |
|---|---|---|
| 2026-10-06 baseline | 338 | 61.8% |
| 2026-10-06 after the testing rollout | 368 | 96.5% |

| File | Before | After | Open |
|---|---|---|---|
| `src/fandango-api.mjs` | (untested) | 77% | The real Chrome fetch's error path and park length; needs Chrome to test. |
| `src/report/view.mjs` | 67% | 93% | 2 survivors judged equivalent (only read when a seat map exists). |
| `src/polite.mjs` | 20% | 97% | Off-peak start == end waits forever today; README does not say what it should mean. David decides. |
| `src/drop-run.mjs` (from `drop-watch.mjs`) | 0% | 97% | Snapshot JSON indent (cosmetic). A first run seeded from an old scan alerts; README says first runs never alert. David decides. |
| `src/app-core.mjs`, `src/discord-core.mjs` | 70%, 72% | 97%, 96% | Equivalent: a length cap after a cut; mode ranks read only by order. |
| `classify`, `scan-core`, `theatres-core`, `signals`, `report/viewmodel`, `format`, `theme`, `landing` | 33-94% | 100% | |

## Closed (last 5)

Move a row here when a thread lands. Trim past 5 — git log is the permanent record, this is a working memory aid, not an archive.
