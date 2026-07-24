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
export const ROOM_USES = {
  main: 'Main dwelling', extension: 'Extension', conservatory: 'Non-separated conservatory',
  room_in_roof: 'Room in roof', excluded: 'Excluded space'
};

export const SURVEY_ITEM_TYPES = {
  radiator: 'Radiator', storage_heater: 'Storage heater', panel_heater: 'Panel heater',
  underfloor_heating: 'Underfloor heating zone', boiler: 'Boiler', heat_pump: 'Heat pump',
  fireplace: 'Fireplace', ventilation: 'Ventilation unit'
};

export function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
export function pointAlong(a, b, ratio) { return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }; }
export function segmentLength(segment) { return distance(segment.from, segment.to); }
export function projectPointToSegment(point, from, to) {
  const dx = to.x - from.x; const dy = to.y - from.y; const lengthSquared = dx * dx + dy * dy;
  const rawRatio = lengthSquared ? ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared : 0;
  const ratio = Math.max(0, Math.min(1, rawRatio)); const projected = pointAlong(from, to, ratio);
  return { point: projected, ratio, distance: distance(point, projected), length: Math.sqrt(lengthSquared) };
}

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

/**
 * Returns a safe copy with one corner moved. The caller can decide how to
 * constrain the point for the interaction it is implementing.
 */
export function moveVertex(points = [], index, point) {
  if (index < 0 || index >= points.length) return clone(points);
  const next = clone(points);
  next[index] = { x: Number(point.x), y: Number(point.y) };
  return next;
}

/**
 * Moves an orthogonal wall along its normal. Both of its end points move,
 * keeping its length and the surrounding wall order intact. Angled walls are
 * intentionally returned unchanged: they should be adjusted by their corners.
 */
export function moveAxisAlignedWall(points = [], wallIndex, coordinate, epsilon = 1e-8) {
  if (points.length < 3) return null;
  const from = points[wallIndex]; const to = points[(wallIndex + 1) % points.length];
  if (!from || !to) return null;
  const next = clone(points); const value = Number(coordinate);
  if (Math.abs(from.y - to.y) < epsilon) {
    next[wallIndex].y = value; next[(wallIndex + 1) % points.length].y = value;
  } else if (Math.abs(from.x - to.x) < epsilon) {
    next[wallIndex].x = value; next[(wallIndex + 1) % points.length].x = value;
  } else return null;
  return next;
}

/**
 * Sets a wall's measured length, anchoring either its first or second corner.
 * This supports direct measurement entry while retaining the wall direction.
 */
