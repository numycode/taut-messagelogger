# Provenance and license

Modified Slick MessageLogger personal plugin port, 2026-10-10. GPL-3.0-only; no warranty.

- Slick: https://github.com/3kh0/slick at `735073448b79f0d15e8ba3919bb6c0039673baf7`.
  Original contributors retain their rights. Complete unchanged reference inputs are under `provenance/slick/`.
  Port retains decode, deletion reconstruction, inline `<s>old text</s> (edited)` rendering, file-slot previews, menu rows, settings semantics and thread fallback.
- Taut: https://github.com/jeremy46231/taut at `b77b13e791d3ea904175ba6528b591831352e3e8`.
  Jeremy Woolley and contributors. `scripts/plugin.ts` and `scripts/userPlugin.ts` copy its compiler with local import-path/header adjustments and formatting.
- Changes: Taut class/config/API, workspace-scoped locked stores, merged batched persistence, batched repaint and image writes, cancellation, tighter payload and network handling, focused offline tests and benchmarks.

The single runtime source is `src/MessageLogger.ts`. Its generated build plus the full source, compiler scripts, lockfile and this license provide corresponding source. No Taut core changes are required. No PR18 dependency or remote writes.
