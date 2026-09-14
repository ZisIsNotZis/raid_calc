# Ticket: 17-optimizer-ui

- **Status:** claimed
- **Need-review:** yes (behavior changes + docs)

## Issue

Design (ui.md §8 / optimizer.md §5) promises optimizer features the UI never wired:
- "Show curve overlay" of the top-3 plans in the results drawer (the drawer supports overlays; the
  optimizer modal only shows a table + Apply).
- Search honesty labels: candidate cap, per-candidate wall-clock budget, feasible/evaluated/skipped
  counts (optimizer.md §6) — the panel shows a plain table.
- sidebar "pinned configs" is mentioned in ui.md §1 but only per-run pinning in the drawer exists;
  either implement a config-level pin list or remove the claim.

## Acceptance criteria

AC1. Optimizer modal shows feasibility/evaluated/skipped/degraded counts and the active budget/cap.
AC2. A "Show curves" action renders/overlays the top-3 (both metrics) into the results drawer; "Apply"
     still paints the winner to the canvas.
AC3. Docs are made honest: implement config-level pins or strike the sidebar claim.

Design refs: ui.md §8, optimizer.md §5-§6 (dual), drawer in main.js.
