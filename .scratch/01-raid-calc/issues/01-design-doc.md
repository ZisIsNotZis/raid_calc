# Ticket: design doc for raid calculator

- **Status:** done
- **Need-review:** satisfied (independent fresh-context review done, findings triaged + integrated)

## Issue

Translate the discussed design (hierarchical pools, CTMC expectation engine, rebuild modeling, two loss modes) into `docs/design/raid-calc.md`.

## Acceptance criteria

- [x] All user-confirmed decisions recorded (strategies, sudden-death disks, computed rebuild time, operator overhead, per-model spares, per-pool common-cause shock, two accounting modes)
- [x] Goals / non-goals explicit
- [x] Open decisions listed with recommendations
- [x] Independent fresh-context review done; findings triaged (extra / missing / implementation burden)
- [x] Doc updated to v2 integrating verified findings; user-gated items surfaced (D1 spare scope, D4 mode-2 scope)

## Comments

- 2026-02-05 agent (pi, terra/sol): doc authored per user go-signal; scaffolding created (README, .gitignore, AGENTS.md/CLAUDE.md symlinks). Fresh-context reviewer launched.
- 2026-02-05 agent (pi, terra/sol): review done (evidence/review-01.md, independent pi session, high thinking). 12 open-review findings — accepted: composition is exact product-space w/ symmetry collapse (was self-contradictory), shocks leaf-only (parent shock broke independence), E[loss] via rate integration + P(any loss) via killed CTMC (exp formula wrong; absorbing-loss gap), mean-matched exponential waits declared, read-path map replaces scalar amplification, strip rebuild = all survivors, URE absorption as rate factor, avg-file-size approximation disclosed, MC validates solver not model, small gaps (units, frontier non-migration, child visibility, bundling, spare shortage). Rejected: collapse λr/λw (user-specified params). User-gated: D4 defer mode-2 + strip-split (reviewer recommends; user decides). Doc rewritten to v2.