export function resizeWall(points = [], wallIndex, length, anchor = 'from') {
  if (points.length < 3 || !(Number(length) > 0)) return null;
  const from = points[wallIndex]; const to = points[(wallIndex + 1) % points.length];
  if (!from || !to) return null;
  const current = distance(from, to); if (!current) return null;
  const dx = (to.x - from.x) / current; const dy = (to.y - from.y) / current;
  const next = clone(points);
  if (anchor === 'to') next[wallIndex] = { x: to.x - dx * Number(length), y: to.y - dy * Number(length) };
  else next[(wallIndex + 1) % points.length] = { x: from.x + dx * Number(length), y: from.y + dy * Number(length) };
  return next;
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

export function createRoom({ name = 'Room', polygon = [], use = 'main', heated = true, habitable = true, ceiling_height_m = null, light_count = null, notes = '' } = {}) {
  return { id: newId('room'), name, polygon: clone(polygon), use, heated, habitable, ceiling_height_m, light_count, notes };
}

export function makePartition(from, to, { thickness_m = .1, name = 'Internal wall' } = {}) {
  return { id: newId('pt'), from: clone(from), to: clone(to), thickness_m, name, openings: [] };
}

export function makeSurveyItem(kind = 'radiator', point = { x: 0, y: 0 }) {
  return { id: newId('item'), kind, point: clone(point), label: '', fuel: '', notes: '' };
}

export function ensureStoreySurveyData(storey) {
  if (!Array.isArray(storey.rooms)) storey.rooms = [];
  if (!Array.isArray(storey.partitions)) storey.partitions = [];
  if (!Array.isArray(storey.survey_items)) storey.survey_items = [];
  for (const room of storey.rooms) {
    if (!Array.isArray(room.polygon)) room.polygon = [];
    if (!room.use) room.use = 'main';
    if (room.heated === undefined) room.heated = true;
    if (room.habitable === undefined) room.habitable = true;
  }
  for (const partition of storey.partitions) if (!Array.isArray(partition.openings)) partition.openings = [];
  return storey;
}

export function createStorey({ name = 'Ground floor', level = 0, height_m = 2.4, outline = [] } = {}) {
  const storey = { id: newId('st'), name, level, height_m, outline: clone(outline), is_closed: false, boxes: [], walls: [], rooms: [], partitions: [], survey_items: [] };
  syncWalls(storey);
  return storey;
}

export function syncWalls(storey, { preserve = true } = {}) {
  ensureStoreySurveyData(storey);
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

export function closestPartition(storey, point, tolerance = Infinity) {
  let closest = null;
  for (const partition of storey.partitions || []) {
    const match = projectPointToSegment(point, partition.from, partition.to);
    if (match.distance <= tolerance && (!closest || match.distance < closest.distance)) closest = { partition, ...match, offset_m: match.length * match.ratio };
  }
  return closest;
}

export function roomArea(room) { return polygonArea(room?.polygon || []); }
export function roomCentroid(room) {
  const points = room?.polygon || []; if (!points.length) return { x: 0, y: 0 };
  return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
}

/**
 * Inserts an editable corner into an external wall and carries its survey
 * classification/openings across the two new wall segments. Openings that
 * begin after the split are rebased to the new segment.
 */
export function splitExternalWall(storey, wallId, point, epsilon = .05) {
  const wallIndex = (storey.walls || []).findIndex(wall => wall.id === wallId);
  if (wallIndex < 0) return null;
  const wall = storey.walls[wallIndex]; const from = storey.outline[wall.from]; const to = storey.outline[wall.to];
  if (!from || !to) return null;
  const match = projectPointToSegment(point, from, to);
  if (match.ratio <= epsilon / Math.max(match.length, epsilon) || match.ratio >= 1 - epsilon / Math.max(match.length, epsilon)) return null;
  const next = clone(storey); const insertedAt = wallIndex + 1; next.outline.splice(insertedAt, 0, match.point);
  const splitOffset = match.length * match.ratio;
  const firstOpenings = []; const secondOpenings = [];
  for (const opening of wall.openings || []) {
    const offset = Number(opening.offset_m) || 0;
    if (offset >= splitOffset) secondOpenings.push({ ...opening, offset_m: offset - splitOffset });
    else firstOpenings.push({ ...opening, width_m: Math.min(Number(opening.width_m) || 0, Math.max(0, splitOffset - offset)) });
  }
  const first = { ...clone(wall), from: wallIndex, to: insertedAt, openings: firstOpenings };
  const second = { ...clone(wall), id: newId('w'), from: insertedAt, to: (insertedAt + 1) % next.outline.length, openings: secondOpenings };
  next.walls = next.outline.map((_, index) => {
    if (index < wallIndex) return { ...clone(storey.walls[index]), from: index, to: index + 1 };
    if (index === wallIndex) return first;
    if (index === insertedAt) return second;
    const old = storey.walls[index - 1]; return { ...clone(old), from: index, to: (index + 1) % next.outline.length };
  });
  ensureStoreySurveyData(next);
  return { storey: next, vertexIndex: insertedAt, wallId: first.id, newWallId: second.id };
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
    const rooms = (storey.rooms || []).map(room => ({ ...room, area_m2: roomArea(room) }));
    const partition_opening_count = (storey.partitions || []).reduce((count, partition) => count + (partition.openings || []).length, 0);
    const heated_room_count = rooms.filter(room => room.heated).length;
    const light_count = rooms.reduce((count, room) => count + (Number(room.light_count) || 0), 0);
    return { id: storey.id, level: storey.level, name: storey.name, floor_area_m2, heat_loss_perimeter_m, party_wall_length_m, sheltered_wall_length_m, gross_wall_area_m2, opening_area_total_m2, net_wall_area_m2: Math.max(0, gross_wall_area_m2 - opening_area_total_m2), external_door_count, walls, rooms, room_count: rooms.length, heated_room_count, light_count, partition_opening_count, survey_items: clone(storey.survey_items || []) };
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
    for (const room of storey.rooms || []) {
      if (!room.name?.trim()) warnings.push(`${storey.name}: name each recorded room before exporting.`);
      if ((room.polygon || []).length < 3 || roomArea(room) <= 0) warnings.push(`${storey.name}: a room zone has no usable measured area.`);
      if (room.ceiling_height_m && (room.ceiling_height_m < 1.5 || room.ceiling_height_m > 4.5)) warnings.push(`${room.name || 'Room'}: verify the recorded ceiling height.`);
    }
  }
  if (Number(plan.north_offset_deg) === 0) warnings.push('North is at the default position — confirm orientations on site.');
  return warnings;
}

function deriveWithoutValidation(plan) { return (plan.geometry?.storeys || []).map(storey => ({ id: storey.id })); }
