import {
  WALL_TYPES, boxesTouchOrOverlap, clone, closestWall, createPlan, createSamplePlan, createStorey, derivePlan,
  distance, getWall, isSelfIntersecting, makeOpening, metres, moveAxisAlignedWall, moveVertex, newId, normaliseBox, outlineFromBoxes, pointAlong, polygonArea, resizeWall, squareMetres, syncWalls, wallLength
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
  drawPreview: null, boxPreview: null, pendingBox: null, boxError: '', derived: null, saveTimer: null, pendingConfirm: null,
  dimensionHits: [], measurementEditor: null, closureSuggestion: null, interactionNotice: ''
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
  if (selection.type === 'opening') return storey.walls.some(wall => wall.openings?.some(opening => opening.id === selection.id));
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

function fitPlan() {
  const outline = activeStorey()?.outline || [];
  const width = frame.clientWidth || 600; const height = frame.clientHeight || 450;
  if (outline.length < 2) { state.view = { scale: Math.max(48, Math.min(width / 11, height / 10)), x: width * .2, y: height * .18, initialised: true }; renderCanvas(); return; }
  const xs = outline.map(point => point.x); const ys = outline.map(point => point.y);
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

function drawOpening(storey, wall, opening) {
  const from = storey.outline[wall.from]; const to = storey.outline[wall.to]; const length = distance(from, to); if (!length) return;
  const start = pointAlong(from, to, Math.max(0, Math.min(1, opening.offset_m / length))); const end = pointAlong(from, to, Math.max(0, Math.min(1, (opening.offset_m + opening.width_m) / length)));
  const screenStart = screenPoint(start); const screenEnd = screenPoint(end); const isSelected = state.selection?.type === 'opening' && state.selection.id === opening.id;
  ctx.save(); ctx.strokeStyle = opening.kind === 'door' ? '#ec5a35' : '#5b9ab4'; ctx.lineWidth = isSelected ? 9 : 7; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(screenStart.x, screenStart.y); ctx.lineTo(screenEnd.x, screenEnd.y); ctx.stroke();
  if (opening.kind === 'door' || opening.kind === 'glazed_door') {
    const dx = screenEnd.x - screenStart.x; const dy = screenEnd.y - screenStart.y; const hypot = Math.hypot(dx, dy) || 1; const nx = -dy / hypot; const ny = dx / hypot;
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ec5a35'; ctx.beginPath(); ctx.arc(screenStart.x, screenStart.y, Math.min(Math.hypot(dx, dy), 38), Math.atan2(ny, nx), Math.atan2(dy, dx), false); ctx.stroke();
  }
  ctx.restore();
}

function drawPlan() {
  const storey = activeStorey(); if (!storey?.outline.length) return;
  const points = storey.outline.map(screenPoint); const closed = Boolean(storey.is_closed);
  ctx.save(); ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); if (closed) ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,.87)'; if (closed) ctx.fill();
  if (!closed) { setLineDash([6, 5]); ctx.strokeStyle = '#ec5a35'; ctx.lineWidth = 3; ctx.stroke(); setLineDash([]); ctx.restore(); return; }
  for (const wall of storey.walls) {
    const from = screenPoint(storey.outline[wall.from]); const to = screenPoint(storey.outline[wall.to]); const isSelected = state.selection?.type === 'wall' && state.selection.id === wall.id;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.strokeStyle = isSelected ? '#ec5a35' : wallColour(wall); ctx.lineWidth = isSelected ? 8 : 5; if (wall.type === 'party') setLineDash([6, 4]); ctx.stroke(); setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = isSelected ? '#ec5a35' : '#25475b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(from.x, from.y, isSelected ? 5.5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const opening of wall.openings || []) drawOpening(storey, wall, opening);
  }
  ctx.restore();
  drawDimensions(storey);
}

