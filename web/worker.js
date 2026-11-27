const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const CACHE_NAME = 'terrarium-tiles-v1';
const MAX_CELLS = 16_000_000;
const HDR = 16;
const STRIDE = 4;
const MAX_SAMPLES = 8192;
const CONCURRENCY = 8;
const MODES = { margin: 0, los: 1, count: 2, sites: 3 };
const MAX_MASK_SITES = 32;

let wasm = null;
let dem = null;

const ready = WebAssembly.instantiateStreaming(fetch(`los.wasm${self.location.search}`), {}).then((r) => {
  wasm = r.instance.exports;
});

function lonLatToPx(lon, lat, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

function pxToLonLat(x, y, z) {
  const n = 256 * 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function fetchTile(cache, z, x, y) {
  const n = 2 ** z;
  const url = TILE_URL(z, ((x % n) + n) % n, Math.max(0, Math.min(n - 1, y)));
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return { blob: await hit.blob(), isCached: true };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (cache) await cache.put(url, res.clone()).catch(() => {});
  return { blob: await res.blob(), isCached: false };
}

const handlers = {
  async loadDem({ bbox, zoom }, progress) {
    const z = zoom;
    const [px0, py0] = lonLatToPx(bbox.west, bbox.north, z);
    const [px1, py1] = lonLatToPx(bbox.east, bbox.south, z);
    const tx0 = Math.floor(px0 / 256);
    const ty0 = Math.floor(py0 / 256);
    const tx1 = Math.floor(px1 / 256);
    const ty1 = Math.floor(py1 / 256);
    const nx = tx1 - tx0 + 1;
    const ny = ty1 - ty0 + 1;
    const w = nx * 256;
    const h = ny * 256;
    if (w * h > MAX_CELLS) {
      throw new Error(
        `That area needs ${nx}×${ny} tiles (${((w * h) / 1e6).toFixed(0)}M cells) at this resolution. Reduce the radius or choose a coarser resolution.`
      );
    }

    const ptr = wasm.dem_init(w, h, z, tx0 * 256, ty0 * 256);
    const cache = await openCache();
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    const total = jobs.length;
    let done = 0;
    let cached = 0;
    let failed = 0;

    const decodeInto = async (blob, tx, ty) => {
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const grid = new Float32Array(wasm.memory.buffer, ptr, w * h);
      const ox = (tx - tx0) * 256;
      const oy = (ty - ty0) * 256;
      for (let j = 0; j < 256; j++) {
        const row = (oy + j) * w + ox;
        for (let i = 0; i < 256; i++) {
          const k = (j * 256 + i) * 4;
          const e = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
          grid[row + i] = e < 0 ? 0 : e;
        }
      }
    };

    const runner = async () => {
      while (jobs.length) {
        const [tx, ty] = jobs.shift();
        try {
          const { blob, isCached } = await fetchTile(cache, z, tx, ty);
          if (isCached) cached++;
          await decodeInto(blob, tx, ty);
        } catch {
          failed++;
        }
        done++;
        progress({ done, total, cached, failed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, runner));

    const [west, north] = pxToLonLat(tx0 * 256, ty0 * 256, z);
    const [east, south] = pxToLonLat((tx1 + 1) * 256, (ty1 + 1) * 256, z);
    const midY = (ty0 * 256 + (ty1 + 1) * 256) / 2;
    const midLat = pxToLonLat(0, midY, z)[1];
    const metersPerCell = (40075016.686 * Math.cos((midLat * Math.PI) / 180)) / (256 * 2 ** z);
    dem = { zoom: z, w, h, bounds: { north, south, east, west } };
    return { ...dem, tiles: total, cached, failed, metersPerCell };
  },

  async elev({ pts }) {
    if (!dem) return pts.map(() => null);
    return pts.map(([lat, lon]) => {
      const [gx, gy] = lonLatToPx(lon, lat, dem.zoom);
      const e = wasm.elev_at(gx, gy);
      return Number.isNaN(e) ? null : e;
    });
  },

  async links({ pairs, radio }) {
    return pairs.map((p) => ({ key: p.key, ...analyze(p.a, p.b, radio, false) }));
  },

  async profile({ a, b, radio }) {
    return analyze(a, b, radio, true);
  },

  async coverage({ sites, radio, radiusM, rxHeight, rxGain, sens, mode }, progress) {
    if (!dem) throw new Error('No elevation data loaded');
    wasm.coverage_reset();
    let i = 0;
    for (const site of sites) {
      const [gx, gy] = lonLatToPx(site.lon, site.lat, dem.zoom);
      const [r, g, b] = site.rgb;
      wasm.set_site_color(i, r, g, b);
      wasm.coverage_add(
        gx, gy, site.h, rxHeight, radiusM, radio.freq, radio.k, radio.clutter,
        radio.txPower + site.gain - radio.cableLoss, rxGain, sens, i
      );
      progress({ done: ++i, total: sites.length });
    }
    const raw = new Float64Array(wasm.memory.buffer, wasm.coverage_areas(), 66);
    const tracked = Math.min(sites.length, MAX_MASK_SITES);
    const areas = {
      covered: Array.from(raw.slice(0, tracked)),
      unique: Array.from(raw.slice(32, 32 + tracked)),
      union: raw[64],
      overlap: raw[65],
    };
    return { ...(await render(mode)), areas };
  },

  async terrain({ mode }) {
    if (!dem) throw new Error('No elevation data loaded');
    const ptr = wasm.terrain_rgba(mode === 'relief' ? 1 : 0, 315, 45, 1.5);
    return { blob: await toPng(ptr), bounds: dem.bounds };
  },

  async colorize({ mode }) {
    if (!dem) throw new Error('No elevation data loaded');
    return render(mode);
  },
};

function analyze(a, b, radio, withSamples) {
  const [ax, ay] = lonLatToPx(a.lon, a.lat, dem.zoom);
  const [bx, by] = lonLatToPx(b.lon, b.lat, dem.zoom);
  const ptr = wasm.link_analyze(ax, ay, a.h, bx, by, b.h, radio.freq, radio.k, radio.clutter);
  const out = new Float32Array(wasm.memory.buffer, ptr, HDR + STRIDE * MAX_SAMPLES);
  const n = out[0];
  const result = {
    n,
    dist: out[1],
    groundA: out[2],
    groundB: out[3],
    minClear: out[4],
    minRatio: out[5],
    worstIdx: out[6],
    diffLoss: out[7],
    fspl: out[8],
    lambda: out[9],
    h0: out[10],
    h1: out[11],
  };
  if (withSamples) result.samples = out.slice(HDR, HDR + STRIDE * n);
  return result;
}

async function render(mode) {
  const ptr = wasm.coverage_rgba(MODES[mode] ?? 0);
  return { blob: await toPng(ptr), bounds: dem.bounds };
}

async function toPng(ptr) {
  const { w, h } = dem;
  const data = new Uint8ClampedArray(new Uint8ClampedArray(wasm.memory.buffer, ptr, w * h * 4));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    const progress = (p) => self.postMessage({ id: msg.id, type: 'progress', ...p });
    try {
      await ready;
      const handler = handlers[msg.cmd];
      if (!handler) throw new Error(`Unknown command "${msg.cmd}". Reload the page with Cmd+Shift+R.`);
      const result = await handler(msg, progress);
      self.postMessage({ id: msg.id, type: 'done', result });
    } catch (err) {
      self.postMessage({ id: msg.id, type: 'done', error: String(err?.message ?? err) });
    }
  });
};
