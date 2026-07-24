import {
  ROOM_USES, SURVEY_ITEM_TYPES, WALL_TYPES, boxesTouchOrOverlap, clone, closestPartition, closestWall, createPlan, createRoom, createSamplePlan, createStorey, derivePlan,
  distance, ensureStoreySurveyData, getWall, isSelfIntersecting, makeOpening, makePartition, makeSurveyItem, metres, moveAxisAlignedWall, moveVertex, newId, normaliseBox, outlineFromBoxes, pointAlong, polygonArea, projectPointToSegment, resizeWall, roomArea, roomCentroid, segmentLength, splitExternalWall, squareMetres, syncWalls, wallLength
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
  dialogMessage: $('#dialogMessage'), dialogConfirm: $('#dialogConfirm'), dimensionPopover: $('#dimensionPopover'), finishOutline: $('#finishOutlineButton')
};

const state = {
  plan: createPlan(), activeStoreyId: null, tool: 'box', selection: null, undo: [], redo: [],
  view: { scale: 65, x: 80, y: 70, initialised: false }, pointers: new Map(), gesture: null, drag: null,
  drawPreview: null, boxPreview: null, pendingBox: null, pendingRoom: null, roomPreview: null, partitionPreview: null, partitionStart: null,
  boxError: '', roomError: '', derived: null, saveTimer: null, pendingConfirm: null,
  dimensionHits: [], measurementEditor: null, closureSuggestion: null, interactionNotice: '', snapGuide: null
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
  const start = pointAlong(from, to, Math.max(0, Math.min(1, opening.offset_m / length))); const end = pointAlong(from, to, Math.max(0, Math.min(1, (opening.offset_m + opening.width_m) / length)));
  const screenStart = screenPoint(start); const screenEnd = screenPoint(end); const isSelected = state.selection?.type === 'opening' && state.selection.id === opening.id;
  ctx.save(); ctx.strokeStyle = opening.kind === 'door' ? '#ec5a35' : '#5b9ab4'; ctx.lineWidth = isSelected ? 9 : 7; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(screenStart.x, screenStart.y); ctx.lineTo(screenEnd.x, screenEnd.y); ctx.stroke();
  if (opening.kind === 'door' || opening.kind === 'glazed_door') {
    const dx = screenEnd.x - screenStart.x; const dy = screenEnd.y - screenStart.y; const hypot = Math.hypot(dx, dy) || 1; const nx = -dy / hypot; const ny = dx / hypot;
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ec5a35'; ctx.beginPath(); ctx.arc(screenStart.x, screenStart.y, Math.min(Math.hypot(dx, dy), 38), Math.atan2(ny, nx), Math.atan2(dy, dx), false); ctx.stroke();
  }
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

function drawPartition(partition) {
  const from = screenPoint(partition.from); const to = screenPoint(partition.to); const selected = state.selection?.type === 'partition' && state.selection.id === partition.id;
  ctx.save(); ctx.strokeStyle = selected ? '#ec5a35' : '#506975'; ctx.lineWidth = selected ? 8 : Math.max(5, Math.min(9, Number(partition.thickness_m || .1) * state.view.scale)); ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  for (const opening of partition.openings || []) drawSegmentOpening(partition.from, partition.to, opening);
  ctx.restore();
}

function drawSurveyItem(item) {
  const point = screenPoint(item.point); const selected = state.selection?.type === 'item' && state.selection.id === item.id; const accent = selected ? '#ec5a35' : '#477d61';
  ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
  if (item.kind === 'radiator' || item.kind === 'storage_heater' || item.kind === 'panel_heater') { ctx.roundRect(point.x - 14, point.y - 8, 28, 16, 3); ctx.fill(); ctx.stroke(); ctx.strokeStyle = accent; ctx.lineWidth = 1; for (let x = -8; x <= 8; x += 5) { ctx.beginPath(); ctx.moveTo(point.x + x, point.y - 5); ctx.lineTo(point.x + x, point.y + 5); ctx.stroke(); } }
  else if (item.kind === 'heat_pump') { ctx.arc(point.x, point.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = accent; ctx.font = '900 13px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('HP', point.x, point.y + .5); }
  else if (item.kind === 'fireplace') { ctx.moveTo(point.x, point.y - 12); ctx.lineTo(point.x + 11, point.y + 10); ctx.lineTo(point.x - 11, point.y + 10); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  else { ctx.roundRect(point.x - 10, point.y - 10, 20, 20, 4); ctx.fill(); ctx.stroke(); ctx.fillStyle = accent; ctx.font = '900 11px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(item.kind === 'ventilation' ? 'V' : 'H', point.x, point.y + .5); }
  if (item.label) { ctx.font = '700 10px ui-sans-serif, system-ui'; ctx.fillStyle = '#405b67'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(item.label, point.x, point.y + 14); }
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
  state.dimensionHits = []; ctx.clearRect(0, 0, rect.width, rect.height); drawGrid(rect.width, rect.height); drawPlan(); drawPreview(); drawBoxPreview(); drawRoomPreview(); drawPartitionPreview(); drawClosureSuggestion(); drawSnapGuide();
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
      <label>Room name<input data-room-field="name" type="text" value="${escapeHTML(room.name || '')}" placeholder="e.g. Lounge" /></label>
      <label>Survey classification<select data-room-field="use">${Object.entries(ROOM_USES).map(([value, label]) => `<option value="${value}" ${room.use === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="form-split"><label>Ceiling height (m)<input data-room-field="ceiling_height_m" type="number" inputmode="decimal" min="1.5" max="4.5" step=".01" value="${room.ceiling_height_m ?? ''}" /></label><label>Lights<input data-room-field="light_count" type="number" inputmode="numeric" min="0" step="1" value="${room.light_count ?? ''}" /></label></div>
      <label class="toggle-row"><input data-room-field="heated" type="checkbox" ${room.heated ? 'checked' : ''} /><span>Heated room</span></label><label class="toggle-row"><input data-room-field="habitable" type="checkbox" ${room.habitable ? 'checked' : ''} /><span>Habitable room</span></label>
      <label>Survey note<textarea data-room-field="notes" rows="3" placeholder="Construction, insulation, ventilation or access notes">${escapeHTML(room.notes || '')}</textarea></label>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-room">Delete room</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'item') {
    const item = storey.survey_items?.find(entry => entry.id === state.selection.id); if (!item) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = SURVEY_ITEM_TYPES[item.kind] || 'Survey item'; elements.selectionBadge.textContent = 'Heating';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#477d61"></i><span>Retrofit survey item<strong>${escapeHTML(SURVEY_ITEM_TYPES[item.kind] || item.kind)}</strong></span></div>
      <label>Item type<select data-item-field="kind">${Object.entries(SURVEY_ITEM_TYPES).map(([value, label]) => `<option value="${value}" ${item.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
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
      <label>Opening type<select data-opening-field="kind"><option value="window" ${opening.kind === 'window' ? 'selected' : ''}>Window</option><option value="door" ${opening.kind === 'door' ? 'selected' : ''}>Door</option><option value="glazed_door" ${opening.kind === 'glazed_door' ? 'selected' : ''}>Highly glazed door</option></select></label>
      <div class="form-split"><label>Width (m)<input data-opening-field="width_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.width_m}" /></label><label>Height (m)<input data-opening-field="height_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.height_m}" /></label></div>
      <label>Offset from left corner (m)<input data-opening-field="offset_m" type="number" inputmode="decimal" min="0" step=".01" value="${opening.offset_m}" /></label>
      <label>Glazed area ratio <input data-opening-field="glazed_area_ratio" type="number" inputmode="decimal" min="0" max="1" step=".01" placeholder="Use only to check door classification" value="${opening.glazed_area_ratio ?? ''}" /></label>
      <div class="stat-stack"><div class="stat-card"><span>Area</span><strong>${squareMetres(derivedOpening?.area_m2)}</strong></div><div class="stat-card"><span>Wall</span><strong>${derivedWall?.orientation || '—'}</strong></div></div>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-opening">Delete</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else {
    elements.inspectorHeading.textContent = 'Survey plan'; elements.selectionBadge.textContent = 'Plan';
    elements.inspector.innerHTML = `<div class="empty-state"><b>Build the shell, then survey the spaces inside it.</b>Use <strong>Add room</strong> for named room zones, <strong>Draw internal wall</strong> for partitions, then add doors, windows and heating/ventilation items. Split an external wall to add an editable corner for angled or stepped shapes.</div><div class="stat-stack"><div class="stat-card"><span>Shell area</span><strong>${squareMetres(derived?.floor_area_m2)}</strong></div><div class="stat-card"><span>Named rooms</span><strong>${derived?.room_count || 0}</strong></div></div><label>Storey name<input data-storey-field="name" type="text" value="${escapeHTML(storey.name)}" /></label><label>Storey height (m)<input data-storey-field="height_m" type="number" inputmode="decimal" min="2" max="3.5" step=".01" value="${storey.height_m}" /></label><p class="field-note">The plan records survey evidence for later RdSAP and retrofit workflows. Verify all dimensions and classifications before export.</p>`;
  }
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
  if (state.tool === 'room') return activeStorey().is_closed ? 'Drag a room zone inside the shell · name it and record retrofit data in the inspector' : 'Draw the external shell first, then add rooms inside it';
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
  renderStoreyTabs(); renderMetrics(); renderInspector(); renderWarnings(); renderCanvas();
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
  const storey = activeStorey(); const wall = getWall(storey, editor.wallId); const length = Number($('#wallLengthInput')?.value); const anchor = $('#wallAnchorInput')?.value || 'from';
  const next = wall && resizeWall(storey.outline, wall.from, length, anchor);
  if (!next || !outlineIsSafe(next)) { const note = elements.dimensionPopover.querySelector('.popover-note'); if (note) note.textContent = 'That would fold the outline. Drag a corner or change the anchored corner instead.'; return; }
  hideDimensionEditor({ redraw: false });
  transaction('set wall length', () => { storey.outline = next; storey.boxes = []; syncWalls(storey); clampOpenings(storey); state.selection = { type: 'wall', id: editor.wallId }; });
}

function pointerDown(event) {
  event.preventDefault(); const point = clientPoint(event); const hit = dimensionHitAt(point);
  if (hit && ['select', 'box', 'extend', 'room'].includes(state.tool)) { openDimensionEditor(hit); return; }
  if (state.measurementEditor) hideDimensionEditor();
  canvas.setPointerCapture?.(event.pointerId); state.pointers.set(event.pointerId, point);
  if (state.pointers.size === 2) { const points = [...state.pointers.values()]; state.gesture = { startDistance: distance(points[0], points[1]), startScale: state.view.scale, startMid: midpoint(points[0], points[1]), startView: { x: state.view.x, y: state.view.y } }; state.drag = null; return; }
  state.drag = { id: event.pointerId, start: point, view: { x: state.view.x, y: state.view.y }, moved: false, mode: 'pan' };
  if (state.tool === 'partition') {
    const snapped = snapWorldPoint(worldPoint(point));
    if (!state.partitionStart) state.partitionStart = snapped;
    state.partitionPreview = snapped; state.drag = { ...state.drag, mode: 'partition-draw', startWorld: clone(state.partitionStart) }; renderCanvas(); return;
  }
  if (state.tool !== 'select' || state.pendingBox || state.pendingRoom) return;
  const storey = activeStorey(); const world = worldPoint(point); const vertexIndex = closestVertexIndex(storey.outline, world, Math.max(.16, 18 / state.view.scale));
  if (vertexIndex !== -1) {
    state.drag = { ...state.drag, mode: 'vertex', vertexIndex, before: snapshot(), initialOutline: clone(storey.outline), changed: false };
    return;
  }
  const wallHit = closestWall(storey, world, Math.max(.18, 16 / state.view.scale));
  if (wallHit && isAxisAlignedWall(storey, wallHit.wall)) state.drag = { ...state.drag, mode: 'wall', wallIndex: wallHit.wall.from, before: snapshot(), initialOutline: clone(storey.outline), changed: false };
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

function updateGeometryDrag(point) {
  const drag = state.drag; if (!drag || (drag.mode !== 'vertex' && drag.mode !== 'wall' && drag.mode !== 'partition-end')) return false;
  const storey = activeStorey(); const raw = worldPoint(point); let next = null;
  if (drag.mode === 'partition-end') {
    const partition = storey.partitions?.find(item => item.id === drag.partitionId); if (!partition) return false;
    partition[drag.endpoint] = snapWorldPoint(raw, { exclude: [partition[drag.endpoint === 'from' ? 'to' : 'from']] }); clampOpenings(storey); drag.changed = true; return true;
  }
  if (drag.mode === 'vertex') {
    const snapped = snapToOutlineAxes(raw, drag.initialOutline, { exclude: [drag.vertexIndex] }); next = moveVertex(drag.initialOutline, drag.vertexIndex, snapped);
  } else {
    const from = drag.initialOutline[drag.wallIndex]; const to = drag.initialOutline[(drag.wallIndex + 1) % drag.initialOutline.length];
    const snapped = snapToOutlineAxes(raw, drag.initialOutline, { exclude: [drag.wallIndex, (drag.wallIndex + 1) % drag.initialOutline.length] });
    next = moveAxisAlignedWall(drag.initialOutline, drag.wallIndex, Math.abs(from.y - to.y) < 1e-8 ? snapped.y : snapped.x);
  }
  if (!next || !outlineIsSafe(next)) return false;
  storey.outline = next; storey.boxes = []; syncWalls(storey); clampOpenings(storey); drag.changed = true; return true;
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

function pointerMove(event) {
  const point = clientPoint(event); if (!state.pointers.has(event.pointerId)) return; state.pointers.set(event.pointerId, point);
  if (state.pointers.size >= 2 && state.gesture) { const [a, b] = [...state.pointers.values()]; const nextDistance = distance(a, b); const nextMid = midpoint(a, b); const scale = Math.min(220, Math.max(20, state.gesture.startScale * nextDistance / Math.max(1, state.gesture.startDistance))); const focusWorld = worldFromView(state.gesture.startMid, state.gesture.startView, state.gesture.startScale); state.view.scale = scale; state.view.x = nextMid.x - focusWorld.x * scale; state.view.y = nextMid.y - focusWorld.y * scale; renderCanvas(); return; }
  if (!state.drag || state.drag.id !== event.pointerId) return; const dx = point.x - state.drag.start.x; const dy = point.y - state.drag.start.y;
  if (Math.hypot(dx, dy) > 4) state.drag.moved = true;
  if (state.drag.mode === 'vertex' || state.drag.mode === 'wall' || state.drag.mode === 'partition-end') updateGeometryDrag(point);
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
    } else if (drag.mode === 'vertex' || drag.mode === 'wall' || drag.mode === 'partition-end') {
      if (drag.changed) commitGeometryDrag(drag); else handleTap(point, event);
    } else if (!drag.moved || state.tool === 'draw') handleTap(point, event);
  }
  state.drag = null; state.drawPreview = null; state.boxPreview = null; state.roomPreview = null; if (state.tool !== 'partition') state.partitionPreview = null; renderCanvas();
}

function handleTap(point, event) {
  const storey = activeStorey(); const world = state.tool === 'draw' ? constrainedPoint(point, event) : snapWorldPoint(worldPoint(point));
  if (state.tool === 'room' || state.tool === 'partition') return;
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

function setTool(tool) { hideDimensionEditor({ redraw: false }); state.tool = tool; state.selection = null; state.boxPreview = null; state.roomPreview = null; state.partitionStart = null; state.partitionPreview = null; state.snapGuide = null; render(); }
function clearDimension() { elements.dimension.value = ''; elements.dimension.focus(); }
function selectStorey(id) { state.activeStoreyId = id; state.selection = null; fitPlan(); render(); }
function newStorey() { transaction('add storey', () => { const highest = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)); const storey = createStorey({ name: `Storey ${highest + 2}`, level: highest + 1 }); state.plan.geometry.storeys.push(storey); state.activeStoreyId = storey.id; state.selection = null; }); fitPlan(); }
function duplicateStorey() { const source = activeStorey(); if (!source.outline.length) return; transaction('duplicate storey', () => { const level = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)) + 1; const copy = clone(source); copy.id = newId('st'); copy.level = level; copy.name = level === 1 ? 'First floor' : `Storey ${level + 1}`; copy.walls.forEach(wall => { wall.id = newId('w'); wall.openings?.forEach(opening => opening.id = newId('op')); }); copy.rooms?.forEach(room => room.id = newId('room')); copy.partitions?.forEach(partition => { partition.id = newId('pt'); partition.openings?.forEach(opening => opening.id = newId('op')); }); copy.survey_items?.forEach(item => item.id = newId('item')); state.plan.geometry.storeys.push(copy); state.activeStoreyId = copy.id; state.selection = null; }); fitPlan(); }

function showConfirm({ title, message, action, confirmText }) { state.pendingConfirm = action; elements.dialogTitle.textContent = title; elements.dialogMessage.textContent = message; elements.dialogConfirm.textContent = confirmText; elements.dialog.showModal(); }
function deleteWall() { const storey = activeStorey(); const wall = getWall(storey, state.selection?.id); if (!wall) return; showConfirm({ title: 'Delete this wall?', message: 'This also removes its openings. The remaining outline will be reconnected.', confirmText: 'Delete wall', action: () => transaction('delete wall', () => { const removeIndex = wall.from; storey.boxes = []; storey.outline.splice(removeIndex, 1); storey.is_closed = storey.outline.length >= 3; syncWalls(storey); state.selection = null; }) }); }
function deleteOpening() { const found = findOpening(state.selection?.id); if (!found) return; transaction('delete opening', () => { found.host.openings = found.host.openings.filter(opening => opening.id !== found.opening.id); state.selection = null; }); }
function deletePartition() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; showConfirm({ title: 'Delete this internal wall?', message: 'This also removes any doors or windows attached to the internal wall.', confirmText: 'Delete wall', action: () => transaction('delete internal wall', () => { storey.partitions = storey.partitions.filter(partition => partition.id !== id); state.selection = null; }) }); }
function deleteRoom() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; transaction('delete room', () => { storey.rooms = storey.rooms.filter(room => room.id !== id); state.selection = null; }); }
function deleteSurveyItem() { const storey = activeStorey(); const id = state.selection?.id; if (!id) return; transaction('delete survey item', () => { storey.survey_items = storey.survey_items.filter(item => item.id !== id); state.selection = null; }); }
function clearOutline() { if (!activeStorey().outline.length) return; showConfirm({ title: 'Clear this storey?', message: 'This removes the shell, rooms, internal walls, openings and survey items on the active storey. This can be undone.', confirmText: 'Clear storey', action: () => transaction('clear storey', () => { const storey = activeStorey(); storey.boxes = []; storey.outline = []; storey.is_closed = false; storey.walls = []; storey.rooms = []; storey.partitions = []; storey.survey_items = []; state.selection = null; }) }); }
function finishOutline() {
  const storey = activeStorey(); const path = closurePath(storey); if (path === null) return;
  transaction('finish outline', () => { storey.outline.push(...path); storey.is_closed = true; syncWalls(storey); state.tool = 'select'; state.selection = null; });
}
function loadSample() { showConfirm({ title: 'Load the example plan?', message: 'This replaces the plan currently stored on this device. You can undo the change while this session is open.', confirmText: 'Load example', action: () => { state.undo.push(snapshot()); state.redo = []; state.plan = createSamplePlan(); state.activeStoreyId = state.plan.geometry.storeys[0].id; state.selection = null; state.view.initialised = false; resizeCanvas(); render(); scheduleSave(); } }); }

function cancelBox() { hideDimensionEditor({ redraw: false }); state.pendingBox = null; state.boxError = ''; render(); }
function cancelRoom() { hideDimensionEditor({ redraw: false }); state.pendingRoom = null; state.roomError = ''; render(); }
function commitPendingRoom() {
  const pending = state.pendingRoom; const storey = activeStorey(); if (!pending) return;
  const box = normaliseBox(pending); const polygon = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.depth }, { x: box.x, y: box.y + box.depth }];
  if (!storey.is_closed || !polygon.every(point => pointInPolygon(point, storey.outline))) { state.roomError = 'Room zones must sit inside the closed external shell.'; render(); return; }
  if (!pending.name?.trim()) { state.roomError = 'Give the room a name so it can be used in the retrofit survey.'; render(); return; }
  transaction('add named room', () => { const room = createRoom({ name: pending.name.trim(), polygon }); storey.rooms.push(room); state.pendingRoom = null; state.roomError = ''; state.selection = { type: 'room', id: room.id }; });
  hideDimensionEditor({ redraw: false });
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
  const actions = { undo, redo, 'fit-plan': fitPlan, 'clear-outline': clearOutline, 'finish-outline': finishOutline, 'sample-plan': loadSample, 'clear-dimension': clearDimension, 'new-storey': newStorey, 'duplicate-storey': duplicateStorey, 'delete-wall': deleteWall, 'delete-opening': deleteOpening, 'delete-partition': deletePartition, 'delete-room': deleteRoom, 'delete-item': deleteSurveyItem, 'split-wall': () => setTool('split'), 'apply-box': applyBox, 'cancel-box': cancelBox, 'apply-room': commitPendingRoom, 'cancel-room': cancelRoom, deselect: () => { state.selection = null; render(); }, 'export-json': exportJson, 'export-png': exportPng, 'zoom-in': () => zoomBy(1.2), 'zoom-out': () => zoomBy(.83) };
  actions[action]?.();
}
function zoomBy(amount) { const centre = { x: frame.clientWidth / 2, y: frame.clientHeight / 2 }; const focus = worldPoint(centre); state.view.scale = Math.max(20, Math.min(220, state.view.scale * amount)); state.view.x = centre.x - focus.x*state.view.scale; state.view.y = centre.y - focus.y*state.view.scale; renderCanvas(); }

