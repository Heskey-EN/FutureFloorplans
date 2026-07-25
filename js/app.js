import {
  OPENING_TYPES, ROOM_USES, SURVEY_ITEM_TYPES, SYMBOL_GROUPS, WALL_TYPES, boundsOf, boxesConnected, boxesTouchOrOverlap, clone, closestPartition, closestWall, createPlan, createRoom, createSamplePlan, createStorey, derivePlan,
  distance, ensureStoreySurveyData, getWall, internalWallsFromRooms, isSelfIntersecting, makeOpening, makePartition, makeSurveyItem, metres, moveAxisAlignedWall, moveVertex, newId, normaliseBox, outlineFromBoxes, pointAlong, polygonArea, projectPointToSegment, rebuildStoreyFromRooms, rectPolygon, resizeRoomEdge, resizeWall, roomArea, roomCentroid, roomOwningWall, segmentLength, splitExternalWall, squareMetres, symbolCode, symbolColor, symbolGroupOf, symbolLabel, syncWalls, wallLength
} from './geometry.js';
import { loadPlan, savePlan } from './storage.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#planCanvas');
const frame = $('#canvasFrame');
const ctx = canvas.getContext('2d');
const elements = {
  address: $('#addressInput'), postcode: $('#postcodeInput'), north: $('#northInput'), northReadout: $('#northReadout'),
  storeyTabs: $('#storeyTabs'), dimension: $('#dimensionInput'), orthogonal: $('#orthogonalInput'),
  saveState: $('#saveState'), instruction: $('#instructionText'), storeyKicker: $('#storeyKicker'), canvasHint: $('#canvasHint'),
  northIndicator: $('#northIndicator'), zoomReadout: $('#zoomReadout'), scaleBar: $('#scaleBar'), scaleLabel: $('#scaleLabel'),
  area: $('#floorAreaMetric'), hlp: $('#hlpMetric'), wallArea: $('#wallAreaMetric'), openings: $('#openingMetric'),
  inspectorHeading: $('#inspectorHeading'), selectionBadge: $('#selectionBadge'), inspector: $('#inspectorContent'),
  warningCount: $('#warningCount'), warnings: $('#warningsList'), dialog: $('#confirmDialog'), dialogTitle: $('#dialogTitle'),
  dialogMessage: $('#dialogMessage'), dialogConfirm: $('#dialogConfirm'), dimensionPopover: $('#dimensionPopover'), finishOutline: $('#finishOutlineButton'),
  symbolPicker: $('#symbolPicker'), customSymbolRow: $('#customSymbolRow'), customSymbolLabel: $('#customSymbolLabel'), customSymbolGroup: $('#customSymbolGroup'), placementNote: $('#placementNote'),
  railGroups: $('#railGroups'), railItems: $('#railItems'), contextBar: $('#contextBar')
};

// Icon glyph per symbol kind / opening style (SVG sprite in index.html).
const ICONS = {
  electric_meter: 'i-meter', consumer_unit: 'i-unit', gas_meter: 'i-meter', stop_tap: 'i-tap',
  combi_gas_boiler: 'i-boiler', reg_gas_boiler: 'i-boiler', electric_boiler: 'i-boiler', oil_boiler: 'i-boiler', back_boiler: 'i-boiler', water_cylinder: 'i-cylinder',
  radiator: 'i-radiator', radiator_trv: 'i-trv', electric_heater: 'i-heater', electric_storage: 'i-heater', gas_fire: 'i-flame',
  programmer: 'i-programmer', thermostat: 'i-thermostat', programmable_thermostat: 'i-thermostat',
  light_high_energy: 'i-light', light_low_energy: 'i-light', custom: 'i-custom',
  window: 'i-window', bay_window: 'i-window-bay', sliding_window: 'i-door-slide', fixed_window: 'i-window-fixed', roof_window: 'i-roof-window',
  door: 'i-door', double_door: 'i-door-double', french_door: 'i-door-double', patio_door: 'i-door-slide', bifold_door: 'i-door-bifold', garage_door: 'i-garage'
};
const iconFor = key => ICONS[key] || 'i-custom';

const state = {
  plan: createPlan(), activeStoreyId: null, tool: 'box', selection: null, undo: [], redo: [],
  view: { scale: 65, x: 80, y: 70, initialised: false }, pointers: new Map(), gesture: null, drag: null,
  drawPreview: null, boxPreview: null, pendingBox: null, pendingRoom: null, roomPreview: null, partitionPreview: null, partitionStart: null,
  boxError: '', roomError: '', derived: null, saveTimer: null, pendingConfirm: null,
  dimensionHits: [], measurementEditor: null, closureSuggestion: null, interactionNotice: '', snapGuide: null,
  placement: null, railGroup: 'openings', alignGuides: [], hover: null, flashTimer: null
};

function activeStorey() { return state.plan.geometry.storeys.find(storey => storey.id === state.activeStoreyId) || state.plan.geometry.storeys[0]; }
function currentDerivedStorey() { return state.derived?.per_storey.find(storey => storey.id === activeStorey().id); }
function snapshot() { return clone(state.plan); }
function setSaveState(label, className = '') { elements.saveState.textContent = label; elements.saveState.className = `save-state ${className}`; }

function scheduleSave() {
  clearTimeout(state.saveTimer); setSaveState('Saving…', 'saving');
  state.saveTimer = setTimeout(async () => {
    state.plan.updated_at = new Date().toISOString();
    try { await savePlan(state.plan); setSaveState('Saved locally'); } catch { setSaveState('Local save failed', 'unsaved'); }
  }, 250);
}

function transaction(label, mutation, { remember = true } = {}) {
  if (remember) { state.undo.push(snapshot()); if (state.undo.length > 100) state.undo.shift(); state.redo = []; }
  mutation(); state.selection = state.selection && selectionExists(state.selection) ? state.selection : null; render(); scheduleSave();
}

function selectionExists(selection) {
  const storey = activeStorey();
  if (selection.type === 'wall') return Boolean(getWall(storey, selection.id));
  if (selection.type === 'partition') return storey.partitions?.some(partition => partition.id === selection.id);
  if (selection.type === 'room') return storey.rooms?.some(room => room.id === selection.id);
  if (selection.type === 'item') return storey.survey_items?.some(item => item.id === selection.id);
  if (selection.type === 'opening') return Boolean(findOpening(selection.id));
  return true;
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot()); state.plan = state.undo.pop(); state.activeStoreyId = state.plan.geometry.storeys[0]?.id; state.selection = null; render(); scheduleSave();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot()); state.plan = state.redo.pop(); state.activeStoreyId = state.plan.geometry.storeys[0]?.id; state.selection = null; render(); scheduleSave();
}

function resizeCanvas() {
  const rect = frame.getBoundingClientRect(); const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!state.view.initialised) fitPlan(); else renderCanvas();
}

function clientPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
function screenPoint(point) { return { x: point.x * state.view.scale + state.view.x, y: point.y * state.view.scale + state.view.y }; }
function worldPoint(point) { return { x: (point.x - state.view.x) / state.view.scale, y: (point.y - state.view.y) / state.view.scale }; }
function snap(point) { const grid = state.view.scale > 110 ? .1 : .25; return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid }; }
function snapCandidates(storey = activeStorey()) {
  return [
    ...(storey.outline || []),
    ...(storey.rooms || []).flatMap(room => room.polygon || []),
    ...(storey.partitions || []).flatMap(partition => [partition.from, partition.to])
  ];
}
function snapWorldPoint(raw, { surface = false, exclude = [] } = {}) {
  const storey = activeStorey(); const threshold = Math.max(.12, 18 / state.view.scale); const gridPoint = snap(raw);
  if (surface) {
    const matched = closestSurface(storey, raw, threshold * 1.6);
    if (matched) { state.snapGuide = { point: matched.point, kind: 'surface' }; return matched.point; }
  }
  const candidates = snapCandidates(storey).filter(candidate => !exclude.some(ignored => Math.abs(candidate.x - ignored.x) < 1e-8 && Math.abs(candidate.y - ignored.y) < 1e-8));
  let nearest = null;
  for (const candidate of candidates) {
    const gap = distance(gridPoint, candidate);
    if (gap <= threshold && (!nearest || gap < nearest.gap)) nearest = { point: candidate, gap };
  }
  if (nearest) { state.snapGuide = { point: nearest.point, kind: 'corner' }; return { ...nearest.point }; }
  const xAxis = candidates.reduce((best, candidate) => Math.abs(candidate.x - gridPoint.x) < Math.abs(best - gridPoint.x) ? candidate.x : best, gridPoint.x);
  const yAxis = candidates.reduce((best, candidate) => Math.abs(candidate.y - gridPoint.y) < Math.abs(best - gridPoint.y) ? candidate.y : best, gridPoint.y);
  const snappedX = Math.abs(xAxis - gridPoint.x) <= threshold ? xAxis : gridPoint.x;
  const snappedY = Math.abs(yAxis - gridPoint.y) <= threshold ? yAxis : gridPoint.y;
  state.snapGuide = snappedX !== gridPoint.x || snappedY !== gridPoint.y ? { point: { x: snappedX, y: snappedY }, kind: 'axis', x: snappedX !== gridPoint.x, y: snappedY !== gridPoint.y } : null;
  return { x: snappedX, y: snappedY };
}
// Full-height/width guides while a room is being dragged into alignment.
function drawAlignGuides() {
  if (!state.alignGuides?.length) return;
  ctx.save(); ctx.strokeStyle = '#ec5a35'; ctx.lineWidth = 1.5; setLineDash([7, 5]);
  for (const guide of state.alignGuides) {
    ctx.beginPath();
    if (guide.x != null) { const x = Math.round(screenPoint({ x: guide.x, y: 0 }).x) + .5; ctx.moveTo(x, 0); ctx.lineTo(x, frame.clientHeight); }
    if (guide.y != null) { const y = Math.round(screenPoint({ x: 0, y: guide.y }).y) + .5; ctx.moveTo(0, y); ctx.lineTo(frame.clientWidth, y); }
    ctx.stroke();
  }
  setLineDash([]); ctx.restore();
}

// Soft highlight of whatever the pointer is over, so targets feel alive.
function drawHover() {
  const hover = state.hover; if (!hover || state.drag) return;
  ctx.save();
  if (hover.type === 'room') {
    const room = activeStorey().rooms?.find(item => item.id === hover.id);
    if (room && !(state.selection?.type === 'room' && state.selection.id === room.id)) {
      const points = room.polygon.map(screenPoint);
      ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
      ctx.fillStyle = 'rgba(236,90,53,.07)'; ctx.fill();
    }
  } else if (hover.type === 'wall' && hover.from && hover.to) {
    const a = screenPoint(hover.from); const b = screenPoint(hover.to);
    ctx.strokeStyle = 'rgba(236,90,53,.55)'; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawSnapGuide() {
  const guide = state.snapGuide; if (!guide) return;
  const point = screenPoint(guide.point); ctx.save(); ctx.strokeStyle = guide.kind === 'surface' ? '#5b9ab4' : '#469d75'; ctx.lineWidth = 1.5; setLineDash([4, 4]);
  if (guide.kind === 'axis') {
    if (guide.x) { ctx.beginPath(); ctx.moveTo(point.x, 0); ctx.lineTo(point.x, frame.clientHeight); ctx.stroke(); }
    if (guide.y) { ctx.beginPath(); ctx.moveTo(0, point.y); ctx.lineTo(frame.clientWidth, point.y); ctx.stroke(); }
  }
  setLineDash([]); ctx.fillStyle = '#fff'; ctx.strokeStyle = guide.kind === 'surface' ? '#5b9ab4' : '#469d75'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
}

function fitPlan() {
  const storey = activeStorey(); const outline = storey?.outline || [];
  const width = frame.clientWidth || 600; const height = frame.clientHeight || 450;
  const surveyPoints = [
    ...outline,
    ...(storey?.rooms || []).flatMap(room => room.polygon || []),
    ...(storey?.partitions || []).flatMap(partition => [partition.from, partition.to]),
    ...(storey?.survey_items || []).map(item => item.point)
  ].filter(Boolean);
  if (surveyPoints.length < 2) { state.view = { scale: Math.max(48, Math.min(width / 11, height / 10)), x: width * .2, y: height * .18, initialised: true }; renderCanvas(); return; }
  const xs = surveyPoints.map(point => point.x); const ys = surveyPoints.map(point => point.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const padding = 60; const scale = Math.max(24, Math.min((width - padding * 2) / Math.max(maxX - minX, 2), (height - padding * 2) / Math.max(maxY - minY, 2)));
  state.view = { scale, x: (width - (minX + maxX) * scale) / 2, y: (height - (minY + maxY) * scale) / 2, initialised: true }; renderCanvas();
}

function drawGrid(width, height) {
  ctx.save(); ctx.fillStyle = '#dfe6e8'; ctx.fillRect(0, 0, width, height);
  const step = state.view.scale; const minor = step / 4; const startX = ((state.view.x % minor) + minor) % minor; const startY = ((state.view.y % minor) + minor) % minor;
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(89, 112, 122, .11)'; ctx.beginPath();
  for (let x = startX; x < width; x += minor) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, height); }
  for (let y = startY; y < height; y += minor) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(width, Math.round(y) + .5); }
  ctx.stroke(); ctx.strokeStyle = 'rgba(69, 95, 105, .19)'; ctx.beginPath();
  const majorX = ((state.view.x % step) + step) % step; const majorY = ((state.view.y % step) + step) % step;
  for (let x = majorX; x < width; x += step) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, height); }
  for (let y = majorY; y < height; y += step) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(width, Math.round(y) + .5); }
  ctx.stroke(); ctx.restore();
}

function wallColour(wall) { return wall.type === 'party' ? '#77858d' : wall.type === 'sheltered' ? '#7e8fba' : wall.type.startsWith('alternative') ? '#e29235' : '#19374a'; }
function setLineDash(dash) { ctx.setLineDash(dash); }

