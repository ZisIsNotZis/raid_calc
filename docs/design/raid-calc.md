# RAID Calculator — Design

Status: draft v2 (2026-02-05, agent synthesis from user discussion; fresh-context review integrated — see `.scratch/01-raid-calc/evidence/review-01.md`). Target form: single-file HTML tool, all computation client-side.

## 1. Purpose

Compute the mathematical expectation of data loss vs time for hierarchical storage pools built from statistically-modeled disks. Unlike traditional RAID calculators (flat arrays, closed-form MTTF), this tool composes arbitrary nested pools — pools produce logical disks, logical disks become members of further pools — and models rebuild IO as a real failure hazard. Primary engine: deterministic CTMC numerics (mathematical expectation, no sampling); Monte Carlo only as validation mode.

## 2. Goals / Non-goals

Goals:
- G1 Deterministic expectation curves from a CTMC composed bottom-up; no Monte Carlo noise in the primary engine.
- G2 Arbitrary hierarchy depth: concat / strip / split pools nest freely; each pool yields one logical disk.
- G3 Usage-ratio-aware loss weighting: expected loss weighted by where used bytes actually live (per-strategy placement function).
- G4 Rebuild modeling: computed rebuild time, survivor hazard elevation from rebuild IO, URE hazard on bulk rebuild reads, operator overhead, spare inventory per disk model.
- G5 Two accounting modes: rigorous (any corruption = file lost) and partial (loss fraction = chunks lost beyond parity). Mode 2 scope is user-gated — see D4.
- G6 Monte Carlo cross-check of the solver; scope of that check defined in §3.8.

Non-goals (v1; revisit on demand):
- Sector-level state, latent-error accumulation, scrub scheduling (URE is an instantaneous per-byte read hazard, active during bulk reads — rebuild; normal-read URE negligible).
- Aging / bathtub curves — constant hazard rates (memorylessness is what makes the CTMC exact).
- Operator error (wrong-disk pulls), forensic recovery beyond the strategy's parity semantics.
- IO bandwidth contention between workload and rebuild (no queueing; rebuild bandwidth is its own parameter), deterministic-clock hybrid models (break Markov property).

## 3. Model

### 3.1 Disk (leaf, physical)

Params: capacity `C`; base die rate `λ0` (per unit time); read die rate `λr`, write die rate `λw` (hazard contributed per unit of read/write IO rate; IO rates measured in bytes per unit time); URE rate `u` (probability per byte read that the read returns unrecoverable — disk stays healthy). Total hazard `λ(t) = λ0 + read_rate(t)·λr + write_rate(t)·λw`. Disk states: alive / dead (full-disk sudden death). All waits are mean-matched exponential — the whole system is a CTMC (see 3.5).

### 3.2 Strategies

Each pool takes members (child logical disks) and produces one logical disk. A strategy defines four functions: **placement** (usage → used bytes per member), **IO fan-out** (workload read/write → per-member IO rates), **read-path map** (composed bottom-up: bytes read at each layer per byte consumed at the top), **loss weights** (dead-member set → lost data fraction, per accounting mode).

- **concat** — sequential address space, fill-first placement (FS assumed never to write past the frontier while earlier space is free). Death of a member entirely below the usage frontier: **zero data loss** but not consequence-free — the pool degrades, a spare is consumed (or procurement triggered), and the CTMC tracks it. Death above the frontier: that member's used bytes lost. Used bytes never migrate: loss fractions are always relative to the *initial* used bytes; the frontier does not recompute after deaths. Rebuild of a used member is a 1:1 copy.
- **strip(D, M)** — block-style RAID: total `D+M` members; fixed stripes round-robin across all members, M parity members per stripe (M=0 RAID0, M=1 RAID5, M=2 RAID6). Usage is spread evenly: every member holds an equal share of used bytes, and every populated stripe spans all members — so even at low usage, M=0 loses *everything* on any death. ≤M dead members (M>0): degraded, rebuildable; >M: all stripes broken, full loss. Rebuild reads: all surviving members per reconstructed data-member byte (i.e. `D+M−1` reads per byte for a dead data member; `D` reads to regenerate a dead parity member).
- **split(N, M)** — file-style erasure coding, coarse: each file cut into N data chunks + M parity chunks, each chunk placed **wholly on one distinct member** (deterministic round-robin). A file survives while ≤M of its chunks are lost. Damage is concentrated: whether a file is touched depends on which members died. Small files live inside one chunk → near all-or-nothing per file. Rebuild of a file chunk: read the N other chunks of that file's group.
- **strip-split(N, M)** — file-style erasure coding, fine: each file cut into many small chunks striped round-robin; consecutive groups of (N+M) small chunks (distinct members) form a parity group — N data streams + M parity streams interleaved at small-chunk granularity. Damage is uniform: every member holds ~1/(N+M) of every file. Scope tied to mode 2 — see D4.

