const L = window.L;

const SETTINGS_KEY = 'meshLos.settings.v1';
const POINTS_KEY = 'meshLos.points.v1';
const DEFAULT_SETTINGS = {
  units: 'imperial',
  radiusKm: 25,
  zoom: 12,
  network: 'meshcore',
  meshcorePreset: 'USA',
  meshtasticPreset: 'Long Fast',
  meshtasticRegion: 'US',
  txPower: 22,
  cableLoss: 1,
  defaultGain: 3,
  k: 1.333,
  clutter: 0,
  extraLoss: 0,
  terrainMode: 'shade',
  terrainOpacity: 0.6,
  showCoverage: false,
  covMode: 'margin',
  covOpacity: 0.7,
  rxHeight: 1.5,
  rxGain: 2,
  showBlocked: true,
  lastDem: null,
};
const STRING_SETTINGS = new Set(['units', 'terrainMode', 'covMode', 'network', 'meshcorePreset', 'meshtasticPreset', 'meshtasticRegion']);
const VIEW_ONLY_SETTINGS = new Set(['covOpacity', 'showBlocked']);
const MESHCORE_PRESETS = [
  ['Australia', 915.8, 10, 250],
  ['Australia (Narrow)', 916.575, 7, 62.5],
  ['Australia (Mid)', 915.075, 9, 125],
  ['Australia: SA, WA', 923.125, 8, 62.5],
  ['Australia: QLD', 923.125, 8, 62.5],
  ['Brazil', 923.125, 8, 62.5],
  ['Canada', 910.525, 7, 62.5],
  ['Costa Rica', 910.525, 11, 125],
  ['Czech Republic (Narrow)', 869.432, 7, 62.5],
  ['EU/UK (Narrow)', 869.618, 8, 62.5],
  ['EU/UK (Deprecated)', 869.525, 11, 250],
  ['EU 433MHz (Long Range)', 433.65, 11, 250],
  ['EU 433MHz (Narrow)', 433.65, 8, 62.5],
  ['Hungary', 869.618, 7, 62.5],
  ['Netherlands', 869.618, 7, 62.5],
  ['Netherlands (Limburg)', 869.618, 8, 62.5],
  ['New Zealand (Narrow)', 917.375, 7, 62.5],
  ['New Zealand (Gisborne)', 917.375, 11, 250],
  ['Portugal 433', 433.375, 9, 62.5],
  ['Portugal 868', 869.618, 7, 62.5],
  ['Slovakia', 869.618, 7, 62.5],
  ['Switzerland', 869.618, 8, 62.5],
  ['Thailand', 921, 7, 62.5],
  ['USA', 910.525, 7, 62.5],
  ['USA - Southern California', 927.875, 7, 62.5],
  ['Vietnam (Narrow)', 920.25, 8, 62.5],
  ['Vietnam (Deprecated)', 920.25, 11, 250],
].map(([name, freq, sf, bw]) => ({ name, freq, sf, bw }));
const MESHTASTIC_PRESETS = [
  ['Long Fast', 11, 250],
  ['Long Moderate', 11, 125],
  ['Long Slow', 12, 125],
  ['Long Turbo', 11, 500],
  ['Medium Slow', 10, 250],
  ['Medium Fast', 9, 250],
  ['Short Slow', 8, 250],
  ['Short Fast', 7, 250],
  ['Short Turbo', 7, 500],
].map(([name, sf, bw]) => ({ name, sf, bw }));
const MESHTASTIC_REGIONS = [
  ['US', 'US / Canada (915 MHz)', 906.875],
  ['EU_868', 'EU / UK (868 MHz)', 869.525],
  ['ANZ', 'Australia / NZ (915–928 MHz)', 919.875],
  ['433', '433 MHz regions', 433.875],
  ['920', 'Asia 920 MHz (JP, KR, TW, SG…)', 921.0],
  ['IN', 'India (865 MHz)', 866.0],
].map(([id, name, freq]) => ({ id, name, freq }));
const SNR_LIMIT_DB = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
const NOISE_FIGURE_DB = 6;
const UNITS = {
  metric: { height: { label: 'm', perMeter: 1 }, distance: { label: 'km', perMeter: 0.001 } },
  imperial: { height: { label: 'ft', perMeter: 3.28084 }, distance: { label: 'mi', perMeter: 1 / 1609.344 } },
};
const UNIT_SETTINGS = {
  radiusKm: { kind: 'distance', meters: 1000 },
  rxHeight: { kind: 'height', meters: 1 },
  clutter: { kind: 'height', meters: 1 },
};
const POINT_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777', '#4f46e5', '#65a30d'];
const LINK_COLORS = { good: '#16a34a', ok: '#eab308', bad: '#dc2626' };
const LEGENDS = {
  margin: [
    ['rgba(21,128,61,0.7)', '≥ 20 dB'],
    ['rgba(74,194,84,0.65)', '10–20 dB'],
    ['rgba(234,179,8,0.6)', '0–10 dB'],
    ['rgba(234,88,12,0.35)', '–10–0 dB (fringe)'],
  ],
  los: [
    ['rgba(22,163,74,0.67)', 'Visible'],
    ['rgba(234,179,8,0.6)', () => `Blocked by ≤ ${heightText(5)}`],
    ['rgba(234,88,12,0.35)', () => `Blocked by ${heightNumber(5)}–${heightText(20)}`],
  ],
  count: [
    ['rgba(96,165,250,0.55)', '1 site'],
    ['rgba(37,99,235,0.65)', '2'],
    ['rgba(30,27,160,0.75)', '3+'],
  ],
};

