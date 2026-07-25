# Future Floor Plans

An offline-first, iPad-first floor-plan editor for Domestic Energy Assessors and Retrofit Assessors. It captures assessor-verifiable RdSAP input data from geometry; it does not calculate an EPC rating, perform a SAP/RdSAP assessment, lodge an EPC, or calculate U-values.

## Run locally

```powershell
npm.cmd test
npm.cmd start
```

Open `http://localhost:4173`.

No install step is needed: the project has no runtime dependencies.

## How it works — room by room

You build the plan one room at a time (the PlanUp / magicplan model); the external
outline, internal and external walls, floor area and heat-loss perimeter are all
**derived from the rooms**.

- **Add room** — drag to rough-size the first room, then type its exact width and
  depth on the plan.
- **Grow the next room off a wall** — with Add room selected, tap an existing
  external wall and the new room extends outward from it, sharing that wall (which
  becomes an internal wall automatically). Build L-, T- and stepped footprints by
  butting rooms together.
- **Size to scale** — drag a wall, tap its measurement chip, or use the room's
  Width / Depth fields; rooms snap to each other and to the grid.
- **Select / move** — tap a room to record its name, use, heated/habitable status,
  ceiling height, lights and survey notes; tap a wall to set its type
  (main / alternative 1–2 / sheltered / party) and heat-loss treatment.

## Symbols and openings

A single grouped **Add symbol or opening** list places everything, and each group
has its own colour so the plan reads at a glance:

- **Openings** — Window (casement), Bay, Sliding, Fixed / picture, Roof window;
  Single / Double / French / Patio / Bi-fold / Garage door (placed on a wall).
- **Services** (blue) — Electric Meter, Consumer Unit, Gas Meter, Stop Tap.
- **Heating Producers** (amber) — Combi / Regular / Electric / Oil / Back boiler,
  Water Cylinder.
- **Heating Emitters** (yellow) — Radiator, Radiator with TRV, Electric Heater,
  Electric Storage Heater, Gas Fire.
- **Heating Controls** (gold) — Programmer, Thermostat, Programmable Thermostat.
- **Lights** (violet) — High Energy, Low Energy.
- **Other** (slate) — create your own label and assign it to a group / colour.

## Also included

- Pointer Events canvas: touch-safe drawing, two-finger pan / pinch zoom, snap grid,
  typed dimensions and undo/redo.
- Single or duplicated storeys; internal walls (partitions) for open-plan subdivision.
- Live gross internal area, heat-loss perimeter, party-wall exclusion, gross/net wall
  area, opening area and eight-point compass orientation.
- Doors and windows on external and internal walls, including a warning for doors that
  are 60%+ glazed.
- IndexedDB-first local persistence with a localStorage fallback, plus a service-worker
  app shell for offline use (network-first on localhost so edits appear immediately).
- PNG plan export and JSON RdSAP-input export.
- Continuous non-blocking review warnings.
- Node test fixtures for the core geometry engine (`npm.cmd test`).

## Compliance boundary

The user remains responsible for checking every captured measurement and classification before use in accredited RdSAP software. The UI intentionally describes calculations as derived/advisory. Core lengths retain floating-point precision and display to two decimal places, matching RdSAP 10 Conventions v12.1, Convention 2.02 (0.01 m or better).

## Next integration milestone

Once Supabase is available, add organisation/job authentication, row-level security, cloud sync/conflict handling and the Future Forms export merge. Geometry should remain the source of truth; `derived` should remain reproducible from it.