Usage rule (applies recursively): for strip / split / strip-split, used bytes are spread **evenly across all members regardless of u** (all members always participate). Only concat has a frontier. Placement maps are deterministic; numeric constants (loss weights, read-path factors per event type) are finalized with worked examples at implementation, but the rule above is fixed — the maps are no longer open design.

### 3.3 Hierarchy rule

Every physical disk belongs to exactly one leaf pool — sharing is forbidden (shared disks would correlate child states). Composition is **exact, not mean-field**: the parent's state is the tuple of its members' lumped child states. For strategies with interchangeable members (strip / split / strip-split with identical member models) the tuple collapses to per-state member counts (compositions — small state space); concat and heterogeneous-member pools keep the ordered tuple (exact, exponential in member count — keep member counts modest, ≤ ~8–10 per pool). Common-cause shocks exist **only at leaf pools** in v1 (physical realism: enclosure, power, batch); a parent-level shock across leaf pools is a future extension requiring the joint space.

### 3.4 Usage & weighting

Usage ratio `u` is constant over time, given at top level, distributed by each strategy's placement: parent distributes `u` across members; each member recursively distributes its own share. Every loss event is weighted by the victim's share of *initial* used bytes. Consequences surfaced in the UI: concat + low usage = most member deaths are free (but still consume spares); strip = every death touches everything.

### 3.5 Failure, replacement, rebuild

On member death (individual or leaf-pool shock):
1. **Degraded exposure** — pool runs with reduced redundancy; further deaths during this window are the dominant loss mechanism.
2. **Operator overhead** — exponential wait, mean `T_op` (notice, decide, source, physically swap).
3. **Swap** — if the dead disk's model has a spare in pool inventory (keyed per disk model): quick swap, mean `T_swap`. If empty (including when a shock demands more spares than stocked): procurement wait, mean `T_proc`, then swap.
4. **Rebuild** — completes at rate `1/T_rebuild(config, state)` (mean-matched exponential; `T_rebuild` itself is **computed**, never input: bytes to reconstruct ÷ rebuild bandwidth, reads only used data via the composed read-path map). Rebuild bandwidth is defined **per member**; parent and child rebuilds proceed independently and concurrently, each consuming their own layer's bandwidth. During rebuild: survivor hazard jumps via their IO terms (`λr` on rebuild reads), and survivor reads carry URE hazard `u`. **URE absorption is a rate correction, not per-stripe tracking**: effective stripe-corruption rate during rebuild = `u × survivor byte-read rate × (1 − a)` where `a` is the per-strategy absorption factor (0 for M=1 — a URE is fatal to that stripe; 1 for M≥2 with a single dead member — the stripe group still has spare parity).

All waits (`T_op`, `T_swap`, `T_proc`, rebuild) are mean-matched exponentials — a declared approximation; real durations are more deterministic, which second-order affects exposure accumulation.

### 3.6 Common-cause shocks

Per **leaf pool**, Poisson shock at rate `λ_cc` kills all members simultaneously (power, firmware, batch defect, enclosure). This dominates the multi-death coincidence terms that parity reliability hinges on; independent per-disk rates alone underestimate it by orders of magnitude.

### 3.7 Loss accounting

