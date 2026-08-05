// app.js — router + lógica de todas as views
// SPA simples: sem framework, troca de <section class="view"> via data-view.

// A FLIR E5 Pro (assumida antes) na verdade nunca existiu neste projeto —
// a câmera é uma FLIR E50 (linha Exx), confirmada via ExifTool:
// RawThermalImageWidth=240, RawThermalImageHeight=180.
const GRID_W = 240;
const GRID_H = 180;
const GRID_SIZE = GRID_W * GRID_H; // 43.200 pontos, resolução real da FLIR E50

// Resolução antiga (160×120), usada só para migrar dados salvos antes
// dessa correção — nenhuma placa/resultado deveria ficar com um array
// do tamanho errado depois da mudança.
const OLD_GRID_W = 160;
const OLD_GRID_H = 120;

// Reamostra um array (categórico ou numérico) por vizinho mais próximo
// de uma resolução pra outra. Serve tanto para o grid de zonas pintadas
// (valores: null | 'IRRELEVANT' | componentId) quanto para uma matriz
// de temperaturas (valores numéricos) — o método é o mesmo.
function resampleGridArray(arr, oldW, oldH, newW, newH) {
  const out = new Array(newW * newH).fill(null);
  for (let y = 0; y < newH; y++) {
    const oy = Math.min(oldH - 1, Math.floor((y * oldH) / newH));
    for (let x = 0; x < newW; x++) {
      const ox = Math.min(oldW - 1, Math.floor((x * oldW) / newW));
      out[y * newW + x] = arr[oy * oldW + ox];
    }
  }
  return out;
}

// Garante que um grid de zonas pintadas (de uma placa) esteja no
// tamanho atual — reamostra automaticamente se detectar o tamanho
// antigo (160×120), sem exigir nenhuma ação manual do usuário.
function migrateGridIfNeeded(grid) {
  if (!grid || !grid.length) return new Array(GRID_SIZE).fill(null);
  if (grid.length === GRID_SIZE) return grid.slice();
  if (grid.length === OLD_GRID_W * OLD_GRID_H) {
    return resampleGridArray(grid, OLD_GRID_W, OLD_GRID_H, GRID_W, GRID_H);
  }
  // Tamanho desconhecido (nem atual, nem o antigo conhecido): não
  // arrisca misturar dados incompatíveis, começa uma grade vazia.
  return new Array(GRID_SIZE).fill(null);
}

// Mesma ideia, mas para um par (gridSnapshot, tempMap) de um resultado
// salvo — os dois precisam ser reamostrados juntos, com o mesmo mapeamento
// de célula, pra continuarem correspondendo um ao outro.
function migrateResultArraysIfNeeded(gridSnapshot, tempMap) {
  if (!gridSnapshot) return { gridSnapshot, tempMap };
  if (gridSnapshot.length === GRID_SIZE) return { gridSnapshot, tempMap };
  if (gridSnapshot.length === OLD_GRID_W * OLD_GRID_H) {
    return {
      gridSnapshot: resampleGridArray(gridSnapshot, OLD_GRID_W, OLD_GRID_H, GRID_W, GRID_H),
      tempMap: tempMap ? resampleGridArray(tempMap, OLD_GRID_W, OLD_GRID_H, GRID_W, GRID_H) : tempMap,
    };
  }
  return { gridSnapshot: null, tempMap: null };
}

const state = {
  currentView: 'home',
  components: [],
  plates: [],

  // --- Editor de zonas (pintura) ---
  editingPlateId: null,
  grid: new Array(GRID_SIZE).fill(null), // null=não pintado | 'IRRELEVANT' | componentId
  brushSize: 4, // raio em células
  paintMode: 'component', // 'component' | 'irrelevant' | 'eraser'
  selectedComponentId: null,
  isPainting: false,

  // --- Fit exato + gestos (edição ampliada) ---
  tf: { scale: 1, rotate: 0, tx: 0, ty: 0 },
  tfNaturalRect: null, // {left, top, width, height} do canvas sem transform, em coords de página
  activePointers: new Map(),
  gesture: null,

  // --- Undo/redo ---
  undoStack: [],
  redoStack: [],

  editingComponentId: null,
  pendingDeleteComponentId: null,
  pendingDeletePlateId: null,
  pendingDeleteResultId: null
};

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  registerServiceWorker();
  wireNav();
  wireModals();
  wireComponentsView();
  wireNewPlateView();
  wirePlatesView();
  wireHomeView();
  wireHistoryView();
  wireNewImageModal();

  await refreshComponents();
  await refreshPlates();
  await refreshHome();
  updateAllTimestamps();
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('SW não registrado:', err);
    });
  }
}