const $ = (id) => document.getElementById(id);

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings simply won't persist */
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key.includes('-')) node.setAttribute(key, value);
    else if (value !== false && value != null) node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

function fmt(value, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '–';
  return value.toFixed(digits);
}

function signed(value, digits = 1) {
  if (!Number.isFinite(value)) return '–';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function unit(kind) {
  return (UNITS[state.settings.units] ?? UNITS.imperial)[kind];
}

function heightNumber(meters, digits = 0) {
  return fmt(meters * unit('height').perMeter, digits);
}

function heightText(meters, digits = 0) {
  return `${heightNumber(meters, digits)} ${unit('height').label}`;
}

function distanceText(meters, digits = 1) {
  return `${fmt(meters * unit('distance').perMeter, digits)} ${unit('distance').label}`;
}

function roundForInput(value) {
  return String(Math.round(value * 10) / 10);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const state = {
  settings: { ...DEFAULT_SETTINGS, ...loadJson(SETTINGS_KEY, {}) },
  points: loadJson(POINTS_KEY, []),
  ground: new Map(),
  dem: null,
  demCounter: 0,
  links: [],
  selectedLinkKey: null,
  selectedPointId: null,
  isAdding: false,
  profile: null,
  coverageKey: null,
  coverageMode: null,
  coverageUrl: null,
  coverageStats: null,
};

const worker = new Worker(`worker.js?v=${Date.now()}`);
const pending = new Map();
let requestId = 0;

worker.onmessage = (e) => {
  const msg = e.data;
  const entry = pending.get(msg.id);
  if (!entry) return;
  if (msg.type === 'progress') {
    entry.onProgress?.(msg);
    return;
  }
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
};

function call(cmd, args = {}, onProgress = null) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, cmd, ...args });
  });
}

function radioConfig() {
  const s = state.settings;
  if (s.network === 'meshtastic') {
    const preset = MESHTASTIC_PRESETS.find((p) => p.name === s.meshtasticPreset) ?? MESHTASTIC_PRESETS[0];
    const region = MESHTASTIC_REGIONS.find((r) => r.id === s.meshtasticRegion) ?? MESHTASTIC_REGIONS[0];
    return { freq: region.freq, sf: preset.sf, bw: preset.bw };
  }
  const preset = MESHCORE_PRESETS.find((p) => p.name === s.meshcorePreset) ?? MESHCORE_PRESETS.find((p) => p.name === 'USA');
  return { freq: preset.freq, sf: preset.sf, bw: preset.bw };
}

function sensitivity() {
  const { bw, sf } = radioConfig();
  return -174 + 10 * Math.log10(bw * 1000) + NOISE_FIGURE_DB + SNR_LIMIT_DB[sf];
}

function radioParams() {
  const s = state.settings;
  return { freq: radioConfig().freq, k: s.k, clutter: s.clutter, txPower: s.txPower, cableLoss: s.cableLoss };
}

function siteOf(p) {
  return { lat: p.lat, lon: p.lon, h: p.h, gain: p.gain };
}

function saveSettings() {
  saveJson(SETTINGS_KEY, state.settings);
}

function savePoints() {
  saveJson(POINTS_KEY, state.points);
}


const map = L.map('map', { zoomControl: true, preferCanvas: false });
const baseLayers = {
  Topographic: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    className: 'grayscale-tiles',
    attribution: 'Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)',
  }),
  Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'grayscale-tiles',
    attribution: '© OpenStreetMap contributors',
  }),
  Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles © Esri',
  }),
};
baseLayers.Streets.addTo(map);
map.createPane('terrain').style.zIndex = 250;
const linksLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
L.control.layers(baseLayers, { Links: linksLayer }, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);

let demRect = null;
let coverageOverlay = null;
let terrainOverlay = null;
let terrainUrl = null;
let terrainSeq = 0;
let hoverMarker = null;
const markers = new Map();


function nextName() {
  const used = new Set(state.points.map((p) => p.name));
  let i = 1;
  while (used.has(`R${i}`)) i++;
  return `R${i}`;
}

function addPoint(lat, lon) {
  const p = {
    id: newId(),
    name: nextName(),
    lat,
    lon,
    h: state.settings.units === 'metric' ? 10 : 30 / UNITS.imperial.height.perMeter,
    gain: state.settings.defaultGain,
    color: POINT_COLORS[state.points.length % POINT_COLORS.length],
    shouldShowCoverage: true,
  };
  state.points.push(p);
  savePoints();
  renderPointList();
  syncMarkers();
  scheduleAnalysis();
}

function removePoint(id) {
  state.points = state.points.filter((p) => p.id !== id);
  state.ground.delete(id);
  if (state.selectedLinkKey?.includes(id)) closeProfile();
  savePoints();
  renderPointList();
  syncMarkers();
  scheduleAnalysis();
}

function updatePoint(id, patch, { shouldAnalyze = true } = {}) {
  const p = state.points.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  savePoints();
  syncMarkers();
  if (shouldAnalyze) scheduleAnalysis();
}

