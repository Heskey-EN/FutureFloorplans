import test from 'node:test';
import assert from 'node:assert/strict';
import { boxesTouchOrOverlap, createPlan, createStorey, derivePlan, makeOpening, moveAxisAlignedWall, moveVertex, outlineFromBoxes, polygonArea, resizeWall, syncWalls, wallOrientation } from '../js/geometry.js';

function rectangularPlan() {
  const plan = createPlan();
  const storey = createStorey({ name: 'Ground floor', height_m: 2.4 });
  storey.outline = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  storey.is_closed = true; syncWalls(storey); plan.geometry.storeys = [storey];
  return { plan, storey };
}

test('shoelace floor area calculates gross internal area', () => {
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }]), 40);
});

test('party walls are excluded from heat loss perimeter', () => {
  const { plan, storey } = rectangularPlan();
  storey.walls[1].type = 'party';
  const derived = derivePlan(plan).per_storey[0];
  assert.equal(derived.floor_area_m2, 40);
  assert.equal(derived.heat_loss_perimeter_m, 21);
  assert.equal(derived.party_wall_length_m, 5);
  assert.equal(derived.gross_wall_area_m2, 50.4);
});

test('partial-height walls use effective heat-loss length', () => {
  const { plan, storey } = rectangularPlan();
  storey.walls[0].heat_loss_mode = 'partial'; storey.walls[0].heat_loss_height_m = 1.2;
  const derived = derivePlan(plan).per_storey[0];
  assert.equal(derived.heat_loss_perimeter_m, 22);
});

test('only openings on heat-loss walls reduce net wall area and contribute external doors', () => {
  const { plan, storey } = rectangularPlan();
  storey.walls[0].openings.push({ ...makeOpening('window', 1), width_m: 1.5, height_m: 1.2 });
  storey.walls[1].type = 'party'; storey.walls[1].openings.push({ ...makeOpening('door', 1), width_m: .9, height_m: 2 });
  const derived = derivePlan(plan).per_storey[0];
  assert.ok(Math.abs(derived.opening_area_total_m2 - 1.8) < 1e-9);
  assert.ok(Math.abs(derived.net_wall_area_m2 - 48.6) < 1e-9);
  assert.equal(derived.external_door_count, 0);
});

test('top wall derives north, with a plan-level north rotation applied', () => {
  const { plan, storey } = rectangularPlan();
  assert.equal(wallOrientation(storey, storey.walls[0], 0), 'N');
  assert.equal(wallOrientation(storey, storey.walls[0], 90), 'E');
  plan.north_offset_deg = 90;
  assert.equal(derivePlan(plan).per_storey[0].walls[0].orientation, 'E');
});

test('an unclosed outline produces no derived floor or heat-loss area', () => {
  const { plan, storey } = rectangularPlan();
  storey.is_closed = false; syncWalls(storey);
  const derived = derivePlan(plan).per_storey[0];
  assert.equal(derived.floor_area_m2, 0);
  assert.equal(derived.heat_loss_perimeter_m, 0);
});

test('adjoining measured boxes become one L-shaped external outline', () => {
  const outline = outlineFromBoxes([{ x: 0, y: 0, width: 8, depth: 5 }, { x: 0, y: 5, width: 5, depth: 2 }]);
  assert.deepEqual(outline, [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 7 }, { x: 0, y: 7 }]);
  assert.equal(polygonArea(outline), 50);
});

test('box extensions must meet the footprint along a real edge, not only at a corner', () => {
  const footprint = [{ x: 0, y: 0, width: 8, depth: 5 }];
  assert.equal(boxesTouchOrOverlap(footprint, { x: 3, y: 5, width: 2, depth: 2 }), true);
  assert.equal(boxesTouchOrOverlap(footprint, { x: 8, y: 5, width: 2, depth: 2 }), false);
});

test('moving a straight wall moves both of its corners along the wall normal', () => {
  const outline = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  assert.deepEqual(moveAxisAlignedWall(outline, 0, -1), [{ x: 0, y: -1 }, { x: 8, y: -1 }, { x: 8, y: 5 }, { x: 0, y: 5 }]);
  assert.deepEqual(moveAxisAlignedWall(outline, 1, 9), [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 5 }, { x: 0, y: 5 }]);
});

test('direct wall measurements can anchor either corner', () => {
  const outline = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  assert.deepEqual(resizeWall(outline, 0, 6), [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }]);
  assert.deepEqual(resizeWall(outline, 0, 6, 'to'), [{ x: 2, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }]);
});

test('moving one corner preserves all untouched corners', () => {
  const outline = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
  assert.deepEqual(moveVertex(outline, 2, { x: 9, y: 6 }), [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 9, y: 6 }, { x: 0, y: 5 }]);
  assert.deepEqual(outline[2], { x: 8, y: 5 });
});
