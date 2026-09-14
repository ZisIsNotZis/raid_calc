# Contributing

Thanks for your interest. This is a personal project, so changes start with an issue in
`.scratch/01-raid-calc/issues/` describing the problem and the acceptance criteria.

## Workflow

1. Branch per ticket (`ticket-NN-slug`).
2. `npm test` must stay green — the suite includes closed-form MTTDL validations at 2%, composition
   identities, Monte Carlo agreement, and UI logic. If you change numerics, justify the error budget.
3. `npm run build` regenerates the committed single-file artifact `raid-calc.html`; commit it with
   your change so the artifact on the default branch always works straight from disk (`file://`,
   offline).
4. UI behavior changes get a Playwright check in `scripts/ux-smoke.mjs` (real gestures, observable
   DOM + live config — no self-fulfilling assertions).
5. Run `npm run smoke` (requires a local Chromium: Playwright will use `~/.cache/ms-playwright`).
6. Open the PR with the ticket number and the evidence (tests, smoke, screenshots).

## Style

- No build-time framework in `src/`; vanilla ES modules only. The single dependency is esbuild.
- `src/core` stays pure (no DOM). Keep side effects in `src/ui`.
- Units: bytes and hours internally.
