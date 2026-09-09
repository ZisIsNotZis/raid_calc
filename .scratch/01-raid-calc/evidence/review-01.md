Review of `/home/z/vibe/raid_calc/docs/design/raid-calc.md`. Three passes as requested, then a ranked list.

---

## Pass 1 — OPEN REVIEW

**1.1 The composition story contradicts itself (§3.8 vs §3.6/§3.7).** §3.8 claims "State counts are O(N+M) per node — tiny matrices" and "Child results lump into effective states + effective transition rates for the parent." But loss weights (§3.7: `E[loss] = Σ P(class) × lost_fraction(class)`) are a function of the *joint* state of a pool's members, not of per-member marginals. For concat (§3.2) the loss depends on *which* member died relative to the usage frontier — a lumped `degraded_k` state cannot express it. For split (§3.2), "whether a file is touched depends on which members died" — the doc says this itself, then proposes state lumping by count. Either the parent solves over the product space of child states (size = ∏ per-child counts, exponential in members — not O(N+M)), or it approximates (mean-field over members), in which case the loss-weight math and the MC validation gate are built on different models. The doc never says which. This is the central computational claim and it is currently false as written. Fix: state explicitly that the parent state is the tuple of child lumped states, bound the real state count (it is still small for shallow trees — say so honestly), or define the mean-field approximation and accept its error.

**1.2 Parent-level shocks break the independence that §3.3 establishes.** §3.3: "Every physical disk belongs to exactly one leaf pool — sharing is forbidden (shared disks would correlate child states)." §3.6 then defines a per-pool Poisson shock that "kills all members simultaneously." A shock at a parent pool is precisely a correlated failure of the physical disks living in *different* leaf pools. Consequences not addressed: (a) the shock must consume spares in every child leaf pool at once — cross-layer state coupling the bottom-up composition cannot express; (b) child CTMCs solved independently never see the shock, so any child-level metric (spare inventory trajectory, degraded exposure) is wrong conditioned on the shock. Fix options: shocks only at leaf pools (physical enclosures — arguably the realistic case anyway), or model parent shocks as transitions in the parent's product space that synchronously drive every member to its dead state and decrement every relevant child inventory — which requires the product space from 1.1.

**1.3 No absorbing loss states — E[lost fraction](t) as specified is not cumulative.** §3.8's state list is "healthy / degraded_k / waiting-for-swap / swapping / rebuilding / dead." Data, once lost, does not come back, but nothing in this state machine records that a stripe/file was lost. If loss fraction is computed as `Σ p_s(t)·loss(s)` over these states, the curve measures *instantaneous exposure*, not accumulated loss, and can decrease (a rebuilt pool looks healthy again). E[lost fraction](t) must be monotone. Fix: add an absorbing loss dimension (e.g., a cumulative "lost class" coordinate, or a killed/absorbing copy of the state space per loss class), or reframe the output as instantaneous risk and say so.

**1.4 `P(any loss by t) = 1 − exp(−∫ any-loss rate)` (§3.7) is incorrect as stated.** That closed form holds only when the any-loss process is Poisson with an exogenous rate. Here the hazard is self-exciting: the loss rate jumps after the first disk death (degraded exposure). The correct computation is the survival of a killed CTMC, `P(loss) = 1 − Σ_{s∈safe} p_s(t)` with loss transitions made absorbing — which is cheap and exact. The exponential formula is at best an approximation and only valid if the rate is integrated along the *no-loss-conditioned* trajectory, which the doc doesn't describe. Fix: replace with the killed-process formula.

**1.5 Deterministic rebuild time inside a CTMC is unaddressed.** §3.5: "`T_rebuild` is computed, never input." §3.1: "All times exponential — the whole system is a CTMC." T_op is explicitly "exponential wait," but nothing says whether T_swap, T_proc, and especially the computed T_rebuild enter as exponential rates (mean-matched) or deterministic durations. This matters: the exposure window's distribution materially changes survivor-hazard and URE accumulation, and deterministic durations break the Markov property (needs phase-type/erlang approximation or an explicit deterministic-clock hybrid). State the choice; mean-matched exponential is the defensible v1, and the doc should say the rebuild *rate* is `1/T_rebuild(config, state)`.

