/** Pure geometry and RdSAP-input derivation functions. No DOM, storage or side effects. */

export const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const WALL_TYPES = {
  main: 'Main wall',
  alternative_1: 'Alternative wall 1',
  alternative_2: 'Alternative wall 2',
  sheltered: 'Sheltered wall',
  party: 'Party wall'
};

let idSeed = 0;
export const newId = prefix => `${prefix}_${Date.now().toString(36)}_${(idSeed += 1).toString(36)}`;

export function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function metres(value) { return `${Number(value || 0).toFixed(2)} m`; }
export function squareMetres(value) { return `${Number(value || 0).toFixed(2)} m²`; }
export function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
export function pointAlong(a, b, ratio) { return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }; }

export function signedArea(points = []) {
  if (points.length < 3) return 0;
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

export function polygonArea(points = []) { return Math.abs(signedArea(points)); }

export function isSelfIntersecting(points = []) {
  if (points.length < 4) return false;
  const orientation = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const intersects = (a, b, c, d) => {
    const abC = orientation(a, b, c); const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a); const cdB = orientation(c, d, b);
    return abC !== abD && cdA !== cdB;
  };
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      if (i === j || (i + 1) % points.length === j || i === (j + 1) % points.length) continue;
      const c = points[j]; const d = points[(j + 1) % points.length];
      if (intersects(a, b, c, d)) return true;
    }
  }
  return false;
}

export function normaliseBox(box) {
  const x2 = Number(box.x) + Number(box.width); const y2 = Number(box.y) + Number(box.depth);
  return { x: Math.min(Number(box.x), x2), y: Math.min(Number(box.y), y2), width: Math.abs(Number(box.width)), depth: Math.abs(Number(box.depth)) };
}

export function boxesTouchOrOverlap(boxes = [], candidate) {
  const box = normaliseBox(candidate); const epsilon = 1e-8;
  return boxes.some(item => {
    const existing = normaliseBox(item);
    const overlapX = Math.min(existing.x + existing.width, box.x + box.width) - Math.max(existing.x, box.x);
    const overlapY = Math.min(existing.y + existing.depth, box.y + box.depth) - Math.max(existing.y, box.y);
    return (overlapX > epsilon && overlapY >= -epsilon) || (overlapY > epsilon && overlapX >= -epsilon);
  });
}

/**
 * Turns one connected set of axis-aligned rectangles into its outer footprint.
 * It is deliberately dependency-free: an occupancy grid gives stable results for
 * L, T, stepped and overlapping measured boxes.
 */
