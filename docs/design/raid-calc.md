# RAID Calculator — Design

Status: draft v3 (2026-02-05, agent synthesis from user discussion; two fresh-context review rounds integrated — see `.scratch/01-raid-calc/evidence/`). Sibling docs: optimizer.md (auto-optimize), ui.md (interface), architecture.md (build/modules). Target form: single-file HTML tool, all computation client-side.

## 1. Purpose

Compute the mathematical expectation of data loss vs time for hierarchical storage pools built from statistically-modeled disks. Unlike traditional RAID calculators (flat arrays, closed-form MTTF), this tool composes arbitrary nested pools — pools produce logical disks, logical disks become members of further pools — and models rebuild IO as a real failure hazard. Primary engine: deterministic CTMC numerics (mathematical expectation, no sampling); Monte Carlo only as validation mode.

## 2. Goals / Non-goals

Goals:

- G1 Deterministic expectation curves from a CTMC composed bottom-up; no Monte Carlo noise in the primary engine.
- G2 Arbitrary hierarchy depth: concat / strip / split pools nest freely; each pool yields one logical disk.
- G3 Usage-ratio-aware loss weighting: expected loss weighted by where used bytes actually live (per-strategy placement function).
- G4 Rebuild modeling: computed rebuild time, survivor hazard elevation from rebuild IO, URE hazard on bulk rebuild reads, operator overhead, spare inventory per disk model.
- G5 Two accounting modes, both in v1 scope (D4 resolved): rigorous (any corruption = file lost) and partial (loss fraction = chunks lost beyond parity).
- G6 Monte Carlo cross-check of the solver; scope of that check defined in §3.8.

Non-goals (v1; revisit on demand):

- Sector-level state, latent-error accumulation, scrub scheduling (URE is an instantaneous per-byte read hazard, active during bulk reads — rebuild; normal-read URE negligible).
- Aging / bathtub curves — constant hazard rates (memorylessness is what makes the CTMC exact).
- Operator error (wrong-disk pulls), forensic recovery beyond the strategy's parity semantics.
- IO bandwidth contention between workload and rebuild (no queueing; rebuild bandwidth is its own parameter), deterministic-clock hybrid models (break Markov property).

## 3. Model

### 3.1 Disk (leaf, physical)

Params: capacity `C`; base die rate `λ0` (per unit time); read die rate `λr`, write die rate `λw` (hazard contributed per unit of read/write IO rate; IO rates measured in bytes per unit time); URE rate `u` (probability per byte read that the read returns unrecoverable — disk stays healthy); read bandwidth, write bandwidth (bytes/s — used by workload feasibility and rebuild contention, see 3.5). IOPS/latency modeling deferred to v2 (random small IO needs queueing). Total hazard `λ(t) = λ0 + read_rate(t)·λr + write_rate(t)·λw`. Disk states: alive / dead (full-disk sudden death). All waits are mean-matched exponential — the whole system is a CTMC (see 3.5).

### 3.2 Strategies

Each pool takes members (child logical disks) and produces one logical disk. A strategy defines four functions: **placement** (usage → used bytes per member), **IO fan-out** (workload read/write → per-member IO rates), **read-path map** (composed bottom-up: bytes read at each layer per byte consumed at the top), **loss weights** (dead-member set → lost data fraction, per accounting mode).

- **concat** — sequential address space, fill-first placement (FS assumed never to write past the frontier while earlier space is free). Loss depends on member position relative to the frontier: members entirely **beyond** the frontier are empty — death costs **zero data loss** but is not consequence-free (pool degrades, a spare is consumed / procurement triggered, CTMC tracks it); the **frontier member** (partially filled) and members entirely **within** the used region hold data — death loses their used bytes. Used bytes never migrate: loss fractions are always relative to the *initial* used bytes; the frontier does not recompute after deaths. Rebuild of a used member is a 1:1 copy.
- **strip(D, M)** — block-style RAID: total `D+M` members; fixed stripes round-robin across all members, M parity members per stripe (M=0 RAID0, M=1 RAID5, M=2 RAID6). Usage is spread evenly: every member holds an equal share of used bytes, and every populated stripe spans all members — so even at low usage, M=0 loses *everything* on any death. ≤M dead members (M>0): degraded, rebuildable; >M: all stripes broken, full loss. Rebuild reads: all surviving members per reconstructed data-member byte (i.e. `D+M−1` reads per byte for a dead data member; `D` reads to regenerate a dead parity member).
- **split(N, M)** — file-style erasure coding, coarse: each file cut into N data chunks + M parity chunks, each chunk placed **wholly on one distinct member** (deterministic round-robin). A file survives while ≤M of its chunks are lost. Damage is concentrated: whether a file is touched depends on which members died. Small files live inside one chunk → near all-or-nothing per file. Rebuild of a file chunk: read the N other chunks of that file's group.
- **strip-split(N, M)** — file-style erasure coding, fine: each file cut into many small chunks striped round-robin; consecutive groups of (N+M) small chunks (distinct members) form a parity group — N data streams + M parity streams interleaved at small-chunk granularity. Damage is uniform: every member holds ~1/(N+M) of every file; a member death takes exactly one small chunk per parity group; average file size determines whether a file spans one or many parity groups (mode-2 span granularity). In v1 scope (D4 resolved).

