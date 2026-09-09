# Round-2 design review (fresh context, pi-subagents reviewer, fork=false, thinking high)

Scope: docs/design/{raid-calc,optimizer,ui,architecture}.md, spec.md, issues/04–12, ui-sketch.html.
Verdict: **BLOCK** — F1, F2, F4, F5 model/plan errors that would propagate into implementation.

## Findings (triage: all accepted; dispositions in ticket 03 comments)

- F1 (P1) concat loss direction inverted in §3.2 (below/above swapped); missing frontier-member case → fixed §3.2 (beyond-frontier = free; frontier + inside members lose used bytes).
- F2 (P1) cross-layer rebuild bandwidth undefined/optimistic → fixed §3.5 (per-disk budget, proportional slowdown, nothing dropped).
- F3 (P1) "cluster still small" unguarded + main-thread previews → fixed §3.3 (state-space budget 10⁶, flag unrunnable) + ui.md/architecture (worker previews, debounce).
- F4 (P1) ticket 04 RAID5 closed-form AC depended on 06/07 → 04 split into 04+05; RAID5 test moved to 05, tolerance ≤2% relative MTTDL; minimal T_rebuild in 05.
- F5 (P1) stale D1 contradicting resolved global-spares decision → D1 removed to resolved.
- F6 (P2) schema missing rebuildBw / lambdaCCDefault / schemaVersion / u derivation / inventory rule → fixed architecture §3.
- F7 (P2) dangling D2 → renamed "placement-map worked examples (formerly D2)".
- F8 (P2) sketch row-3 arithmetic (strip(5,0) w/ 6 mirrors) → mirrors = strip(1,1) in space; reference example pinned in optimizer.md §5 + ticket 10 AC.
- F9 (P2) URE absorption factor under-specified → factor table (M−dead ≥ 1; parity-only death = degraded-only; bulk rebuild reads only).
- F10 (P2) "no floats cross config boundary" contradicted schema → reworded (convert once at validation).
- M1 swap-race semantics (config order; serial within pool, concurrent across pools). M2 inventory validation rule → ticket 04 AC. M3 slowdown factor defined (§3.7). M4 chart scales (E log-y, P linear). M5 preview semantics (standalone, workload scaled by usable share; worker, debounced). M6 Run-disabled behavior.
- Sizing: 04 split into 04+05; chain renumbered 04–13; UI canvas (11) parallelizable after 04; optimizer budget-degradation policy added; worker split follows cost.