function formatTimestamp(date) {
  const d = date || new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} | ${hh}:${min}`;
}

function updateAllTimestamps() {
  const now = formatTimestamp();
  const home = document.getElementById('home-updated-at');
  if (home) home.textContent = `atualizado em: ${now}`;
  const plates = document.getElementById('plates-updated-at');
  if (plates) plates.textContent = now;
  const comps = document.getElementById('components-updated-at');
  if (comps) comps.textContent = now;
  const history = document.getElementById('history-updated-at');
  if (history) history.textContent = now;
}

// ---------------------------------------------------------
// Navegação
// ---------------------------------------------------------

function wireNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => goToView(btn.dataset.view));
  });
}

function goToView(viewName) {
  if (viewName !== 'newplate' && !document.getElementById('canvas-expand').hidden) {
    closeCanvasExpand();
  }

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');

  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });

  state.currentView = viewName;
}

// ---------------------------------------------------------
// Gradiente "Iron" + cor automática por componente
// ---------------------------------------------------------

const IRON_STOPS = [
  { pos: 0.00, rgb: [0, 0, 0] },
  { pos: 0.17, rgb: [60, 0, 90] },
  { pos: 0.33, rgb: [180, 0, 180] },
  { pos: 0.50, rgb: [230, 20, 20] },
  { pos: 0.67, rgb: [255, 130, 0] },
  { pos: 0.83, rgb: [255, 220, 0] },
  { pos: 1.00, rgb: [255, 255, 255] }
];

// Gradientes do "filtro" verde/vermelho da tela de resultado — verde
// pra pixels dentro do limite (Tp), vermelho pra pixels acima dele.
const GREEN_STOPS = [
  { pos: 0.00, rgb: [0, 128, 0] },
  { pos: 0.17, rgb: [0, 168, 0] },
  { pos: 0.33, rgb: [0, 210, 0] },
  { pos: 0.50, rgb: [0, 255, 0] },
  { pos: 0.67, rgb: [80, 255, 80] },
  { pos: 0.83, rgb: [120, 255, 120] },
  { pos: 1.00, rgb: [160, 255, 160] }
];
const RED_STOPS = [
  { pos: 0.00, rgb: [128, 0, 0] },
  { pos: 0.17, rgb: [168, 0, 0] },
  { pos: 0.33, rgb: [210, 0, 0] },
  { pos: 0.50, rgb: [255, 0, 0] },
  { pos: 0.67, rgb: [255, 40, 40] },
  { pos: 0.83, rgb: [255, 80, 80] },
  { pos: 1.00, rgb: [255, 128, 128] }
];

function lerp(a, b, t) { return a + (b - a) * t; }

// Amostra um gradiente genérico (lista de stops {pos, rgb}) numa posição t (0..1).
function sampleGradient(stops, t) {
  t = Math.max(0, Math.min(1, t));
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
      a = stops[i]; b = stops[i + 1];
      break;
    }
  }
  const span = (b.pos - a.pos) || 1;
  const localT = (t - a.pos) / span;
  return [
    Math.round(lerp(a.rgb[0], b.rgb[0], localT)),
    Math.round(lerp(a.rgb[1], b.rgb[1], localT)),
    Math.round(lerp(a.rgb[2], b.rgb[2], localT))
  ];
}

function ironColor(t) { return sampleGradient(IRON_STOPS, t); }

// Função pura: recebe a lista de componentes de UMA placa e devolve
// Map<componentId, [r,g,b]>. Só deve ser chamada quando essa lista mudar
// (add/edit/remove de componente na placa), nunca no mount da página.
function calcularCoresComponentes(componentes) {
  const map = new Map();
  if (!componentes.length) return map;

  const tValues = componentes.map((c) => c.tMax);
  const tMin = Math.min(...tValues);
  const tMax = Math.max(...tValues);

  if (tMin === tMax) {
    componentes.forEach((c) => map.set(c.id, [154, 154, 154])); // cinza neutro da equipe
    return map;
  }

  componentes.forEach((c) => {
    const pos = (c.tMax - tMin) / (tMax - tMin);
    map.set(c.id, ironColor(pos));
  });

  return map;
}

function rgbToCss([r, g, b], alpha = 1) {
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------
// COMPONENTES
// ---------------------------------------------------------

function wireComponentsView() {
  document.getElementById('btn-add-component-shortcut').addEventListener('click', () => openComponentModal());
  document.getElementById('btn-shortcut-new-component').addEventListener('click', () => openComponentModal());
  document.getElementById('btn-save-component').addEventListener('click', saveComponentFromModal);
  document.getElementById('btn-cancel-component').addEventListener('click', closeComponentModal);
}

function openComponentModal(existing) {
  state.editingComponentId = existing ? existing.id : null;
  document.getElementById('component-modal-title').textContent = existing ? 'Editar componente' : 'Novo componente';
  document.getElementById('btn-save-component').textContent = existing ? 'Editar' : 'Criar';
  document.getElementById('comp-name').value = existing ? existing.name : '';
  document.getElementById('comp-code').value = existing ? (existing.code || '') : '';
  document.getElementById('comp-tmax').value = existing ? existing.tMax : '';
  document.getElementById('modal-component').classList.add('active');
}

function closeComponentModal() {
  document.getElementById('modal-component').classList.remove('active');
}

async function saveComponentFromModal() {
  const name = document.getElementById('comp-name').value.trim();
  const code = document.getElementById('comp-code').value.trim();
  const tMax = parseFloat(document.getElementById('comp-tmax').value);

  if (!name || isNaN(tMax)) {
    alert('Preencha nome e temperatura máxima.');
    return;
  }

  if (state.editingComponentId) {
    await DB.updateComponent({ id: state.editingComponentId, name, code, tMax });
  } else {
    await DB.addComponent({ name, code, tMax });
  }

  closeComponentModal();
  await refreshComponents();
  updateAllTimestamps();
}

async function refreshComponents() {
  state.components = await DB.getAllComponents();
  renderComponentsList();
}

function renderComponentsList() {
  const el = document.getElementById('components-list');
  el.innerHTML = '';

  if (!state.components.length) {
    el.appendChild(emptyState(
      'Nenhum componente cadastrado',
      'Toque em "+ Novo componente" para adicionar o primeiro, com nome, código e temperatura máxima.'
    ));
    return;
  }

  state.components.forEach((comp) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-row">
        <div>
          <div class="card-title">${escapeHTML(comp.name)}</div>
          <div class="card-sub">Temp. Máx: ${comp.tMax}°C${comp.code ? ' · ' + escapeHTML(comp.code) : ''}</div>
        </div>
        <div class="card-actions">
          <button class="link-action link-action--edit">Editar</button>
          <button class="link-action link-action--delete">Excluir</button>
        </div>
      </div>
    `;

    card.querySelector('.link-action--edit').addEventListener('click', () => openComponentModal(comp));
    card.querySelector('.link-action--delete').addEventListener('click', () => {
      state.pendingDeleteComponentId = comp.id;
      const input = document.getElementById('confirm-delete-component-input');
      input.value = '';
      document.getElementById('btn-confirm-delete-component').disabled = true;

      const placasApagadas = calcularPlacasQueSeriamApagadas(comp.id);
      const warningEl = document.getElementById('delete-component-cascade-warning');
      if (placasApagadas.length) {
        const nomes = placasApagadas.map((p) => `"${p.name}"`).join(', ');
        warningEl.textContent = `Ao excluir esse componente, a(s) placa(s) ${nomes} ficarão sem nenhum componente relevante e serão excluídas também!`;
        warningEl.hidden = false;
      } else {
        warningEl.hidden = true;
      }

      document.getElementById('modal-delete-component').classList.add('active');
    });

    el.appendChild(card);
  });
}

// ---------------------------------------------------------
// NOVA PLACA / EDITAR PLACA — editor de pintura (grade 240x180)
// ---------------------------------------------------------

function wireNewPlateView() {
  const canvas = document.getElementById('zone-canvas');

  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
    canvas.addEventListener(evt, onCanvasPointerUp);
  });

  document.querySelectorAll('.brush-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      document.querySelectorAll('.brush-dot').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll(`.brush-dot[data-size="${size}"]`).forEach((b) => b.classList.add('active'));
      state.brushSize = parseInt(size, 10);
    });
  });

  document.getElementById('tool-irrelevant').addEventListener('click', () => togglePaintMode('irrelevant'));
  document.getElementById('tool-eraser').addEventListener('click', () => togglePaintMode('eraser'));
  document.getElementById('tool-irrelevant-modal').addEventListener('click', () => togglePaintMode('irrelevant'));
  document.getElementById('tool-eraser-modal').addEventListener('click', () => togglePaintMode('eraser'));

  document.getElementById('btn-save-plate').addEventListener('click', handleConcluirPlaca);
  document.getElementById('btn-add-plate-shortcut').addEventListener('click', () => openPlateEditor());
  document.getElementById('btn-shortcut-new-plate').addEventListener('click', () => openPlateEditor());

  document.getElementById('btn-expand-canvas').addEventListener('click', openCanvasExpand);
  document.getElementById('btn-collapse-canvas').addEventListener('click', closeCanvasExpand);
  document.getElementById('btn-clear-canvas').addEventListener('click', clearCanvas);
  document.getElementById('btn-clear-canvas-modal').addEventListener('click', clearCanvas);
  document.querySelectorAll('.js-btn-undo').forEach((b) => b.addEventListener('click', undoPaint));
  document.querySelectorAll('.js-btn-redo').forEach((b) => b.addEventListener('click', redoPaint));

  const roMain = new ResizeObserver(() => fitCanvasExact(document.querySelector('.zone-canvas-wrap')));
  roMain.observe(document.querySelector('.zone-canvas-wrap'));
  const roModal = new ResizeObserver(() => fitCanvasExact(document.getElementById('canvas-expand-stage')));
  roModal.observe(document.getElementById('canvas-expand-stage'));
  const roThermal = new ResizeObserver(fitThermalFilterWrap);
  roThermal.observe(document.getElementById('thermal-filter-wrap'));
}