function drawDimensions(storey) {
  if (state.view.scale < 35 || !storey.outline.length) return;
  ctx.save(); ctx.font = '800 11px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const wall of storey.walls) {
    const from = screenPoint(storey.outline[wall.from]); const to = screenPoint(storey.outline[wall.to]); const length = wallLength(storey, wall); const midX = (from.x + to.x) / 2; const midY = (from.y + to.y) / 2;
    const dx = to.x - from.x; const dy = to.y - from.y; const n = Math.hypot(dx, dy) || 1; const offX = -dy / n * 14; const offY = dx / n * 14;
    drawMeasurementChip(`${length.toFixed(2)} m`, { x: midX + offX, y: midY + offY }, { kind: 'wall', wallId: wall.id });
  }
  ctx.restore();
}

function drawMeasurementChip(label, centre, hit) {
  const measured = ctx.measureText(label).width + 20; const width = Math.max(58, measured); const height = 26;
  const x = centre.x - width / 2; const y = centre.y - height / 2; const active = (hit.kind === 'wall' && state.selection?.type === 'wall' && state.selection.id === hit.wallId) || (hit.kind === 'box' && state.measurementEditor?.kind === 'box');
  ctx.save(); ctx.fillStyle = active ? '#ec5a35' : 'rgba(255,255,255,.96)'; ctx.strokeStyle = active ? '#ec5a35' : '#a8b8be'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, width, height, 5); ctx.fill(); ctx.stroke(); ctx.fillStyle = active ? '#fff' : '#344d5a'; ctx.fillText(label, centre.x, centre.y + .5); ctx.restore();
  state.dimensionHits.push({ x: x - 8, y: y - 7, width: width + 16, height: height + 14, centre, ...hit });
}

function drawPreview() {
  const storey = activeStorey(); if (state.tool !== 'draw' || !state.drawPreview || !storey.outline.length) return;
  const from = screenPoint(storey.outline.at(-1)); const to = screenPoint(state.drawPreview);
  ctx.save(); ctx.strokeStyle = '#ec5a35'; ctx.lineWidth = 3; setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); setLineDash([]);
  const label = `${distance(storey.outline.at(-1), state.drawPreview).toFixed(2)} m`; ctx.font = '800 11px ui-sans-serif, system-ui'; const midX = (from.x + to.x)/2; const midY = (from.y + to.y)/2; const width = ctx.measureText(label).width + 16; ctx.fillStyle = '#102332'; ctx.fillRect(midX - width/2, midY - 12, width, 22); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, midX, midY); ctx.restore();
}

function drawBoxOverlay(box, { pending = false } = {}) {
  if (!box || box.width <= 0 || box.depth <= 0) return;
  const topLeft = screenPoint(box); const width = box.width * state.view.scale; const height = box.depth * state.view.scale;
  ctx.save(); ctx.fillStyle = pending ? 'rgba(236, 90, 53, .16)' : 'rgba(236, 90, 53, .07)'; ctx.strokeStyle = pending ? '#ec5a35' : '#9e6e45'; ctx.lineWidth = pending ? 3 : 1.5; setLineDash(pending ? [8, 5] : [4, 5]); ctx.fillRect(topLeft.x, topLeft.y, width, height); ctx.strokeRect(topLeft.x, topLeft.y, width, height); setLineDash([]);
  ctx.font = '800 11px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  drawMeasurementChip(`${box.width.toFixed(2)} m`, { x: topLeft.x + width / 2, y: Math.max(21, topLeft.y - 19) }, { kind: 'box', field: 'width' });
  drawMeasurementChip(`${box.depth.toFixed(2)} m`, { x: Math.min(frame.clientWidth - 37, topLeft.x + width + 27), y: topLeft.y + height / 2 }, { kind: 'box', field: 'depth' });
  ctx.restore();
}