Usage rule (applies recursively): for strip / split / strip-split, used bytes are spread **evenly across all members regardless of u** (all members always participate). Only concat has a frontier. Placement maps are deterministic; numeric constants (loss weights, read-path factors per event type) are finalized with worked examples at implementation, but the rule above is fixed — the maps are no longer open design.

### 3.3 Hierarchy rule

Every physical disk belongs to exactly one leaf pool — sharing is forbidden (shared disks would correlate child states). Composition is **exact, not mean-field**: the parent's state is the tuple of its members' lumped child states. For strategies with interchangeable members (strip / split / strip-split with identical member models) the tuple collapses to per-state member counts (compositions — small state space); concat and heterogeneous-member pools keep the ordered tuple (exact, exponential in member count — keep member counts modest, ≤ ~8–10 per pool). Common-cause shocks exist **only at leaf pools** in v1 (physical realism: enclosure, power, batch); a parent-level shock across leaf pools is a future extension requiring the joint space.

**Spare-sharing clusters**: disk-kind spare inventory is a global, user-configured count per kind (hot spares are automatic — pools never configure their own; surplus disks are simply discarded). Pools that use the same disk kind therefore share inventory and are **solved jointly as one cluster** (product space of their member-state tuples plus the shared spare-count dimension — still small); pools with disjoint disk kinds compose independently. A **state-space budget** guards this: each cluster's estimated state count is computed at config validation; above the budget (v1: 10⁶ states) the config is flagged unrunnable with an explanatory note instead of being solved — "keep pools modest" is advice, the budget is the mechanism.

### 3.4 Usage & weighting

Usage ratio `u` is constant over time, given at top level, distributed by each strategy's placement: parent distributes `u` across members; each member recursively distributes its own share. Every loss event is weighted by the victim's share of *initial* used bytes. Consequences surfaced in the UI: concat + low usage = most member deaths are free (but still consume spares); strip = every death touches everything.

### 3.5 Failure, replacement, rebuild

On member death (individual or leaf-pool shock):

1. **Degraded exposure** — pool runs with reduced redundancy; further deaths during this window are the dominant loss mechanism.
2. **Operator overhead** — exponential wait, mean `T_op` (notice, decide, source, physically swap).
3. **Swap** — if the dead disk's kind has a spare in the **global per-kind inventory** (hot spares are automatic): quick swap, mean `T_swap`. If empty (including when a shock demands more spares than stocked): procurement wait, mean `T_proc`, then swap. Spare-allocation races (two pools waiting, one spare frees) resolve by **fixed config order** — deterministic, a documented v1 limitation. Multiple dead members in one pool swap **serially** (one installer, `T_swap` each); different pools swap concurrently.
4. **Rebuild** — completes at rate `1/T_rebuild(config, state)` (mean-matched exponential; `T_rebuild` itself is **computed**, never input: bytes to reconstruct ÷ effective rebuild bandwidth, reads only used data via the composed read-path map). **Contention model** (no queueing): effective rebuild bandwidth per surviving member = member bandwidth − per-disk workload IO share during rebuild (from the strategy fan-out); a concat rebuild is pair-limited (source read + spare write). Toggle: contention on/off (off = a dedicated rebuild-bandwidth parameter). **Cross-level rule: every physical disk has one bandwidth budget**, divided proportionally among all concurrent demands on it (workload share + leaf rebuild + parent-rebuild read-path traffic traversing it); demands exceeding a disk's bandwidth slow each other proportionally — nothing is dropped or implicitly serialized. Parent and child rebuilds proceed concurrently under that budget. During rebuild: survivor hazard jumps via their IO terms (`λr` on rebuild reads), and survivor reads carry URE hazard `u`. **URE absorption is a rate correction, not per-stripe tracking**: effective stripe-corruption rate during rebuild = `u × survivor byte-read rate × (1 − a)`. The factor `a(strategy, M, deadCount, phase)`: `a = 1` while the affected stripe group retains ≥1 spare parity (`M − dead ≥ 1`), else `0`; a URE corrupting **regenerated parity** (parity member dead, no data member dead) is degraded-only, not data loss; URE hazard is active on **bulk rebuild reads only** (degraded-operation read volume is negligible in v1).