// ---- Fit exato do canvas (sem letterbox) ----
// Mede o espaço realmente disponível no container e aplica width/height
// em px ao canvas preservando a proporção 4:3, sem sobra. Reseta o
// transform pra identidade e recaptura o "retângulo natural" (posição
// sem transform), usado depois pra mapear toque -> célula da grade
// mesmo quando um zoom/rotação estiver ativo.
function fitCanvasExact(container) {
  if (!container) return;
  const canvas = document.getElementById('zone-canvas');
  const tfWrap = document.getElementById('canvas-tf');
  if (tfWrap.parentElement !== container) return; // não é o container ativo agora

  const availW = container.clientWidth;
  const availH = container.clientHeight;
  if (!availW || !availH) return;

  const ratio = GRID_W / GRID_H;
  let w = availW;
  let h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }

  canvas.style.width = Math.max(1, Math.floor(w)) + 'px';
  canvas.style.height = Math.max(1, Math.floor(h)) + 'px';

  resetCanvasTransform();
  state.tfNaturalRect = canvas.getBoundingClientRect();
}

function resetCanvasTransform() {
  state.tf = { scale: 1, rotate: 0, tx: 0, ty: 0 };
  applyCanvasTransform();
}

function applyCanvasTransform() {
  const tfWrap = document.getElementById('canvas-tf');
  const { tx, ty, rotate, scale } = state.tf;
  tfWrap.style.transform = `translate(${tx}px, ${ty}px) rotate(${rotate}deg) scale(${scale})`;
}

const UNDO_LIMIT = 30;

function pushUndoSnapshot() {
  state.undoStack.push(state.grid.slice());
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  state.redoStack = [];
  refreshUndoRedoButtons();
}

function undoPaint() {
  if (!state.undoStack.length) return;
  state.redoStack.push(state.grid.slice());
  state.grid = state.undoStack.pop();
  redrawCanvasFull();
  refreshUndoRedoButtons();
}

function redoPaint() {
  if (!state.redoStack.length) return;
  state.undoStack.push(state.grid.slice());
  state.grid = state.redoStack.pop();
  redrawCanvasFull();
  refreshUndoRedoButtons();
}

function resetUndoRedo() {
  state.undoStack = [];
  state.redoStack = [];
  refreshUndoRedoButtons();
}

function refreshUndoRedoButtons() {
  document.querySelectorAll('.js-btn-undo').forEach((b) => {
    b.disabled = !state.undoStack.length;
    b.style.opacity = state.undoStack.length ? '1' : '0.35';
  });
  document.querySelectorAll('.js-btn-redo').forEach((b) => {
    b.disabled = !state.redoStack.length;
    b.style.opacity = state.redoStack.length ? '1' : '0.35';
  });
}

function clearCanvas() {
  const temAlgo = state.grid.some((v) => v !== null);
  if (!temAlgo) return;
  if (!confirm('Apagar tudo o que foi pintado nessa placa?')) return;
  pushUndoSnapshot();
  state.grid = new Array(GRID_SIZE).fill(null);
  redrawCanvasFull();
}

// ---- Edição ampliada (modal fullscreen) ----
function openCanvasExpand() {
  const stage = document.getElementById('canvas-expand-stage');
  const tfWrap = document.getElementById('canvas-tf');
  const fieldSlot = document.getElementById('canvas-expand-field-slot');
  const field = document.getElementById('component-select-field');
  stage.appendChild(tfWrap);
  fieldSlot.appendChild(field);
  document.getElementById('canvas-expand').hidden = false;
  fitCanvasExact(stage);
}

function closeCanvasExpand() {
  const wrap = document.querySelector('.zone-canvas-wrap');
  const view = document.getElementById('view-newplate');
  const tfWrap = document.getElementById('canvas-tf');
  const field = document.getElementById('component-select-field');
  view.insertBefore(field, wrap);
  wrap.appendChild(tfWrap);
  document.getElementById('canvas-expand').hidden = true;
  fitCanvasExact(wrap);
}

// ---- Ponteiros: 1 dedo pinta, 2 dedos ampliam/rotacionam ----
function onCanvasPointerDown(e) {
  const canvas = document.getElementById('zone-canvas');
  canvas.setPointerCapture(e.pointerId);
  state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (state.activePointers.size === 1) {
    state.isPainting = true;
    pushUndoSnapshot();
    paintAtClientPoint(e.clientX, e.clientY);
  } else if (state.activePointers.size === 2) {
    state.isPainting = false;
    beginGesture();
  }
}

function onCanvasPointerMove(e) {
  if (!state.activePointers.has(e.pointerId)) return;
  state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (state.activePointers.size >= 2) {
    updateGesture();
  } else if (state.isPainting) {
    paintAtClientPoint(e.clientX, e.clientY);
  }
}

function onCanvasPointerUp(e) {
  state.activePointers.delete(e.pointerId);
  if (state.activePointers.size < 2) state.gesture = null;
  if (state.activePointers.size === 0) state.isPainting = false;
}

function gestureMetrics() {
  const pts = [...state.activePointers.values()];
  const [a, b] = pts;
  const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  return { dist, angle, midX, midY };
}

function beginGesture() {
  state.gesture = { ...gestureMetrics(), tf: { ...state.tf } };
}

function updateGesture() {
  if (!state.gesture) { beginGesture(); return; }
  const m = gestureMetrics();
  const g = state.gesture;

  let scale = g.tf.scale * (m.dist / g.dist);
  scale = Math.min(6, Math.max(1, scale));
  const rotate = g.tf.rotate + (m.angle - g.angle);

  const nr = state.tfNaturalRect;
  const maxT = nr ? Math.max(nr.width, nr.height) * scale * 0.6 : 300;
  const tx = Math.min(maxT, Math.max(-maxT, g.tf.tx + (m.midX - g.midX)));
  const ty = Math.min(maxT, Math.max(-maxT, g.tf.ty + (m.midY - g.midY)));

  state.tf = { scale, rotate, tx, ty };
  applyCanvasTransform();
}