function selectPoint(id) {
  state.selectedPointId = id;
  for (const node of document.querySelectorAll('.point')) {
    node.classList.toggle('selected', node.dataset.id === id);
  }
  syncMarkers();
  document.querySelector(`.point[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function pinIcon(p) {
  const isSelected = p.id === state.selectedPointId;
  const html = el('div', { class: `pin${isSelected ? ' selected' : ''}` }, [
    el('span', { class: 'pin-dot', style: { background: p.color } }),
    el('span', { class: 'pin-label', text: p.name }),
  ]);
  return L.divIcon({ html, className: 'pin-icon', iconSize: null, iconAnchor: [0, 0] });
}

function syncMarkers() {
  const ids = new Set(state.points.map((p) => p.id));
  for (const [id, marker] of markers) {
    if (!ids.has(id)) {
      markersLayer.removeLayer(marker);
      markers.delete(id);
    }
  }
  for (const p of state.points) {
    let marker = markers.get(p.id);
    if (!marker) {
      marker = L.marker([p.lat, p.lon], { draggable: true, icon: pinIcon(p), keyboard: false });
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        updatePoint(p.id, { lat, lon: lng });
        updatePointMeta();
      });
      marker.on('click', () => selectPoint(p.id));
      marker.addTo(markersLayer);
      markers.set(p.id, marker);
    } else {
      marker.setLatLng([p.lat, p.lon]);
      marker.setIcon(pinIcon(p));
    }
  }
}

function numberField(label, value, step, onChange) {
  return el('label', {}, [
    label,
    el('input', {
      type: 'number',
      value,
      step,
      onchange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      },
    }),
  ]);
}

function renderPointList() {
  const list = $('pointList');
  list.replaceChildren();
  $('pointsEmpty').hidden = state.points.length > 0;
  for (const p of state.points) {
    const item = el('div', { class: `point${p.id === state.selectedPointId ? ' selected' : ''}` }, [
      el('span', { class: 'dot', style: { background: p.color } }),
      el('input', {
        class: 'name',
        value: p.name,
        'aria-label': 'Point name',
        oninput: (e) => {
          updatePoint(p.id, { name: e.target.value }, { shouldAnalyze: false });
          renderLinks();
        },
      }),
      el('div', { class: 'actions' }, [
        el('button', {
          type: 'button',
          title: 'Zoom to point',
          text: '⌖',
          onclick: () => {
            map.setView([p.lat, p.lon], Math.max(map.getZoom(), 13));
            selectPoint(p.id);
          },
        }),
        el('button', { type: 'button', title: 'Delete point', text: '✕', onclick: () => removePoint(p.id) }),
      ]),
      el('div', { class: 'fields' }, [
        numberField(`Height (${unit('height').label} AGL)`, roundForInput(p.h * unit('height').perMeter), 1, (v) =>
          updatePoint(p.id, { h: Math.max(0, v / unit('height').perMeter) })
        ),
        numberField('Gain (dBi)', p.gain, 0.5, (v) => updatePoint(p.id, { gain: v })),
        el('label', { class: 'check small', title: 'Include in coverage overlay' }, [
          el('input', {
            type: 'checkbox',
            checked: p.shouldShowCoverage,
            onchange: (e) => updatePoint(p.id, { shouldShowCoverage: e.target.checked }),
          }),
          'Coverage',
        ]),
      ]),
      el('div', { class: 'meta', 'data-meta': p.id }),
    ]);
    item.dataset.id = p.id;
    item.addEventListener('click', (e) => {
      if (e.target === item) selectPoint(p.id);
    });
    list.append(item);
  }
  updatePointMeta();
}

function updatePointMeta() {
  for (const p of state.points) {
    const node = document.querySelector(`.point[data-id="${CSS.escape(p.id)}"] .meta`);
    if (!node) continue;
    const ground = state.ground.get(p.id);
    const coords = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
    node.textContent =
      ground == null
        ? `${coords} · no elevation data here yet`
        : `${coords} · ground ${heightText(ground)} · antenna ${heightText(ground + p.h)} above sea level`;
  }
}


function areaBbox() {
  const r = state.settings.radiusKm;
  if (!state.points.length) {
    const b = map.getBounds();
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  }
  const lats = state.points.map((p) => p.lat);
  const lons = state.points.map((p) => p.lon);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const maxAbsLat = Math.max(Math.abs(north), Math.abs(south));
  const dLat = r / 111.32;
  const dLon = r / (111.32 * Math.cos((Math.min(maxAbsLat + dLat, 85) * Math.PI) / 180));
  return {
    north: Math.min(85, north + dLat),
    south: Math.max(-85, south - dLat),
    east: Math.max(...lons) + dLon,
    west: Math.min(...lons) - dLon,
  };
}

function setProgress(barId, fraction) {
  const bar = $(barId);
  if (fraction == null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
}

async function downloadDem(bbox, zoom, { isQuiet = false } = {}) {
  const btn = $('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  setProgress('demProgress', 0);
  try {
    const info = await call('loadDem', { bbox, zoom }, (p) => {
      setProgress('demProgress', p.done / p.total);
      $('demStatus').textContent = `Tile ${p.done} of ${p.total}${p.cached ? ` (${p.cached} cached)` : ''}${p.failed ? ` · ${p.failed} failed` : ''}`;
    });
    state.dem = { ...info, id: ++state.demCounter };
    state.coverageKey = null;
    state.settings.lastDem = { bbox, zoom };
    saveSettings();
    drawDemRect();
    renderDemStatus();
    updateTerrain();
    if (!isQuiet && state.points.length === 0) map.fitBounds(demBounds());
    scheduleAnalysis(0);
  } catch (err) {
    $('demStatus').textContent = `Could not load elevation: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download elevation for area';
    setProgress('demProgress', null);
  }
}

