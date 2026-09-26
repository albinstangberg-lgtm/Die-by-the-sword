# Claude working notes

## Checks

- `npm run typecheck`: fast (~3 s). Run it yourself after every change.
- `npm run smoke`: headless physics harness (`tools/smoke.ts`), ~3.5 min.
  **Don't run it inline.** Hand it to the `smoke-tester` subagent (below).
  It's seeded (`tools/dice.ts`): the same code gives the same result on every
  run, so running it again won't turn a FAIL into a PASS.
  `SMOKE_SEED=<n> npm run smoke` repeats a run from the seed its log prints,
  or rolls other dice.

## Smoke tests run in the background

When a request has several tasks ("add X, make Y, fix Z..."), don't wait on
the smoke suite between them:

1. Finish one task and get `npm run typecheck` clean.
2. Launch the `smoke-tester` agent **in the background**
   (`subagent_type: "smoke-tester"`, `run_in_background: true`). Say which
   task it's checking and which files that task touched. The agent tests a
   frozen snapshot, so you can keep editing right away.
3. Start the next task straight away.
4. When a smoke report arrives, fix any FAIL it attributes to your work
   before you start another task. Then launch a new smoke run.
5. Run only one smoke-tester at a time. If one is still running when you
   finish the next task, don't start another. Launch a single run once it
   reports, and that run covers everything done since.
6. Before you commit or push, the latest smoke report must be **PASS** and
   must have run on a snapshot that includes every change you're pushing.
   If code changed after the last report, launch one final run and wait for it.