**1.6 "Rebuild amplification … multiplicative across depth" (§3.5) is wrong in general.** Amplification factors do not compose multiplicatively when lower layers have usage frontiers, dead members, or copy-only layers (concat is 1:1 on used bytes regardless of what sits above it). The honest formulation: total child-byte reads = Σ over top-level used bytes of the composed read-path map, which is exactly the deterministic chunk-placement map (D2) — which §3.2 defers to implementation. See 1.7.

**1.7 D2 is not an implementation detail; it is a blocking dependency.** §3.2: "Precise chunk-placement maps … finalize at implementation." But loss weights (mode 1 *and* 2), rebuild-read volumes, rebuild time, URE-exposure byte counts, and the strip-vs-strip-split distinction all reduce to this map. Deferring it means the four strategy functions cannot be written. Related unspecified fork with the same status: **usage distribution within a strip pool for u < 1** — is data striped across all N members at fractional usage, or fill-first over a subset? "Rebuild reads only used data" (§3.5) is undefined until this is answered, and the two answers give very different loss weights and rebuild times.

**1.8 Arithmetic error in §3.2 strip rebuild.** "rebuild reads N·(1 byte per survivor) per reconstructed byte" — reconstructing 1 byte in RAID5 reads N−1 survivor bytes, not N; with M parity, N−1 (any N−M surviving data/parity combination suffices... strictly, N−M+… — for the standard single-dead-member case it is N−1 reads for M≥1). As written it overstates rebuild reads by ~1/N and, worse, will be copied into code.

**1.9 Mode 1 needs file→stripe mapping, but only "avg file size" is given.** §3.7 mode 1: "any corruption of any part counts the affected file as lost." Computing E[lost fraction] for a corrupted stripe requires knowing which files span that stripe — a size distribution, not an average. With one corrupted stripe among many, lost fraction per event ranges from ~0 (one small file) to large (one big file). The doc should either specify a file-size distribution per workload or state that mode 1 uses a per-stripe expected-lost-fraction approximation derived from avg file size — and disclose the approximation.

**1.10 Absorbed UREs (§3.5, D3) have no mathematical home.** "A URE … corrupts that stripe (absorbed if within remaining parity of that stripe's group)" — absorption is a *per-stripe* condition. Modeling it exactly means tracking per-stripe URE counts → state explosion. The implementable version is a rate correction: effective stripe-corruption rate during rebuild = u × survivor-read-rate × P(not absorbed), with P(absorbed) a per-strategy constant (0 for M=1, some value for M=2 under 1 dead member). The doc should say this is the intended semantics; otherwise D3 is unanswerable.

**1.11 What does the MC simulate?** §3.8: "agreement with analytic curves within MC noise is a required validation gate." If MC simulates the *true* semantics (exact placement maps, per-stripe URE absorption, deterministic rebuild times) and the analytic engine uses lumping/mean-field/mean-matched-exponential approximations, the gate fails by construction wherever approximations bite — and you can't tell approximation error from bug. The gate needs a definition: either MC simulates the same approximation (then it validates the solver, not the model) or MC is the reference and disagreement is diagnostic information, not a failure.

**1.12 Smaller gaps:** (a) units of λr/λw ("hazard per unit of read/write IO rate") — IO rate in bytes/s or IOPS? Define. (b) Concat: member below frontier dies → capacity shrinks; does the usage ratio u get recomputed (frontier moves) or does the pool hold usage constant? Changes everything downstream. (c) A degraded child (rebuilding leaf pool) seen by its parent: alive or dead for parent purposes? Its capacity and read-path during the child's rebuild? (d) §4 "single-file HTML" vs §5 `core/`, `ui/` directories — presumably build-time modules bundled; say so. (e) Whether multiple spares can be consumed by one shock when inventory < k is implied but worth one sentence.

---

## Pass 2 — EXTRA (cut or defer)

