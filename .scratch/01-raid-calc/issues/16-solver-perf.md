# Ticket: 16-solver-perf

- **Status:** done
- **Need-review:** yes
- **Need-test-cases:** yes

## Issue

README's disclosed top follow-up: the CTMC solver takes minutes for large joint state spaces
(>~100k states) at multi-year horizons, so the auto-optimizer silently skips them (`skippedLarge`,
stateCap default 5000). This is the tool's biggest remaining limitation: big farms are where a
hierarchical calculator earns its keep.

Claim to honor while speeding up: the numerics stay **exact within the documented approximation**
(raid-calc.md §3 — mean-matched exponential waits are the only approximation), so the closed-form
validation tests (engine.test.js: RAID5 hazard ≈ MTTDL within 2%, composition identities, etc.) must
stay green, and P(any loss) / both loss modes must not drift.

## Acceptance criteria

AC1. Profile where the time actually goes (machine construction vs integration vs previews) and
     record it.
AC2. A meaningful speedup (≥3× on the multi-year, ≥10k-state case, measured before/after on the same
     reference configs) with accuracy within the existing test tolerances; the full engine suite
     stays green.
AC3. The optimizer's `stateCap` can rise (better designs reachable) without spending minutes per
     sweep — relax the default from 5000 to a level the new solver sustains at budgetMs = 10 s, and
     surface the cap/budget/skipped count in the optimizer modal UI (honesty labels, optimizer.md §6).
AC4. Evidence: benchmark script under scripts/ (committed), before/after numbers + the configs used,
     under `.scratch/01-raid-calc/evidence/`.

Design refs: raid-calc.md §3.3/§3.5/§3.7, ctmc.js, machine.js, optimizer.js.

## Comments (closure)

- 2026-09-13 agent (pi, deepseek-v4): implemented and merged on master (b504d58).
  16-solver-perf done; lock released by the merge commit.
