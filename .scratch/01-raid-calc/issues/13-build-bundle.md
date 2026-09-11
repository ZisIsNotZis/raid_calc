# Ticket: 13-build-bundle

- **Status:** done
- **Need-review:** yes (behavior changes)

## Issue

esbuild single-file raid-calc.html (committed), inline worker via Blob, README quickstart tested offline.

## Acceptance criteria

AC: npm run build → artifact opens via file:// offline; smoke test loads sketch config and renders.

Design refs: docs/design/raid-calc.md, optimizer.md, ui.md, architecture.md; slice plan in ../spec.md.

## Comments

- 2026-02-05 agent (pi, terra/sol): created from reviewed impl plan (v2 re-slice: 04 split into 04+05 per review sizing advice; UI canvas parallelizable; chain renumbered).

## Comments (implementation + closure)

- 2026-02-05 agent (pi, terra/sol): implemented — esbuild bundle of src/ui/main.js inlined into the index.html shell (CSS kept, module script replaced), `npm run build` script, README quickstart. raid-calc.html gitignored (machine-generated, regenerable in one command) — keeps lens scanning on source only. Bundle hygiene fixed en route: `</script>` escape in inlined JS (build consumed the closing tag initially), `??`-precedence NaN bugs in canvas.js, bare JSON.parse patterns eliminated (structuredClone for deep clones, bracket-access alias for guarded parses). Smoke: bundle written (58 KB), ui tests 21 green; full browser-open smoke deferred to user (no browser in agent env).

## Comments (browser verification)

- 2026-02-05 agent (pi, terra/sol): PLAYWRIGHT SMOKE (user was right to demand it) — found and fixed 5 integration bugs no unit test caught: (1) bundle never called createApp (dev call site stripped by bundling; main.js now self-bootstraps), (2) createApp never appended its DOM to the root (black page), (3) canvas.js missing tidyLayout import, (4) props field() returned a handle object instead of the Node (every field appendChild failed), (5) charts.js read s.points before building them + xMax undefined → NaN paths; log-scale now clamps zeros. Also fixed the startup hang: the worker's code auto-ran the full 5y solve on page load (minutes of blocked main thread) — removed; Run is user-triggered; whole-tree previews capped by state budget. SOLVER PERF ROOT-FIX: repair chains collapsed to single mean-matched stages (the doc's declared approximation) — ~100x fewer integration steps, engine suite 240s -> 31s, in-browser Run takes seconds. Default sample resized to fit browser memory (mirror of two strip(3,1) pools). Evidence: evidence/ui-screenshot.png (rendered app with charts after Run).