function drawSegmentOpening(from, to, opening) {
  const length = distance(from, to); if (!length) return;
  const style = opening.style || opening.kind;
  const start = pointAlong(from, to, Math.max(0, Math.min(1, opening.offset_m / length))); const end = pointAlong(from, to, Math.max(0, Math.min(1, (opening.offset_m + opening.width_m) / length)));
  const a = screenPoint(start); const b = screenPoint(end); const isSelected = state.selection?.type === 'opening' && state.selection.id === opening.id;
  const isDoor = opening.kind === 'door' || opening.kind === 'glazed_door';
  const colour = isSelected ? '#ec5a35' : (isDoor ? '#ec5a35' : '#5b9ab4');
  const dx = b.x - a.x; const dy = b.y - a.y; const hyp = Math.hypot(dx, dy) || 1; const ux = dx / hyp; const uy = dy / hyp; const nx = -uy; const ny = ux; const swingR = Math.min(hyp, 38);
  ctx.save(); ctx.lineCap = 'square';
  ctx.strokeStyle = '#fff'; ctx.lineWidth = (isSelected ? 9 : 7) + 4; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();   // clear the wall behind it
  ctx.strokeStyle = colour;
  const line = offset => { ctx.beginPath(); ctx.moveTo(a.x + nx * offset, a.y + ny * offset); ctx.lineTo(b.x + nx * offset, b.y + ny * offset); ctx.stroke(); };
  ctx.lineWidth = isSelected ? 7 : 5;
  if (style === 'door') { line(0); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(a.x, a.y, swingR, Math.atan2(ny, nx), Math.atan2(uy, ux)); ctx.stroke(); }
  else if (style === 'double_door' || style === 'french_door') { line(0); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(a.x, a.y, hyp / 2, Math.atan2(ny, nx), Math.atan2(uy, ux)); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x, b.y, hyp / 2, Math.atan2(-uy, -ux), Math.atan2(ny, nx)); ctx.stroke(); }
  else if (style === 'patio_door' || style === 'sliding_window') { ctx.lineWidth = isSelected ? 6 : 4; line(-2.5); line(2.5); }
  else if (style === 'bifold_door') { ctx.lineWidth = isSelected ? 5 : 3; const panels = 4; const d = Math.min(hyp / panels, 26); ctx.beginPath(); for (let i = 0; i < panels; i++) { const s = i / panels; const m = (i + 0.5) / panels; const e = (i + 1) / panels; ctx.moveTo(a.x + ux * hyp * s, a.y + uy * hyp * s); ctx.lineTo(a.x + ux * hyp * m + nx * d, a.y + uy * hyp * m + ny * d); ctx.lineTo(a.x + ux * hyp * e, a.y + uy * hyp * e); } ctx.stroke(); }
  else if (style === 'garage_door' || style === 'roof_window') { ctx.setLineDash([5, 4]); ctx.lineWidth = isSelected ? 6 : 4; line(0); ctx.setLineDash([]); }
  else if (style === 'bay_window') { ctx.lineWidth = isSelected ? 4 : 2.5; const d = Math.min(hyp * 0.5, 30); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + ux * hyp * 0.2 + nx * d, a.y + uy * hyp * 0.2 + ny * d); ctx.lineTo(a.x + ux * hyp * 0.8 + nx * d, a.y + uy * hyp * 0.8 + ny * d); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  else if (style === 'fixed_window') { ctx.lineWidth = isSelected ? 7 : 5; line(0); }
  else { ctx.lineWidth = isSelected ? 6 : 4; line(-2); line(2); }   // casement / sliding window default: double glass line
  ctx.restore();
}

function drawOpening(storey, wall, opening) { drawSegmentOpening(storey.outline[wall.from], storey.outline[wall.to], opening); }

function drawRoom(room) {
  const points = (room.polygon || []).map(screenPoint); if (points.length < 3) return;
  const selected = state.selection?.type === 'room' && state.selection.id === room.id;
  ctx.save(); ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
  ctx.fillStyle = selected ? 'rgba(236,90,53,.18)' : 'rgba(75,143,169,.10)'; ctx.fill(); ctx.strokeStyle = selected ? '#ec5a35' : '#5b9ab4'; ctx.lineWidth = selected ? 3 : 1.5; setLineDash([5, 4]); ctx.stroke(); setLineDash([]);
  const centre = screenPoint(roomCentroid(room)); const name = room.name || 'Unnamed room'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '800 12px ui-sans-serif, system-ui'; const width = Math.max(76, ctx.measureText(name).width + 18);
  ctx.fillStyle = selected ? '#ec5a35' : 'rgba(255,255,255,.94)'; ctx.fillRect(centre.x - width / 2, centre.y - 20, width, 24); ctx.fillStyle = selected ? '#fff' : '#25475b'; ctx.fillText(name, centre.x, centre.y - 8);
  ctx.font = '700 10px ui-sans-serif, system-ui'; ctx.fillStyle = selected ? '#fff7f2' : '#637882'; ctx.fillText(squareMetres(roomArea(room)), centre.x, centre.y + 7); ctx.restore();
}

function drawInternalWall(segment) {
  const from = screenPoint(segment.from); const to = screenPoint(segment.to);
  ctx.save(); ctx.strokeStyle = '#506975'; ctx.lineWidth = Math.max(3, Math.min(7, .09 * state.view.scale)); ctx.lineCap = 'square';
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.restore();
}

function drawPartition(partition) {
  const from = screenPoint(partition.from); const to = screenPoint(partition.to); const selected = state.selection?.type === 'partition' && state.selection.id === partition.id;
  ctx.save(); ctx.strokeStyle = selected ? '#ec5a35' : '#506975'; ctx.lineWidth = selected ? 8 : Math.max(5, Math.min(9, Number(partition.thickness_m || .1) * state.view.scale)); ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  for (const opening of partition.openings || []) drawSegmentOpening(partition.from, partition.to, opening);
  ctx.restore();
}

function drawSurveyItem(item) {
  const point = screenPoint(item.point); const selected = state.selection?.type === 'item' && state.selection.id === item.id;
  const colour = selected ? '#ec5a35' : symbolColor(item); const code = symbolCode(item);
  ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (['radiator', 'radiator_trv', 'electric_heater', 'electric_storage'].includes(item.kind)) {
    ctx.beginPath(); ctx.roundRect(point.x - 16, point.y - 9, 32, 18, 3); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = colour; ctx.lineWidth = 1; for (let x = -11; x <= 11; x += 5) { ctx.beginPath(); ctx.moveTo(point.x + x, point.y - 6); ctx.lineTo(point.x + x, point.y + 6); ctx.stroke(); }
    if (item.kind === 'radiator_trv') { ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(point.x + 15, point.y - 8, 3.5, 0, Math.PI * 2); ctx.fill(); }
  } else if (item.kind === 'gas_fire') {
    ctx.beginPath(); ctx.roundRect(point.x - 15, point.y - 10, 30, 20, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = colour; ctx.beginPath(); ctx.moveTo(point.x, point.y - 5); ctx.quadraticCurveTo(point.x + 7, point.y + 3, point.x, point.y + 8); ctx.quadraticCurveTo(point.x - 7, point.y + 3, point.x, point.y - 5); ctx.fill();
  } else {
    ctx.beginPath(); ctx.roundRect(point.x - 17, point.y - 11, 34, 22, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = colour; ctx.font = '800 10px ui-sans-serif, system-ui'; ctx.fillText(code, point.x, point.y + .5);
  }
  const caption = item.label || symbolLabel(item.kind);
  if (caption) { ctx.font = '700 10px ui-sans-serif, system-ui'; ctx.fillStyle = '#405b67'; ctx.textBaseline = 'top'; ctx.fillText(caption, point.x, point.y + 14); }
  ctx.restore();
}

function drawPlan() {
  const storey = activeStorey(); if (!storey?.outline.length) return;
  const points = storey.outline.map(screenPoint); const closed = Boolean(storey.is_closed);
  ctx.save(); ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); if (closed) ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,.87)'; if (closed) ctx.fill();
  if (!closed) { setLineDash([6, 5]); ctx.strokeStyle = '#ec5a35'; ctx.lineWidth = 3; ctx.stroke(); setLineDash([]); ctx.restore(); return; }
  ctx.restore();
  for (const room of storey.rooms || []) drawRoom(room);
  for (const segment of internalWallsFromRooms(storey)) drawInternalWall(segment);
  for (const partition of storey.partitions || []) drawPartition(partition);
  ctx.save();
  for (const wall of storey.walls) {
    const from = screenPoint(storey.outline[wall.from]); const to = screenPoint(storey.outline[wall.to]); const isSelected = state.selection?.type === 'wall' && state.selection.id === wall.id;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.strokeStyle = isSelected ? '#ec5a35' : wallColour(wall); ctx.lineWidth = isSelected ? 8 : 5; if (wall.type === 'party') setLineDash([6, 4]); ctx.stroke(); setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = isSelected ? '#ec5a35' : '#25475b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(from.x, from.y, isSelected ? 5.5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const opening of wall.openings || []) drawOpening(storey, wall, opening);
  }
  ctx.restore();
  drawDimensions(storey);
  for (const item of storey.survey_items || []) drawSurveyItem(item);
}

function drawDimensions(storey) {
  if (state.view.scale < 35 || !storey.outline.length) return;
  ctx.save(); ctx.font = '800 11px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const wall of storey.walls) {
    const from = screenPoint(storey.outline[wall.from]); const to = screenPoint(storey.outline[wall.to]); const length = wallLength(storey, wall); const midX = (from.x + to.x) / 2; const midY = (from.y + to.y) / 2;
    const dx = to.x - from.x; const dy = to.y - from.y; const n = Math.hypot(dx, dy) || 1; const offX = -dy / n * 14; const offY = dx / n * 14;
    drawMeasurementChip(`${length.toFixed(2)} m`, { x: midX + offX, y: midY + offY }, { kind: 'wall', wallId: wall.id });
  }
  for (const partition of storey.partitions || []) {
    const from = screenPoint(partition.from); const to = screenPoint(partition.to); const length = segmentLength(partition); const midX = (from.x + to.x) / 2; const midY = (from.y + to.y) / 2;
    const dx = to.x - from.x; const dy = to.y - from.y; const n = Math.hypot(dx, dy) || 1; const offX = -dy / n * 14; const offY = dx / n * 14;
    drawMeasurementChip(`${length.toFixed(2)} m`, { x: midX + offX, y: midY + offY }, { kind: 'partition', partitionId: partition.id });
  }
  ctx.restore();
}

function drawMeasurementChip(label, centre, hit) {
  const measured = ctx.measureText(label).width + 20; const width = Math.max(58, measured); const height = 26;
  const x = centre.x - width / 2; const y = centre.y - height / 2; const active = (hit.kind === 'wall' && state.selection?.type === 'wall' && state.selection.id === hit.wallId) || (hit.kind === 'partition' && state.selection?.type === 'partition' && state.selection.id === hit.partitionId) || (hit.kind === 'box' && state.measurementEditor?.kind === 'box');
  ctx.save(); ctx.fillStyle = active ? '#ec5a35' : 'rgba(255,255,255,.96)'; ctx.strokeStyle = active ? '#ec5a35' : '#a8b8be'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, width, height, 5); ctx.fill(); ctx.stroke(); ctx.fillStyle = active ? '#fff' : '#344d5a'; ctx.fillText(label, centre.x, centre.y + .5); ctx.restore();
  state.dimensionHits.push({ x: x - 8, y: y - 7, width: width + 16, height: height + 14, centre, ...hit });
}

function drawPreview() {
  const storey = activeStorey(); if (state.tool !== 'draw' || !state.drawPreview || !storey.outline.length) return;
  const from = screenPoint(storey.outline.at(-1)); const to = screenPoint(state.drawPreview);
  ctx.save(); ctx.strokeStyle = '#ec5a35'; ctx.lineWidth = 3; setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); setLineDash([]);
  const label = `${distance(storey.outline.at(-1), state.drawPreview).toFixed(2)} m`; ctx.font = '800 11px ui-sans-serif, system-ui'; const midX = (from.x + to.x)/2; const midY = (from.y + to.y)/2; const width = ctx.measureText(label).width + 16; ctx.fillStyle = '#102332'; ctx.fillRect(midX - width/2, midY - 12, width, 22); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, midX, midY); ctx.restore();
}

function drawBoxOverlay(box, { pending = false, kind = 'box' } = {}) {
  if (!box || box.width <= 0 || box.depth <= 0) return;
  const topLeft = screenPoint(box); const width = box.width * state.view.scale; const height = box.depth * state.view.scale;
  ctx.save(); ctx.fillStyle = pending ? 'rgba(236, 90, 53, .16)' : 'rgba(236, 90, 53, .07)'; ctx.strokeStyle = pending ? '#ec5a35' : '#9e6e45'; ctx.lineWidth = pending ? 3 : 1.5; setLineDash(pending ? [8, 5] : [4, 5]); ctx.fillRect(topLeft.x, topLeft.y, width, height); ctx.strokeRect(topLeft.x, topLeft.y, width, height); setLineDash([]);
  ctx.font = '800 11px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  drawMeasurementChip(`${box.width.toFixed(2)} m`, { x: topLeft.x + width / 2, y: Math.max(21, topLeft.y - 19) }, { kind, field: 'width' });
  drawMeasurementChip(`${box.depth.toFixed(2)} m`, { x: Math.min(frame.clientWidth - 37, topLeft.x + width + 27), y: topLeft.y + height / 2 }, { kind, field: 'depth' });
  ctx.restore();
}

function drawBoxPreview() { if (state.boxPreview || state.pendingBox) drawBoxOverlay(state.boxPreview || state.pendingBox, { pending: true }); }
function drawRoomPreview() { if (state.roomPreview || state.pendingRoom) drawBoxOverlay(state.roomPreview || state.pendingRoom, { pending: true, kind: 'room' }); }
function drawPartitionPreview() {
  if (!state.partitionStart || !state.partitionPreview) return;
  const from = screenPoint(state.partitionStart); const to = screenPoint(state.partitionPreview); ctx.save(); ctx.strokeStyle = '#506975'; ctx.lineWidth = 6; setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); setLineDash([]); ctx.restore();
}

function closurePath(storey = activeStorey()) {
  if (state.tool !== 'draw' || storey.is_closed || storey.outline.length < 3) return null;
  const first = storey.outline[0]; const last = storey.outline.at(-1); const tolerance = .0001;
  if (Math.abs(first.x - last.x) < tolerance || Math.abs(first.y - last.y) < tolerance) return [];
  const corner = { x: first.x, y: last.y };
  if (storey.outline.slice(1, -1).some(point => Math.abs(point.x - corner.x) < tolerance && Math.abs(point.y - corner.y) < tolerance)) return null;
  return [corner];
}

