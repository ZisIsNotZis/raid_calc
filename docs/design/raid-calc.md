# RAID Calculator — Design

Status: draft v1 (2026-02-05, agent synthesis from user discussion — user-approved decisions marked). Target form: single-file HTML tool, all computation client-side.

## 1. Purpose

Compute the mathematical expectation of data loss vs time for hierarchical storage pools built from statistically-modeled disks. Unlike traditional RAID calculators (flat arrays, closed-form MTTF), this tool composes arbitrary nested pools — pools produce logical disks, logical disks become members of further pools — and models rebuild IO as a real failure hazard. Primary engine: deterministic CTMC numerics (mathematical expectation, no sampling); Monte Carlo only as validation mode.

## 2. Goals / Non-goals

Goals:
- G1 Deterministic expectation curves from a CTMC solved per node; no Monte Carlo noise in the primary engine.
- G2 Arbitrary hierarchy depth: concat / strip / split / strip-split pools nest freely; each pool yields one logical disk.
- G3 Usage-ratio-aware loss weighting: expected loss weighted by where used bytes actually live (per-strategy placement function).
- G4 Rebuild modeling: computed rebuild time, survivor hazard elevation from rebuild IO, URE hazard on bulk rebuild reads, operator overhead, spare inventory per disk model.
- G5 Two accounting modes: rigorous (any corruption = file lost) and partial (loss fraction = chunks lost beyond parity, file "kind of usable").
- G6 Monte Carlo cross-check toggle; analytic and simulated curves must agree within noise.

Non-goals (v1; revisit on demand):
- Sector-level state, latent-error accumulation, scrub scheduling (URE is an instantaneous per-byte read hazard, active during bulk reads — rebuild; normal-read URE negligible).
- Aging / bathtub curves — constant hazard rates (memorylessness is what makes the CTMC exact).
- Operator error (wrong-disk pulls), forensic recovery beyond the strategy's parity semantics.
- IO bandwidth contention between workload and rebuild (no queueing; rebuild bandwidth is its own parameter).

## 3. Model

### 3.1 Disk (leaf, physical)

Params: capacity `C`; base die rate `λ0` (per unit time); read die rate `λr`, write die rate `λw` (hazard contributed per unit of read/write IO rate); URE rate `u` (probability per byte read that the read returns unrecoverable — disk stays healthy). Total hazard `λ(t) = λ0 + read_rate(t)·λr + write_rate(t)·λw`. Disk states: alive / dead (full-disk sudden death). All times exponential — the whole system is a CTMC.

### 3.2 Strategies

Each pool takes members (child logical disks) and produces one logical disk. A strategy must define four functions: **placement** (usage ratio → used bytes per member), **IO fan-out** (workload read/write → per-member IO rates), **rebuild amplification** (reconstruct 1 byte → bytes read/written per member), **loss weights** (member-death set → lost data fraction, per accounting mode).

- **concat** — sequential address space, fill-first placement (FS assumed never to write past the frontier while earlier space is free). Death of a member entirely below the usage frontier: **zero data loss** but not consequence-free — the pool still degrades, a spare is consumed (or procurement triggered), and the CTMC must track it. Death above the frontier: that member's used bytes lost. Rebuild reads only used members; amplification 1:1 (copy).
- **strip(N, M)** — block-style RAID: fixed stripes round-robin across all members, M parity members per stripe (M=0 RAID0, M=1 RAID5, M=2 RAID6). Any member death with M=0: all data lost (rigorous: everything; partial mode: 1/N of every file). With M>0: ≤M simultaneous dead members = degraded, rebuildable; >M = all stripes broken, full loss. Workload IO fans out to all members (each read touches ~1/N of every member); rebuild reads N·(1 byte per survivor) per reconstructed byte.
- **split(N, M)** — file-style erasure coding, coarse: each file cut into N data chunks + M parity chunks, each chunk placed **wholly on one distinct member**. A file survives while ≤M of its chunks are lost. Damage is concentrated: whether a file is touched depends on which members died. Small files live inside one chunk → near all-or-nothing per file.
- **strip-split(N, M)** — file-style erasure coding, fine: each file cut into many small chunks striped round-robin across members; consecutive groups of (N+M) small chunks (on distinct members) form a parity group — equivalent to N data streams + M parity streams interleaved at small-chunk granularity. Damage is uniform: every member holds ~1/(N+M) of every file; a member death takes exactly one small chunk per parity group. Average file size determines whether a file spans one or many parity groups (span granularity for mode 2).

Precise chunk-placement maps (which member holds which chunk of which file) are deterministic per strategy; finalize at implementation, keep deterministic so loss weights are computable.

### 3.3 Hierarchy rule

Every physical disk belongs to exactly one leaf pool — sharing is forbidden (shared disks would correlate child states and break lumped composition; exponential state blow-up). Cross-pool interaction exists only through shared spare inventory if global scope is chosen (D1).

### 3.4 Usage & weighting