// Converte um ponto de tela (clientX/Y) na célula da grade 240×180,
// invertendo o transform (translate + rotate + scale) aplicado ao
// canvas-tf, de forma que a pintura continue precisa mesmo com
// zoom/rotação ativos na edição ampliada.
function clientToGridPoint(clientX, clientY) {
  const nr = state.tfNaturalRect;
  if (!nr || !nr.width || !nr.height) return null;

  const cx = nr.left + nr.width / 2;
  const cy = nr.top + nr.height / 2;
  const { tx, ty, rotate, scale } = state.tf;
  const rad = -rotate * Math.PI / 180;

  let x = clientX - cx - tx;
  let y = clientY - cy - ty;

  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;

  const sx = rx / scale;
  const sy = ry / scale;

  const localX = sx + cx - nr.left;
  const localY = sy + cy - nr.top;

  const gx = Math.floor((localX / nr.width) * GRID_W);
  const gy = Math.floor((localY / nr.height) * GRID_H);
  return { gx, gy };
}

function paintAtClientPoint(clientX, clientY) {
  if (state.paintMode === 'component' && !state.selectedComponentId) {
    alert('Cadastre e selecione um componente primeiro.');
    state.isPainting = false;
    return;
  }
  const pt = clientToGridPoint(clientX, clientY);
  if (!pt) return;
  paintBrush(pt.gx, pt.gy);
  redrawCanvasFull();
}

function togglePaintMode(mode) {
  setPaintMode(state.paintMode === mode ? 'component' : mode);
}

function setPaintMode(mode) {
  state.paintMode = mode;
  document.querySelectorAll('.js-tool-irrelevant').forEach((b) => b.classList.toggle('active', mode === 'irrelevant'));
  document.querySelectorAll('.js-tool-eraser').forEach((b) => b.classList.toggle('active', mode === 'eraser'));
}

function renderComponentSelectForEditor() {
  const select = document.getElementById('plate-component-select');
  select.innerHTML = '';

  if (!state.components.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Cadastre componentes primeiro';
    select.appendChild(opt);
    state.selectedComponentId = null;
    return;
  }

  state.components.forEach((comp) => {
    const opt = document.createElement('option');
    opt.value = comp.id;
    opt.textContent = `${comp.name} (${comp.tMax}°C)`;
    select.appendChild(opt);
  });

  state.selectedComponentId = state.components[0].id;
  select.value = state.selectedComponentId;
  select.onchange = () => {
    state.selectedComponentId = parseInt(select.value, 10);
    setPaintMode('component');
  };
}

function currentPaintValue() {
  if (state.paintMode === 'irrelevant') return 'IRRELEVANT';
  if (state.paintMode === 'eraser') return null;
  return state.selectedComponentId;
}


function paintBrush(cx, cy) {
  const value = currentPaintValue();
  const r = state.brushSize;
  const r2 = r * r;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      state.grid[y * GRID_W + x] = value;
    }
  }
}

function componentesUsadosNaGrade() {
  const idsUsados = new Set();
  for (let i = 0; i < state.grid.length; i++) {
    const v = state.grid[i];
    if (v !== null && v !== 'IRRELEVANT') idsUsados.add(v);
  }
  return state.components.filter((c) => idsUsados.has(c.id));
}

function redrawCanvasFull() {
  const canvas = document.getElementById('zone-canvas');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(GRID_W, GRID_H);
  const data = imageData.data;

  const componentesUsados = componentesUsadosNaGrade();
  const colorMap = calcularCoresComponentes(componentesUsados);

  for (let i = 0; i < GRID_SIZE; i++) {
    const v = state.grid[i];
    const offset = i * 4;

    if (v === null) {
      data[offset + 3] = 0; // transparente — mostra o xadrez de fundo
    } else if (v === 'IRRELEVANT') {
      data[offset] = 154; data[offset + 1] = 154; data[offset + 2] = 154; data[offset + 3] = 190;
    } else {
      const rgb = colorMap.get(v) || [154, 154, 154];
      data[offset] = rgb[0]; data[offset + 1] = rgb[1]; data[offset + 2] = rgb[2]; data[offset + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  renderLegend(componentesUsados, colorMap);
}

function renderLegend(componentesUsados, colorMap) {
  const el = document.getElementById('zone-legend');
  el.innerHTML = '';

  const usados = componentesUsados || componentesUsadosNaGrade();
  const cores = colorMap || calcularCoresComponentes(usados);
  const temIrrelevante = state.grid.includes('IRRELEVANT');

  if (!usados.length && !temIrrelevante) {
    el.classList.add('legend-list--empty');
    const empty = document.createElement('div');
    empty.className = 'legend-empty';
    empty.textContent = 'Nenhum componente pintado ainda.';
    el.appendChild(empty);
    return;
  }
  el.classList.remove('legend-list--empty');

  usados.forEach((comp) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const rgb = cores.get(comp.id) || [154, 154, 154];
    row.innerHTML = `<span class="legend-swatch" style="background:${rgbToCss(rgb)}"></span><span class="legend-name">${escapeHTML(comp.name)} — ${comp.tMax}°C</span>`;
    el.appendChild(row);
  });

  if (temIrrelevante) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="legend-swatch" style="background:rgba(154,154,154,0.75)"></span><span class="legend-name">Irrelevante (não verificado)</span>`;
    el.appendChild(row);
  }
}

function openPlateEditor(existingPlate) {
  state.editingPlateId = existingPlate ? existingPlate.id : null;
  document.getElementById('plateeditor-title').textContent = existingPlate ? 'Editar placa' : 'Nova placa';
  document.getElementById('btn-save-plate').textContent = existingPlate ? 'Salvar alterações' : 'Concluir';
  document.getElementById('plate-name').value = existingPlate ? existingPlate.name : '';

  state.grid = migrateGridIfNeeded(existingPlate && existingPlate.grid);

  setPaintMode('component');
  document.querySelectorAll('.brush-dot').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.brush-dot[data-size="4"]').forEach((b) => b.classList.add('active'));
  state.brushSize = 4;

  renderComponentSelectForEditor();
  resetUndoRedo();
  redrawCanvasFull();
  goToView('newplate');
}

async function handleConcluirPlaca() {
  const name = document.getElementById('plate-name').value.trim();
  if (!name) { alert('Dê um nome pra placa.'); return; }

  const temAlgoPintado = state.grid.some((v) => v !== null);
  if (!temAlgoPintado) { alert('Pinte pelo menos a área de um componente.'); return; }

  const componentesReais = componentesUsadosNaGrade();
  if (!componentesReais.length) {
    alert('Uma placa não pode ter apenas pontos "irrelevante" — pinte a área de pelo menos um componente de verdade.');
    return;
  }

  const temPontosVazios = state.grid.some((v) => v === null);
  if (temPontosVazios) {
    document.getElementById('modal-fill-irrelevant').classList.add('active');
    return;
  }

  await finalizeSavePlate();
}

async function finalizeSavePlate() {
  const name = document.getElementById('plate-name').value.trim();

  if (state.editingPlateId) {
    await DB.updatePlate({ id: state.editingPlateId, name, grid: state.grid });
  } else {
    await DB.addPlate({ name, grid: state.grid });
  }

  state.editingPlateId = null;
  state.grid = new Array(GRID_SIZE).fill(null);

  await refreshPlates();
  updateAllTimestamps();
  goToView('plates');
}

// ---------------------------------------------------------
// PLACAS
// ---------------------------------------------------------

function wirePlatesView() {
  document.getElementById('btn-shortcut-components').addEventListener('click', () => goToView('components'));
  document.getElementById('btn-shortcut-plates').addEventListener('click', () => goToView('plates'));
}

async function refreshPlates() {
  state.plates = await DB.getAllPlates();
  renderPlatesList();
}

function renderPlatesList() {
  const el = document.getElementById('plates-list');
  el.innerHTML = '';

  if (!state.plates.length) {
    el.appendChild(emptyState(
      'Nenhuma placa cadastrada',
      'Toque em "+ Nova placa" para pintar o primeiro perfil com as zonas de componentes.'
    ));
    return;
  }

  state.plates.forEach((plate) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-row">
        <div class="card-title" style="cursor:pointer">${escapeHTML(plate.name)}</div>
        <div class="card-actions">
          <button class="link-action link-action--edit">Editar</button>
          <button class="link-action link-action--delete">Excluir</button>
        </div>
      </div>
    `;

    card.querySelector('.card-title').addEventListener('click', () => runMockDiagnostic(plate));
    card.querySelector('.link-action--edit').addEventListener('click', () => openPlateEditor(plate));
    card.querySelector('.link-action--delete').addEventListener('click', () => {
      state.pendingDeletePlateId = plate.id;
      const input = document.getElementById('confirm-delete-plate-input');
      input.value = '';
      document.getElementById('btn-confirm-delete-plate').disabled = true;
      document.getElementById('modal-delete-plate').classList.add('active');
    });

    el.appendChild(card);
  });
}

