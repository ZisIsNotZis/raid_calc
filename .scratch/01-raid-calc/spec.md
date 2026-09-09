# Spec: raid calculator

Single-file HTML tool computing mathematical expectation of data loss vs time for hierarchical storage pools. Full design: `docs/design/raid-calc.md`.

Slices (tracer-bullet order):
1. Design doc + review (this ticket dir, issue 01).
2. Core model: disk + strategies as data, placement/IO-fanout/amplification/loss-weight functions.
3. CTMC solver + bottom-up composition + accounting (modes 1 & 2).
4. MC cross-check.
5. HTML UI: tree editor, params, charts.