- `E[lost fraction](t) = ∫₀ᵗ Σ_s p(s,t')·ρ_loss(s) dt'` where `ρ_loss(s)` is the instantaneous expected-loss-fraction rate in state `s`. Exact by linearity of expectation, monotone by construction, no absorbing states needed. Relative to initial used bytes.
- `P(any loss by t) = 1 − Σ_{s∈safe} p(s,t)` via a **killed CTMC** (loss transitions absorbing, "has-lost" dimension). The naive `1 − exp(−∫rate)` is wrong here — the hazard is self-exciting (jumps after the first death), not Poisson.
- **Mode 1 (rigorous)**: any corruption of any part counts the affected file as lost. File→chunk mapping from *average file size only* is a disclosed approximation (expected lost fraction per corruption event ≈ f(avg file size, span); exact per-file results need a file-size distribution — extension).
- **Mode 2 (partial)**: loss fraction = chunks lost beyond parity, per file-span; average file size sets span granularity. Scope user-gated (D4).

### 3.8 Solver

Bottom-up, exact composition per §3.3. Each node: small CTMC — states: healthy / degraded_k / waiting-for-swap / swapping / rebuilding / dead, plus spare-count dimension at leaf pools; rates state-dependent (rebuild IO hazards, URE rate correction in rebuilding states). Solve via uniformization or ODE integration on the output time grid. The genuinely easy part is the linear algebra; the correctness risk lives in composition and accounting (see §3.3, §3.7).

**Monte Carlo scope**: the MC simulator implements the *same* semantics (same rates, same mean-matched waits, same composed read-path maps and loss weights) via discrete-event simulation — it validates the **solver implementation**, not the model approximations. Model-level approximations (exponential waits, avg-file-size mapping, URE rate correction) are disclosed in place and accepted by construction.

## 4. Interface

Single-file HTML (built by bundling `core/` + `ui/` modules — build step, then fully client-side, offline). Strategy tree edited as a visual tree / serialized JSON (config-driven core). Inputs: disk models, tree structure, workload (usage ratio, avg read rate, avg write rate — bytes per unit time, avg file size), operational params (T_op, T_swap, T_proc, spares per model, rebuild bandwidth per member, λ_cc, time unit). Outputs: charts of E[lost fraction](t) and P(any loss)(t) per top-level pool, mode 1 (+ mode 2 if in scope) side by side, MC toggle.

## 5. Architecture

- `core/` — model types; strategy implementations (the four functions each); CTMC solver; composition; MC simulator; accounting.
- `ui/` — tree editor, parameter forms, charts.
- One pool-solver template, parameterized by a strategy's four functions — strategies never touch the solver.
- Rebuild time and read-path factors are computed bottom-up once per config (used bytes per member + composed read-path map) and cached.

## 6. Parameter summary

| Object | Params |
|---|---|
| Disk model | capacity, λ0, λr, λw, URE rate |
| Leaf pool | strategy, members, D/M or N/M, λ_cc, rebuild bandwidth (per member), T_op, T_swap, T_proc, spares (per member model) |
| Workload (top) | usage ratio, avg read rate, avg write rate (bytes/unit time), avg file size |
| Output | E[lost fraction](t), P(any loss)(t), mode 1 (+2 if in scope), MC toggle |

## 7. Decisions

Resolved:
- Chunk-placement rule: fixed (§3.2) — even spread for strip/split/strip-split, fill-first for concat; numeric constants at implementation.
- URE absorption: rate correction with per-strategy factor (§3.5).
- All waits mean-matched exponential (§3.5); P(any loss) via killed CTMC (§3.7); MC validates the solver, not the model (§3.8).
- Shocks leaf-pool-only in v1 (§3.3); composition exact with symmetry collapse (§3.3).
- λr/λw kept separate (user-specified parameters; workload write modulation matters for SSD wear even though rebuild is read-only).

Open (user-gated):
- D1 **Spare inventory scope** — per-pool-per-model (v1 proposal: keeps child pools independent) vs global-per-model (realistic procurement pooling; couples pools sharing a model — needs joint state or approximation). Recommend per-pool v1, global as extension.
- D4 **Mode 2 (partial loss) and strip-split scope** — reviewer recommendation: defer both to v2 (strip-split's only distinguishing effect is mode-2 span granularity; mode 2 is the largest complexity multiplier and the core promise is fully delivered by mode 1). Counter-consideration: partial-loss accounting is a stated user goal. User decides.