// ---------------------------------------------------------
// RESULTADO / ANÁLISE (mock — sem sensor real conectado ainda)
// ---------------------------------------------------------

function componentesUsadosNaPlaca(plate) {
  const idsUsados = new Set();
  (plate.grid || []).forEach((v) => { if (v !== null && v !== 'IRRELEVANT') idsUsados.add(v); });
  return state.components.filter((c) => idsUsados.has(c.id));
}

// Placas que usam este componente E que, sem ele, ficariam com
// zero componentes reais — ou seja, seriam apagadas junto.
function calcularPlacasQueSeriamApagadas(componentId) {
  return state.plates.filter((plate) => {
    const idsUsados = new Set();
    (plate.grid || []).forEach((v) => { if (v !== null && v !== 'IRRELEVANT') idsUsados.add(v); });
    if (!idsUsados.has(componentId)) return false;
    idsUsados.delete(componentId);
    return idsUsados.size === 0;
  });
}

// Gera leituras simuladas por componente. Usado enquanto a extração real
// de temperatura por pixel (dado radiométrico embutido no arquivo da
// FLIR) não está implementada — inclusive no fluxo de upload real, que
// hoje valida a imagem (resolução) mas ainda não lê temperatura dela.
function generateMockReadings(componentes) {
  return componentes.map((comp) => {
    const factor = 0.55 + Math.random() * 0.6;
    const measured = Math.round(comp.tMax * factor * 10) / 10;
    return { componentId: comp.id, componentName: comp.name, tMax: comp.tMax, measured };
  });
}

async function runMockDiagnostic(plate) {
  const componentes = componentesUsadosNaPlaca(plate);

  if (!componentes.length) {
    alert('Essa placa não tem componentes válidos pintados (ou todos foram marcados como irrelevante).');
    return;
  }

  const readings = generateMockReadings(componentes);

  const gridSnapshot = (plate.grid || []).slice();
  const tempMap = generateTempMap(plate, readings);

  await DB.addResult({ plateId: plate.id, plateName: plate.name, readings, tempMap, gridSnapshot, source: 'mock' });
  renderResultView(plate.name, readings, new Date(), tempMap, gridSnapshot);
  await refreshHome();
  goToView('result');
}

function renderResultView(plateName, readings, timestamp, tempMap, gridSnapshot) {
  document.getElementById('result-plate-name').textContent = plateName;
  document.getElementById('result-updated-at').textContent = formatTimestamp(timestamp);

  const migrated = migrateResultArraysIfNeeded(gridSnapshot, tempMap);
  tempMap = migrated.tempMap;
  gridSnapshot = migrated.gridSnapshot;

  if (tempMap && gridSnapshot) {
    const coloredMap = buildThermalFilterMap(tempMap, gridSnapshot, readings);
    renderThermalFilter(coloredMap, gridSnapshot);
  } else {
    renderThermalFilter(null, null);
  }

  const el = document.getElementById('result-list');
  el.innerHTML = '';

  readings.forEach((r) => {
    const semDados = r.measured === null || r.measured === undefined;
    const isAlert = !semDados && r.measured > r.tMax;
    const card = document.createElement('div');
    card.className = `card ${semDados ? '' : isAlert ? 'card--alert' : 'card--ok'}`;
    card.innerHTML = `
      <div class="card-row">
        <div class="card-title">${escapeHTML(r.componentName)}</div>
        <span class="status-pill ${semDados ? '' : isAlert ? 'status-pill--alert' : 'status-pill--ok'}">${semDados ? '—' : isAlert ? '!' : 'OK'}</span>
      </div>
      <div class="temp-columns">
        <div class="temp-col">
          <div class="temp-col-label">Temp. Máx</div>
          <div class="temp-value temp-value--ok">${r.tMax}°C</div>
        </div>
        <div class="temp-col">
          <div class="temp-col-label">Temp. atual</div>
          <div class="temp-value ${semDados ? '' : isAlert ? 'temp-value--alert' : 'temp-value--ok'}">${semDados ? 'Sem dados' : r.measured + '°C'}</div>
        </div>
      </div>
    `;
    el.appendChild(card);
  });
}

// ---------------------------------------------------------
// HOME
// ---------------------------------------------------------

function wireHomeView() {
  document.getElementById('btn-new-image').addEventListener('click', openNewImageModal);
  document.getElementById('btn-analyze-last').addEventListener('click', async () => {
    await refreshHistory();
    goToView('history');
  });
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await refreshComponents();
    await refreshPlates();
    await refreshHome();
    updateAllTimestamps();
  });
}

