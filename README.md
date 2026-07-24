# Future Floor Plans

An offline-first, iPad-first floor-plan editor for Domestic Energy Assessors and Retrofit Assessors. It captures assessor-verifiable RdSAP input data from geometry; it does not calculate an EPC rating, perform a SAP/RdSAP assessment, lodge an EPC, or calculate U-values.

## Run locally

```powershell
npm.cmd test
npm.cmd start
```

Open `http://localhost:4173`.

No install step is needed: the project has no runtime dependencies.

## Working MVP

- Shell-first drafting: drag the external shell, then enter its exact width and depth in the large on-plan measurement chips. Use Extend shell for L-, T- and stepped footprints; Trace shell remains available for unusual shapes.
- Direct plan editing: select and drag a corner or a straight wall to correct a shape, or tap a wall measurement chip to type an exact length. Measurement chips use generous touch targets for on-site iPad work.
- Survey-grade interior capture: add named room zones inside the external shell, record room classification, heated/habitable status, ceiling height, lights and survey notes, and draw internal walls between spaces.
- Wall tooling: split any external wall with one tap to create an editable corner, use corner/axis/surface snapping, and add doors or windows to both external and internal walls.
- Retrofit survey items: place radiators, storage/panel heaters, underfloor-heating zones, boilers, heat pumps, fireplaces and ventilation items, then record reference, fuel/system detail and evidence notes.
- Pointer Events canvas with touch-safe drawing, two-finger pan / pinch zoom, snap grid, orthogonal lock, typed dimensions and undo/redo.
- Single or duplicated storeys, internal floor polygons, wall types and partial-height heat-loss walls.
- Live gross internal area, heat-loss perimeter, party-wall exclusion, gross/net wall area, opening area and eight-point compass orientation.
- Window and door placement/editing, including a warning for doors that are 60%+ glazed.
- IndexedDB-first local persistence with a localStorage fallback, plus a service-worker app shell for offline use.
- PNG plan export and JSON RdSAP-input export.
- Continuous non-blocking review warnings.
- Node test fixtures for the core geometry engine.

## Compliance boundary

The user remains responsible for checking every captured measurement and classification before use in accredited RdSAP software. The UI intentionally describes calculations as derived/advisory. Core lengths retain floating-point precision and display to two decimal places, matching RdSAP 10 Conventions v12.1, Convention 2.02 (0.01 m or better).

## Next integration milestone

Once Supabase is available, add organisation/job authentication, row-level security, cloud sync/conflict handling and the Future Forms export merge. Geometry should remain the source of truth; `derived` should remain reproducible from it.
