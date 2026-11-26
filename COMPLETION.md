# Completion

**Status:** Completed on 2026-11-26.

**Accepted scope:** A single-file, offline calculator for expected data loss and loss probability over time in nested storage pools. This covers configuration, the CTMC solver, plots, and bounded optimization.

**Verification:** Install locked development dependencies with `npm ci`. Run `npm test` (111 tests, including closed-form and composition controls), `npm run build` (identical checked-in HTML), and `npm run smoke` with the locked Playwright Chromium installed (53 browser checks against the built file).

**Source verified:** `4ae87a1d20e84b95e6b38b087a4a748f8e28817b`. This completion change adds documentation only.

**Limits:** Results are conditional on input hazards and solver bounds. The file is a planning model and offers no operational data durability guarantees.
