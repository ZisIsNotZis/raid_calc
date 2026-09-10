# Ticket: 06-erasure-strategies

- **Status:** claimed
- **Need-review:** yes (behavior changes)

## Issue

split(N,M) and strip-split(N,M) (both in v1 scope — D4 resolved 2026-02-05): placement, IO fan-out, read-path map, loss weights for both accounting modes; worked-example tests finalizing the placement-map constants (formerly D2).

## Acceptance criteria

AC: worked examples pass for both strategies; parity absorption factor per raid-calc.md §3.5; mode-2 span granularity from avg file size (disclosed approximation); mode-1 and mode-2 curves differ where expected (strip vs split damage concentration).

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).
- 2026-02-05 agent (pi, terra/sol): re-scoped per user D4 decision — strip-split + mode 2 now v1 scope; renamed from 06-split-strategy.

## Comments (review + closure)

- 2026-02-05 agent (pi, terra/sol): implemented split/strip-split erasure leaves (generalized builder), mode-2 graded loss weights max(0, dead−M)/(N+M), URE as rate terms (per-event cost avgFile/used × data-prob (N−m)/N, absorption per §3.5, rebuild-occupancy scaling, suppressed in saturated mode-1 states), read-path factor per strategy (strip N−1, split/strip-split n), parent propagation of child lossRate weighted by used share, usableBytes parity-adjusted. Fresh-context review verdict BLOCK → all must-fixes integrated (P0 parent propagation was silently missing — fixed + regression test; P1 perEvent1 factor, P1 rate-terms-in-lost-states, P1 read-volume). 29 tests green incl. exactness identity, URE magnitude parent test, mode-1 ≤ 1 bound, strip-split worked examples.
- 2026-02-05 agent (pi, terra/sol): recorded decisions — (a) λCC shock lands members directly in alive-empty (skips repair chain: deliberate v1 simplification, shock = enclosure loss, spares consumed per ticket 08's inventory model); (b) AC "strip vs split curves differ" reconciled with §3.7 disclosed convergence: under the avg-file span approximation split/strip-split/strip share loss fractions at members == N+M; they differ in rebuild IO granularity (ticket 07) and small-file behavior. Non-finite-rate guard added (shift-left).
