# Auto-optimize — Design

Status: v1 (2026-02-05). Companion to `raid-calc.md` (model) — uses its engine, adds search. UI surface described in `ui.md`.

## 1. Purpose

Given a disk inventory and global workload/operational params, find the best pool design: search the space of buildable configs, evaluate each with the CTMC engine, and present the winner — painted onto the UI canvas as if the user had built it, with runner-ups for context.

## 2. Inputs

- Inventory: disk kinds with counts (same objects as UI disk-model nodes) + global spare counts per kind.
- Constraints: bytes to store `≥ X`; workload (avg read rate, write rate, avg file size); horizon `T`.
- Operational: T_op, T_swap, T_proc, per-kind spares, λ_cc default, contention on/off.
- Objective: dropdown — `E[lost bytes] @ T` (default) or `P(any loss by T)`; **both are computed and displayed for every candidate regardless of which optimizes** (they can rank differently — e.g. all-mirror configs win P(any loss) but lose E[lost bytes]).

## 3. Feasibility gates (applied before CTMC evaluation)

1. **Capacity**: usable bytes of the config ≥ X. Usable = raw capacity minus parity/replication overhead per strategy, times top-layer overhead; concat frontier counted as unusable.
2. **Bandwidth**: workload must be servable — per-disk IO share (workload demand fanned out via each strategy's IO fan-out, composed through the read/write path maps, including amplification) ≤ that disk's read/write bandwidth. The bottleneck disk and its utilization are reported per candidate.
3. **Assignment**: every inventory disk is assigned exactly one role — pool member, hot spare (global per-kind count is part of the search output), or discarded. All three are first-class; leaving disks unassigned is invalid.

Infeasible configs are counted and dropped (count shown in UI as "feasible: N / evaluated: N").

## 4. Search space

- **Templates, not free-form trees**: leaf pools = set partitions of the disk multiset (identical disks → group-size vectors only, large pruning); each leaf gets a strategy + params (concat / strip(D,M) / split(N,M), sensible M/N ranges); then zero or one top layer (strip / split over the leaf pools, or none). Depth ≤ 2 by default, ≤ 3 optional.
- **Enumeration caps**: candidate count cap (e.g. 20k) shown in UI; beyond cap, greedy construction + local swaps (swap a disk between pools, change one strategy param). Deterministic tie-breaking (same objective → lexicographic config order) so results are reproducible. **Budget policy**: per-candidate evaluation ≤ ~5 ms; when the sweep exceeds its wall-clock budget, degrade by shrinking the candidate cap first, then depth — never by skipping feasibility gates.
- **Mirrors are in the search space** as `strip(1,1)` (2 members, 1 data + 1 parity).
- Strip-split is in scope (D4 resolved) — same four-function interface; mode-2 span granularity from avg file size.

## 5. Evaluation & output

- Each feasible candidate: solve its spare-sharing cluster(s) (see raid-calc.md §3.3) → E[lost bytes] @ T, P(any loss) @ T, usable capacity, bottleneck utilization, rebuild-slowdown factor (defined in raid-calc.md §3.7).
- Rank by the chosen objective. Output: **top-3 table** (design summary, both metrics, capacity, bottleneck note) + curve overlay of the three; **Apply → canvas** paints the winner's tree via the same config JSON the editor uses. The optimizer emits configs — it never bypasses the editor.
- **Reference example** (assertion test in ticket 10): 12× HDD 8 TB → 3× strip(3,1) → split(2,1), store 40 TB (the approved-sketch config) must appear as a feasible candidate and rank highly.

## 6. Honesty labels (shown in the optimizer panel)

- The optimizer optimizes *the model*: configs the model considers equivalent tie and are broken lexicographically.
- Performance enters only as streaming-bandwidth feasibility; IOPS/latency are out of scope (v2).
- Procurement cost is not an objective (disks are given).