export function outlineFromBoxes(input = []) {
  const boxes = input.map(normaliseBox).filter(box => box.width > 0 && box.depth > 0);
  if (!boxes.length) return [];
  const xs = [...new Set(boxes.flatMap(box => [box.x, box.x + box.width]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap(box => [box.y, box.y + box.depth]))].sort((a, b) => a - b);
  const occupied = (x, y) => boxes.some(box => x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.depth);
  const edges = [];
  for (let yi = 0; yi < ys.length - 1; yi += 1) for (let xi = 0; xi < xs.length - 1; xi += 1) {
    const left = xs[xi]; const right = xs[xi + 1]; const top = ys[yi]; const bottom = ys[yi + 1];
    const centreX = (left + right) / 2; const centreY = (top + bottom) / 2;
    if (!occupied(centreX, centreY)) continue;
    if (yi === 0 || !occupied(centreX, (ys[yi - 1] + top) / 2)) edges.push({ a: { x: left, y: top }, b: { x: right, y: top } });
    if (xi === xs.length - 2 || !occupied((right + xs[xi + 2]) / 2, centreY)) edges.push({ a: { x: right, y: top }, b: { x: right, y: bottom } });
    if (yi === ys.length - 2 || !occupied(centreX, (bottom + ys[yi + 2]) / 2)) edges.push({ a: { x: right, y: bottom }, b: { x: left, y:bottom } });
    if (xi === 0 || !occupied((xs[xi - 1] + left) / 2, centreY)) edges.push({ a: { x: left, y: bottom }, b: { x: left, y: top } });
  }
  const key = point => `${point.x}:${point.y}`;
  const remaining = new Map(edges.map(edge => [key(edge.a), edge]));
  const loops = [];
  while (remaining.size) {
    const first = remaining.values().next().value; const loop = [first.a]; let edge = first; remaining.delete(key(edge.a));
    while (key(edge.b) !== key(first.a)) {
      loop.push(edge.b); edge = remaining.get(key(edge.b));
      if (!edge) throw new Error('Boxes must form a single connected footprint.');
      remaining.delete(key(edge.a));
    }
    loops.push(loop);
  }
  const outer = loops.sort((a, b) => polygonArea(b) - polygonArea(a))[0];
  return outer.filter((point, index, points) => {
    const previous = points[(index - 1 + points.length) % points.length]; const next = points[(index + 1) % points.length];
    return Math.abs((point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x)) > 1e-9;
  });
}

export function createStorey({ name = 'Ground floor', level = 0, height_m = 2.4, outline = [] } = {}) {
  const storey = { id: newId('st'), name, level, height_m, outline: clone(outline), is_closed: false, boxes: [], walls: [], rooms: [] };
  syncWalls(storey);
  return storey;
}

export function syncWalls(storey, { preserve = true } = {}) {
  if (!storey.is_closed) { storey.walls = []; return storey; }
  const previous = new Map(preserve ? (storey.walls || []).map(wall => [`${wall.from}:${wall.to}`, wall]) : []);
  const count = storey.outline?.length || 0;
  storey.walls = Array.from({ length: count }, (_, from) => {
    const to = (from + 1) % count;
    const old = previous.get(`${from}:${to}`);
    return old ? { ...old, from, to, openings: old.openings || [] } : {
      id: newId('w'), from, to, type: 'main', heat_loss_mode: 'full', heat_loss_height_m: null, openings: []
    };
  });
  return storey;
}

export function getWall(storey, wallId) { return storey.walls.find(wall => wall.id === wallId); }
export function wallPoints(storey, wall) { return { from: storey.outline[wall.from], to: storey.outline[wall.to] }; }
export function wallLength(storey, wall) { const { from, to } = wallPoints(storey, wall); return distance(from, to); }
export function effectiveLength(storey, wall) {
  const length = wallLength(storey, wall);
  if (wall.type === 'party' || wall.heat_loss_mode === 'none') return 0;
  if (wall.heat_loss_mode !== 'partial') return length;
  const roomHeight = Number(storey.height_m) || 0;
  return roomHeight > 0 ? length * Math.max(0, Math.min(Number(wall.heat_loss_height_m) || 0, roomHeight)) / roomHeight : 0;
}

export function wallOrientation(storey, wall, northOffsetDeg = 0) {
  const { from, to } = wallPoints(storey, wall);
  const dx = to.x - from.x; const dy = to.y - from.y;
  if (!dx && !dy) return 'N';
  // With the app's y-down drawing coordinates, positive signed area means a visually clockwise outline.
  const clockwise = signedArea(storey.outline) > 0;
  const normal = clockwise ? { x: dy, y: -dx } : { x: -dy, y: dx };
  const angle = (Math.atan2(normal.x, -normal.y) * 180 / Math.PI + 360 + Number(northOffsetDeg || 0)) % 360;
  return COMPASS_POINTS[Math.round(angle / 45) % 8];
}

export function closestWall(storey, point, tolerance = Infinity) {
  let closest = null;
  for (const wall of storey.walls || []) {
    const { from, to } = wallPoints(storey, wall);
    const dx = to.x - from.x; const dy = to.y - from.y; const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) continue;
    const rawT = ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, rawT)); const projected = pointAlong(from, to, t); const gap = distance(point, projected);
    if (gap <= tolerance && (!closest || gap < closest.distance)) closest = { wall, point: projected, distance: gap, ratio: t, offset_m: Math.sqrt(lengthSquared) * t };
  }
  return closest;
}

export function makeOpening(kind = 'window', offset_m = 0) {
  const isDoor = kind === 'door' || kind === 'glazed_door';
  return { id: newId('op'), kind, offset_m, width_m: isDoor ? 0.9 : 1.2, height_m: isDoor ? 2 : 1.2, frame_material: 'uPVC', glazing_type: isDoor ? 'N/A' : 'Double', glazing_depth_mm: isDoor ? null : 16, glazing_age_band: 'Unknown', glazed_area_ratio: kind === 'glazed_door' ? 0.7 : null, orientation_overridden: false, orientation: null };
}

export function createPlan() {
  return {
    version: 1,
    property_address: '',
    postcode: '',
    north_offset_deg: 0,
    measurement_convention: 'internal',
    storey_height_basis: 'floor_to_floor',
    status: 'draft',
    geometry: { storeys: [createStorey()] },
    derived: {},
    updated_at: new Date().toISOString()
  };
}

export function createSamplePlan() {
  const boxes = [{ x: 0, y: 0, width: 8.4, depth: 5.8 }, { x: 0, y: 5.8, width: 5.4, depth: 1.8 }];
  const plan = createPlan();
  plan.property_address = '14 Orchard Lane'; plan.postcode = 'PR1 2AB';
  const storey = plan.geometry.storeys[0]; storey.name = 'Ground floor'; storey.boxes = boxes; storey.outline = outlineFromBoxes(boxes); storey.is_closed = true; storey.height_m = 2.4; syncWalls(storey);
  storey.walls[1].type = 'party';
  storey.walls[2].type = 'alternative_1';
  storey.walls[0].openings.push({ ...makeOpening('window', 1.3), width_m: 1.6, height_m: 1.2 });
  storey.walls[3].openings.push({ ...makeOpening('door', 0.7), width_m: .9, height_m: 2.0 });
  storey.walls[4].openings.push({ ...makeOpening('window', .5), width_m: 1.1, height_m: 1.2 });
  return plan;
}