function drawClosureSuggestion() {
  const storey = activeStorey(); const path = closurePath(storey); state.closureSuggestion = path;
  elements.finishOutline.classList.toggle('hidden', path === null);
  if (path === null) return;
  const points = [storey.outline.at(-1), ...path, storey.outline[0]].map(screenPoint);
  ctx.save(); ctx.strokeStyle = '#469d75'; ctx.lineWidth = 3; setLineDash([7, 5]); ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke(); setLineDash([]);
  for (const point of points.slice(1, -1)) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#469d75'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

function renderCanvas() {
  const rect = frame.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  state.dimensionHits = []; ctx.clearRect(0, 0, rect.width, rect.height); drawGrid(rect.width, rect.height); drawHover(); drawPlan(); drawPreview(); drawBoxPreview(); drawRoomPreview(); drawPartitionPreview(); drawClosureSuggestion(); drawAlignGuides(); drawSnapGuide();
  const scaleLength = state.view.scale >= 110 ? 1 : state.view.scale >= 55 ? 2 : 5; const scalePx = Math.min(90, Math.max(32, state.view.scale * scaleLength));
  elements.scaleBar.style.width = `${scalePx}px`; elements.scaleLabel.textContent = `${scaleLength} m`; elements.zoomReadout.textContent = `${Math.round(state.view.scale / 65 * 100)}%`;
  elements.northIndicator.querySelector('span').style.transform = `rotate(${Number(state.plan.north_offset_deg || 0)}deg)`;
}

function renderStoreyTabs() {
  elements.storeyTabs.innerHTML = state.plan.geometry.storeys.map(storey => `<button data-storey="${storey.id}" class="${storey.id === activeStorey().id ? 'active' : ''}">${escapeHTML(storey.name.replace(' floor', ''))}</button>`).join('');
}
function escapeHTML(value) { return String(value || '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

function renderInspector() {
  const storey = activeStorey(); const derived = currentDerivedStorey();
  if (state.pendingBox) {
    const box = state.pendingBox; const isExtension = box.mode === 'extend';
    elements.inspectorHeading.textContent = isExtension ? 'Size extension' : 'Size footprint'; elements.selectionBadge.textContent = 'Box';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#ec5a35"></i><span>${isExtension ? 'Adjoining shape' : 'Footprint box'}<strong>${squareMetres(box.width * box.depth)}</strong></span></div>
      <div class="empty-state"><b>${isExtension ? 'Make a complex shape quickly.' : 'Give the rough drag its exact dimensions.'}</b>${isExtension ? 'This room must touch the existing footprint along an edge. It will be merged into one clean external outline.' : 'Tap either measurement label on the plan for the fastest entry, or use these fields.'}</div>
      <div class="form-split"><label>Width (m)<input data-box-field="width" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.width}" /></label><label>Depth (m)<input data-box-field="depth" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.depth}" /></label></div>
      ${state.boxError ? `<p class="field-note box-error">${escapeHTML(state.boxError)}</p>` : '<p class="field-note">Input is kept to two decimal places. You can pan and inspect the outline after applying it.</p>'}
      <div class="inspector-action-row"><button class="secondary-button" data-action="cancel-box">Cancel</button><button class="primary-button" data-action="apply-box">${isExtension ? 'Add extension' : 'Set footprint'}</button></div>`;
  } else if (state.pendingRoom) {
    const room = state.pendingRoom;
    elements.inspectorHeading.textContent = 'Name room'; elements.selectionBadge.textContent = 'Room';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#5b9ab4"></i><span>Measured room zone<strong>${squareMetres(room.width * room.depth)}</strong></span></div>
      <div class="empty-state"><b>Place a named room inside the shell.</b>Room zones can overlap open-plan areas; use <strong>Draw internal wall</strong> when you also need a physical partition.</div>
      <label>Room name<input data-room-draft-field="name" type="text" value="${escapeHTML(room.name || '')}" placeholder="e.g. Kitchen" autofocus /></label>
      <div class="form-split"><label>Width (m)<input data-room-draft-field="width" type="number" inputmode="decimal" min=".1" step=".01" value="${room.width}" /></label><label>Depth (m)<input data-room-draft-field="depth" type="number" inputmode="decimal" min=".1" step=".01" value="${room.depth}" /></label></div>
      ${state.roomError ? `<p class="field-note box-error">${escapeHTML(state.roomError)}</p>` : '<p class="field-note">Add the room name now; retrofit room data can be completed when you select it.</p>'}
      <div class="inspector-action-row"><button class="secondary-button" data-action="cancel-room">Cancel</button><button class="primary-button" data-action="apply-room">Place room</button></div>`;
  } else if (state.selection?.type === 'wall') {
    const wall = getWall(storey, state.selection.id); const derivedWall = derived?.walls.find(item => item.id === wall?.id);
    if (!wall) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = `Wall ${wall.from + 1}`; elements.selectionBadge.textContent = 'Wall';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:${wallColour(wall)}"></i><span>External wall length<strong>${metres(derivedWall?.length_m)}</strong></span></div>
      <label>Wall type<select data-wall-field="type">${Object.entries(WALL_TYPES).map(([value, label]) => `<option value="${value}" ${wall.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Heat loss treatment<select data-wall-field="heat_loss_mode"><option value="full" ${wall.heat_loss_mode === 'full' ? 'selected' : ''}>Full height</option><option value="partial" ${wall.heat_loss_mode === 'partial' ? 'selected' : ''}>Partial height</option><option value="none" ${wall.heat_loss_mode === 'none' ? 'selected' : ''}>None</option></select></label>
      ${wall.heat_loss_mode === 'partial' ? `<label>Heat loss height (m)<input data-wall-field="heat_loss_height_m" type="number" inputmode="decimal" min="0" max="${storey.height_m}" step="0.01" value="${wall.heat_loss_height_m ?? ''}" /></label>` : ''}
      <div class="stat-stack"><div class="stat-card"><span>Effective HLP</span><strong>${metres(derivedWall?.effective_length_m)}</strong></div><div class="stat-card"><span>Orientation</span><strong>${derivedWall?.orientation || '—'}</strong></div></div>
      <p class="field-note">Party walls are excluded from heat loss perimeter. Derived figures are advisory and remain assessor-verifiable.</p>
      <div class="inspector-action-row"><button class="secondary-button" data-action="split-wall">Split wall</button><button class="secondary-button danger" data-action="delete-wall">Delete wall</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'partition') {
    const partition = storey.partitions?.find(item => item.id === state.selection.id); if (!partition) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = 'Internal wall'; elements.selectionBadge.textContent = 'Partition';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#506975"></i><span>Internal wall length<strong>${metres(segmentLength(partition))}</strong></span></div>
      <label>Wall label<input data-partition-field="name" type="text" value="${escapeHTML(partition.name || '')}" /></label>
      <label>Wall thickness (m)<input data-partition-field="thickness_m" type="number" inputmode="decimal" min=".05" max=".5" step=".01" value="${partition.thickness_m ?? .1}" /></label>
      <p class="field-note">Doors and windows can attach to this internal wall. Drag either end to reshape it.</p>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-partition">Delete wall</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'room') {
    const room = storey.rooms?.find(item => item.id === state.selection.id); if (!room) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = room.name || 'Room'; elements.selectionBadge.textContent = 'Room';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#5b9ab4"></i><span>Measured room area<strong>${squareMetres(roomArea(room))}</strong></span></div>
      <div class="form-split"><label>Width (m)<input data-room-size="width" type="number" inputmode="decimal" min=".1" step=".01" value="${boundsOf(room.polygon).width.toFixed(2)}" /></label><label>Depth (m)<input data-room-size="depth" type="number" inputmode="decimal" min=".1" step=".01" value="${boundsOf(room.polygon).depth.toFixed(2)}" /></label></div>
      <label>Room name<input data-room-field="name" type="text" value="${escapeHTML(room.name || '')}" placeholder="e.g. Lounge" /></label>
      <label>Survey classification<select data-room-field="use">${Object.entries(ROOM_USES).map(([value, label]) => `<option value="${value}" ${room.use === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="form-split"><label>Ceiling height (m)<input data-room-field="ceiling_height_m" type="number" inputmode="decimal" min="1.5" max="4.5" step=".01" value="${room.ceiling_height_m ?? ''}" /></label><label>Lights<input data-room-field="light_count" type="number" inputmode="numeric" min="0" step="1" value="${room.light_count ?? ''}" /></label></div>
      <label class="toggle-row"><input data-room-field="heated" type="checkbox" ${room.heated ? 'checked' : ''} /><span>Heated room</span></label><label class="toggle-row"><input data-room-field="habitable" type="checkbox" ${room.habitable ? 'checked' : ''} /><span>Habitable room</span></label>
      <label>Survey note<textarea data-room-field="notes" rows="3" placeholder="Construction, insulation, ventilation or access notes">${escapeHTML(room.notes || '')}</textarea></label>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-room">Delete room</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'item') {
    const item = storey.survey_items?.find(entry => entry.id === state.selection.id); if (!item) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = item.label || symbolLabel(item.kind) || 'Survey item'; elements.selectionBadge.textContent = SYMBOL_GROUPS[symbolGroupOf(item)]?.label || 'Symbol';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:${symbolColor(item)}"></i><span>${escapeHTML(SYMBOL_GROUPS[symbolGroupOf(item)]?.label || 'Symbol')}<strong>${escapeHTML(item.label || symbolLabel(item.kind))}</strong></span></div>
      <label>Symbol<select data-item-field="kind">${Object.entries(SYMBOL_GROUPS).map(([groupKey, group]) => `<optgroup label="${escapeHTML(group.label)}">${Object.entries(group.items).map(([kind, meta]) => `<option value="${kind}" ${item.kind === kind ? 'selected' : ''}>${escapeHTML(meta.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>Group / colour<select data-item-field="group">${Object.entries(SYMBOL_GROUPS).map(([groupKey, group]) => `<option value="${groupKey}" ${symbolGroupOf(item) === groupKey ? 'selected' : ''}>${escapeHTML(group.label)}</option>`).join('')}</select></label>
      <label>Label / reference<input data-item-field="label" type="text" value="${escapeHTML(item.label || '')}" placeholder="e.g. Living room radiator" /></label>
      <label>Fuel / system detail<input data-item-field="fuel" type="text" value="${escapeHTML(item.fuel || '')}" placeholder="e.g. Gas boiler, electric, ASHP" /></label>
      <label>Survey note<textarea data-item-field="notes" rows="3" placeholder="Controls, condition, ventilation or evidence">${escapeHTML(item.notes || '')}</textarea></label>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-item">Delete item</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'opening') {
    const found = findOpening(state.selection.id); if (!found) { state.selection = null; return renderInspector(); }
    const { host, opening, surface } = found; const derivedWall = surface === 'external' ? derived?.walls.find(item => item.id === host.id) : null; const derivedOpening = derivedWall?.openings.find(item => item.id === opening.id);
    elements.inspectorHeading.textContent = opening.kind === 'window' ? 'Window' : (surface === 'partition' ? 'Internal door' : 'External door'); elements.selectionBadge.textContent = 'Opening';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#5b9ab4"></i><span>Derived orientation<strong>${derivedOpening?.orientation || '—'}</strong></span></div>
      <label>Opening type<select data-opening-field="style">${Object.entries(OPENING_TYPES).map(([style, meta]) => `<option value="${style}" ${(opening.style || opening.kind) === style ? 'selected' : ''}>${escapeHTML(meta.label)}</option>`).join('')}</select></label>
      <div class="form-split"><label>Width (m)<input data-opening-field="width_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.width_m}" /></label><label>Height (m)<input data-opening-field="height_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.height_m}" /></label></div>
      <label>Offset from left corner (m)<input data-opening-field="offset_m" type="number" inputmode="decimal" min="0" step=".01" value="${opening.offset_m}" /></label>
      <label>Glazed area ratio <input data-opening-field="glazed_area_ratio" type="number" inputmode="decimal" min="0" max="1" step=".01" placeholder="Use only to check door classification" value="${opening.glazed_area_ratio ?? ''}" /></label>
      <div class="stat-stack"><div class="stat-card"><span>Area</span><strong>${squareMetres(derivedOpening?.area_m2)}</strong></div><div class="stat-card"><span>Wall</span><strong>${derivedWall?.orientation || '—'}</strong></div></div>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-opening">Delete</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else {
    elements.inspectorHeading.textContent = 'Survey plan'; elements.selectionBadge.textContent = 'Plan';
    elements.inspector.innerHTML = `<div class="empty-state"><b>Build the plan room by room.</b>Use <strong>Add room</strong> to size the first room, then tap an external wall to grow the next room from it. Add doors, windows, services, heating and lights from the <strong>Add symbol or opening</strong> list. The outline, walls and heat-loss perimeter come from the rooms.</div><div class="stat-stack"><div class="stat-card"><span>Floor area</span><strong>${squareMetres(derived?.floor_area_m2)}</strong></div><div class="stat-card"><span>Rooms</span><strong>${derived?.room_count || 0}</strong></div></div><label>Storey name<input data-storey-field="name" type="text" value="${escapeHTML(storey.name)}" /></label><label>Storey height (m)<input data-storey-field="height_m" type="number" inputmode="decimal" min="2" max="3.5" step=".01" value="${storey.height_m}" /></label><p class="field-note">The plan records survey evidence for later RdSAP and retrofit workflows. Verify all dimensions and classifications before export.</p>`;
  }
}

// Floating action bar pinned above the current selection.
function renderContextBar() {
  const bar = elements.contextBar; if (!bar) return;
  const selection = state.selection; const storey = activeStorey();
  if (!selection || state.pendingRoom || state.pendingBox) { bar.classList.add('hidden'); return; }
  let anchor = null; let buttons = '';
  if (selection.type === 'room') {
    const room = storey.rooms?.find(item => item.id === selection.id); if (!room) { bar.classList.add('hidden'); return; }
    const box = boundsOf(room.polygon); anchor = screenPoint({ x: box.x + box.width / 2, y: box.y });
    buttons = `<button data-action="edit-room-size" title="Set exact size">${box.width.toFixed(2)} × ${box.depth.toFixed(2)} m</button><span class="ctx-sep"></span><button data-action="duplicate-room" title="Duplicate room">Duplicate</button><button class="ctx-danger" data-action="delete-room" title="Delete room">Delete</button>`;
  } else if (selection.type === 'wall') {
    const wall = getWall(storey, selection.id); if (!wall) { bar.classList.add('hidden'); return; }
    const from = storey.outline[wall.from]; const to = storey.outline[wall.to];
    anchor = screenPoint({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    buttons = `<button data-action="cycle-wall-type" title="Change wall type">${escapeHTML(WALL_TYPES[wall.type] || 'Wall')}</button><span class="ctx-sep"></span><button data-action="split-wall" title="Add a corner">Split</button>`;
  } else if (selection.type === 'item') {
    const item = storey.survey_items?.find(entry => entry.id === selection.id); if (!item) { bar.classList.add('hidden'); return; }
    anchor = screenPoint(item.point);
    buttons = `<button data-action="duplicate-item">Duplicate</button><button class="ctx-danger" data-action="delete-item">Delete</button>`;
  } else if (selection.type === 'opening') {
    const found = findOpening(selection.id); if (!found) { bar.classList.add('hidden'); return; }
    const host = found.host; const from = found.surface === 'external' ? storey.outline[host.from] : host.from; const to = found.surface === 'external' ? storey.outline[host.to] : host.to;
    const length = distance(from, to) || 1; const mid = pointAlong(from, to, Math.min(1, (found.opening.offset_m + found.opening.width_m / 2) / length));
    anchor = screenPoint(mid);
    buttons = `<button class="ctx-danger" data-action="delete-opening">Delete</button>`;
  }
  if (!anchor) { bar.classList.add('hidden'); return; }
  bar.innerHTML = buttons; bar.classList.remove('hidden');
  const width = bar.offsetWidth || 200; const height = bar.offsetHeight || 38;
  bar.style.left = `${Math.max(8, Math.min(frame.clientWidth - width - 8, anchor.x - width / 2))}px`;
  bar.style.top = `${Math.max(8, Math.min(frame.clientHeight - height - 8, anchor.y - height - 14))}px`;
}

function renderWarnings() {
  const warnings = state.derived?.warnings || []; elements.warningCount.textContent = warnings.length; elements.warningCount.classList.toggle('clear', !warnings.length);
  elements.warnings.innerHTML = warnings.length ? warnings.map(warning => `<li>${escapeHTML(warning)}</li>`).join('') : '<li class="good">No geometry checks need attention.</li>';
}

function renderMetrics() {
  const current = currentDerivedStorey(); elements.area.textContent = squareMetres(current?.floor_area_m2); elements.hlp.textContent = metres(current?.heat_loss_perimeter_m); elements.wallArea.textContent = squareMetres(current?.net_wall_area_m2);
  const openings = (current?.walls.reduce((count, wall) => count + wall.openings.length, 0) || 0) + (current?.partition_opening_count || 0); elements.openings.textContent = String(openings);
}

function surveyInstructions() {
  if (state.interactionNotice) return state.interactionNotice;
  if (state.tool === 'place') return state.placement?.mode === 'opening' ? `Tap a wall to add a ${placementLabel()} · Esc to stop` : `Tap the plan to place a ${placementLabel()} · Esc to stop`;
  if (state.tool === 'room') return activeStorey().rooms?.length ? 'Tap an external wall — the next room grows from it' : 'Tap or drag to place your first room';
  if (state.tool === 'select') {
    if (state.selection?.type === 'room') return 'Drag to move · drag a wall to resize · Enter to type exact size · Delete to remove';
    return 'Tap a room or wall · drag a room to move it · drag a wall to resize';
  }
  if (state.tool === 'partition') return state.partitionStart ? 'Tap the end of the internal wall · corners, walls and axes snap automatically' : 'Tap or drag to start an internal wall · then tap its end';
  if (state.tool === 'split') return 'Tap an external wall to insert an editable corner exactly on it';
  if (state.tool === 'door') return 'Tap any external or internal wall to add a door';
  if (state.tool === 'window') return 'Tap any external or internal wall to add a window';
  if (state.tool === 'heating') return 'Tap inside the plan to add a radiator · select it to change its type';
  if (state.tool === 'box') return activeStorey().outline.length ? 'Drag a new external shell to replace this storey' : 'Drag the external shell, then enter its measured size';
  if (state.tool === 'extend') return activeStorey().boxes?.length ? 'Drag an adjoining external shell extension' : 'Draw the external shell before adding an extension';
  if (state.tool === 'draw') return activeStorey().is_closed ? 'Shell closed · use Split wall to add corners or Draw internal wall for partitions' : 'Tap shell corners · use Finish shape when the green suggestion is right';
  if (state.tool === 'north') return 'Tap in the plan to point north from the centre';
  return 'Tap measurements to type them · drag corners or walls · pinch to zoom';
}

function render() {
  state.derived = derivePlan(state.plan); const storey = activeStorey();
  elements.address.value = state.plan.property_address || ''; elements.postcode.value = state.plan.postcode || ''; elements.north.value = String(Math.round(state.plan.north_offset_deg || 0)); elements.northReadout.textContent = `${Math.round(state.plan.north_offset_deg || 0)}°`;
  elements.storeyKicker.textContent = storey.name; elements.canvasHint.classList.toggle('hidden', storey.outline.length > 0 || Boolean(state.pendingBox) || Boolean(state.pendingRoom));
  elements.instruction.textContent = surveyInstructions(); document.querySelectorAll('.tool-button').forEach(button => button.classList.toggle('active', button.dataset.tool === state.tool));
  if (elements.placementNote) elements.placementNote.textContent = state.placement ? `Placing ${placementLabel()} — tap the plan. Esc to stop.` : '';
  renderStoreyTabs(); renderRail(); renderMetrics(); renderInspector(); renderWarnings(); renderCanvas(); renderContextBar();
}

function instructions() {
  if (state.tool === 'box') return activeStorey().outline.length ? 'Draw room replaces this storey · drag rough bounds, then enter the measured size on the plan' : 'Drag rough room bounds · enter the measured width and depth on the plan';
  if (state.tool === 'extend') return activeStorey().boxes?.length ? 'Drag an adjoining room · enter its measured size · it merges into one footprint' : 'Draw the first room before adding adjoining rooms';
  if (state.tool === 'draw') return activeStorey().is_closed ? 'Outline closed · switch to Select to classify walls and add openings' : (activeStorey().outline.length ? 'Tap the next corner · use Finish shape when the green suggestion is right' : 'Tap the first internal corner to begin · drag to size a wall · hold Shift for free angle');
  if (state.tool === 'opening') return 'Tap a heat-loss wall to add a window · change it to a door in the inspector';
  if (state.tool === 'north') return 'Tap in the plan to point north from the centre, or use the North control';
  return 'Tap a measurement to type it · drag a corner or straight wall to reshape · pinch to zoom';
}

function findOpening(id) {
  const storey = activeStorey();
  for (const wall of storey.walls || []) { const opening = wall.openings?.find(item => item.id === id); if (opening) return { host: wall, opening, surface: 'external' }; }
  for (const partition of storey.partitions || []) { const opening = partition.openings?.find(item => item.id === id); if (opening) return { host: partition, opening, surface: 'partition' }; }
  return null;
}

function closestSurface(storey, point, tolerance = Infinity) {
  const wallMatch = closestWall(storey, point, tolerance);
  const partitionMatch = closestPartition(storey, point, tolerance);
  if (!partitionMatch || (wallMatch && wallMatch.distance <= partitionMatch.distance)) return wallMatch ? { ...wallMatch, host: wallMatch.wall, surface: 'external' } : null;
  return { ...partitionMatch, host: partitionMatch.partition, surface: 'partition' };
}

function dimensionHitAt(point) {
  return [...state.dimensionHits].reverse().find(hit => point.x >= hit.x && point.x <= hit.x + hit.width && point.y >= hit.y && point.y <= hit.y + hit.height);
}

function placeDimensionPopover(anchor) {
  const popover = elements.dimensionPopover; const width = popover.offsetWidth || 276; const height = popover.offsetHeight || 160;
  const left = Math.max(10, Math.min(frame.clientWidth - width - 10, anchor.x - width / 2));
  const top = Math.max(10, Math.min(frame.clientHeight - height - 10, anchor.y + 22));
  popover.style.left = `${left}px`; popover.style.top = `${top}px`;
}

function hideDimensionEditor({ redraw = true } = {}) {
  state.measurementEditor = null; elements.dimensionPopover.classList.add('hidden'); elements.dimensionPopover.innerHTML = '';
  if (redraw) renderCanvas();
}

function openDimensionEditor(hit) {
  if (hit.kind === 'room-size') {
    const room = activeStorey().rooms?.find(item => item.id === hit.roomId); if (!room) return;
    const box = boundsOf(room.polygon);
    state.measurementEditor = { kind: 'room-size', roomId: room.id };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">${escapeHTML(room.name || 'Room')} size</span><div class="popover-fields"><label>Width (m)<input id="sizeWidthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.width.toFixed(2)}" /></label><label>Depth (m)<input id="sizeDepthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.depth.toFixed(2)}" /></label></div><span class="popover-note">Type your laser measurements. Tab moves between fields · Enter applies.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Set size</button></div>`;
    elements.dimensionPopover.classList.remove('hidden'); placeDimensionPopover(hit.centre); renderCanvas();
    requestAnimationFrame(() => { const input = $('#sizeWidthInput'); input?.focus({ preventScroll: true }); input?.select(); });
    return;
  }
  if (hit.kind === 'box') {
    const box = state.pendingBox; if (!box) return;
    state.measurementEditor = { kind: 'box', field: hit.field };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">Measured room</span><div class="popover-fields"><label>Width (m)<input id="boxWidthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.width}" /></label><label>Depth (m)<input id="boxDepthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${box.depth}" /></label></div><span class="popover-note">The rough drag sets position. Enter your laser measurements, then place the room.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Place room</button></div>`;
  } else if (hit.kind === 'room') {
    const room = state.pendingRoom; if (!room) return;
    state.measurementEditor = { kind: 'room', field: hit.field };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">Measured room zone</span><label>Room name<input id="roomNameInput" type="text" value="${escapeHTML(room.name || '')}" placeholder="e.g. Kitchen" /></label><div class="popover-fields"><label>Width (m)<input id="roomWidthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${room.width}" /></label><label>Depth (m)<input id="roomDepthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${room.depth}" /></label></div><span class="popover-note">Name this space now. You can record room-use, lights and heating information after placing it.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Place room</button></div>`;
  } else if (hit.kind === 'wall') {
    const wall = getWall(activeStorey(), hit.wallId); if (!wall) return;
    state.selection = { type: 'wall', id: wall.id }; state.measurementEditor = { kind: 'wall', wallId: wall.id };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">Wall measurement</span><label>Length (m)<input id="wallLengthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${wallLength(activeStorey(), wall).toFixed(2)}" /></label><label>Keep this corner fixed<select id="wallAnchorInput"><option value="from">Start corner</option><option value="to">End corner</option></select></label><span class="popover-note">The opposite corner moves. Drag either corner instead if you need to reshape adjoining walls.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Set length</button></div>`;
  } else if (hit.kind === 'partition') {
    const partition = activeStorey().partitions?.find(item => item.id === hit.partitionId); if (!partition) return;
    state.selection = { type: 'partition', id: partition.id }; state.measurementEditor = { kind: 'partition', partitionId: partition.id };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">Internal wall measurement</span><label>Length (m)<input id="partitionLengthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${segmentLength(partition).toFixed(2)}" /></label><label>Keep this end fixed<select id="partitionAnchorInput"><option value="from">Start</option><option value="to">End</option></select></label><span class="popover-note">The opposite end moves. Drag an endpoint to reshape the wall.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Set length</button></div>`;
  } else return;
  elements.dimensionPopover.classList.remove('hidden'); placeDimensionPopover(hit.centre); renderCanvas();
  requestAnimationFrame(() => {
    const input = hit.kind === 'box' ? (hit.field === 'width' ? $('#boxWidthInput') : $('#boxDepthInput')) : (hit.kind === 'room' ? (hit.field === 'width' ? $('#roomWidthInput') : $('#roomDepthInput')) : (hit.kind === 'partition' ? $('#partitionLengthInput') : $('#wallLengthInput')));
    input?.focus({ preventScroll: true }); input?.select();
  });
}

function clampOpenings(storey) {
  for (const wall of storey.walls || []) {
    const length = wallLength(storey, wall);
    for (const opening of wall.openings || []) opening.offset_m = Math.max(0, Math.min(Number(opening.offset_m) || 0, Math.max(0, length - (Number(opening.width_m) || 0))));
  }
  for (const partition of storey.partitions || []) {
    const length = segmentLength(partition);
    for (const opening of partition.openings || []) opening.offset_m = Math.max(0, Math.min(Number(opening.offset_m) || 0, Math.max(0, length - (Number(opening.width_m) || 0))));
  }
}

function outlineIsSafe(outline) {
  return outline.length >= 3 && outline.every((point, index) => distance(point, outline[(index + 1) % outline.length]) >= .1) && !isSelfIntersecting(outline);
}

function applyDimensionEditor() {
  const editor = state.measurementEditor;
  if (!editor) return;
  if (editor.kind === 'room-size') {
    const storey = activeStorey(); const room = storey.rooms?.find(item => item.id === editor.roomId);
    const width = Number($('#sizeWidthInput')?.value); const depth = Number($('#sizeDepthInput')?.value);
    if (!room || !(width >= .1) || !(depth >= .1)) return;
    const box = boundsOf(room.polygon);
    const trial = clone(room); resizeRoomEdge(trial, 'right', box.x + width); resizeRoomEdge(trial, 'bottom', box.y + depth);
    const others = storey.rooms.filter(item => item.id !== room.id).map(item => boundsOf(item.polygon));
    if (others.length && !boxesConnected([...others, boundsOf(trial.polygon)])) { const note = elements.dimensionPopover.querySelector('.popover-note'); if (note) note.textContent = 'That size would disconnect the room from the plan.'; return; }
    hideDimensionEditor({ redraw: false });
    transaction('set room size', () => { resizeRoomEdge(room, 'right', box.x + width); resizeRoomEdge(room, 'bottom', box.y + depth); rebuildStoreyFromRooms(storey); clampOpenings(storey); });
    return;
  }
  if (editor.kind === 'box') {
    const width = Number($('#boxWidthInput')?.value); const depth = Number($('#boxDepthInput')?.value);
    if (!(width >= .1 && depth >= .1)) return;
    state.pendingBox.width = width; state.pendingBox.depth = depth; hideDimensionEditor({ redraw: false }); commitPendingBox(); return;
  }
  if (editor.kind === 'room') {
    const width = Number($('#roomWidthInput')?.value); const depth = Number($('#roomDepthInput')?.value);
    if (!(width >= .1 && depth >= .1) || !state.pendingRoom) return;
    state.pendingRoom.width = width; state.pendingRoom.depth = depth; state.pendingRoom.name = $('#roomNameInput')?.value || '';
    hideDimensionEditor({ redraw: false }); commitPendingRoom(); return;
  }
  if (editor.kind === 'partition') {
    const storey = activeStorey(); const partition = storey.partitions?.find(item => item.id === editor.partitionId); const length = Number($('#partitionLengthInput')?.value); const anchor = $('#partitionAnchorInput')?.value || 'from';
    if (!partition || !(length >= .1)) return;
    const current = segmentLength(partition); if (!current) return; const dx = (partition.to.x - partition.from.x) / current; const dy = (partition.to.y - partition.from.y) / current;
    hideDimensionEditor({ redraw: false }); transaction('set internal wall length', () => {
      if (anchor === 'to') partition.from = { x: partition.to.x - dx * length, y: partition.to.y - dy * length };
      else partition.to = { x: partition.from.x + dx * length, y: partition.from.y + dy * length };
      clampOpenings(storey); state.selection = { type: 'partition', id: partition.id };
    }); return;
  }
  const storey = activeStorey(); const wall = getWall(storey, editor.wallId); const length = Number($('#wallLengthInput')?.value);
  const setNote = text => { const note = elements.dimensionPopover.querySelector('.popover-note'); if (note) note.textContent = text; };
  if (!wall || !(length >= .1)) return;
  const room = roomOwningWall(storey, wall); const side = wallSideOfRoom(room, wall, storey);
  if (!room || !side) { setNote('Select the room to set its size.'); return; }
  const box = boundsOf(room.polygon); const horizontal = side === 'top' || side === 'bottom';
  const resizeSide = horizontal ? 'right' : 'bottom'; const coord = horizontal ? box.x + length : box.y + length;
  const trial = clone(room); resizeRoomEdge(trial, resizeSide, coord);
  const others = storey.rooms.filter(item => item.id !== room.id).map(item => boundsOf(item.polygon));
  if (others.length && !boxesConnected([...others, boundsOf(trial.polygon)])) { setNote('That length would disconnect the room from the plan.'); return; }
  hideDimensionEditor({ redraw: false });
  transaction('set room size', () => { resizeRoomEdge(room, resizeSide, coord); rebuildStoreyFromRooms(storey); clampOpenings(storey); state.selection = { type: 'room', id: room.id }; });
}

function pointerDown(event) {
  event.preventDefault(); const point = clientPoint(event); const hit = dimensionHitAt(point);
  if (hit && (state.tool === 'select' || state.pendingBox || state.pendingRoom)) { openDimensionEditor(hit); return; }
  if (state.measurementEditor) hideDimensionEditor();
  try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer not capturable */ } state.pointers.set(event.pointerId, point);
  if (state.pointers.size === 2) { const points = [...state.pointers.values()]; state.gesture = { startDistance: distance(points[0], points[1]), startScale: state.view.scale, startMid: midpoint(points[0], points[1]), startView: { x: state.view.x, y: state.view.y } }; state.drag = null; return; }
  state.drag = { id: event.pointerId, start: point, view: { x: state.view.x, y: state.view.y }, moved: false, mode: 'pan' };
  if (state.tool === 'partition') {
    const snapped = snapWorldPoint(worldPoint(point));
    if (!state.partitionStart) state.partitionStart = snapped;
    state.partitionPreview = snapped; state.drag = { ...state.drag, mode: 'partition-draw', startWorld: clone(state.partitionStart) }; renderCanvas(); return;
  }
  if (state.tool !== 'select' || state.pendingBox || state.pendingRoom) return;
  const storey = activeStorey(); const world = worldPoint(point);
  const wallHit = closestWall(storey, world, Math.max(.18, 16 / state.view.scale));
  if (wallHit && isAxisAlignedWall(storey, wallHit.wall)) {
    const room = roomOwningWall(storey, wallHit.wall); const side = wallSideOfRoom(room, wallHit.wall, storey);
    if (room && side) { state.drag = { ...state.drag, mode: 'wall', roomId: room.id, side, before: snapshot(), changed: false }; return; }
  }
  // dragging inside a room moves the whole room (with alignment guides)
  const insideRoom = roomAt(storey, world);
  if (insideRoom) {
    state.drag = { ...state.drag, mode: 'room-move', roomId: insideRoom.id, grabWorld: world, origin: boundsOf(insideRoom.polygon), before: snapshot(), changed: false };
  }
  const partitionHit = closestPartition(storey, world, Math.max(.18, 16 / state.view.scale));
  if (partitionHit) {
    const endpoint = distance(world, partitionHit.partition.from) <= distance(world, partitionHit.partition.to) ? 'from' : 'to';
    if (distance(world, partitionHit.partition[endpoint]) <= Math.max(.22, 20 / state.view.scale)) state.drag = { ...state.drag, mode: 'partition-end', partitionId: partitionHit.partition.id, endpoint, before: snapshot(), changed: false };
  }
}

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function constrainedPoint(point, event) {
  const storey = activeStorey(); let next = snapWorldPoint(worldPoint(point)); const last = storey.outline.at(-1); if (!last) return next;
  const wantsOrtho = elements.orthogonal.checked && !event.shiftKey;
  if (wantsOrtho) { const dx = next.x - last.x; const dy = next.y - last.y; next = Math.abs(dx) >= Math.abs(dy) ? { x: next.x, y: last.y } : { x: last.x, y: next.y }; }
  const typed = Number(elements.dimension.value); if (typed > 0) { const dx = next.x - last.x; const dy = next.y - last.y; const length = Math.hypot(dx, dy); if (length) next = { x: last.x + dx / length * typed, y: last.y + dy / length * typed }; }
  return snapWorldPoint(next);
}

function closestVertexIndex(outline, point, tolerance) {
  let closest = -1; let closestDistance = tolerance;
  outline.forEach((vertex, index) => { const gap = distance(vertex, point); if (gap <= closestDistance) { closest = index; closestDistance = gap; } });
  return closest;
}

function isAxisAlignedWall(storey, wall) {
  const from = storey.outline[wall.from]; const to = storey.outline[wall.to]; return Boolean(from && to && (Math.abs(from.x - to.x) < 1e-8 || Math.abs(from.y - to.y) < 1e-8));
}

function snapToOutlineAxes(point, outline, { exclude = [] } = {}) {
  const next = snapWorldPoint(point); const threshold = Math.max(.14, 16 / state.view.scale); const candidates = outline.filter((_, index) => !exclude.includes(index));
  const x = candidates.reduce((best, candidate) => Math.abs(candidate.x - next.x) < Math.abs(best - next.x) ? candidate.x : best, next.x);
  const y = candidates.reduce((best, candidate) => Math.abs(candidate.y - next.y) < Math.abs(best - next.y) ? candidate.y : best, next.y);
  return { x: Math.abs(x - next.x) <= threshold ? x : next.x, y: Math.abs(y - next.y) <= threshold ? y : next.y };
}

// Snap a moving room's edges to other rooms' edges; returns the offset plus the
// guide lines to draw. Magnetic within ~14 screen px, otherwise falls to grid.
function snapRoomMove(storey, roomId, box) {
  const tol = Math.max(.1, 14 / state.view.scale);
  const targetsX = []; const targetsY = [];
  for (const other of storey.rooms || []) {
    if (other.id === roomId) continue;
    const b = boundsOf(other.polygon);
    targetsX.push(b.x, b.x + b.width); targetsY.push(b.y, b.y + b.depth);
  }
  const edgesX = [box.x, box.x + box.width]; const edgesY = [box.y, box.y + box.depth];
  let dx = 0, dy = 0, bestX = tol, bestY = tol; const guides = [];
  for (const edge of edgesX) for (const target of targetsX) { const gap = Math.abs(target - edge); if (gap < bestX) { bestX = gap; dx = target - edge; } }
  for (const edge of edgesY) for (const target of targetsY) { const gap = Math.abs(target - edge); if (gap < bestY) { bestY = gap; dy = target - edge; } }
  const snapped = { x: box.x + dx, y: box.y + dy, width: box.width, depth: box.depth };
  if (dx !== 0) guides.push({ x: Math.abs(targetsX.reduce((best, t) => Math.abs(t - snapped.x) < Math.abs(best - snapped.x) ? t : best, snapped.x) - snapped.x) < 1e-6 ? snapped.x : snapped.x + snapped.width });
  if (dy !== 0) guides.push({ y: Math.abs(targetsY.reduce((best, t) => Math.abs(t - snapped.y) < Math.abs(best - snapped.y) ? t : best, snapped.y) - snapped.y) < 1e-6 ? snapped.y : snapped.y + snapped.depth });
  return { box: snapped, guides };
}

function updateGeometryDrag(point) {
  const drag = state.drag; if (!drag || (drag.mode !== 'wall' && drag.mode !== 'partition-end' && drag.mode !== 'room-move')) return false;
  const storey = activeStorey(); const raw = worldPoint(point);
  if (drag.mode === 'room-move') {
    const room = storey.rooms?.find(item => item.id === drag.roomId); if (!room) return false;
    const rawBox = { x: drag.origin.x + (raw.x - drag.grabWorld.x), y: drag.origin.y + (raw.y - drag.grabWorld.y), width: drag.origin.width, depth: drag.origin.depth };
    const gridBox = { ...rawBox, x: Math.round(rawBox.x / .05) * .05, y: Math.round(rawBox.y / .05) * .05 };
    const { box, guides } = snapRoomMove(storey, room.id, gridBox);
    const others = storey.rooms.filter(item => item.id !== room.id).map(item => boundsOf(item.polygon));
    if (others.length && !boxesConnected([...others, box])) { state.alignGuides = []; return false; }
    room.polygon = rectPolygon(box);
    if (!rebuildStoreyFromRooms(storey)) return false;
    state.alignGuides = guides; clampOpenings(storey); drag.changed = true; return true;
  }
  if (drag.mode === 'partition-end') {
    const partition = storey.partitions?.find(item => item.id === drag.partitionId); if (!partition) return false;
    partition[drag.endpoint] = snapWorldPoint(raw, { exclude: [partition[drag.endpoint === 'from' ? 'to' : 'from']] }); clampOpenings(storey); drag.changed = true; return true;
  }
  // wall drag → resize the owning room's edge, keeping the footprint connected
  const room = storey.rooms?.find(item => item.id === drag.roomId); if (!room || !drag.side) return false;
  const snapped = snapWorldPoint(raw); const coord = (drag.side === 'left' || drag.side === 'right') ? snapped.x : snapped.y;
  const trial = clone(room); resizeRoomEdge(trial, drag.side, coord);
  const others = storey.rooms.filter(item => item.id !== room.id).map(item => boundsOf(item.polygon));
  if (others.length && !boxesConnected([...others, boundsOf(trial.polygon)])) return false;
  resizeRoomEdge(room, drag.side, coord); if (!rebuildStoreyFromRooms(storey)) return false; clampOpenings(storey); drag.changed = true; return true;
}

function commitGeometryDrag(drag) {
  if (!drag.changed) return;
  state.undo.push(drag.before); if (state.undo.length > 100) state.undo.shift(); state.redo = []; state.selection = null; state.interactionNotice = ''; render(); scheduleSave();
}

function boxFromDrag(start, end) {
  const a = snapWorldPoint(worldPoint(start)); const b = snapWorldPoint(worldPoint(end)); const box = normaliseBox({ x: a.x, y: a.y, width: b.x - a.x, depth: b.y - a.y });
  const storey = activeStorey(); if (!storey.outline.length) return box;
  const tolerance = Math.max(.16, 18 / state.view.scale); const xs = [...new Set(storey.outline.map(point => point.x))]; const ys = [...new Set(storey.outline.map(point => point.y))];
  const snapToPlan = (value, candidates) => {
    const closest = candidates.reduce((best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, candidates[0]);
    return Math.abs(closest - value) <= tolerance ? closest : value;
  };
  const left = snapToPlan(box.x, xs); const right = snapToPlan(box.x + box.width, xs); const top = snapToPlan(box.y, ys); const bottom = snapToPlan(box.y + box.depth, ys);
  return normaliseBox({ x: left, y: top, width: right - left, depth: bottom - top });
}

// Hover feedback: highlight the wall or room under the pointer and set a cursor
// that says what a press will do.
function updateHover(point) {
  const storey = activeStorey(); const world = worldPoint(point); let next = null; let cursor = 'default';
  if (state.tool === 'place') cursor = 'copy';
  else if (state.tool === 'room') { const match = storey.rooms?.length ? closestWall(storey, world, Math.max(.35, 30 / state.view.scale)) : null; if (match) { next = { type: 'wall', id: match.wall.id, from: storey.outline[match.wall.from], to: storey.outline[match.wall.to] }; cursor = 'copy'; } else cursor = storey.rooms?.length ? 'not-allowed' : 'copy'; }
  else if (state.tool === 'select') {
    const wallHit = closestWall(storey, world, Math.max(.18, 16 / state.view.scale));
    if (wallHit && isAxisAlignedWall(storey, wallHit.wall)) {
      const from = storey.outline[wallHit.wall.from]; const to = storey.outline[wallHit.wall.to];
      next = { type: 'wall', id: wallHit.wall.id, from, to };
      cursor = Math.abs(from.y - to.y) < 1e-8 ? 'ns-resize' : 'ew-resize';
    } else { const room = roomAt(storey, world); if (room) { next = { type: 'room', id: room.id }; cursor = 'move'; } }
  }
  const changed = JSON.stringify(next?.id ?? null) !== JSON.stringify(state.hover?.id ?? null) || next?.type !== state.hover?.type;
  state.hover = next; canvas.style.cursor = cursor;
  if (changed) renderCanvas();
}

function pointerMove(event) {
  const point = clientPoint(event);
  if (!state.pointers.has(event.pointerId)) { if (event.pointerType !== 'touch') updateHover(point); return; }
  state.pointers.set(event.pointerId, point);
  if (state.pointers.size >= 2 && state.gesture) { const [a, b] = [...state.pointers.values()]; const nextDistance = distance(a, b); const nextMid = midpoint(a, b); const scale = Math.min(220, Math.max(20, state.gesture.startScale * nextDistance / Math.max(1, state.gesture.startDistance))); const focusWorld = worldFromView(state.gesture.startMid, state.gesture.startView, state.gesture.startScale); state.view.scale = scale; state.view.x = nextMid.x - focusWorld.x * scale; state.view.y = nextMid.y - focusWorld.y * scale; renderCanvas(); return; }
  if (!state.drag || state.drag.id !== event.pointerId) return; const dx = point.x - state.drag.start.x; const dy = point.y - state.drag.start.y;
  if (Math.hypot(dx, dy) > 4) state.drag.moved = true;
  if (state.drag.mode === 'wall' || state.drag.mode === 'partition-end' || state.drag.mode === 'room-move') updateGeometryDrag(point);
  else if (state.tool === 'draw') state.drawPreview = constrainedPoint(point, event);
  else if (state.drag.mode === 'partition-draw') state.partitionPreview = snapWorldPoint(worldPoint(point), { exclude: [state.partitionStart] });
  else if (state.tool === 'room') state.roomPreview = boxFromDrag(state.drag.start, point);
  else if (state.tool === 'box' || state.tool === 'extend') state.boxPreview = boxFromDrag(state.drag.start, point);
  else if (state.drag.moved && state.tool !== 'north') { state.view.x = state.drag.view.x + dx; state.view.y = state.drag.view.y + dy; state.drawPreview = null; }
  renderCanvas();
}

function worldFromView(point, view, scale) { return { x: (point.x - view.x) / scale, y: (point.y - view.y) / scale }; }
function pointerUp(event) {
  const point = clientPoint(event); const drag = state.drag; const hadGesture = Boolean(state.gesture); state.pointers.delete(event.pointerId);
  if (state.pointers.size < 2) state.gesture = null;
  if (drag?.id === event.pointerId && !hadGesture) {
    if (drag.mode === 'partition-draw') {
      const end = snapWorldPoint(worldPoint(point), { exclude: [drag.startWorld] });
      if (distance(drag.startWorld, end) >= .1) transaction('add internal wall', () => { activeStorey().partitions.push(makePartition(drag.startWorld, end)); state.partitionStart = null; state.partitionPreview = null; });
      else { state.partitionStart = drag.startWorld; state.partitionPreview = null; renderCanvas(); }
    } else if (state.tool === 'room' && drag.moved && state.roomPreview?.width > 0 && state.roomPreview?.depth > 0) {
      state.pendingRoom = { ...state.roomPreview, name: `Room ${(activeStorey().rooms?.length || 0) + 1}` }; state.roomError = ''; state.selection = null; render();
      const widthHit = state.dimensionHits.find(hit => hit.kind === 'room' && hit.field === 'width'); if (widthHit) openDimensionEditor(widthHit);
    } else if ((state.tool === 'box' || state.tool === 'extend') && drag.moved && state.boxPreview?.width > 0 && state.boxPreview?.depth > 0) {
      state.pendingBox = { ...state.boxPreview, mode: state.tool }; state.boxError = ''; state.selection = null; render();
      const widthHit = state.dimensionHits.find(hit => hit.kind === 'box' && hit.field === 'width'); if (widthHit) openDimensionEditor(widthHit);
    } else if (drag.mode === 'wall' || drag.mode === 'partition-end' || drag.mode === 'room-move') {
      if (drag.changed) commitGeometryDrag(drag); else handleTap(point, event);
    } else if (!drag.moved || state.tool === 'draw') handleTap(point, event);
  }
  state.drag = null; state.drawPreview = null; state.boxPreview = null; state.roomPreview = null; state.alignGuides = []; if (state.tool !== 'partition') state.partitionPreview = null; renderCanvas();
}

function handleTap(point, event) {
  const storey = activeStorey(); const world = state.tool === 'draw' ? constrainedPoint(point, event) : snapWorldPoint(worldPoint(point));
  if (state.tool === 'partition') return;
  if (state.tool === 'room') {
    if (storey.rooms?.length) {
      const match = closestWall(storey, world, Math.max(.35, 30 / state.view.scale));
      if (match) { placeRoomNow(growRoomBoxFromWall(storey, match.wall).box); return; }
      flash('Tap an external wall to grow the next room from it');
      return;
    }
    placeRoomNow(defaultRoomBox(world)); return;
  }
  if (state.tool === 'place') {
    const placement = state.placement; if (!placement) return;
    if (placement.mode === 'opening') {
      const match = closestSurface(storey, world, Math.max(.25, 22 / state.view.scale)); if (!match) return;
      if (match.surface === 'external' && (match.host.type === 'party' || match.host.heat_loss_mode === 'none')) return;
      transaction('add opening', () => { const opening = makeOpening(placement.style, Number(match.offset_m.toFixed(2))); match.host.openings.push(opening); clampOpenings(storey); state.selection = { type: 'opening', id: opening.id }; });
      return;
    }
    transaction('add symbol', () => { const item = makeSurveyItem(placement.kind, world, { group: placement.group, label: placement.label || '' }); storey.survey_items.push(item); state.selection = { type: 'item', id: item.id }; });
    return;
  }
  if (state.tool === 'split') {
    const match = closestWall(storey, world, Math.max(.2, 20 / state.view.scale)); if (!match) return;
    const result = splitExternalWall(storey, match.wall.id, match.point); if (!result) return;
    transaction('split external wall', () => { Object.assign(storey, result.storey); storey.boxes = []; state.tool = 'select'; state.selection = { type: 'wall', id: result.wallId }; }); return;
  }
  if (state.tool === 'door' || state.tool === 'window') {
    const match = closestSurface(storey, world, Math.max(.2, 20 / state.view.scale)); if (!match) return;
    if (match.surface === 'external' && (match.host.type === 'party' || match.host.heat_loss_mode === 'none')) return;
    transaction(`add ${state.tool}`, () => { const opening = makeOpening(state.tool === 'door' ? 'door' : 'window', Number(match.offset_m.toFixed(2))); match.host.openings.push(opening); clampOpenings(storey); state.selection = { type: 'opening', id: opening.id }; }); return;
  }
  if (state.tool === 'heating') {
    transaction('add heating item', () => { const item = makeSurveyItem('radiator', world); storey.survey_items.push(item); state.selection = { type: 'item', id: item.id }; }); return;
  }
  if (state.tool === 'box' || state.tool === 'extend') return;
  if (state.tool === 'draw') {
    if (storey.is_closed) return;
    if (storey.outline.length >= 3 && distance(world, storey.outline[0]) < Math.max(.25, 15 / state.view.scale)) {
      transaction('close outline', () => { storey.is_closed = true; syncWalls(storey); }); return;
    }
    transaction('add corner', () => { storey.boxes = []; storey.outline.push(world); }); return;
  }
  if (state.tool === 'opening') {
    const match = closestWall(storey, world, Math.max(.2, 18 / state.view.scale));
    if (!match || match.wall.type === 'party' || match.wall.heat_loss_mode === 'none') return;
    transaction('add opening', () => { const opening = makeOpening('window', Number(match.offset_m.toFixed(2))); match.wall.openings.push(opening); state.selection = { type: 'opening', id: opening.id }; }); return;
  }
  if (state.tool === 'north') {
    const centre = centroid(storey.outline); if (!centre) return; const dx = world.x - centre.x; const dy = world.y - centre.y; if (!dx && !dy) return;
    transaction('set north', () => { state.plan.north_offset_deg = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360); }); return;
  }
  if (state.tool === 'select') {
    const opening = closestOpening(storey, world, Math.max(.2, 18 / state.view.scale));
    if (opening) { state.selection = { type: 'opening', id: opening.opening.id }; render(); return; }
    const item = closestSurveyItem(storey, world, Math.max(.25, 20 / state.view.scale));
    if (item) { state.selection = { type: 'item', id: item.id }; render(); return; }
    const partition = closestPartition(storey, world, Math.max(.18, 16 / state.view.scale));
    if (partition) { state.selection = { type: 'partition', id: partition.partition.id }; render(); return; }
    const room = roomAt(storey, world);
    if (room) { state.selection = { type: 'room', id: room.id }; render(); return; }
  }
  const opening = closestOpening(storey, world, Math.max(.18, 16 / state.view.scale));
  if (opening) { state.selection = { type: 'opening', id: opening.opening.id }; render(); return; }
  const wall = closestWall(storey, world, Math.max(.16, 14 / state.view.scale)); state.selection = wall ? { type: 'wall', id: wall.wall.id } : null; render();
}

function centroid(points) { if (!points?.length) return null; return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 }); }
function closestOpening(storey, point, tolerance) {
  let closest = null;
  const surfaces = [
    ...(storey.walls || []).map(wall => ({ host: wall, surface: 'external', from: storey.outline[wall.from], to: storey.outline[wall.to] })),
    ...(storey.partitions || []).map(partition => ({ host: partition, surface: 'partition', from: partition.from, to: partition.to }))
  ];
  for (const surface of surfaces) for (const opening of surface.host.openings || []) {
    const { from, to } = surface; const length = distance(from, to); if (!length) continue;
    const a = pointAlong(from, to, opening.offset_m / length); const b = pointAlong(from, to, (opening.offset_m + opening.width_m) / length);
    const match = pointToSegment(point, a, b); if (match.distance <= tolerance && (!closest || match.distance < closest.distance)) closest = { ...surface, opening, distance: match.distance };
  }
  return closest;
}
function pointToSegment(point, a, b) { const dx = b.x - a.x; const dy = b.y - a.y; const lengthSq = dx * dx + dy * dy; const t = lengthSq ? Math.max(0, Math.min(1, ((point.x-a.x)*dx + (point.y-a.y)*dy) / lengthSq)) : 0; const projected = { x:a.x+dx*t, y:a.y+dy*t }; return { point: projected, distance: distance(point, projected) }; }
function pointInPolygon(point, polygon = []) {
  let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]; const b = polygon[j]; if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside; } return inside;
}
function roomAt(storey, point) { return [...(storey.rooms || [])].reverse().find(room => pointInPolygon(point, room.polygon)); }
function closestSurveyItem(storey, point, tolerance) { let closest = null; for (const item of storey.survey_items || []) { const gap = distance(point, item.point); if (gap <= tolerance && (!closest || gap < closest.gap)) closest = { ...item, gap }; } return closest; }

// ----------------------------------------------------- symbols & openings ---
// One grouped dropdown places every symbol and opening. Each group has a colour.

// The rail: colour-coded group chips + one row of icon buttons for the active
// group. Everything is one tap away — no scrolling through a dropdown.
const RAIL_SHORT = { heating_producers: 'Producers', heating_emitters: 'Emitters', heating_controls: 'Controls' };
const RAIL_GROUPS = [
  { key: 'openings', label: 'Openings', color: '#5b9ab4' },
  ...Object.entries(SYMBOL_GROUPS).map(([key, group]) => ({ key, label: group.label, color: group.color }))
].map(group => ({ ...group, short: RAIL_SHORT[group.key] || group.label }));

function railItemsFor(groupKey) {
  if (groupKey === 'openings') return Object.entries(OPENING_TYPES).map(([style, meta]) => ({ value: `open:${style}`, label: meta.label, icon: iconFor(style), color: meta.base === 'window' ? '#5b9ab4' : '#ec5a35' }));
  const group = SYMBOL_GROUPS[groupKey]; if (!group) return [];
  return Object.entries(group.items).map(([kind, meta]) => ({ value: kind === 'custom' ? 'custom' : `sym:${kind}`, label: meta.label, icon: iconFor(kind), color: group.color }));
}

function renderRail() {
  if (!elements.railGroups) return;
  elements.railGroups.innerHTML = RAIL_GROUPS.map(group =>
    `<button class="rail-chip ${group.key === state.railGroup ? 'active' : ''}" data-rail-group="${group.key}" style="--chip:${group.color}" role="tab" aria-selected="${group.key === state.railGroup}"><span class="lbl-full">${escapeHTML(group.label)}</span><span class="lbl-short">${escapeHTML(group.short)}</span></button>`).join('');
  const armed = state.placement ? (state.placement.mode === 'opening' ? `open:${state.placement.style}` : (state.placement.kind === 'custom' ? 'custom' : `sym:${state.placement.kind}`)) : '';
  elements.railItems.innerHTML = railItemsFor(state.railGroup).map(item =>
    `<button class="rail-item ${item.value === armed ? 'active' : ''}" data-rail-item="${item.value}" style="--tint:${item.color}" title="${escapeHTML(item.label)}">
       <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${item.icon}"/></svg><span>${escapeHTML(item.label)}</span>
     </button>`).join('');
  if (elements.customSymbolGroup && !elements.customSymbolGroup.options.length) elements.customSymbolGroup.innerHTML = Object.entries(SYMBOL_GROUPS).map(([key, group]) => `<option value="${key}">${escapeHTML(group.label)}</option>`).join('');
}

function selectRailGroup(key) { state.railGroup = key; toggleCustomRow(false); renderRail(); }

function toggleCustomRow(show) { elements.customSymbolRow?.classList.toggle('hidden', !show); }

function disarmPlacement() { state.placement = null; toggleCustomRow(false); if (state.tool === 'place') state.tool = 'select'; render(); }

function armPlacementFromPicker(value) {
  if (!value) return disarmPlacement();
  // tapping the armed item again turns it off
  const current = state.placement ? (state.placement.mode === 'opening' ? `open:${state.placement.style}` : (state.placement.kind === 'custom' ? 'custom' : `sym:${state.placement.kind}`)) : '';
  if (value === current) return disarmPlacement();
  if (value === 'custom') { toggleCustomRow(true); return; }
  toggleCustomRow(false);
  if (value.startsWith('open:')) state.placement = { mode: 'opening', style: value.slice(5) };
  else if (value.startsWith('sym:')) state.placement = { mode: 'symbol', kind: value.slice(4) };
  hideDimensionEditor({ redraw: false }); state.tool = 'place'; state.selection = null; render();
}

function armCustomSymbol() {
  const label = (elements.customSymbolLabel?.value || '').trim(); const group = elements.customSymbolGroup?.value || 'other';
  if (!label) { elements.customSymbolLabel?.focus(); return; }
  state.placement = { mode: 'symbol', kind: 'custom', group, label }; state.tool = 'place'; state.selection = null; toggleCustomRow(false); render();
}

function placementLabel() {
  const placement = state.placement; if (!placement) return '';
  if (placement.mode === 'opening') return OPENING_TYPES[placement.style]?.label || 'opening';
  return placement.kind === 'custom' ? (placement.label || 'custom symbol') : symbolLabel(placement.kind);
}

function setTool(tool) { hideDimensionEditor({ redraw: false }); state.tool = tool; state.selection = null; state.boxPreview = null; state.roomPreview = null; state.pendingRoom = null; state.pendingBox = null; state.roomError = ''; state.boxError = ''; state.partitionStart = null; state.partitionPreview = null; state.snapGuide = null; state.placement = null; if (elements.symbolPicker) elements.symbolPicker.value = ''; toggleCustomRow(false); render(); }
function clearDimension() { elements.dimension.value = ''; elements.dimension.focus(); }
function selectStorey(id) { state.activeStoreyId = id; state.selection = null; fitPlan(); render(); }
function newStorey() { transaction('add storey', () => { const highest = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)); const storey = createStorey({ name: `Storey ${highest + 2}`, level: highest + 1 }); state.plan.geometry.storeys.push(storey); state.activeStoreyId = storey.id; state.selection = null; }); fitPlan(); }
function duplicateStorey() { const source = activeStorey(); if (!source.outline.length) return; transaction('duplicate storey', () => { const level = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)) + 1; const copy = clone(source); copy.id = newId('st'); copy.level = level; copy.name = level === 1 ? 'First floor' : `Storey ${level + 1}`; copy.walls.forEach(wall => { wall.id = newId('w'); wall.openings?.forEach(opening => opening.id = newId('op')); }); copy.rooms?.forEach(room => room.id = newId('room')); copy.partitions?.forEach(partition => { partition.id = newId('pt'); partition.openings?.forEach(opening => opening.id = newId('op')); }); copy.survey_items?.forEach(item => item.id = newId('item')); state.plan.geometry.storeys.push(copy); state.activeStoreyId = copy.id; state.selection = null; }); fitPlan(); }