All waits (`T_op`, `T_swap`, `T_proc`, rebuild) are mean-matched exponentials — a declared approximation; real durations are more deterministic, which second-order affects exposure accumulation.

### 3.6 Common-cause shocks

Per **leaf pool**, Poisson shock at rate `λ_cc` kills all members simultaneously (power, firmware, batch defect, enclosure). This dominates the multi-death coincidence terms that parity reliability hinges on; independent per-disk rates alone underestimate it by orders of magnitude.

### 3.7 Loss accounting

- `E[lost fraction](t) = ∫₀ᵗ Σ_s p(s,t')·ρ_loss(s) dt'` where `ρ_loss(s)` is the instantaneous expected-loss-fraction rate in state `s`. Exact by linearity of expectation, monotone by construction, no absorbing states needed. Relative to initial used bytes.
- `P(any loss by t) = 1 − Σ_{s∈safe} p(s,t)` via a **killed CTMC** (loss transitions absorbing, "has-lost" dimension). The naive `1 − exp(−∫rate)` is wrong here — the hazard is self-exciting (jumps after the first death), not Poisson.
- **Mode 1 (rigorous)**: any corruption of any part counts the affected file as lost. File→chunk mapping from *average file size only* is a disclosed approximation (expected lost fraction per corruption event ≈ f(avg file size, span); exact per-file results need a file-size distribution — extension).
- **Rebuild slowdown factor** = `T_rebuild` under workload contention ÷ `T_rebuild` on an idle pool (full member bandwidth). One definition, displayed in UI previews and optimizer results.
- **Mode 2 (partial)**: loss fraction = chunks lost beyond parity, per file-span; average file size sets span granularity (how many parity groups a file covers; files smaller than one chunk = all-or-nothing). In v1 scope (D4 resolved); accounting via per-strategy mode-2 loss weights on the same events as mode 1.

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
| --- | --- |
| Disk model | capacity, λ0, λr, λw, URE rate, read bw, write bw |
| Leaf pool | strategy, members, D/M or N/M, λ_cc |
| Global | spares (per disk kind), T_op, T_swap, T_proc, time unit |
| Workload (top) | usage ratio, avg read rate, avg write rate (bytes/unit time), avg file size |
| Output | E[lost fraction](t), P(any loss)(t), mode 1 (+2 if in scope), MC toggle |

## 7. Decisions

Resolved:

- Chunk-placement rule: fixed (§3.2) — even spread for strip/split/strip-split, fill-first for concat; numeric constants at implementation.
- URE absorption: rate correction with per-strategy factor (§3.5).
- All waits mean-matched exponential (§3.5); P(any loss) via killed CTMC (§3.7); MC validates the solver, not the model (§3.8).
- Shocks leaf-pool-only in v1 (§3.3); composition exact with symmetry collapse (§3.3).
- λr/λw kept separate (user-specified parameters; workload write modulation matters for SSD wear even though rebuild is read-only).
- **Spares: global per-kind count, automatic, surplus disks discarded** (user decision). Pools sharing a disk kind are solved as one joint spare-sharing cluster (§3.3).
- **Contention: leftover-bandwidth model** — effective rebuild bandwidth = member bandwidth − workload IO share; contention on/off toggle (§3.5). Per-disk read/write bandwidth added to disk params; IOPS deferred (§3.1).
- **Placement-map worked examples** (formerly D2): numeric constants finalized at implementation — tested in tickets 04/06.
- **Rebuild slowdown factor**: one definition (§3.7).
- **Usage ratio is derived, not input**: the config stores `storeTB` (SSOT); `u = storeTB ÷ usable`, displayed.

Open (user-gated): none. Resolved 2026-02-05 (user): D4 — mode 2 (partial loss) and strip-split are **in v1 scope** (reviewer had recommended deferral; user decided to keep the stated goal).