export function derivePlan(plan) {
  const per_storey = (plan.geometry?.storeys || []).map(storey => {
    const floor_area_m2 = storey.is_closed ? polygonArea(storey.outline) : 0;
    const walls = (storey.walls || []).map(wall => {
      const length_m = wallLength(storey, wall); const effective_length_m = effectiveLength(storey, wall);
      const orientation = wallOrientation(storey, wall, plan.north_offset_deg);
      const openings = (wall.openings || []).map(opening => ({ ...opening, orientation: opening.orientation_overridden && opening.orientation ? opening.orientation : orientation, area_m2: (Number(opening.width_m) || 0) * (Number(opening.height_m) || 0) }));
      return { ...wall, length_m, effective_length_m, orientation, openings };
    });
    const heat_loss_perimeter_m = walls.reduce((sum, wall) => sum + wall.effective_length_m, 0);
    const party_wall_length_m = walls.filter(wall => wall.type === 'party').reduce((sum, wall) => sum + wall.length_m, 0);
    const sheltered_wall_length_m = walls.filter(wall => wall.type === 'sheltered').reduce((sum, wall) => sum + wall.effective_length_m, 0);
    const gross_wall_area_m2 = heat_loss_perimeter_m * (Number(storey.height_m) || 0);
    const heatLossOpenings = walls.filter(wall => wall.effective_length_m > 0).flatMap(wall => wall.openings);
    const opening_area_total_m2 = heatLossOpenings.reduce((sum, opening) => sum + opening.area_m2, 0);
    const external_door_count = heatLossOpenings.filter(opening => opening.kind === 'door').length + heatLossOpenings.filter(opening => opening.kind === 'glazed_door').length * 2;
    return { id: storey.id, level: storey.level, name: storey.name, floor_area_m2, heat_loss_perimeter_m, party_wall_length_m, sheltered_wall_length_m, gross_wall_area_m2, opening_area_total_m2, net_wall_area_m2: Math.max(0, gross_wall_area_m2 - opening_area_total_m2), external_door_count, walls };
  });
  const totals = per_storey.reduce((sum, storey) => ({ floor_area_m2: sum.floor_area_m2 + storey.floor_area_m2, heat_loss_perimeter_m: sum.heat_loss_perimeter_m + storey.heat_loss_perimeter_m, gross_wall_area_m2: sum.gross_wall_area_m2 + storey.gross_wall_area_m2, opening_area_total_m2: sum.opening_area_total_m2 + storey.opening_area_total_m2, net_wall_area_m2: sum.net_wall_area_m2 + storey.net_wall_area_m2, external_door_count: sum.external_door_count + storey.external_door_count }), { floor_area_m2: 0, heat_loss_perimeter_m: 0, gross_wall_area_m2: 0, opening_area_total_m2: 0, net_wall_area_m2: 0, external_door_count: 0 });
  return { per_storey, totals, warnings: validatePlan(plan, per_storey) };
}

export function validatePlan(plan, perStorey = deriveWithoutValidation(plan)) {
  const warnings = [];
  if (!plan.property_address?.trim()) warnings.push('Add the property address before exporting.');
  for (const storey of plan.geometry?.storeys || []) {
    if (storey.outline.length < 3 || !storey.is_closed) { warnings.push(`${storey.name}: outline needs at least three corners and must be closed.`); continue; }
    if (isSelfIntersecting(storey.outline)) warnings.push(`${storey.name}: outline crosses itself — check the wall order.`);
    if (!storey.height_m || storey.height_m < 2 || storey.height_m > 3.5) warnings.push(`${storey.name}: verify the storey height (${storey.height_m || 'not set'} m).`);
    const alternativeTypes = new Set(storey.walls.filter(wall => wall.type === 'alternative_1' || wall.type === 'alternative_2').map(wall => wall.type));
    if (alternativeTypes.size > 2) warnings.push(`${storey.name}: more than two alternative wall types are assigned.`);
    for (const wall of storey.walls) {
      if (!WALL_TYPES[wall.type]) warnings.push(`${storey.name}: a wall has no type assigned.`);
      if (wall.type === 'sheltered' && !alternativeTypes.size) warnings.push(`${storey.name}: sheltered wall should also be recorded as an alternative wall.`);
      if (wall.type === 'party' && wall.openings?.length) warnings.push(`${storey.name}: party wall contains an opening, which is excluded from the schedule.`);
      for (const opening of wall.openings || []) {
        if (opening.kind === 'door' && Number(opening.glazed_area_ratio) >= .6) warnings.push(`${storey.name}: a door is at least 60% glazed — consider classifying it as a window.`);
      }
    }
  }
  if (Number(plan.north_offset_deg) === 0) warnings.push('North is at the default position — confirm orientations on site.');
  return warnings;
}

function deriveWithoutValidation(plan) { return (plan.geometry?.storeys || []).map(storey => ({ id: storey.id })); }