function showConfirm({ title, message, action, confirmText }) { state.pendingConfirm = action; elements.dialogTitle.textContent = title; elements.dialogMessage.textContent = message; elements.dialogConfirm.textContent = confirmText; elements.dialog.showModal(); }
function deleteWall() { const storey = activeStorey(); const wall = getWall(storey, state.selection?.id); if (!wall) return; showConfirm({ title: 'Delete this wall?', message: 'This also removes its openings. The remaining outline will be reconnected.', confirmText: 'Delete wall', action: () => transaction('delete wall', () => { const removeIndex = wall.from; storey.boxes = []; storey.outline.splice(removeIndex, 1); storey.is_closed = storey.outline.length >= 3; syncWalls(storey); state.selection = null; }) }); }
function deleteOpening() { const found = findOpening(state.selection?.id); if (!found) return; transaction('delete opening', () => { found.host.openings = found.host.openings.filter(opening => opening.id !== found.opening.id); state.selection = null; }); }
function deletePartition() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; showConfirm({ title: 'Delete this internal wall?', message: 'This also removes any doors or windows attached to the internal wall.', confirmText: 'Delete wall', action: () => transaction('delete internal wall', () => { storey.partitions = storey.partitions.filter(partition => partition.id !== id); state.selection = null; }) }); }
function deleteRoom() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; transaction('delete room', () => { storey.rooms = storey.rooms.filter(room => room.id !== id); rebuildStoreyFromRooms(storey); state.selection = null; }); }