Usage ratio `u` is constant over time, given at top level, distributed by each strategy's placement function: parent distributes `u` across members; each member recursively distributes its own share. Every loss event is weighted by the victim's share of used bytes. Consequence: concat + low usage = most member deaths are free; strip = every death touches everything. This is a first-class modeling effect, surfaced in the UI.

### 3.5 Failure, replacement, rebuild

On member death (individual or common-cause shock):
1. **Degraded exposure** — pool runs with reduced redundancy; further deaths during this window are the dominant loss mechanism.
2. **Operator overhead** — exponential wait, mean `T_op` (notice, decide, source, physically swap) before any swap. Exposure continues.
3. **Swap** — if the dead disk's model has a spare in inventory: quick swap `T_swap`. Inventory is keyed per disk model (models have different params). If empty: procurement wait `T_proc` (order + delivery), then swap.
4. **Rebuild** — `T_rebuild` is **computed**, never input: bytes to reconstruct ÷ rebuild bandwidth, reads only used data, cascades through child layers with per-strategy amplification (reading 1 top-level byte through a split(N,M) layer costs ~N child-byte reads at each level — multiplicative across depth). During rebuild: survivor hazard jumps via their IO terms (`λr` on rebuild reads), and every survivor byte read carries URE hazard `u`; a URE while reconstructing a parity-dependent stripe corrupts that stripe (absorbed if within remaining parity of that stripe's group).

Spare inventory is CTMC state: data-loss-free deaths (concat below frontier) still consume inventory and are tracked.

### 3.6 Common-cause shocks

Per-pool Poisson shock at rate `λ_cc` kills **all members simultaneously** (power, firmware, batch defect, enclosure). This dominates the multi-death coincidence terms that parity reliability hinges on; independent per-disk rates alone underestimate it by orders of magnitude. v1 granularity: per-pool (user confirmed). Reserve per-batch grouping as extension.

### 3.7 Loss accounting

Expectation of lost fraction of used data is **linear in event probabilities**: `E[loss](t) = Σ_classes P(class) × lost_fraction(class)` — no joint distribution over files needed; classes bucketed coarsely (0, 1/N … all). Mode 1 (rigorous): any corruption of any part counts the affected file as lost. Mode 2 (partial): loss fraction = chunks lost beyond parity, per file-span; average file size sets span granularity (how many parity groups a file covers; files smaller than one chunk = all-or-nothing). Derived metrics from the same run: `P(any loss by t) = 1 − exp(−∫ any-loss rate)`, conditional `P(loss next year | survived to now)`.

### 3.8 Solver

Bottom-up composition. Each node solves a small lumped CTMC — states: healthy / degraded_k / waiting-for-swap / swapping / rebuilding / dead, plus spare-count dimension at leaf pools; rates are state-dependent (rebuild IO hazards, URE term in rebuilding states). Child results lump into effective states + effective transition rates for the parent. State counts are O(N+M) per node — tiny matrices; solve via uniformization or ODE integration on the output time grid. Monte Carlo mode: discrete-event simulation, ~100k runs, same strategy tree; agreement with analytic curves within MC noise is a required validation gate.

## 4. Interface

Single-file HTML, client-side only, works offline. Strategy tree edited as a visual tree / serialized JSON (config-driven core). Inputs: disk models, tree structure, workload (usage ratio, avg read rate, avg write rate, avg file size), operational params (T_op, T_swap, T_proc, spares per model, rebuild bandwidth, λ_cc, time unit). Outputs: charts of E[lost fraction](t) and P(any loss)(t) per top-level pool, mode 1 and mode 2 side by side, MC toggle.

## 5. Architecture

- `core/` — model types; strategy implementations (the four functions each); CTMC solver; lumping; MC simulator; accounting.
- `ui/` — tree editor, parameter forms, charts.
- One pool-solver template, parameterized by a strategy's four functions — strategies never touch the solver.
- Rebuild-time computation needs used-bytes per member from placement + amplification from the full subtree — computed bottom-up once per config, cached.

## 6. Parameter summary

| Object | Params |
|---|---|
| Disk model | capacity, λ0, λr, λw, URE rate |
| Pool | strategy, members, N/M (strip, split, strip-split), λ_cc, rebuild bandwidth, T_op, T_swap, T_proc, spares (per member model) |
| Workload (top) | usage ratio, avg read rate, avg write rate, avg file size |
| Output | E[lost fraction](t), P(any loss)(t), mode 1 + mode 2, MC toggle |

## 7. Open decisions

- D1 **Spare inventory scope** — per-pool-per-model (v1 proposal: keeps child pools independent, composition clean) vs global-per-model (realistic procurement pooling; couples pools sharing a model — needs joint state or approximation). Recommend per-pool v1, global as extension.
- D2 **Chunk-placement maps** for split / strip-split — exact deterministic mapping (affects loss weights and amplification constants). Defined in 3.2 as first cut; finalize with worked examples during implementation.
- D3 **URE cost semantics in partial mode** — a URE-corrupted stripe within remaining parity: absorbed silently, or still counts as degraded exposure? Recommend absorbed (parity did its job), consistent with 3.5.