- **Mode 2 (partial accounting), G5/§3.7 — defer to v2.** It is the single largest complexity multiplier: file spans, chunk maps, per-strategy partial semantics, file-size distribution. Its value is "kind of usable" fuzzy numbers; the tool's core promise (expectation curves) is fully delivered by mode 1. Every hour on mode 2 is an hour not spent making mode 1 trustworthy. The strategy interface (§3.2) already reserves a slot for a loss-weights function — keep the interface, return a trivial mode-2 placeholder or drop the mode entirely for v1.
- **strip-split as a separate strategy — defer.** At fine chunk granularity its loss weights and amplification converge to strip's; the *only* thing it changes is mode-2 span granularity (§3.2). With mode 2 deferred, strip-split earns nothing. Ship strip + split + concat.
- **Separate λr and λw — candidate for collapse.** Writes never occur during rebuild; workload write rate only modulates baseline hazard. A single workload-scaled hazard factor per disk model is simpler and covers most of the effect. Keep the split only if the user actually has per-read/per-write die-rate data (unlikely).
- **`P(loss next year | survived)` (§3.7) — keep, it's nearly free** once the killed-process solve exists; just note it requires the conditional (renormalized) distribution.
- **Per-strategy IO fan-out as a strategy function — keep** but note it reduces to a scalar read/write multiplier for all four strategies; don't build machinery for exotic fan-outs.
- **What stays:** the four-function strategy interface, per-pool spare scope (D1 recommendation), config-driven tree, MC toggle. These are the right shape.

---

## Pass 3 — IMPLEMENTATION BURDEN

Ranked by (risk of silent wrongness × difficulty):

| Component | Effort | Risk | Notes |
|---|---|---|---|
| Hierarchy composition / lumping (§3.8) | **High** | **Critical** | Hardest correctness problem in the doc. Product-space vs mean-field decision changes every number. Errors are silent — curves look plausible. Must be resolved on paper before code. |
| Cross-level rebuild cascade (§3.5) | High | High | Parent rebuild writes into a child that is itself dead/rebuilding; sequencing, concurrent rebuilds, who consumes which spare, at which level rebuild reads happen. Nothing in the doc specifies the ordering. |
| Loss accounting with absorbing states (§3.7 + fix for 1.3) | Medium | High | Conceptually simple, easy to get subtly wrong (non-monotone curves, double-counting between levels). Depends on 1.1's state-space decision. |
| Chunk-placement maps D2 + usage distribution for u<1 (§3.2) | Medium | High | Looks like a detail; is a blocking prerequisite for weights, amplification, rebuild time. Must be specified with worked examples *before* strategy code. |
| MC simulator + validation gate | Medium | Medium | The simulator itself is routine; the risk is 1.11 — an ill-defined gate that either always fails or validates nothing. Decide the reference semantics first. |
| URE-in-rebuild semantics (§3.5, D3) | Medium | Medium | Simple as a rate correction, explosive if modeled per-stripe; doc must pick the approximation (1.10). |
| CTMC solver (uniformization / ODE, small matrices) | Low | Low | Well-trodden; trivially correct for tiny dense problems. The *only* genuinely easy part of the engine. |
| Strategies: placement / fan-out / amplification / weights (concat, strip, split) | Medium | Medium | Mechanical once 1.7 and D2 are decided. |
| UI: tree editor, forms, charts | Medium-High (grind) | Low | Most calendar time, least correctness risk. Single-file HTML + charts is commodity work. |

Simple-looking things hiding difficulty: "rebuild bandwidth is its own parameter" — bandwidth per member vs per pool vs shared, and whether it degrades with the number of survivors, is unspecified and shifts all rebuild times; "usage ratio given at top level, distributed by placement" — the recursive distribution rule is one sentence that doesn't exist yet; "spares per member model" per pool with multi-model pools — state dimension multiplies silently.

---

## Top 5 findings for the author

1. **State-space composition is self-contradictory** (1.1 + 1.2): O(N+M) lumped per-node solving cannot produce joint-state loss weights, and parent-level shocks break the child independence the whole bottom-up scheme rests on. Decide product-space vs approximation on paper before any engine code.
2. **No absorbing loss tracking** (1.3): as specified, E[lost fraction](t) is instantaneous exposure, not cumulative loss — the tool's headline output would be the wrong quantity.
3. **D2 chunk-placement maps and the u<1 usage distribution are blocking prerequisites**, not implementation details (1.7) — loss weights, amplification, rebuild time, and mode 2 all reduce to them.
4. **`P(any loss) = 1 − exp(−∫rate)` is wrong** (1.4); replace with the killed-CTMC survival formula — cheap and exact.
5. **Define what the MC simulates before promising the validation gate** (1.11), and fix the strip rebuild arithmetic (N−1, not N, 1.8) plus the exponential-vs-deterministic rebuild-time question (1.5) — all three are small edits that prevent a validator that can't validate.