function duplicateRoom() {
  const storey = activeStorey(); const room = storey.rooms?.find(item => item.id === state.selection?.id); if (!room) return;
  const box = boundsOf(room.polygon);
  const spot = [{ x: box.x + box.width, y: box.y }, { x: box.x, y: box.y + box.depth }, { x: box.x - box.width, y: box.y }, { x: box.x, y: box.y - box.depth }]
    .find(candidate => boxesConnected([...storey.rooms.map(item => boundsOf(item.polygon)), { ...box, ...candidate }]));
  if (!spot) { flash('No free edge to duplicate onto'); return; }
  transaction('duplicate room', () => {
    const copy = createRoom({ ...clone(room), id: undefined, name: `${room.name} copy`, polygon: rectPolygon({ ...box, ...spot }) });
    storey.rooms.push(copy); rebuildStoreyFromRooms(storey); state.selection = { type: 'room', id: copy.id };
  });
}

function duplicateItem() {
  const storey = activeStorey(); const item = storey.survey_items?.find(entry => entry.id === state.selection?.id); if (!item) return;
  transaction('duplicate symbol', () => {
    const copy = { ...clone(item), id: newId('item'), point: { x: item.point.x + .4, y: item.point.y + .4 } };
    storey.survey_items.push(copy); state.selection = { type: 'item', id: copy.id };
  });
}

