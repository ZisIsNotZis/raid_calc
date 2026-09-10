# Ticket: 05-ctmc-solver

- **Status:** done
- **Need-review:** yes (behavior changes)

## Issue

CTMC solver (uniformization/ODE) + bottom-up composition (exact product space, symmetry collapse) + accounting (E[loss] rate integration, killed-CTMC P(any loss)) + minimal no-contention T_rebuild = bytes ÷ member bandwidth (ticket 07 refines).

## Acceptance criteria

AC: closed-form agreement — single disk, RAID1 mirror, RAID5 first-order MTTDL within relative error ≤2%; monotone curves; composition exactness unit test.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).

## Comments (closure)

- 2026-02-05 agent (pi, terra/sol): done, same branch/merge. Closed-form validations pass: single disk exact, RAID1 analytic, RAID5 + staged-repair first-order MTTDL within 2%; composition exactness identity P(parent loss)=P(child)² added (regression-covers the P0); E[loss] monotonicity asserted. Known perf note: fixed-step RK4 with fast swap stages → large state spaces take minutes; optimize (uniformization/adaptive) in ticket 11 worker slice. P(any loss) via killed CTMC per §3.7.
