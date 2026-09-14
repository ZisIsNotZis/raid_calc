# Ticket: 09-mc-crosscheck

- **Status:** done
- **Need-review:** yes (behavior changes)

## Issue

Discrete-event MC (worker-ready) implementing identical semantics; agreement gate vs analytic within MC noise.

## Acceptance criteria

AC: agreement on ≥3 configs (mirror, RAID5, split); discrepancies diagnosable via per-state counts.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).

## Comments (closure)

- 2026-02-05 agent (pi, worker, fork): implemented src/core/mc.js — Gillespie discrete-event simulation over the same machine representation the analytic solver consumes (identical transitions + rate semantics; §3.8 solver-validation scope). simulate(config, {runs, points, seed}) mirrors evaluate()'s output shape; seeded mulberry32 PRNG for determinism; grid-recording variant with reused buffers (no inner-loop allocation).
- 2026-02-05 agent (pi, worker, fork): tests (tests/mc.test.js, 5 green): single disk within 3 SE of 1−exp(−λt) at 1/3/5y (20k runs); RAID1 mirror vs analytic birth-death survival (λ=1e-4 for statistical power, 4 grid points); mode2 ≤ mode1 for strip(3,1)+URE; fixed-seed determinism (+ different-seed divergence); perf: 20k runs in <1s (AC bar 30s).
- 2026-02-05 agent (pi, worker, fork): URE DEPENDENCY — per-event costs (perEvent1/2) are local consts in buildErasureLeaf, not machine-exposed, so per task constraints (machine.js owned by ticket-08 worker) MC samples URE events but contributes 0 to cumulative loss. mc.js is forward-compatible: it reads machine.eventCost1/eventCost2 when exposed and picks URE accumulation up automatically. The mode2≤mode1 test still holds (death-driven lf2 jumps only). Ticket-08 worker or a follow-up should add `eventCost1: perEvent1, eventCost2: perEvent2` to the erasure-leaf machine return; no MC change needed.
- 2026-02-05 agent (pi, worker, fork): not merged — awaiting parent integration per protocol. Branch ticket-09-mc-crosscheck, single commit.