// Quick wall-type cycling straight from the plan.
function cycleWallType() {
  const storey = activeStorey(); const wall = getWall(storey, state.selection?.id); if (!wall) return;
  const order = Object.keys(WALL_TYPES); const next = order[(order.indexOf(wall.type) + 1) % order.length];
  transaction('change wall type', () => { wall.type = next; });
  flash(`Wall set to ${WALL_TYPES[next]}`);
}

function editRoomSize() {
  const storey = activeStorey(); const room = storey.rooms?.find(item => item.id === state.selection?.id); if (!room) return;
  const box = boundsOf(room.polygon); const centre = screenPoint({ x: box.x + box.width / 2, y: box.y + box.depth / 2 });
  openDimensionEditor({ kind: 'room-size', roomId: room.id, centre });
}

function deleteSelection() {
  const type = state.selection?.type;
  if (type === 'room') deleteRoom();
  else if (type === 'item') deleteSurveyItem();
  else if (type === 'opening') deleteOpening();
  else if (type === 'partition') deletePartition();
}
function deleteSurveyItem() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; transaction('delete survey item', () => { storey.survey_items = storey.survey_items.filter(item => item.id !== id); state.selection = null; }); }
function clearOutline() { if (!activeStorey().outline.length) return; showConfirm({ title: 'Clear this storey?', message: 'This removes the shell, rooms, internal walls, openings and survey items on the active storey. This can be undone.', confirmText: 'Clear storey', action: () => transaction('clear storey', () => { const storey = activeStorey(); storey.boxes = []; storey.outline = []; storey.is_closed = false; storey.walls = []; storey.rooms = []; storey.partitions = []; storey.survey_items = []; state.selection = null; }) }); }
function finishOutline() {
  const storey = activeStorey(); const path = closurePath(storey); if (path === null) return;
  transaction('finish outline', () => { storey.outline.push(...path); storey.is_closed = true; syncWalls(storey); state.tool = 'select'; state.selection = null; });
}
function loadSample() { showConfirm({ title: 'Load the example plan?', message: 'This replaces the plan currently stored on this device. You can undo the change while this session is open.', confirmText: 'Load example', action: () => { state.undo.push(snapshot()); state.redo = []; state.plan = createSamplePlan(); state.activeStoreyId = state.plan.geometry.storeys[0].id; state.selection = null; state.view.initialised = false; resizeCanvas(); render(); scheduleSave(); } }); }