function openNewImageModal() {
  const select = document.getElementById('new-image-plate-select');
  select.innerHTML = '';

  if (!state.plates.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Cadastre uma placa primeiro';
    select.appendChild(opt);
  } else {
    state.plates.forEach((plate) => {
      const opt = document.createElement('option');
      opt.value = plate.id;
      opt.textContent = plate.name;
      select.appendChild(opt);
    });
  }

  document.getElementById('new-image-error').hidden = true;
  document.getElementById('new-image-file-input').value = '';
  document.getElementById('modal-new-image').classList.add('active');
}

function wireNewImageModal() {
  document.getElementById('btn-new-image-result').addEventListener('click', openNewImageModal);
  document.getElementById('btn-new-image-upload').addEventListener('click', () => {
    document.getElementById('new-image-file-input').click();
  });
  document.getElementById('new-image-file-input').addEventListener('change', handleImageFileSelected);
  document.getElementById('btn-test-analysis').addEventListener('click', runTestAnalysis);
  document.getElementById('btn-close-new-image').addEventListener('click', () => {
    document.getElementById('modal-new-image').classList.remove('active');
  });
}

function showNewImageError(msg) {
  const el = document.getElementById('new-image-error');
  el.textContent = msg;
  el.hidden = false;
}

// Procura uma sequência de bytes (needle) dentro de outra (haystack).
// Retorna o índice onde ela começa, ou -1 se não encontrar.
function findBytes(haystack, needle) {
  outer:
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Valida o arquivo pelos metadados/blocos proprietários da FLIR (RJPEG),
// não pela resolução do JPEG — câmeras FLIR salvam uma imagem de
// visualização em resolução maior (ex: 640×480) mesmo quando o sensor
// térmico é bem menor (ex: 160×120); a resolução do arquivo não diz
// nada sobre a presença do dado térmico real.
async function validateFlirFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const manufacturerNeedle = new TextEncoder().encode('FLIR Systems');
  const hasManufacturer = findBytes(bytes, manufacturerNeedle) !== -1;

  // Assinatura mágica "FFF\0" que marca o início do bloco radiométrico
  // bruto (o que vai virar a matriz de temperatura, RawThermalImage).
  const rawBlockNeedle = new Uint8Array([0x46, 0x46, 0x46, 0x00]);
  const hasRawBlock = findBytes(bytes, rawBlockNeedle) !== -1;

  if (!hasManufacturer) {
    return { valid: false, reason: 'Essa imagem não tem os metadados da FLIR (fabricante não encontrado). Selecione o arquivo original exportado da câmera.' };
  }
  if (!hasRawBlock) {
    return { valid: false, reason: 'Essa imagem tem metadados da FLIR, mas não o bloco de dados térmicos brutos — parece ser só a foto visual (sem a matriz de temperatura). Selecione o arquivo original (RJPEG), sem edição/recompressão/print.' };
  }
  return { valid: true };
}

async function handleImageFileSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // permite selecionar o mesmo arquivo de novo depois, se precisar
  if (!file) return;

  document.getElementById('new-image-error').hidden = true;

  const select = document.getElementById('new-image-plate-select');
  const plateId = parseInt(select.value, 10);
  const plate = state.plates.find((p) => p.id === plateId);

  if (!plate) {
    showNewImageError('Cadastre e selecione uma placa primeiro.');
    return;
  }

  const componentes = componentesUsadosNaPlaca(plate);
  if (!componentes.length) {
    showNewImageError('Essa placa não tem componentes válidos pintados (ou todos foram marcados como irrelevante).');
    return;
  }

  if (!file.type.startsWith('image/') && !/\.(jpe?g)$/i.test(file.name)) {
    showNewImageError('Esse arquivo não é uma imagem JPEG.');
    return;
  }

  let validation;
  try {
    validation = await validateFlirFile(file);
  } catch {
    showNewImageError('Não foi possível ler esse arquivo.');
    return;
  }

  if (!validation.valid) {
    showNewImageError(validation.reason);
    return;
  }

  await finishImageUpload(plate, componentes, file);
}

// Calcula, por componente, a temperatura máxima real medida dentro da
// sua zona pintada — usando a matriz de temperatura de verdade extraída
// pelo FlirParser (não mais simulada). Máximo (não média) porque o que
// importa numa inspeção térmica é pegar o ponto mais quente da zona.
function computeComponentReadingsFromTempMap(componentes, tempArray, grid) {
  const maxByComponent = new Map();

  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v === null || v === undefined || v === 'IRRELEVANT') continue;
    const t = tempArray[i];
    if (t === null || t === undefined || Number.isNaN(t)) continue;
    const current = maxByComponent.get(v);
    if (current === undefined || t > current) maxByComponent.set(v, t);
  }

  return componentes.map((comp) => {
    const max = maxByComponent.get(comp.id);
    return {
      componentId: comp.id,
      componentName: comp.name,
      tMax: comp.tMax,
      measured: max === undefined ? null : Math.round(max * 10) / 10,
    };
  });
}

// A câmera tem sua própria resolução de sensor (240×180 na FLIR E50,
// mesma resolução canônica do app hoje — mas o resample aqui garante
// que, se algum dia isso divergir, nada quebra silenciosamente).
function resampleTempMapToGrid(frame) {
  if (frame.width === GRID_W && frame.height === GRID_H) {
    return frame.temperatureMap;
  }
  return resampleGridArray(frame.temperatureMap, frame.width, frame.height, GRID_W, GRID_H);
}

// A extração real de temperatura por pixel — leitura do bloco
// radiométrico bruto da FLIR, conversão via equação de Planck — está
// implementada em js/flir/ (módulos FlirParser/thermalParser/etc.) e é
// usada aqui. A verificação de qualidade da foto (se está reta,
// centralizada, próxima o suficiente) ainda fica pra depois — por ora
// toda imagem validada é tratada como uma boa imagem da placa.
async function finishImageUpload(plate, componentes, file) {
  if (!window.FlirParser) {
    showNewImageError('O leitor de imagens da FLIR ainda não carregou. Aguarde um instante e tente de novo.');
    return;
  }

  let frame;
  try {
    frame = await window.FlirParser.parse(file);
  } catch (error) {
    console.error(error);
    showNewImageError(
      'Essa imagem parece ser da FLIR, mas não foi possível extrair os dados térmicos dela ' +
      '(pode estar corrompida ou num formato não suportado ainda). Detalhe técnico: ' + error.message
    );
    return;
  }

  const gridSnapshot = (plate.grid || []).slice();
  const tempMap = resampleTempMapToGrid(frame);
  const readings = computeComponentReadingsFromTempMap(componentes, tempMap, gridSnapshot);

  await DB.addResult({ plateId: plate.id, plateName: plate.name, readings, tempMap, gridSnapshot, source: 'upload' });

  document.getElementById('modal-new-image').classList.remove('active');
  renderResultView(plate.name, readings, new Date(), tempMap, gridSnapshot);
  await refreshHome();
  goToView('result');
}

