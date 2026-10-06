# TODO

**Archived since 2026-10-06.** David will reopen it later. Start here when he does.

## Decisions for David

Both behaviours are pinned by tests as they are today. Once David decides, change the test first, then the code.

1. **Off-peak window with start hour == end hour.** Today `src/polite.mjs` waits forever: no hour is ever inside the window. Should it mean "always open", or be refused as a config error? README "Politeness budget" does not say. Test: `tests/polite.test.mjs`, off-peak cases.
2. **First drop-watch run seeded from an old scan.** README "Drop watch" says first runs record a baseline and never alert. But when `data/scans/<target>.json` exists, `src/drop-run.mjs` uses that scan as the baseline and can alert on the very first watcher run. Keep the alert (a scan is a real baseline), or stay silent on every first watcher run? Test: `tests/drop-watch.test.mjs`, marked "pinned from code; README ambiguous".

## Test gaps

- `src/fandango-api.mjs` scores 77%: the real Chrome fetch's error path and the park length need Chrome to test. Details in `docs/projects/STATUS.md` "Test backlog".