function cancelBox() { hideDimensionEditor({ redraw: false }); state.pendingBox = null; state.boxError = ''; render(); }
function cancelRoom() { hideDimensionEditor({ redraw: false }); state.pendingRoom = null; state.roomError = ''; render(); }

// ------------------------------------------------------------ room-first ----
// Rooms are the primitive: the outline, walls and areas derive from them.

function defaultRoomBox(world) { const snapped = snapWorldPoint(world); return { x: snapped.x, y: snapped.y, width: 3, depth: 4 }; }

// A room that grows outward from an existing external wall, sharing it. Returns
// the box plus the fixed (shared) edge so typed sizes keep it against the wall.
function growRoomBoxFromWall(storey, wall, depth = 3) {
  const from = storey.outline[wall.from]; const to = storey.outline[wall.to]; const eps = 1e-6;
  const horizontal = Math.abs(from.y - to.y) < eps;
  if (horizontal) {
    const line = from.y; const lo = Math.min(from.x, to.x); const width = Math.abs(to.x - from.x);
    const interiorBelow = pointInPolygon({ x: (from.x + to.x) / 2, y: line + 0.05 }, storey.outline);
    return interiorBelow
      ? { box: { x: lo, y: line - depth, width, depth }, fixed: { side: 'bottom', line, lo } }
      : { box: { x: lo, y: line, width, depth }, fixed: { side: 'top', line, lo } };
  }
  const line = from.x; const lo = Math.min(from.y, to.y); const height = Math.abs(to.y - from.y);
  const interiorRight = pointInPolygon({ x: line + 0.05, y: (from.y + to.y) / 2 }, storey.outline);
  return interiorRight
    ? { box: { x: line - depth, y: lo, width: depth, depth: height }, fixed: { side: 'right', line, lo } }
    : { box: { x: line, y: lo, width: depth, depth: height }, fixed: { side: 'left', line, lo } };
}

// Recompute a pending room's box from its width/depth, holding any shared edge.
function boxFromPending(pending) {
  const width = Number(pending.width) || 0; const depth = Number(pending.depth) || 0; const fixed = pending.fixed;
  if (!fixed) return { x: pending.x, y: pending.y, width, depth };
  if (fixed.side === 'bottom') return { x: fixed.lo, y: fixed.line - depth, width, depth };
  if (fixed.side === 'top') return { x: fixed.lo, y: fixed.line, width, depth };
  if (fixed.side === 'right') return { x: fixed.line - width, y: fixed.lo, width, depth };
  if (fixed.side === 'left') return { x: fixed.line, y: fixed.lo, width, depth };
  return { x: pending.x, y: pending.y, width, depth };
}

function setPendingRoomSize(field, value) {
  if (!state.pendingRoom) return;
  state.pendingRoom[field] = value === '' ? 0 : Number(value);
  Object.assign(state.pendingRoom, boxFromPending(state.pendingRoom));
}

// Instant placement: the room lands on the plan immediately, selected, with its
// handles and dimension chips live. No draft/confirm step (research: every good
// editor places first and lets you adjust after).
function placeRoomNow(box) {
  const storey = activeStorey(); const rect = normaliseBox(box);
  if (rect.width < .1 || rect.depth < .1) return null;
  const existing = (storey.rooms || []).map(room => boundsOf(room.polygon));
  if (existing.length && !boxesConnected([...existing, rect])) { flash('New rooms must touch an existing room along a wall'); return null; }
  let created = null;
  transaction('add room', () => {
    created = createRoom({ name: `Room ${(storey.rooms?.length || 0) + 1}`, polygon: rectPolygon(rect) });
    storey.rooms.push(created);
    if (!rebuildStoreyFromRooms(storey)) { storey.rooms.pop(); rebuildStoreyFromRooms(storey); created = null; }
  });
  if (created) { state.selection = { type: 'room', id: created.id }; render(); }
  return created;
}

function flash(message) { state.interactionNotice = message; render(); clearTimeout(state.flashTimer); state.flashTimer = setTimeout(() => { state.interactionNotice = ''; render(); }, 2600); }

// Which side of a room's rectangle an external wall lies on (for edge resizing).
function wallSideOfRoom(room, wall, storey, eps = 1e-6) {
  if (!room) return null; const from = storey.outline[wall.from]; const to = storey.outline[wall.to]; const box = boundsOf(room.polygon);
  if (Math.abs(from.y - to.y) < eps) return Math.abs(from.y - box.y) < eps ? 'top' : 'bottom';
  return Math.abs(from.x - box.x) < eps ? 'left' : 'right';
}

function commitPendingRoom() {
  const pending = state.pendingRoom; const storey = activeStorey(); if (!pending) return;
  const box = normaliseBox(boxFromPending(pending));
  if (box.width < .1 || box.depth < .1) { state.roomError = 'Enter a width and depth of at least 0.10 m.'; render(); return; }
  if (!pending.name?.trim()) { state.roomError = 'Give the room a name so it can be used in the retrofit survey.'; render(); return; }
  const existing = (storey.rooms || []).map(room => boundsOf(room.polygon));
  if (existing.length && !boxesConnected([...existing, box])) { state.roomError = 'New rooms must touch an existing room along a wall.'; render(); return; }
  transaction('add room', () => {
    const room = createRoom({ name: pending.name.trim(), polygon: rectPolygon(box) });
    storey.rooms.push(room); rebuildStoreyFromRooms(storey);
    state.pendingRoom = null; state.roomError = ''; state.selection = { type: 'room', id: room.id };
  });
  hideDimensionEditor({ redraw: false }); fitPlan();
}
function commitPendingBox() {
  const pending = state.pendingBox; const storey = activeStorey(); if (!pending) return;
  const box = normaliseBox(pending);
  if (box.width < .1 || box.depth < .1) { state.boxError = 'Enter a width and depth of at least 0.10 m.'; render(); return; }
  if (pending.mode === 'extend') {
    if (!storey.boxes?.length) { state.boxError = 'Extensions work from a box footprint. Start the storey with Box footprint or use Trace walls for this plan.'; render(); return; }
    if (!boxesTouchOrOverlap(storey.boxes, box)) { state.boxError = 'The extension must touch the existing footprint along an edge. Drag it against the plan, then set the measured size.'; render(); return; }
  }
  transaction(pending.mode === 'extend' ? 'add box extension' : 'set box footprint', () => {
    storey.boxes = pending.mode === 'extend' ? [...storey.boxes, box] : [box];
    storey.outline = outlineFromBoxes(storey.boxes); storey.is_closed = true; syncWalls(storey, { preserve: false });
    if (pending.mode === 'box') { storey.rooms = []; storey.partitions = []; storey.survey_items = []; }
    state.pendingBox = null; state.boxError = ''; state.selection = null;
  });
  hideDimensionEditor({ redraw: false });
  fitPlan();
}
function applyBox() {
  if (!state.pendingBox) return;
  if (state.pendingBox.mode === 'box' && activeStorey().outline.length) {
    showConfirm({ title: 'Replace this storey footprint?', message: 'The new measured box will replace the existing outline, wall classifications and openings. This can be undone.', confirmText: 'Replace footprint', action: commitPendingBox });
  } else commitPendingBox();
}