function renderDemStatus() {
  const info = state.dem;
  if (!info) return;
  const failed = info.failed ? ` · ${info.failed} tiles failed (filled as sea level)` : '';
  $('demStatus').textContent = `${info.tiles} tiles (${info.cached} from cache) · ${info.w}×${info.h} cells · ~${heightText(info.metersPerCell)} per cell${failed}`;
}

function demBounds() {
  const b = state.dem.bounds;
  return L.latLngBounds([b.south, b.west], [b.north, b.east]);
}

function drawDemRect() {
  if (demRect) map.removeLayer(demRect);
  demRect = L.rectangle(demBounds(), {
    color: '#0f766e',
    weight: 1.5,
    dashArray: '6 6',
    fill: false,
    interactive: false,
  }).addTo(map);
}

function isInsideDem(p) {
  if (!state.dem) return false;
  const b = state.dem.bounds;
  return p.lat <= b.north && p.lat >= b.south && p.lon <= b.east && p.lon >= b.west;
}

function updateDemWarning() {
  const warn = $('demWarn');
  if (!state.points.length) {
    warn.hidden = true;
    return;
  }
  if (!state.dem) {
    warn.hidden = false;
    warn.textContent = 'Download elevation data to analyze line of sight.';
    return;
  }
  const outside = state.points.filter((p) => !isInsideDem(p)).length;
  warn.hidden = outside === 0;
  warn.textContent = `${outside} point${outside === 1 ? ' is' : 's are'} outside the elevation area. Download again to include ${outside === 1 ? 'it' : 'them'}.`;
}


let analysisTimer = null;
let analysisSeq = 0;

function scheduleAnalysis(delay = 250) {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, delay);
}

async function runAnalysis() {
  const seq = ++analysisSeq;
  updateDemWarning();
  updateSensitivity();
  if (!state.dem) {
    state.links = [];
    renderLinks();
    return;
  }
  try {
    const ground = await call('elev', { pts: state.points.map((p) => [p.lat, p.lon]) });
    if (seq !== analysisSeq) return;
    state.points.forEach((p, i) => state.ground.set(p.id, ground[i]));
    updatePointMeta();

    const inside = state.points.filter((p) => state.ground.get(p.id) != null);
    const pairs = [];
    for (let i = 0; i < inside.length; i++) {
      for (let j = i + 1; j < inside.length; j++) {
        pairs.push({ key: `${inside[i].id}|${inside[j].id}`, a: siteOf(inside[i]), b: siteOf(inside[j]) });
      }
    }
    const results = pairs.length ? await call('links', { pairs, radio: radioParams() }) : [];
    if (seq !== analysisSeq) return;
    state.links = results.map(decorateLink).filter(Boolean);
    renderLinks();

    if (state.selectedLinkKey) {
      if (state.links.some((l) => l.key === state.selectedLinkKey)) await loadProfile(state.selectedLinkKey);
      else closeProfile();
    }

    if (state.settings.showCoverage) await updateCoverage(seq);
    else removeCoverage();
  } catch (err) {
    $('covStatus').textContent = `Analysis failed: ${err.message}`;
  }
}

function linkBudget(a, b, fspl, diffLoss) {
  const s = state.settings;
  return s.txPower + a.gain + b.gain - 2 * s.cableLoss - s.extraLoss - fspl - diffLoss - sensitivity();
}

function pathClass(minClear, minRatio) {
  if (minClear < 0) return 'blocked';
  if (minRatio < 0.6) return 'fresnel';
  return 'clear';
}

function marginClass(margin) {
  if (margin >= 10) return 'good';
  if (margin >= 0) return 'ok';
  return 'bad';
}

function decorateLink(r) {
  const [idA, idB] = r.key.split('|');
  const a = state.points.find((p) => p.id === idA);
  const b = state.points.find((p) => p.id === idB);
  if (!a || !b) return null;
  const margin = linkBudget(a, b, r.fspl, r.diffLoss);
  return { ...r, a, b, margin, path: pathClass(r.minClear, r.minRatio), quality: marginClass(margin) };
}

const PATH_LABELS = { clear: 'Clear', fresnel: 'Fresnel', blocked: 'Blocked' };
const PATH_LONG = {
  clear: 'Clear line of sight (≥ 60% of the first Fresnel zone free)',
  fresnel: 'Line of sight, but the Fresnel zone is obstructed',
  blocked: 'No line of sight (terrain blocks the path)',
};

