# seat-scout: agent notes

Finds showtimes with good adjacent seats on Fandango and publishes counts-only signals to a static site. `README.md` has the scan modes, the politeness budget, the drop watcher and the public site; `docs/projects/STATUS.md` has what is active.

## Fandango: one honest session, never a probe

- Never run a scan, `drop-watch`, the bot or any `/napi/` call from an agent. Fandango's robots.txt disallows `/napi/*`; the tool stays inside the lines only by being one human-paced session (README "Politeness budget"). A test that needs Fandango's answer reads a hand-built payload.
- `data/`, `watchlist.json` and `public/signals.json` are live state, not fixtures. Never edit them from a test or a branch.

## Preview

The shared server serves the site: `http://localhost:8000/seat-scout/` (main checkout's `public/`), and a worktree at `http://localhost:8000/seat-scout-wt/<worktree>/public/`. Never start a server of your own. `signals.json` is gitignored, so a fresh worktree shows the site's error state until `npm run signals` has run there.

## Git

Default branch is `main`. Worktree per feature from `origin/main`; finish with `git land`. Code lands only on David's "land it".

## Testing

TDD is the default; standards live in the `testing` skill.

| Do | Run |
|---|---|
| One test | `node --test --test-name-pattern="pairs: runs yield" tests/classify.test.mjs` |
| One file | `node --test tests/classify.test.mjs` |
| While working | `npm test` |
| Full suite | `npm test` |
| Before land | `python $HOME/.agents/skills/testing/scripts/land_gate.py` |
| Mutation score | `python $HOME/.agents/skills/testing/scripts/mutate.py` |

- **Layers:** pure cores as unit tests (`classify`, `scan-core`, `app-core`, `discord-core`, `theatres-core`, `report/*`); the report as rendered-HTML regression tests (`view.test.mjs`); one smoke test over a real `data/scan-latest.json`, skipped when the file is absent. No layer touches Chrome or Fandango.
- **Oracle:** README.md states the rules (pairs are non-overlapping, doable times rank first, tiered freshness, run extension vs returned seats). Expected values come from it or are worked out by hand, never from running the code.
- **Exemplars:** `classify.test.mjs` (each tier boundary worked by hand from `cx = (n-1)/20`); `drop-core.test.mjs` (one behaviour per test, named for the rule); `viewmodel.test.mjs` (the hand-described `makeScan()` house, numbers checked against its comment).
- **Building blocks:** `tests/helpers.mjs` (`cfg` with the real tier geometry, `makeRow`, `auditorium`, `makeShow`, `makeScan`).
- **Mutation survivors** go to `docs/projects/STATUS.md` "Test backlog".