function exportJson() { const filename = safeFilename(); download(new Blob([JSON.stringify({ ...state.plan, derived: state.derived }, null, 2)], { type: 'application/json' }), `${filename}-rdsap-input.json`); }
function exportPng() {
  const previous = { width: canvas.width, height: canvas.height, transform: { ...state.view } }; const storey = activeStorey(); if (!storey.outline.length) return;
  const exportCanvas = document.createElement('canvas'); exportCanvas.width = 1600; exportCanvas.height = 1100; const exportCtx = exportCanvas.getContext('2d');
  exportCtx.fillStyle = '#f4f6f6'; exportCtx.fillRect(0, 0, 1600, 1100); exportCtx.fillStyle = '#102332'; exportCtx.fillRect(0, 0, 1600, 98);
  exportCtx.fillStyle = '#fff'; exportCtx.font = '700 32px system-ui'; exportCtx.fillText('Future Floor Plans', 60, 61); exportCtx.fillStyle = '#b7c4c9'; exportCtx.font = '700 14px system-ui'; exportCtx.fillText('ASSESOR-VISIBLE RDSAP INPUT PLAN', 60, 83);
  const xs = storey.outline.map(p => p.x); const ys = storey.outline.map(p => p.y); const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys); const scale = Math.min(1100 / Math.max(maxX-minX, 1), 700 / Math.max(maxY-minY, 1)); const ox = 800 - (minX+maxX)*scale/2; const oy = 500 - (minY+maxY)*scale/2;
  const drawPoint = p => ({ x: p.x*scale+ox, y:p.y*scale+oy });
  exportCtx.beginPath(); storey.outline.map(drawPoint).forEach((p,i) => i?exportCtx.lineTo(p.x,p.y):exportCtx.moveTo(p.x,p.y)); exportCtx.closePath(); exportCtx.fillStyle = '#fff'; exportCtx.fill();
  for (const room of storey.rooms || []) { const points = room.polygon.map(drawPoint); if (points.length < 3) continue; exportCtx.beginPath(); points.forEach((p, i) => i ? exportCtx.lineTo(p.x, p.y) : exportCtx.moveTo(p.x, p.y)); exportCtx.closePath(); exportCtx.fillStyle = 'rgba(91,154,180,.10)'; exportCtx.fill(); exportCtx.strokeStyle = '#5b9ab4'; exportCtx.lineWidth = 2; exportCtx.setLineDash([8,6]); exportCtx.stroke(); exportCtx.setLineDash([]); const centre = drawPoint(roomCentroid(room)); exportCtx.fillStyle = '#25475b'; exportCtx.font = '700 18px system-ui'; exportCtx.textAlign = 'center'; exportCtx.fillText(room.name || 'Room', centre.x, centre.y); exportCtx.font = '600 14px system-ui'; exportCtx.fillStyle = '#637882'; exportCtx.fillText(squareMetres(roomArea(room)), centre.x, centre.y + 19); }
  for (const partition of storey.partitions || []) { const from = drawPoint(partition.from); const to = drawPoint(partition.to); exportCtx.strokeStyle = '#506975'; exportCtx.lineWidth = 9; exportCtx.beginPath(); exportCtx.moveTo(from.x, from.y); exportCtx.lineTo(to.x, to.y); exportCtx.stroke(); for (const opening of partition.openings || []) { const length = segmentLength(partition); const a = drawPoint(pointAlong(partition.from, partition.to, opening.offset_m / length)); const b = drawPoint(pointAlong(partition.from, partition.to, (opening.offset_m + opening.width_m) / length)); exportCtx.strokeStyle = opening.kind === 'window' ? '#5b9ab4' : '#ec5a35'; exportCtx.lineWidth = 14; exportCtx.beginPath(); exportCtx.moveTo(a.x, a.y); exportCtx.lineTo(b.x, b.y); exportCtx.stroke(); } }
  for (const wall of storey.walls) { const from=drawPoint(storey.outline[wall.from]); const to=drawPoint(storey.outline[wall.to]); exportCtx.beginPath(); exportCtx.moveTo(from.x,from.y); exportCtx.lineTo(to.x,to.y); exportCtx.strokeStyle=wallColour(wall); exportCtx.lineWidth=12; if(wall.type==='party') exportCtx.setLineDash([16,9]); exportCtx.stroke(); exportCtx.setLineDash([]); for(const opening of wall.openings||[]) { const length=wallLength(storey,wall); const a=drawPoint(pointAlong(storey.outline[wall.from],storey.outline[wall.to],opening.offset_m/length)); const b=drawPoint(pointAlong(storey.outline[wall.from],storey.outline[wall.to],(opening.offset_m+opening.width_m)/length)); exportCtx.beginPath(); exportCtx.moveTo(a.x,a.y); exportCtx.lineTo(b.x,b.y); exportCtx.lineWidth=15; exportCtx.strokeStyle=opening.kind==='window'?'#5b9ab4':'#ec5a35'; exportCtx.stroke(); } }
  for (const item of storey.survey_items || []) { const itemPoint = drawPoint(item.point); exportCtx.fillStyle = '#fff'; exportCtx.strokeStyle = '#477d61'; exportCtx.lineWidth = 3; exportCtx.beginPath(); exportCtx.roundRect(itemPoint.x - 15, itemPoint.y - 10, 30, 20, 3); exportCtx.fill(); exportCtx.stroke(); exportCtx.fillStyle = '#477d61'; exportCtx.font = '800 12px system-ui'; exportCtx.textAlign = 'center'; exportCtx.fillText(item.kind === 'heat_pump' ? 'HP' : 'H', itemPoint.x, itemPoint.y + 4); }
  exportCtx.fillStyle='#102332'; exportCtx.font='700 22px system-ui'; exportCtx.fillText(state.plan.property_address || 'Unaddressed plan', 60, 1018); exportCtx.fillStyle='#52616c'; exportCtx.font='500 18px system-ui'; exportCtx.fillText(`${storey.name} · Internal measurements · Floor area ${squareMetres(currentDerivedStorey()?.floor_area_m2)} · HLP ${metres(currentDerivedStorey()?.heat_loss_perimeter_m)}`,60,1052); exportCtx.fillText('Advisory RdSAP input capture — verify all measurements and classifications before use.',60,1080);
  exportCtx.fillStyle='#ec5a35'; exportCtx.font='900 56px system-ui'; exportCtx.fillText('↑',1490,160); exportCtx.fillStyle='#102332'; exportCtx.font='900 16px system-ui'; exportCtx.fillText('N',1505,185);
  exportCanvas.toBlob(blob => download(blob, `${safeFilename()}-floor-plan.png`), 'image/png');
  void previous;
}
function safeFilename() { return (state.plan.property_address || 'future-floor-plan').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'') || 'future-floor-plan'; }
function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function handleAction(action) {
  const actions = { undo, redo, 'fit-plan': fitPlan, 'clear-outline': clearOutline, 'finish-outline': finishOutline, 'sample-plan': loadSample, 'clear-dimension': clearDimension, 'new-storey': newStorey, 'duplicate-storey': duplicateStorey, 'delete-wall': deleteWall, 'delete-opening': deleteOpening, 'delete-partition': deletePartition, 'delete-room': deleteRoom, 'delete-item': deleteSurveyItem, 'split-wall': () => setTool('split'), 'apply-box': applyBox, 'cancel-box': cancelBox, 'apply-room': commitPendingRoom, 'cancel-room': cancelRoom, 'arm-custom': armCustomSymbol, deselect: () => { state.selection = null; render(); }, 'export-json': exportJson, 'export-png': exportPng, 'zoom-in': () => zoomBy(1.2), 'zoom-out': () => zoomBy(.83),
    'duplicate-room': duplicateRoom, 'duplicate-item': duplicateItem, 'cycle-wall-type': cycleWallType, 'edit-room-size': editRoomSize };
  actions[action]?.();
}
function zoomBy(amount) { const centre = { x: frame.clientWidth / 2, y: frame.clientHeight / 2 }; const focus = worldPoint(centre); state.view.scale = Math.max(20, Math.min(220, state.view.scale * amount)); state.view.x = centre.x - focus.x*state.view.scale; state.view.y = centre.y - focus.y*state.view.scale; renderCanvas(); }

document.addEventListener('click', event => {
  const railGroup = event.target.closest('[data-rail-group]'); if (railGroup) { selectRailGroup(railGroup.dataset.railGroup); return; }
  const railItem = event.target.closest('[data-rail-item]'); if (railItem) { armPlacementFromPicker(railItem.dataset.railItem); return; }
  const tool = event.target.closest('[data-tool]'); if (tool) { setTool(tool.dataset.tool); return; }
  const action = event.target.closest('[data-action]'); if (action) { handleAction(action.dataset.action); return; }
  const storey = event.target.closest('[data-storey]'); if (storey) selectStorey(storey.dataset.storey);
});

// Keyboard: fast on desktop, harmless on tablet.
document.addEventListener('keydown', event => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape') { if (state.measurementEditor) hideDimensionEditor(); else if (state.placement) disarmPlacement(); else if (state.selection) { state.selection = null; render(); } return; }
  if (typing) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection) { event.preventDefault(); deleteSelection(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && state.selection?.type === 'room') { event.preventDefault(); duplicateRoom(); return; }
  if (event.key === 'Enter' && state.selection?.type === 'room') { event.preventDefault(); editRoomSize(); return; }
  if (event.key === 'r' || event.key === 'R') setTool('room');
  if (event.key === 'v' || event.key === 'V') setTool('select');
});

elements.address.addEventListener('change', () => transaction('change address', () => { state.plan.property_address = elements.address.value; }, { remember: false }));
elements.postcode.addEventListener('change', () => transaction('change postcode', () => { state.plan.postcode = elements.postcode.value; }, { remember: false }));
elements.north.addEventListener('input', () => transaction('set north', () => { state.plan.north_offset_deg = Number(elements.north.value); }, { remember: false }));
elements.inspector.addEventListener('input', event => {
  const target = event.target;
  if (target.dataset.boxField && state.pendingBox) { state.pendingBox[target.dataset.boxField] = target.value === '' ? 0 : Number(target.value); state.boxError = ''; renderCanvas(); }
  if (target.dataset.roomDraftField && state.pendingRoom) { const field = target.dataset.roomDraftField; if (field === 'width' || field === 'depth') setPendingRoomSize(field, target.value); else state.pendingRoom[field] = target.value; state.roomError = ''; renderCanvas(); }
});
elements.inspector.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.boxField && state.pendingBox) { state.pendingBox[target.dataset.boxField] = target.value === '' ? 0 : Number(target.value); state.boxError = ''; render(); }
  if (target.dataset.roomDraftField && state.pendingRoom) { const field = target.dataset.roomDraftField; if (field === 'width' || field === 'depth') setPendingRoomSize(field, target.value); else state.pendingRoom[field] = target.value; state.roomError = ''; render(); }
  if (target.dataset.wallField) { const wall = getWall(activeStorey(), state.selection?.id); if (!wall) return; transaction('edit wall', () => { wall[target.dataset.wallField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.partitionField) { const partition = activeStorey().partitions?.find(item => item.id === state.selection?.id); if (!partition) return; transaction('edit internal wall', () => { partition[target.dataset.partitionField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.openingField) { const found = findOpening(state.selection?.id); if (!found) return; transaction('edit opening', () => { const field = target.dataset.openingField; if (field === 'style') { found.opening.style = target.value; found.opening.kind = OPENING_TYPES[target.value]?.base || found.opening.kind; } else found.opening[field] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.roomField) { const room = activeStorey().rooms?.find(item => item.id === state.selection?.id); if (!room) return; transaction('edit room survey data', () => { room[target.dataset.roomField] = target.type === 'checkbox' ? target.checked : (target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value); }); }
  if (target.dataset.roomSize) {
    const storey = activeStorey(); const room = storey.rooms?.find(item => item.id === state.selection?.id); if (!room) return;
    const value = Number(target.value); if (!(value >= .1)) { render(); return; }
    const box = boundsOf(room.polygon); const side = target.dataset.roomSize === 'width' ? 'right' : 'bottom';
    const coord = target.dataset.roomSize === 'width' ? box.x + value : box.y + value;
    const trial = clone(room); resizeRoomEdge(trial, side, coord);
    const others = storey.rooms.filter(item => item.id !== room.id).map(item => boundsOf(item.polygon));
    if (others.length && !boxesConnected([...others, boundsOf(trial.polygon)])) { state.interactionNotice = 'That size would disconnect the room from the plan.'; render(); return; }
    transaction('resize room', () => { resizeRoomEdge(room, side, coord); rebuildStoreyFromRooms(storey); clampOpenings(storey); });
  }
  if (target.dataset.itemField) { const item = activeStorey().survey_items?.find(entry => entry.id === state.selection?.id); if (!item) return; transaction('edit survey item', () => { const field = target.dataset.itemField; item[field] = target.value; if (field === 'kind' && target.value !== 'custom') item.group = symbolGroupOf({ kind: target.value }); }); }
  if (target.dataset.storeyField) { transaction('edit storey', () => { activeStorey()[target.dataset.storeyField] = target.type === 'number' ? Number(target.value) : target.value; }); }
});
elements.dimensionPopover.addEventListener('submit', event => { event.preventDefault(); applyDimensionEditor(); });
elements.dimensionPopover.addEventListener('click', event => {
  const action = event.target.closest('[data-measurement-action]')?.dataset.measurementAction;
  if (action === 'cancel') { if (state.measurementEditor?.kind === 'box') cancelBox(); else if (state.measurementEditor?.kind === 'room') cancelRoom(); else hideDimensionEditor(); }
});
elements.dimensionPopover.addEventListener('input', event => {
  if (state.measurementEditor?.kind === 'box' && state.pendingBox) {
    if (event.target.id === 'boxWidthInput') state.pendingBox.width = Number(event.target.value) || 0;
    if (event.target.id === 'boxDepthInput') state.pendingBox.depth = Number(event.target.value) || 0;
    state.boxError = ''; renderCanvas();
  }
  if (state.measurementEditor?.kind === 'room' && state.pendingRoom) {
    if (event.target.id === 'roomWidthInput') setPendingRoomSize('width', event.target.value);
    if (event.target.id === 'roomDepthInput') setPendingRoomSize('depth', event.target.value);
    if (event.target.id === 'roomNameInput') state.pendingRoom.name = event.target.value;
    state.roomError = ''; renderCanvas();
  }
});
elements.symbolPicker?.addEventListener('change', event => armPlacementFromPicker(event.target.value));
elements.dialog.addEventListener('close', () => { if (elements.dialog.returnValue === 'confirm') state.pendingConfirm?.(); state.pendingConfirm = null; });
canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp); canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => { event.preventDefault(); const before = worldPoint(clientPoint(event)); state.view.scale = Math.max(20, Math.min(220, state.view.scale * (event.deltaY < 0 ? 1.12 : .89))); const after = screenPoint(before); const at = clientPoint(event); state.view.x += at.x - after.x; state.view.y += at.y - after.y; renderCanvas(); }, { passive: false });
window.addEventListener('resize', resizeCanvas); window.addEventListener('beforeunload', () => { if (state.saveTimer) savePlan(state.plan); });

async function initialise() {
  const existing = await loadPlan(); state.plan = existing?.geometry?.storeys ? existing : createPlan(); state.activeStoreyId = state.plan.geometry.storeys[0]?.id;
  for (const storey of state.plan.geometry.storeys) { if (storey.is_closed === undefined) storey.is_closed = Boolean(storey.walls?.length); ensureStoreySurveyData(storey); }
  state.tool = activeStorey()?.rooms?.length ? 'select' : 'room';
  resizeCanvas(); render(); requestAnimationFrame(() => { if (activeStorey()?.outline.length) fitPlan(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (typeof window !== 'undefined') window.__ffp = { state, activeStorey, render, rebuild: () => rebuildStoreyFromRooms(activeStorey()) };
initialise();