document.addEventListener('click', event => {
  const tool = event.target.closest('[data-tool]'); if (tool) { setTool(tool.dataset.tool); return; }
  const action = event.target.closest('[data-action]'); if (action) { handleAction(action.dataset.action); return; }
  const storey = event.target.closest('[data-storey]'); if (storey) selectStorey(storey.dataset.storey);
});

elements.address.addEventListener('change', () => transaction('change address', () => { state.plan.property_address = elements.address.value; }, { remember: false }));
elements.postcode.addEventListener('change', () => transaction('change postcode', () => { state.plan.postcode = elements.postcode.value; }, { remember: false }));
elements.north.addEventListener('input', () => transaction('set north', () => { state.plan.north_offset_deg = Number(elements.north.value); }, { remember: false }));
elements.inspector.addEventListener('input', event => {
  const target = event.target;
  if (target.dataset.boxField && state.pendingBox) { state.pendingBox[target.dataset.boxField] = target.value === '' ? 0 : Number(target.value); state.boxError = ''; renderCanvas(); }
  if (target.dataset.roomDraftField && state.pendingRoom) { state.pendingRoom[target.dataset.roomDraftField] = ['width', 'depth'].includes(target.dataset.roomDraftField) ? (target.value === '' ? 0 : Number(target.value)) : target.value; state.roomError = ''; renderCanvas(); }
});
elements.inspector.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.boxField && state.pendingBox) { state.pendingBox[target.dataset.boxField] = target.value === '' ? 0 : Number(target.value); state.boxError = ''; render(); }
  if (target.dataset.roomDraftField && state.pendingRoom) { state.pendingRoom[target.dataset.roomDraftField] = ['width', 'depth'].includes(target.dataset.roomDraftField) ? (target.value === '' ? 0 : Number(target.value)) : target.value; state.roomError = ''; render(); }
  if (target.dataset.wallField) { const wall = getWall(activeStorey(), state.selection?.id); if (!wall) return; transaction('edit wall', () => { wall[target.dataset.wallField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.partitionField) { const partition = activeStorey().partitions?.find(item => item.id === state.selection?.id); if (!partition) return; transaction('edit internal wall', () => { partition[target.dataset.partitionField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.openingField) { const found = findOpening(state.selection?.id); if (!found) return; transaction('edit opening', () => { found.opening[target.dataset.openingField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.roomField) { const room = activeStorey().rooms?.find(item => item.id === state.selection?.id); if (!room) return; transaction('edit room survey data', () => { room[target.dataset.roomField] = target.type === 'checkbox' ? target.checked : (target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value); }); }
  if (target.dataset.itemField) { const item = activeStorey().survey_items?.find(entry => entry.id === state.selection?.id); if (!item) return; transaction('edit survey item', () => { item[target.dataset.itemField] = target.value; }); }
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
    if (event.target.id === 'roomWidthInput') state.pendingRoom.width = Number(event.target.value) || 0;
    if (event.target.id === 'roomDepthInput') state.pendingRoom.depth = Number(event.target.value) || 0;
    if (event.target.id === 'roomNameInput') state.pendingRoom.name = event.target.value;
    state.roomError = ''; renderCanvas();
  }
});
elements.dialog.addEventListener('close', () => { if (elements.dialog.returnValue === 'confirm') state.pendingConfirm?.(); state.pendingConfirm = null; });
canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp); canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => { event.preventDefault(); const before = worldPoint(clientPoint(event)); state.view.scale = Math.max(20, Math.min(220, state.view.scale * (event.deltaY < 0 ? 1.12 : .89))); const after = screenPoint(before); const at = clientPoint(event); state.view.x += at.x - after.x; state.view.y += at.y - after.y; renderCanvas(); }, { passive: false });
window.addEventListener('resize', resizeCanvas); window.addEventListener('beforeunload', () => { if (state.saveTimer) savePlan(state.plan); });

async function initialise() {
  const existing = await loadPlan(); state.plan = existing?.geometry?.storeys ? existing : createPlan(); state.activeStoreyId = state.plan.geometry.storeys[0]?.id;
  for (const storey of state.plan.geometry.storeys) { if (storey.is_closed === undefined) storey.is_closed = Boolean(storey.walls?.length); ensureStoreySurveyData(storey); }
  state.tool = activeStorey()?.outline.length ? 'select' : 'box';
  resizeCanvas(); render(); requestAnimationFrame(() => { if (activeStorey()?.outline.length) fitPlan(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
initialise();