function drawBoxPreview() { if (state.boxPreview || state.pendingBox) drawBoxOverlay(state.boxPreview || state.pendingBox, { pending: true }); }

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
  state.dimensionHits = []; ctx.clearRect(0, 0, rect.width, rect.height); drawGrid(rect.width, rect.height); drawPlan(); drawPreview(); drawBoxPreview(); drawClosureSuggestion();
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
  } else if (state.selection?.type === 'wall') {
    const wall = getWall(storey, state.selection.id); const derivedWall = derived?.walls.find(item => item.id === wall?.id);
    if (!wall) { state.selection = null; return renderInspector(); }
    elements.inspectorHeading.textContent = `Wall ${wall.from + 1}`; elements.selectionBadge.textContent = 'Wall';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:${wallColour(wall)}"></i><span>Internal wall length<strong>${metres(derivedWall?.length_m)}</strong></span></div>
      <label>Wall type<select data-wall-field="type">${Object.entries(WALL_TYPES).map(([value, label]) => `<option value="${value}" ${wall.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Heat loss treatment<select data-wall-field="heat_loss_mode"><option value="full" ${wall.heat_loss_mode === 'full' ? 'selected' : ''}>Full height</option><option value="partial" ${wall.heat_loss_mode === 'partial' ? 'selected' : ''}>Partial height</option><option value="none" ${wall.heat_loss_mode === 'none' ? 'selected' : ''}>None</option></select></label>
      ${wall.heat_loss_mode === 'partial' ? `<label>Heat loss height (m)<input data-wall-field="heat_loss_height_m" type="number" inputmode="decimal" min="0" max="${storey.height_m}" step="0.01" value="${wall.heat_loss_height_m ?? ''}" /></label>` : ''}
      <div class="stat-stack"><div class="stat-card"><span>Effective HLP</span><strong>${metres(derivedWall?.effective_length_m)}</strong></div><div class="stat-card"><span>Orientation</span><strong>${derivedWall?.orientation || '—'}</strong></div></div>
      <p class="field-note">Party walls are excluded from heat loss perimeter. Derived figures are advisory and remain assessor-verifiable.</p>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-wall">Delete wall</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else if (state.selection?.type === 'opening') {
    const found = findOpening(state.selection.id); if (!found) { state.selection = null; return renderInspector(); }
    const { wall, opening } = found; const derivedWall = derived?.walls.find(item => item.id === wall.id); const derivedOpening = derivedWall?.openings.find(item => item.id === opening.id);
    elements.inspectorHeading.textContent = opening.kind === 'window' ? 'Window' : 'External opening'; elements.selectionBadge.textContent = 'Opening';
    elements.inspector.innerHTML = `
      <div class="wall-chip"><i style="background:#5b9ab4"></i><span>Derived orientation<strong>${derivedOpening?.orientation || '—'}</strong></span></div>
      <label>Opening type<select data-opening-field="kind"><option value="window" ${opening.kind === 'window' ? 'selected' : ''}>Window</option><option value="door" ${opening.kind === 'door' ? 'selected' : ''}>External door</option><option value="glazed_door" ${opening.kind === 'glazed_door' ? 'selected' : ''}>Highly glazed door</option></select></label>
      <div class="form-split"><label>Width (m)<input data-opening-field="width_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.width_m}" /></label><label>Height (m)<input data-opening-field="height_m" type="number" inputmode="decimal" min=".1" step=".01" value="${opening.height_m}" /></label></div>
      <label>Offset from left corner (m)<input data-opening-field="offset_m" type="number" inputmode="decimal" min="0" step=".01" value="${opening.offset_m}" /></label>
      <label>Glazed area ratio <input data-opening-field="glazed_area_ratio" type="number" inputmode="decimal" min="0" max="1" step=".01" placeholder="Use only to check door classification" value="${opening.glazed_area_ratio ?? ''}" /></label>
      <div class="stat-stack"><div class="stat-card"><span>Area</span><strong>${squareMetres(derivedOpening?.area_m2)}</strong></div><div class="stat-card"><span>Wall</span><strong>${derivedWall?.orientation || '—'}</strong></div></div>
      <div class="inspector-action-row"><button class="secondary-button danger" data-action="delete-opening">Delete</button><button class="secondary-button" data-action="deselect">Done</button></div>`;
  } else {
    elements.inspectorHeading.textContent = 'Plan review'; elements.selectionBadge.textContent = 'Plan';
    elements.inspector.innerHTML = `<div class="empty-state"><b>Draw rooms roughly; measure them exactly.</b>Drag <strong>Draw room</strong>, then tap its on-plan measurement chips. Use <strong>Add room</strong> for L-, T- and stepped forms. In Select, drag corners or straight walls to correct the outline.</div><div class="stat-stack"><div class="stat-card"><span>This storey</span><strong>${squareMetres(derived?.floor_area_m2)}</strong></div><div class="stat-card"><span>Storey height</span><strong>${metres(storey.height_m)}</strong></div></div><label>Storey name<input data-storey-field="name" type="text" value="${escapeHTML(storey.name)}" /></label><label>Storey height (m)<input data-storey-field="height_m" type="number" inputmode="decimal" min="2" max="3.5" step=".01" value="${storey.height_m}" /></label><p class="field-note">Geometry is saved to this device after every change. A future sync will add it to your Eco Futures organisation.</p>`;
  }
}

function renderWarnings() {
  const warnings = state.derived?.warnings || []; elements.warningCount.textContent = warnings.length; elements.warningCount.classList.toggle('clear', !warnings.length);
  elements.warnings.innerHTML = warnings.length ? warnings.map(warning => `<li>${escapeHTML(warning)}</li>`).join('') : '<li class="good">No geometry checks need attention.</li>';
}

function renderMetrics() {
  const current = currentDerivedStorey(); elements.area.textContent = squareMetres(current?.floor_area_m2); elements.hlp.textContent = metres(current?.heat_loss_perimeter_m); elements.wallArea.textContent = squareMetres(current?.net_wall_area_m2);
  const openings = current?.walls.reduce((count, wall) => count + wall.openings.length, 0) || 0; elements.openings.textContent = String(openings);
}

function render() {
  state.derived = derivePlan(state.plan); const storey = activeStorey();
  elements.address.value = state.plan.property_address || ''; elements.postcode.value = state.plan.postcode || ''; elements.north.value = String(Math.round(state.plan.north_offset_deg || 0)); elements.northReadout.textContent = `${Math.round(state.plan.north_offset_deg || 0)}°`;
  elements.storeyKicker.textContent = storey.name; elements.canvasHint.classList.toggle('hidden', storey.outline.length > 0 || Boolean(state.pendingBox));
  elements.instruction.textContent = instructions(); document.querySelectorAll('.tool-button').forEach(button => button.classList.toggle('active', button.dataset.tool === state.tool));
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

function findOpening(id) { const storey = activeStorey(); for (const wall of storey.walls) { const opening = wall.openings?.find(item => item.id === id); if (opening) return { wall, opening }; } return null; }

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
  } else if (hit.kind === 'wall') {
    const wall = getWall(activeStorey(), hit.wallId); if (!wall) return;
    state.selection = { type: 'wall', id: wall.id }; state.measurementEditor = { kind: 'wall', wallId: wall.id };
    elements.dimensionPopover.innerHTML = `<span class="popover-kicker">Wall measurement</span><label>Length (m)<input id="wallLengthInput" type="number" inputmode="decimal" min="0.1" step="0.01" value="${wallLength(activeStorey(), wall).toFixed(2)}" /></label><label>Keep this corner fixed<select id="wallAnchorInput"><option value="from">Start corner</option><option value="to">End corner</option></select></label><span class="popover-note">The opposite corner moves. Drag either corner instead if you need to reshape adjoining walls.</span><div class="popover-actions"><button class="secondary-button" type="button" data-measurement-action="cancel">Cancel</button><button class="primary-button" type="submit">Set length</button></div>`;
  } else return;
  elements.dimensionPopover.classList.remove('hidden'); placeDimensionPopover(hit.centre); renderCanvas();
  requestAnimationFrame(() => {
    const input = hit.kind === 'box' ? (hit.field === 'width' ? $('#boxWidthInput') : $('#boxDepthInput')) : $('#wallLengthInput');
    input?.focus({ preventScroll: true }); input?.select();
  });
}

function clampOpenings(storey) {
  for (const wall of storey.walls || []) {
    const length = wallLength(storey, wall);
    for (const opening of wall.openings || []) opening.offset_m = Math.max(0, Math.min(Number(opening.offset_m) || 0, Math.max(0, length - (Number(opening.width_m) || 0))));
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
  const storey = activeStorey(); const wall = getWall(storey, editor.wallId); const length = Number($('#wallLengthInput')?.value); const anchor = $('#wallAnchorInput')?.value || 'from';
  const next = wall && resizeWall(storey.outline, wall.from, length, anchor);
  if (!next || !outlineIsSafe(next)) { const note = elements.dimensionPopover.querySelector('.popover-note'); if (note) note.textContent = 'That would fold the outline. Drag a corner or change the anchored corner instead.'; return; }
  hideDimensionEditor({ redraw: false });
  transaction('set wall length', () => { storey.outline = next; storey.boxes = []; syncWalls(storey); clampOpenings(storey); state.selection = { type: 'wall', id: editor.wallId }; });
}

function pointerDown(event) {
  event.preventDefault(); const point = clientPoint(event); const hit = dimensionHitAt(point);
  if (hit) { openDimensionEditor(hit); return; }
  if (state.measurementEditor) hideDimensionEditor();
  canvas.setPointerCapture?.(event.pointerId); state.pointers.set(event.pointerId, point);
  if (state.pointers.size === 2) { const points = [...state.pointers.values()]; state.gesture = { startDistance: distance(points[0], points[1]), startScale: state.view.scale, startMid: midpoint(points[0], points[1]), startView: { x: state.view.x, y: state.view.y } }; state.drag = null; return; }
  state.drag = { id: event.pointerId, start: point, view: { x: state.view.x, y: state.view.y }, moved: false, mode: 'pan' };
  if (state.tool !== 'select' || state.pendingBox) return;
  const storey = activeStorey(); const world = worldPoint(point); const vertexIndex = closestVertexIndex(storey.outline, world, Math.max(.16, 18 / state.view.scale));
  if (vertexIndex !== -1) {
    state.drag = { ...state.drag, mode: 'vertex', vertexIndex, before: snapshot(), initialOutline: clone(storey.outline), changed: false };
    return;
  }
  const wallHit = closestWall(storey, world, Math.max(.18, 16 / state.view.scale));
  if (wallHit && isAxisAlignedWall(storey, wallHit.wall)) state.drag = { ...state.drag, mode: 'wall', wallIndex: wallHit.wall.from, before: snapshot(), initialOutline: clone(storey.outline), changed: false };
}

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function constrainedPoint(point, event) {
  const storey = activeStorey(); let next = snap(worldPoint(point)); const last = storey.outline.at(-1); if (!last) return next;
  const wantsOrtho = elements.orthogonal.checked && !event.shiftKey;
  if (wantsOrtho) { const dx = next.x - last.x; const dy = next.y - last.y; next = Math.abs(dx) >= Math.abs(dy) ? { x: next.x, y: last.y } : { x: last.x, y: next.y }; }
  const typed = Number(elements.dimension.value); if (typed > 0) { const dx = next.x - last.x; const dy = next.y - last.y; const length = Math.hypot(dx, dy); if (length) next = { x: last.x + dx / length * typed, y: last.y + dy / length * typed }; }
  return snapToOutlineAxes(next, storey.outline);
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
  const next = snap(point); const threshold = Math.max(.14, 16 / state.view.scale); const candidates = outline.filter((_, index) => !exclude.includes(index));
  const x = candidates.reduce((best, candidate) => Math.abs(candidate.x - next.x) < Math.abs(best - next.x) ? candidate.x : best, next.x);
  const y = candidates.reduce((best, candidate) => Math.abs(candidate.y - next.y) < Math.abs(best - next.y) ? candidate.y : best, next.y);
  return { x: Math.abs(x - next.x) <= threshold ? x : next.x, y: Math.abs(y - next.y) <= threshold ? y : next.y };
}

function updateGeometryDrag(point) {
  const drag = state.drag; if (!drag || (drag.mode !== 'vertex' && drag.mode !== 'wall')) return false;
  const storey = activeStorey(); const raw = worldPoint(point); let next = null;
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
  const a = snap(worldPoint(start)); const b = snap(worldPoint(end)); const box = normaliseBox({ x: a.x, y: a.y, width: b.x - a.x, depth: b.y - a.y });
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
  if (state.drag.mode === 'vertex' || state.drag.mode === 'wall') updateGeometryDrag(point);
  else if (state.tool === 'draw') state.drawPreview = constrainedPoint(point, event);
  else if (state.tool === 'box' || state.tool === 'extend') state.boxPreview = boxFromDrag(state.drag.start, point);
  else if (state.drag.moved && state.tool !== 'north') { state.view.x = state.drag.view.x + dx; state.view.y = state.drag.view.y + dy; state.drawPreview = null; }
  renderCanvas();
}

function worldFromView(point, view, scale) { return { x: (point.x - view.x) / scale, y: (point.y - view.y) / scale }; }
function pointerUp(event) {
  const point = clientPoint(event); const drag = state.drag; const hadGesture = Boolean(state.gesture); state.pointers.delete(event.pointerId);
  if (state.pointers.size < 2) state.gesture = null;
  if (drag?.id === event.pointerId && !hadGesture) {
    if ((state.tool === 'box' || state.tool === 'extend') && drag.moved && state.boxPreview?.width > 0 && state.boxPreview?.depth > 0) {
      state.pendingBox = { ...state.boxPreview, mode: state.tool }; state.boxError = ''; state.selection = null; render();
      const widthHit = state.dimensionHits.find(hit => hit.kind === 'box' && hit.field === 'width'); if (widthHit) openDimensionEditor(widthHit);
    } else if (drag.mode === 'vertex' || drag.mode === 'wall') {
      if (drag.changed) commitGeometryDrag(drag); else handleTap(point, event);
    } else if (!drag.moved || state.tool === 'draw') handleTap(point, event);
  }
  state.drag = null; state.drawPreview = null; state.boxPreview = null; renderCanvas();
}

function handleTap(point, event) {
  const storey = activeStorey(); const world = constrainedPoint(point, event);
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
  const opening = closestOpening(storey, world, Math.max(.18, 16 / state.view.scale));
  if (opening) { state.selection = { type: 'opening', id: opening.opening.id }; render(); return; }
  const wall = closestWall(storey, world, Math.max(.16, 14 / state.view.scale)); state.selection = wall ? { type: 'wall', id: wall.wall.id } : null; render();
}

function centroid(points) { if (!points?.length) return null; return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 }); }
function closestOpening(storey, point, tolerance) {
  let closest = null;
  for (const wall of storey.walls) for (const opening of wall.openings || []) {
    const from = storey.outline[wall.from]; const to = storey.outline[wall.to]; const length = distance(from, to); if (!length) continue;
    const a = pointAlong(from, to, opening.offset_m / length); const b = pointAlong(from, to, (opening.offset_m + opening.width_m) / length);
    const match = pointToSegment(point, a, b); if (match.distance <= tolerance && (!closest || match.distance < closest.distance)) closest = { wall, opening, distance: match.distance };
  }
  return closest;
}
function pointToSegment(point, a, b) { const dx = b.x - a.x; const dy = b.y - a.y; const lengthSq = dx * dx + dy * dy; const t = lengthSq ? Math.max(0, Math.min(1, ((point.x-a.x)*dx + (point.y-a.y)*dy) / lengthSq)) : 0; const projected = { x:a.x+dx*t, y:a.y+dy*t }; return { point: projected, distance: distance(point, projected) }; }

function setTool(tool) { hideDimensionEditor({ redraw: false }); state.tool = tool; state.selection = null; state.boxPreview = null; render(); }
function clearDimension() { elements.dimension.value = ''; elements.dimension.focus(); }
function selectStorey(id) { state.activeStoreyId = id; state.selection = null; fitPlan(); render(); }
function newStorey() { transaction('add storey', () => { const highest = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)); const storey = createStorey({ name: `Storey ${highest + 2}`, level: highest + 1 }); state.plan.geometry.storeys.push(storey); state.activeStoreyId = storey.id; state.selection = null; }); fitPlan(); }
function duplicateStorey() { const source = activeStorey(); if (!source.outline.length) return; transaction('duplicate storey', () => { const level = Math.max(...state.plan.geometry.storeys.map(storey => storey.level)) + 1; const copy = clone(source); copy.id = newId('st'); copy.level = level; copy.name = level === 1 ? 'First floor' : `Storey ${level + 1}`; copy.walls.forEach(wall => { wall.id = newId('w'); wall.openings?.forEach(opening => opening.id = newId('op')); }); state.plan.geometry.storeys.push(copy); state.activeStoreyId = copy.id; state.selection = null; }); fitPlan(); }

function showConfirm({ title, message, action, confirmText }) { state.pendingConfirm = action; elements.dialogTitle.textContent = title; elements.dialogMessage.textContent = message; elements.dialogConfirm.textContent = confirmText; elements.dialog.showModal(); }
function deleteWall() { const storey = activeStorey(); const wall = getWall(storey, state.selection?.id); if (!wall) return; showConfirm({ title: 'Delete this wall?', message: 'This also removes its openings. The remaining outline will be reconnected.', confirmText: 'Delete wall', action: () => transaction('delete wall', () => { const removeIndex = wall.from; storey.boxes = []; storey.outline.splice(removeIndex, 1); storey.is_closed = storey.outline.length >= 3; syncWalls(storey); state.selection = null; }) }); }
function deleteOpening() { const found = findOpening(state.selection?.id); if (!found) return; transaction('delete opening', () => { found.wall.openings = found.wall.openings.filter(opening => opening.id !== found.opening.id); state.selection = null; }); }
function clearOutline() { if (!activeStorey().outline.length) return; showConfirm({ title: 'Clear this storey?', message: 'This removes the outline and every opening on the active storey. This can be undone.', confirmText: 'Clear storey', action: () => transaction('clear storey', () => { const storey = activeStorey(); storey.boxes = []; storey.outline = []; storey.is_closed = false; storey.walls = []; state.selection = null; }) }); }
function finishOutline() {
  const storey = activeStorey(); const path = closurePath(storey); if (path === null) return;
  transaction('finish outline', () => { storey.outline.push(...path); storey.is_closed = true; syncWalls(storey); state.tool = 'select'; state.selection = null; });
}
function loadSample() { showConfirm({ title: 'Load the example plan?', message: 'This replaces the plan currently stored on this device. You can undo the change while this session is open.', confirmText: 'Load example', action: () => { state.undo.push(snapshot()); state.redo = []; state.plan = createSamplePlan(); state.activeStoreyId = state.plan.geometry.storeys[0].id; state.selection = null; state.view.initialised = false; resizeCanvas(); render(); scheduleSave(); } }); }

function cancelBox() { hideDimensionEditor({ redraw: false }); state.pendingBox = null; state.boxError = ''; render(); }
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
  for (const wall of storey.walls) { const from=drawPoint(storey.outline[wall.from]); const to=drawPoint(storey.outline[wall.to]); exportCtx.beginPath(); exportCtx.moveTo(from.x,from.y); exportCtx.lineTo(to.x,to.y); exportCtx.strokeStyle=wallColour(wall); exportCtx.lineWidth=12; if(wall.type==='party') exportCtx.setLineDash([16,9]); exportCtx.stroke(); exportCtx.setLineDash([]); for(const opening of wall.openings||[]) { const length=wallLength(storey,wall); const a=drawPoint(pointAlong(storey.outline[wall.from],storey.outline[wall.to],opening.offset_m/length)); const b=drawPoint(pointAlong(storey.outline[wall.from],storey.outline[wall.to],(opening.offset_m+opening.width_m)/length)); exportCtx.beginPath(); exportCtx.moveTo(a.x,a.y); exportCtx.lineTo(b.x,b.y); exportCtx.lineWidth=15; exportCtx.strokeStyle=opening.kind==='window'?'#5b9ab4':'#ec5a35'; exportCtx.stroke(); } }
  exportCtx.fillStyle='#102332'; exportCtx.font='700 22px system-ui'; exportCtx.fillText(state.plan.property_address || 'Unaddressed plan', 60, 1018); exportCtx.fillStyle='#52616c'; exportCtx.font='500 18px system-ui'; exportCtx.fillText(`${storey.name} · Internal measurements · Floor area ${squareMetres(currentDerivedStorey()?.floor_area_m2)} · HLP ${metres(currentDerivedStorey()?.heat_loss_perimeter_m)}`,60,1052); exportCtx.fillText('Advisory RdSAP input capture — verify all measurements and classifications before use.',60,1080);
  exportCtx.fillStyle='#ec5a35'; exportCtx.font='900 56px system-ui'; exportCtx.fillText('↑',1490,160); exportCtx.fillStyle='#102332'; exportCtx.font='900 16px system-ui'; exportCtx.fillText('N',1505,185);
  exportCanvas.toBlob(blob => download(blob, `${safeFilename()}-floor-plan.png`), 'image/png');
  void previous;
}
function safeFilename() { return (state.plan.property_address || 'future-floor-plan').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'') || 'future-floor-plan'; }
function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function handleAction(action) {
  const actions = { undo, redo, 'fit-plan': fitPlan, 'clear-outline': clearOutline, 'finish-outline': finishOutline, 'sample-plan': loadSample, 'clear-dimension': clearDimension, 'new-storey': newStorey, 'duplicate-storey': duplicateStorey, 'delete-wall': deleteWall, 'delete-opening': deleteOpening, 'apply-box': applyBox, 'cancel-box': cancelBox, deselect: () => { state.selection = null; render(); }, 'export-json': exportJson, 'export-png': exportPng, 'zoom-in': () => zoomBy(1.2), 'zoom-out': () => zoomBy(.83) };
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
});
elements.inspector.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.boxField && state.pendingBox) { state.pendingBox[target.dataset.boxField] = target.value === '' ? 0 : Number(target.value); state.boxError = ''; render(); }
  if (target.dataset.wallField) { const wall = getWall(activeStorey(), state.selection?.id); if (!wall) return; transaction('edit wall', () => { wall[target.dataset.wallField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.openingField) { const found = findOpening(state.selection?.id); if (!found) return; transaction('edit opening', () => { found.opening[target.dataset.openingField] = target.type === 'number' ? (target.value === '' ? null : Number(target.value)) : target.value; }); }
  if (target.dataset.storeyField) { transaction('edit storey', () => { activeStorey()[target.dataset.storeyField] = target.type === 'number' ? Number(target.value) : target.value; }); }
});
elements.dimensionPopover.addEventListener('submit', event => { event.preventDefault(); applyDimensionEditor(); });
elements.dimensionPopover.addEventListener('click', event => {
  const action = event.target.closest('[data-measurement-action]')?.dataset.measurementAction;
  if (action === 'cancel') { if (state.measurementEditor?.kind === 'box') cancelBox(); else hideDimensionEditor(); }
});
elements.dimensionPopover.addEventListener('input', event => {
  if (state.measurementEditor?.kind !== 'box' || !state.pendingBox) return;
  if (event.target.id === 'boxWidthInput') state.pendingBox.width = Number(event.target.value) || 0;
  if (event.target.id === 'boxDepthInput') state.pendingBox.depth = Number(event.target.value) || 0;
  state.boxError = ''; renderCanvas();
});
elements.dialog.addEventListener('close', () => { if (elements.dialog.returnValue === 'confirm') state.pendingConfirm?.(); state.pendingConfirm = null; });
canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp); canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => { event.preventDefault(); const before = worldPoint(clientPoint(event)); state.view.scale = Math.max(20, Math.min(220, state.view.scale * (event.deltaY < 0 ? 1.12 : .89))); const after = screenPoint(before); const at = clientPoint(event); state.view.x += at.x - after.x; state.view.y += at.y - after.y; renderCanvas(); }, { passive: false });
window.addEventListener('resize', resizeCanvas); window.addEventListener('beforeunload', () => { if (state.saveTimer) savePlan(state.plan); });

async function initialise() {
  const existing = await loadPlan(); state.plan = existing?.geometry?.storeys ? existing : createPlan(); state.activeStoreyId = state.plan.geometry.storeys[0]?.id;
  for (const storey of state.plan.geometry.storeys) if (storey.is_closed === undefined) storey.is_closed = Boolean(storey.walls?.length);
  state.tool = activeStorey()?.outline.length ? 'select' : 'box';
  resizeCanvas(); render(); requestAnimationFrame(() => { if (activeStorey()?.outline.length) fitPlan(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
initialise();