async function refreshHome() {
  const last = await DB.getLastResult();
  const el = document.getElementById('home-last-result');
  el.innerHTML = '';

  if (!last) {
    el.appendChild(emptyState(
      'Nenhuma leitura ainda',
      'Crie uma placa e rode uma captura para ver o resultado aqui.'
    ));
    return;
  }

  const alerts = last.readings.filter((r) => r.measured > r.tMax);
  const card = document.createElement('div');
  card.className = `card card--pressable ${alerts.length ? 'card--alert' : 'card--ok'}`;
  card.innerHTML = `
    <div class="card-row">
      <div>
        <div class="card-title">${escapeHTML(last.plateName)}</div>
        <div class="card-sub">${alerts.length ? `${alerts.length} em alerta` : 'Tudo dentro do limite'} · ${formatTimestamp(new Date(last.timestamp))}</div>
      </div>
      <span class="status-pill ${alerts.length ? 'status-pill--alert' : 'status-pill--ok'}">${alerts.length ? '!' : 'OK'}</span>
    </div>
  `;
  card.addEventListener('click', () => {
    renderResultView(last.plateName, last.readings, new Date(last.timestamp), last.tempMap, last.gridSnapshot);
    goToView('result');
  });
  el.appendChild(card);
}

// ---------------------------------------------------------
// HISTÓRICO (últimas imagens / análises)
// ---------------------------------------------------------

function wireHistoryView() {
  document.getElementById('btn-history-back').addEventListener('click', () => goToView('home'));
}

async function refreshHistory() {
  const results = await DB.getAllResults();
  renderHistoryList(results);
  const el = document.getElementById('history-updated-at');
  if (el) el.textContent = formatTimestamp();
}

function labelParaOrigem(source) {
  if (source === 'test') return 'Teste';
  if (source === 'mock') return 'Mock';
  return null; // análise real (futuro) não recebe indicativo
}

function renderHistoryList(results) {
  const el = document.getElementById('history-list');
  el.innerHTML = '';

  if (!results.length) {
    el.appendChild(emptyState(
      'Nenhuma análise ainda',
      'Toque em "+ Nova imagem" e rode uma análise para vê-la aqui.'
    ));
    return;
  }

  results.forEach((r) => {
    const alerts = r.readings.filter((rd) => rd.measured > rd.tMax);
    const origemLabel = labelParaOrigem(r.source);

    const card = document.createElement('div');
    card.className = `card card--pressable ${alerts.length ? 'card--alert' : 'card--ok'}`;
    card.innerHTML = `
      <div class="card-row">
        <div>
          <div class="card-title">${escapeHTML(r.plateName)}</div>
          <div class="card-sub">${alerts.length ? `${alerts.length} em alerta` : 'Tudo dentro do limite'} · ${formatTimestamp(new Date(r.timestamp))}</div>
        </div>
        <div class="card-actions" style="align-items:center">
          ${origemLabel ? `<span class="status-pill status-pill--muted">${origemLabel}</span>` : ''}
          <button class="link-action link-action--delete">Excluir</button>
        </div>
      </div>
    `;

    card.querySelector('.card-title').addEventListener('click', () => {
      renderResultView(r.plateName, r.readings, new Date(r.timestamp), r.tempMap, r.gridSnapshot);
      goToView('result');
    });

    card.querySelector('.link-action--delete').addEventListener('click', (e) => {
      e.stopPropagation();
      state.pendingDeleteResultId = r.id;
      const input = document.getElementById('confirm-delete-result-input');
      input.value = '';
      document.getElementById('btn-confirm-delete-result').disabled = true;
      document.getElementById('modal-delete-result').classList.add('active');
    });

    el.appendChild(card);
  });
}

// ---------------------------------------------------------
// ANÁLISE TESTE (dev only) — gera uma matriz 240x180 de temperaturas
// simuladas (com ruído por pixel), reaproveitando o grid já pintado da
// placa pra saber de qual componente cada pixel é. O objetivo é ter
// "algo pra filtrar" enquanto a captura real da FLIR não existe —
// quando ela entrar, só troca a origem desse array; o filtro e o
// desenho continuam os mesmos.
// ---------------------------------------------------------

function generateTempMap(plate, readings) {
  const grid = plate.grid || [];
  const byComponent = new Map(readings.map((r) => [r.componentId, r]));
  const temps = new Array(GRID_SIZE).fill(null);

  for (let i = 0; i < GRID_SIZE; i++) {
    const v = grid[i];
    if (v === null || v === undefined) continue; // fora da área pintada
    if (v === 'IRRELEVANT') { temps[i] = 'IRRELEVANT'; continue; }
    const r = byComponent.get(v);
    if (!r) continue;
    // Ruído de ±9% em torno do valor "medido" do componente, só pra dar
    // textura ao filtro (como a imprecisão real da câmera faria).
    const noise = (Math.random() - 0.5) * r.measured * 0.18;
    temps[i] = Math.max(0, Math.round((r.measured + noise) * 10) / 10);
  }
  return temps;
}

// Desenha o "filtro" verde/vermelho no canvas de resultado: separa os
// pixels avaliados em dois grupos (dentro do limite / acima dele) e usa
// o min/max de CADA grupo (não um valor fixo) pra espalhar o contraste
// pelo gradiente inteiro — dá a sensação de "foto filtrada", não um
// bloco de cor sólida.
function fitThermalFilterWrap() {
  const wrap = document.getElementById('thermal-filter-wrap');
  if (!wrap || wrap.hidden) return;
  const w = wrap.clientWidth;
  if (!w) return;
  wrap.style.height = Math.round((w * 3) / 4) + 'px';
}