function renderLinks() {
  linksLayer.clearLayers();
  const tbody = $('linkTable').querySelector('tbody');
  tbody.replaceChildren();
  const visible = state.links
    .filter((l) => state.settings.showBlocked || l.margin >= 0)
    .sort((x, y) => y.margin - x.margin);
  $('linksEmpty').hidden = visible.length > 0;
  $('linksEmpty').textContent = state.links.length
    ? 'All links fail. Tick “Show failed links” to see them.'
    : 'Add two or more points and download elevation data to see links.';

  for (const l of visible) {
    const isSelected = l.key === state.selectedLinkKey;
    const line = L.polyline(
      [
        [l.a.lat, l.a.lon],
        [l.b.lat, l.b.lon],
      ],
      {
        color: LINK_COLORS[l.quality],
        weight: isSelected ? 6 : 3.5,
        opacity: l.margin >= 0 ? 0.9 : 0.55,
        dashArray: l.path === 'blocked' ? '8 7' : null,
      }
    );
    line.bindTooltip(
      el('span', { text: `${l.a.name} ↔ ${l.b.name} · ${distanceText(l.dist)} · ${PATH_LABELS[l.path]} · ${signed(l.margin)} dB` }),
      { sticky: true, className: 'link-tip' }
    );
    line.on('click', () => selectLink(l.key));
    line.addTo(linksLayer);
    if (isSelected) line.bringToFront();

    const row = el('tr', { class: isSelected ? 'selected' : '', onclick: () => selectLink(l.key, { shouldFit: true }) }, [
      el('td', { text: `${l.a.name} ↔ ${l.b.name}` }),
      el('td', { text: fmt(l.dist * unit('distance').perMeter, 1) }),
      el('td', {}, el('span', { class: `badge ${l.path}`, title: PATH_LONG[l.path], text: PATH_LABELS[l.path] })),
      el('td', { class: `margin-${l.quality}`, text: `${signed(l.margin)} dB` }),
    ]);
    tbody.append(row);
  }
}

async function selectLink(key, { shouldFit = false } = {}) {
  state.selectedLinkKey = key;
  renderLinks();
  const link = state.links.find((l) => l.key === key);
  if (link && shouldFit) {
    map.fitBounds(
      L.latLngBounds([
        [link.a.lat, link.a.lon],
        [link.b.lat, link.b.lon],
      ]),
      { padding: [60, 60], paddingBottomRight: [60, 320] }
    );
  }
  await loadProfile(key);
}


async function loadProfile(key) {
  const link = state.links.find((l) => l.key === key);
  if (!link) return;
  const data = await call('profile', { a: siteOf(link.a), b: siteOf(link.b), radio: radioParams() });
  if (state.selectedLinkKey !== key) return;
  state.profile = { link, data };
  $('profile').hidden = false;
  $('profileTitle').textContent = `${link.a.name} → ${link.b.name}`;
  renderProfileSummary();
  drawProfile();
}

function renderProfileSummary() {
  if (!state.profile) return;
  const { link } = state.profile;
  $('profileSummary').textContent = [
    distanceText(link.dist, 2),
    PATH_LONG[link.path],
    `min Fresnel clearance ${fmt(link.minRatio * 100)}%`,
    `diffraction ${fmt(link.diffLoss, 1)} dB`,
    `path loss ${fmt(link.fspl + link.diffLoss, 1)} dB`,
    `link margin ${signed(link.margin)} dB`,
  ].join(' · ');
}

function closeProfile() {
  state.selectedLinkKey = null;
  state.profile = null;
  $('profile').hidden = true;
  if (hoverMarker) {
    map.removeLayer(hoverMarker);
    hoverMarker = null;
  }
  renderLinks();
}

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function profileSeries(data) {
  const { n, dist, h0, h1, lambda, samples } = data;
  const d = new Float64Array(n);
  const elev = new Float64Array(n);
  const ground = new Float64Array(n);
  const top = new Float64Array(n);
  const los = new Float64Array(n);
  const f1 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    d[i] = samples[o];
    elev[i] = samples[o + 1];
    ground[i] = samples[o + 1] + samples[o + 2];
    top[i] = ground[i] + samples[o + 3];
    los[i] = h0 + ((h1 - h0) * d[i]) / dist;
    f1[i] = Math.sqrt(Math.max(0, (lambda * d[i] * (dist - d[i])) / dist));
  }
  return { n, dist, h0, h1, d, elev, ground, top, los, f1 };
}

let profileHoverX = null;

function drawProfile() {
  if (!state.profile) return;
  const canvas = $('profileCanvas');
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  if (W === 0 || H === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const s = profileSeries(state.profile.data);
  const { n, dist: D } = s;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    yMin = Math.min(yMin, s.ground[i]);
    yMax = Math.max(yMax, s.top[i], s.los[i] + s.f1[i]);
  }
  yMax = Math.max(yMax, s.h0, s.h1);
  const yRange = Math.max(yMax - yMin, 10);
  yMin -= yRange * 0.06;
  yMax += yRange * 0.1;

  const pad = { l: 56, r: 16, t: 10, b: 26 };
  const X = (d) => pad.l + (d / D) * (W - pad.l - pad.r);
  const Y = (e) => pad.t + ((yMax - e) / (yMax - yMin)) * (H - pad.t - pad.b);
  const bottom = H - pad.b;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = color('--muted');
  ctx.strokeStyle = color('--chart-grid');
  ctx.lineWidth = 1;
  const hu = unit('height');
  const du = unit('distance');
  const yStep = niceStep((yMax - yMin) * hu.perMeter, 5);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil((yMin * hu.perMeter) / yStep) * yStep; v <= yMax * hu.perMeter; v += yStep) {
    const y = Y(v / hu.perMeter);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(`${v.toFixed(0)} ${hu.label}`, pad.l - 6, y);
  }
  const span = D * du.perMeter;
  const xStep = niceStep(span, 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let v = 0; v <= span + 1e-9; v += xStep) {
    const x = X(v / du.perMeter);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.fillText(`${+v.toFixed(2)} ${du.label}`, x, bottom + 6);
  }

  ctx.beginPath();
  for (let i = 0; i < n; i++) ctx.lineTo(X(s.d[i]), Y(s.los[i] + s.f1[i]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(s.d[i]), Y(s.los[i] - s.f1[i]));
  ctx.closePath();
  ctx.fillStyle = color('--chart-fresnel');
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) ctx.lineTo(X(s.d[i]), Y(s.los[i] - 0.6 * s.f1[i]));
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = color('--chart-los');
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  const hasClutter = s.top.some((t, i) => t > s.ground[i]);
  if (hasClutter) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(X(s.d[i]), Y(s.top[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(s.d[i]), Y(s.ground[i]));
    ctx.closePath();
    ctx.fillStyle = color('--chart-clutter');
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.beginPath();
  ctx.moveTo(X(0), bottom);
  for (let i = 0; i < n; i++) ctx.lineTo(X(s.d[i]), Y(s.ground[i]));
  ctx.lineTo(X(D), bottom);
  ctx.closePath();
  ctx.fillStyle = color('--chart-terrain');
  ctx.fill();

  ctx.lineWidth = 3;
  for (let i = 1; i < n - 1; i++) {
    const isBlocking = s.top[i] > s.los[i];
    const isInFresnel = s.top[i] > s.los[i] - 0.6 * s.f1[i];
    if (!isInFresnel) continue;
    ctx.strokeStyle = isBlocking ? LINK_COLORS.bad : LINK_COLORS.ok;
    ctx.beginPath();
    ctx.moveTo(X(s.d[i - 1]), Y(s.top[i - 1]));
    ctx.lineTo(X(s.d[i]), Y(s.top[i]));
    ctx.stroke();
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = color('--chart-los');
  ctx.beginPath();
  ctx.moveTo(X(0), Y(s.h0));
  ctx.lineTo(X(D), Y(s.h1));
  ctx.stroke();

  const { link } = state.profile;
  for (const [d, groundE, top, p, align] of [
    [0, s.ground[0], s.h0, link.a, 'left'],
    [D, s.ground[n - 1], s.h1, link.b, 'right'],
  ]) {
    ctx.strokeStyle = color('--text');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(d), Y(groundE));
    ctx.lineTo(X(d), Y(top));
    ctx.stroke();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(X(d), Y(top), 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color('--text');
    ctx.textAlign = align;
    ctx.textBaseline = 'bottom';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`${p.name} (${heightText(p.h)})`, X(d) + (align === 'left' ? 6 : -6), Y(top) - 4);
  }

  drawProfileHover(ctx, s, X, Y, pad, bottom, color);
}

function drawProfileHover(ctx, s, X, Y, pad, bottom, color) {
  const tip = $('profileTip');
  if (profileHoverX == null) {
    tip.hidden = true;
    return;
  }
  const W = ctx.canvas.width / (window.devicePixelRatio || 1);
  const frac = (profileHoverX - pad.l) / (W - pad.l - pad.r);
  if (frac < 0 || frac > 1) {
    tip.hidden = true;
    return;
  }
  const i = Math.round(frac * (s.n - 1));
  const x = X(s.d[i]);
  ctx.strokeStyle = color('--text');
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, pad.t);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const clearance = s.los[i] - s.top[i];
  const pct = s.f1[i] > 0 ? (clearance / s.f1[i]) * 100 : null;
  tip.textContent = [
    distanceText(s.d[i], 2),
    `ground ${heightText(s.elev[i])}`,
    `LOS ${heightText(s.los[i])}`,
    `clearance ${signed(clearance * unit('height').perMeter, 0)} ${unit('height').label}${pct == null ? '' : ` (${fmt(pct)}% of F1)`}`,
  ].join(' · ');
  tip.hidden = false;
  const tipWidth = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(x - tipWidth / 2, 4), W - tipWidth - 4)}px`;

  const { link } = state.profile;
  const f = s.d[i] / s.dist;
  const latlng = [link.a.lat + (link.b.lat - link.a.lat) * f, link.a.lon + (link.b.lon - link.a.lon) * f];
  if (!hoverMarker) {
    hoverMarker = L.circleMarker(latlng, { radius: 6, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    hoverMarker.setLatLng(latlng);
  }
}


async function updateCoverage(seq) {
  const sites = state.points.filter((p) => p.shouldShowCoverage && state.ground.get(p.id) != null).map(siteOf);
  if (!sites.length) {
    removeCoverage();
    $('covStatus').textContent = 'Tick “Coverage” on at least one point inside the elevation area.';
    return;
  }
  const s = state.settings;
  const params = {
    sites,
    radio: radioParams(),
    radiusM: s.radiusKm * 1000,
    rxHeight: s.rxHeight,
    rxGain: s.rxGain,
    sens: sensitivity() + s.extraLoss,
  };
  const key = JSON.stringify({ ...params, demId: state.dem.id });
  const mode = s.covMode;
  if (key === state.coverageKey && mode === state.coverageMode && coverageOverlay) return;

  let result;
  if (key === state.coverageKey) {
    result = await call('colorize', { mode });
  } else {
    const started = performance.now();
    setProgress('covProgress', 0);
    $('covStatus').textContent = `Computing coverage for ${sites.length} point${sites.length === 1 ? '' : 's'}…`;
    try {
      result = await call('coverage', { ...params, mode }, (p) => setProgress('covProgress', p.done / p.total));
    } finally {
      setProgress('covProgress', null);
    }
    state.coverageKey = key;
    state.coverageStats = { count: sites.length, radiusM: params.radiusM, seconds: (performance.now() - started) / 1000 };
    renderCoverageStatus();
  }
  state.coverageMode = mode;
  if (seq !== analysisSeq || !state.settings.showCoverage) return;
  setCoverageImage(result.blob, result.bounds);
}

async function updateTerrain() {
  const seq = ++terrainSeq;
  const mode = state.settings.terrainMode;
  if (!state.dem || mode === 'off') {
    removeTerrain();
    return;
  }
  try {
    const { blob, bounds } = await call('terrain', { mode });
    if (seq !== terrainSeq) return;
    const url = URL.createObjectURL(blob);
    const latLngBounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
    if (terrainOverlay) {
      terrainOverlay.setUrl(url);
      terrainOverlay.setBounds(latLngBounds);
    } else {
      terrainOverlay = L.imageOverlay(url, latLngBounds, {
        pane: 'terrain',
        opacity: state.settings.terrainOpacity,
        interactive: false,
      }).addTo(map);
    }
    if (terrainUrl) URL.revokeObjectURL(terrainUrl);
    terrainUrl = url;
  } catch (err) {
    $('demStatus').textContent = `Could not draw terrain: ${err.message}`;
  }
}

function removeTerrain() {
  if (terrainOverlay) {
    map.removeLayer(terrainOverlay);
    terrainOverlay = null;
  }
  if (terrainUrl) {
    URL.revokeObjectURL(terrainUrl);
    terrainUrl = null;
  }
}

function renderCoverageStatus() {
  const stats = state.coverageStats;
  if (!stats) return;
  $('covStatus').textContent = `Coverage for ${stats.count} point${stats.count === 1 ? '' : 's'} out to ${distanceText(stats.radiusM, 0)}, computed in ${stats.seconds.toFixed(1)} s.`;
}

function setCoverageImage(blob, b) {
  const url = URL.createObjectURL(blob);
  const bounds = [
    [b.south, b.west],
    [b.north, b.east],
  ];
  if (coverageOverlay) {
    coverageOverlay.setUrl(url);
    coverageOverlay.setBounds(L.latLngBounds(bounds));
  } else {
    coverageOverlay = L.imageOverlay(url, bounds, {
      opacity: state.settings.covOpacity,
      className: 'cov-img',
      interactive: false,
    }).addTo(map);
    coverageOverlay.bringToBack();
  }
  if (state.coverageUrl) URL.revokeObjectURL(state.coverageUrl);
  state.coverageUrl = url;
}

function removeCoverage() {
  if (coverageOverlay) {
    map.removeLayer(coverageOverlay);
    coverageOverlay = null;
  }
  if (state.coverageUrl) {
    URL.revokeObjectURL(state.coverageUrl);
    state.coverageUrl = null;
  }
}

function renderLegend() {
  const items = LEGENDS[state.settings.covMode] ?? [];
  $('legend').replaceChildren(
    ...items.map(([bg, label]) =>
      el('span', {}, [el('i', { style: { background: bg } }), typeof label === 'function' ? label() : label])
    )
  );
}


function updateSensitivity() {
  const { freq, sf, bw } = radioConfig();
  $('radioSummary').textContent = `SF${sf} · BW ${bw} kHz · ${freq} MHz · sensitivity ≈ ${fmt(sensitivity(), 1)} dBm`;
}

function populateRadioOptions() {
  $('meshcorePreset').replaceChildren(...MESHCORE_PRESETS.map((p) => el('option', { value: p.name, text: p.name })));
  $('meshtasticPreset').replaceChildren(
    ...MESHTASTIC_PRESETS.map((p) => el('option', { value: p.name, text: `${p.name}${p.name === 'Long Fast' ? ' (default)' : ''}` }))
  );
  $('meshtasticRegion').replaceChildren(...MESHTASTIC_REGIONS.map((r) => el('option', { value: r.id, text: r.name })));
}

function showNetworkFields() {
  for (const node of document.querySelectorAll('[data-network]')) {
    node.hidden = node.dataset.network !== state.settings.network;
  }
}

function applySettingToInput(input) {
  const key = input.dataset.setting;
  const value = state.settings[key];
  const conversion = UNIT_SETTINGS[key];
  if (conversion) input.value = roundForInput(value * conversion.meters * unit(conversion.kind).perMeter);
  else if (input.type === 'checkbox') input.checked = Boolean(value);
  else if (input.type === 'radio') input.checked = input.value === value;
  else input.value = String(value);
}

function bindSettings() {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    applySettingToInput(input);

    input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
      let next;
      if (input.type === 'checkbox') next = input.checked;
      else if (STRING_SETTINGS.has(key)) next = input.value;
      else {
        next = Number(input.value);
        if (!Number.isFinite(next)) return;
        const conversion = UNIT_SETTINGS[key];
        if (conversion) next = next / unit(conversion.kind).perMeter / conversion.meters;
      }
      state.settings[key] = next;
      saveSettings();
      onSettingChanged(key);
    });
  }
  showNetworkFields();
}

function renderUnits() {
  for (const node of document.querySelectorAll('[data-unit-label]')) {
    node.textContent = unit(node.dataset.unitLabel).label;
  }
  for (const option of document.querySelectorAll('[data-cell-m]')) {
    option.textContent = `${option.dataset.name} (~${heightText(Number(option.dataset.cellM))})`;
  }
  for (const input of document.querySelectorAll('[data-setting]')) {
    if (UNIT_SETTINGS[input.dataset.setting]) applySettingToInput(input);
  }
}

function onSettingChanged(key) {
  if (key === 'units') {
    renderUnits();
    renderPointList();
    renderLinks();
    renderLegend();
    renderDemStatus();
    renderCoverageStatus();
    renderProfileSummary();
    drawProfile();
    return;
  }
  if (key === 'terrainOpacity') {
    terrainOverlay?.setOpacity(state.settings.terrainOpacity);
    return;
  }
  if (key === 'terrainMode') {
    updateTerrain();
    return;
  }
  if (key === 'covOpacity') {
    coverageOverlay?.setOpacity(state.settings.covOpacity);
    return;
  }
  if (key === 'showBlocked') {
    renderLinks();
    return;
  }
  if (key === 'covMode') renderLegend();
  if (key === 'network') showNetworkFields();
  if (key === 'zoom') return;
  if (VIEW_ONLY_SETTINGS.has(key)) return;
  scheduleAnalysis();
}


function setAdding(isOn) {
  state.isAdding = isOn;
  $('addModeBtn').classList.toggle('active', isOn);
  $('addModeBtn').textContent = isOn ? 'Done adding' : '+ Add on map';
  $('addHint').hidden = !isOn;
  $('map').classList.toggle('adding', isOn);
}

function parseCoords(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

function exportJson() {
  const data = { version: 1, points: state.points, settings: state.settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'mesh-los-points.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const points = Array.isArray(data) ? data : data.points;
    if (!Array.isArray(points)) throw new Error('No points array found');
    state.points = points
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p, i) => ({
        id: p.id ?? newId(),
        name: String(p.name ?? `R${i + 1}`),
        lat: p.lat,
        lon: p.lon,
        h: Number.isFinite(p.h) ? p.h : 10,
        gain: Number.isFinite(p.gain) ? p.gain : state.settings.defaultGain,
        color: p.color ?? POINT_COLORS[i % POINT_COLORS.length],
        shouldShowCoverage: p.shouldShowCoverage ?? true,
      }));
    if (data.settings && typeof data.settings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...data.settings, lastDem: state.settings.lastDem };
      saveSettings();
      bindSettingsValues();
    }
    savePoints();
    renderPointList();
    syncMarkers();
    fitPoints();
    scheduleAnalysis(0);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
}

function bindSettingsValues() {
  for (const input of document.querySelectorAll('[data-setting]')) applySettingToInput(input);
  renderUnits();
  showNetworkFields();
  updateSensitivity();
  renderLegend();
}

function fitPoints() {
  if (!state.points.length) return;
  if (state.points.length === 1) {
    map.setView([state.points[0].lat, state.points[0].lon], 12);
    return;
  }
  map.fitBounds(L.latLngBounds(state.points.map((p) => [p.lat, p.lon])), { padding: [50, 50], maxZoom: 13 });
}

$('addModeBtn').addEventListener('click', () => setAdding(!state.isAdding));
map.on('click', (e) => {
  if (state.isAdding) addPoint(e.latlng.lat, e.latlng.lng);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.isAdding) setAdding(false);
  else if (state.profile) closeProfile();
});
$('coordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const coords = parseCoords($('coordInput').value);
  if (!coords) {
    $('coordInput').setCustomValidity('Enter "lat, lon" in decimal degrees');
    $('coordInput').reportValidity();
    return;
  }
  $('coordInput').setCustomValidity('');
  $('coordInput').value = '';
  addPoint(coords[0], coords[1]);
  map.setView(coords, Math.max(map.getZoom(), 11));
});
$('coordInput').addEventListener('input', () => $('coordInput').setCustomValidity(''));
$('fitBtn').addEventListener('click', fitPoints);
$('exportBtn').addEventListener('click', exportJson);
$('importInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file);
  e.target.value = '';
});
$('clearBtn').addEventListener('click', () => {
  if (!state.points.length || !confirm('Remove all points?')) return;
  state.points = [];
  state.ground.clear();
  closeProfile();
  savePoints();
  renderPointList();
  syncMarkers();
  scheduleAnalysis(0);
});
$('downloadBtn').addEventListener('click', () => downloadDem(areaBbox(), state.settings.zoom));
$('clearCacheBtn').addEventListener('click', async () => {
  try {
    await caches.delete('terrarium-tiles-v1');
    $('demStatus').textContent = 'Tile cache cleared.';
  } catch {
    $('demStatus').textContent = 'Could not clear the tile cache in this browser.';
  }
});
$('profileClose').addEventListener('click', closeProfile);
$('profileCanvas').addEventListener('mousemove', (e) => {
  profileHoverX = e.clientX - e.currentTarget.getBoundingClientRect().left;
  drawProfile();
});
$('profileCanvas').addEventListener('mouseleave', () => {
  profileHoverX = null;
  if (hoverMarker) {
    map.removeLayer(hoverMarker);
    hoverMarker = null;
  }
  drawProfile();
});
new ResizeObserver(() => drawProfile()).observe($('profileCanvas'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawProfile());


populateRadioOptions();
bindSettings();
renderUnits();
renderLegend();
updateSensitivity();
renderPointList();
syncMarkers();
if (state.points.length) fitPoints();
else if (state.settings.lastDem) {
  const b = state.settings.lastDem.bbox;
  map.fitBounds([
    [b.south, b.west],
    [b.north, b.east],
  ]);
} else map.setView([39.8, -98.6], 4);

if (state.settings.lastDem) downloadDem(state.settings.lastDem.bbox, state.settings.lastDem.zoom, { isQuiet: true });
else scheduleAnalysis(0);