function renderThermalFilter(coloredMap, grid) {
  const wrap = document.getElementById('thermal-filter-wrap');
  const legend = document.getElementById('thermal-filter-legend');
  const canvas = document.getElementById('thermal-filter-canvas');

  if (!coloredMap) {
    wrap.hidden = true;
    legend.hidden = true;
    return;
  }

  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(GRID_W, GRID_H);

  for (let i = 0; i < GRID_SIZE; i++) {
    const off = i * 4;
    const v = grid[i];
    const cell = coloredMap[i];

    if (v === null || v === undefined || !cell) {
      imageData.data[off + 3] = 0; // fora da placa (ou sem dado): transparente
      continue;
    }
    if (cell === 'IRRELEVANT') {
      imageData.data[off] = 154; imageData.data[off + 1] = 154; imageData.data[off + 2] = 154;
      imageData.data[off + 3] = 255;
      continue;
    }

    const [r, g, b] = cell.color;
    imageData.data[off] = r; imageData.data[off + 1] = g; imageData.data[off + 2] = b;
    imageData.data[off + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  wrap.hidden = false;
  legend.hidden = false;
  fitThermalFilterWrap();
}

// Calcula, pra cada pixel avaliado, se está OK ou em ALERTA (comparando
// com o Tp do componente dono da célula) e a cor correspondente,
// normalizada pelo min/max do próprio grupo (OK ou ALERTA) dentro
// dessa imagem — é o que cria o contraste "de foto".
function buildThermalFilterMap(tempMap, grid, readings) {
  const tpById = new Map(readings.map((r) => [r.componentId, r.tMax]));
  const okVals = [];
  const alertVals = [];
  const status = new Array(GRID_SIZE).fill(null);

  for (let i = 0; i < GRID_SIZE; i++) {
    const v = grid[i];
    const t = tempMap[i];
    if (v === null || v === undefined || v === 'IRRELEVANT' || t === null || t === undefined) continue;
    const tp = tpById.get(v);
    if (tp === undefined) continue;
    const isAlert = t > tp;
    status[i] = { isAlert, value: t };
    (isAlert ? alertVals : okVals).push(t);
  }

  const okMin = okVals.length ? Math.min(...okVals) : 0;
  const okMax = okVals.length ? Math.max(...okVals) : 1;
  const alertMin = alertVals.length ? Math.min(...alertVals) : 0;
  const alertMax = alertVals.length ? Math.max(...alertVals) : 1;

  const colored = new Array(GRID_SIZE).fill(null);
  for (let i = 0; i < GRID_SIZE; i++) {
    if (grid[i] === 'IRRELEVANT') { colored[i] = 'IRRELEVANT'; continue; }
    const s = status[i];
    if (!s) continue;
    let t;
    if (s.isAlert) {
      t = alertMax === alertMin ? 1 : (s.value - alertMin) / (alertMax - alertMin);
      colored[i] = { color: sampleGradient(RED_STOPS, t) };
    } else {
      t = okMax === okMin ? 1 : (s.value - okMin) / (okMax - okMin);
      colored[i] = { color: sampleGradient(GREEN_STOPS, t) };
    }
  }
  return colored;
}

async function runTestAnalysis() {
  const select = document.getElementById('new-image-plate-select');
  const plateId = parseInt(select.value, 10);
  const plate = state.plates.find((p) => p.id === plateId);

  if (!plate) {
    alert('Cadastre e selecione uma placa primeiro.');
    return;
  }

  const componentes = componentesUsadosNaPlaca(plate);
  if (!componentes.length) {
    alert('Essa placa não tem componentes válidos pintados (ou todos foram marcados como irrelevante).');
    return;
  }

  const readings = generateMockReadings(componentes);

  const gridSnapshot = (plate.grid || []).slice();
  const tempMap = generateTempMap(plate, readings); // simula a captura — cada chamada é diferente

  await DB.addResult({ plateId: plate.id, plateName: plate.name, readings, tempMap, gridSnapshot, source: 'test' });

  document.getElementById('modal-new-image').classList.remove('active');
  renderResultView(plate.name, readings, new Date(), tempMap, gridSnapshot);
  await refreshHome();
  goToView('result');
}

// ---------------------------------------------------------
// Modais
// ---------------------------------------------------------

function wireModals() {
  // Preencher com irrelevante ao concluir placa
  document.getElementById('btn-fill-back').addEventListener('click', () => {
    document.getElementById('modal-fill-irrelevant').classList.remove('active');
    // Não salva nada — volta pro editor pra continuar pintando.
  });
  document.getElementById('btn-fill-yes').addEventListener('click', async () => {
    state.grid = state.grid.map((v) => (v === null ? 'IRRELEVANT' : v));
    document.getElementById('modal-fill-irrelevant').classList.remove('active');
    await finalizeSavePlate();
  });

  // Excluir componente — exige digitar "excluir"
  const compInput = document.getElementById('confirm-delete-component-input');
  const compConfirmBtn = document.getElementById('btn-confirm-delete-component');
  compInput.addEventListener('input', () => {
    compConfirmBtn.disabled = compInput.value.trim().toLowerCase() !== 'excluir';
  });
  document.getElementById('btn-cancel-delete-component').addEventListener('click', () => {
    state.pendingDeleteComponentId = null;
    document.getElementById('modal-delete-component').classList.remove('active');
  });
  compConfirmBtn.addEventListener('click', async () => {
    if (state.pendingDeleteComponentId) {
      const placasApagadas = calcularPlacasQueSeriamApagadas(state.pendingDeleteComponentId);
      for (const plate of placasApagadas) {
        await DB.deletePlate(plate.id);
      }
      await DB.replaceComponentUsageWithIrrelevant(state.pendingDeleteComponentId);
      await DB.deleteComponent(state.pendingDeleteComponentId);
      state.pendingDeleteComponentId = null;
      await refreshComponents();
      await refreshPlates();
      await refreshHome();
      updateAllTimestamps();
    }
    document.getElementById('modal-delete-component').classList.remove('active');
  });

  // Excluir placa — exige digitar "excluir"
  const plateInput = document.getElementById('confirm-delete-plate-input');
  const plateConfirmBtn = document.getElementById('btn-confirm-delete-plate');
  plateInput.addEventListener('input', () => {
    plateConfirmBtn.disabled = plateInput.value.trim().toLowerCase() !== 'excluir';
  });
  document.getElementById('btn-cancel-delete-plate').addEventListener('click', () => {
    state.pendingDeletePlateId = null;
    document.getElementById('modal-delete-plate').classList.remove('active');
  });
  plateConfirmBtn.addEventListener('click', async () => {
    if (state.pendingDeletePlateId) {
      await DB.deletePlate(state.pendingDeletePlateId);
      state.pendingDeletePlateId = null;
      await refreshPlates();
      updateAllTimestamps();
    }
    document.getElementById('modal-delete-plate').classList.remove('active');
  });

  // Excluir resultado/análise — exige digitar "excluir"
  const resultInput = document.getElementById('confirm-delete-result-input');
  const resultConfirmBtn = document.getElementById('btn-confirm-delete-result');
  resultInput.addEventListener('input', () => {
    resultConfirmBtn.disabled = resultInput.value.trim().toLowerCase() !== 'excluir';
  });
  document.getElementById('btn-cancel-delete-result').addEventListener('click', () => {
    state.pendingDeleteResultId = null;
    document.getElementById('modal-delete-result').classList.remove('active');
  });
  resultConfirmBtn.addEventListener('click', async () => {
    if (state.pendingDeleteResultId) {
      await DB.deleteResult(state.pendingDeleteResultId);
      state.pendingDeleteResultId = null;
      await refreshHistory();
      await refreshHome();
      updateAllTimestamps();
    }
    document.getElementById('modal-delete-result').classList.remove('active');
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.remove('active');
    });
  });
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

function emptyState(title, body) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<div class="empty-state__title">${escapeHTML(title)}</div><div class="empty-state__body">${escapeHTML(body)}</div>`;
  return div;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
