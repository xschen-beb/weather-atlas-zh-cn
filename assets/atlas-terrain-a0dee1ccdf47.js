const SIZE = 256;
const DETAIL_ZOOM = 5;
const MAX_ZOOM = 11;
const ENDPOINTS = [
  'https://elevation-tiles-prod.s3.amazonaws.com',
  'https://elevation-tiles-prod.s3.us-east-1.amazonaws.com',
];
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const wrap = (x, width) => ((x % width) + width) % width;
const mercX = lon => (lon + 180) / 360;
const mercY = lat => (1 - Math.asinh(Math.tan(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180)) / Math.PI) / 2;
const tileKey = (z, x, y) => `${z}/${wrap(x, 2 ** z)}/${y}`;

function canvas() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(SIZE, SIZE);
  return Object.assign(document.createElement('canvas'), {width: SIZE, height: SIZE});
}

function baseHeight({w, h, q}, lon, lat) {
  const x = wrap(mercX(lon) * w - .5, w);
  const y = clamp((90 - lat) * h / 180 - .5, 0, h - 1);
  const i = Math.floor(x), j = Math.floor(y), t = x - i, u = y - j;
  const k = (i + 1) % w, l = Math.min(j + 1, h - 1);
  const v = ((q[j*w+i] * (1-t) + q[j*w+k] * t) * (1-u) + (q[l*w+i] * (1-t) + q[l*w+k] * t) * u) / 255;
  return v * v * 9000;
}

async function basePng(base, z, x, y) {
  const image = new ImageData(SIZE, SIZE);
  const n = 2 ** z;
  for (let row = 0; row < SIZE; row++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (row + .5) / SIZE) / n))) * 180 / Math.PI;
    for (let col = 0; col < SIZE; col++) {
      const lon = 360 * (x + (col + .5) / SIZE) / n - 180;
      const v = Math.round(baseHeight(base, lon, lat) * 256) + 32768 * 256;
      const offset = (row * SIZE + col) * 4;
      image.data[offset] = v >> 16;
      image.data[offset + 1] = (v >> 8) & 255;
      image.data[offset + 2] = v & 255;
      image.data[offset + 3] = 255;
    }
  }
  const output = canvas();
  output.getContext('2d').putImageData(image, 0, 0);
  const png = output.convertToBlob ? await output.convertToBlob() : await new Promise(resolve => output.toBlob(resolve));
  return png.arrayBuffer();
}

async function readTile(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, {signal: controller.signal, credentials: 'omit', redirect: 'error'});
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await response.arrayBuffer();
    const image = await createImageBitmap(new Blob([bytes], {type:'image/png'}), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none',
    });
    try {
      if (image.width !== SIZE || image.height !== SIZE) return null;
      const ctx = canvas().getContext('2d', {willReadFrequently:true});
      ctx.drawImage(image, 0, 0);
      const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const heights = new Float32Array(SIZE * SIZE);
      for (let i = 0; i < heights.length; i++) {
        const p = i * 4;
        heights[i] = Math.max(0, rgba[p] * 256 + rgba[p+1] + rgba[p+2] / 256 - 32768);
      }
      return {bytes, heights};
    } finally { image.close(); }
  } catch (error) {
    if (controller.signal.aborted) throw error;
    return null;
  } finally { clearTimeout(timer); }
}

function viewTiles(map) {
  const zoom = map.getZoom();
  if (zoom < DETAIL_ZOOM || (zoom < 6 && map.getProjection()?.type === 'globe')) return null;
  const bounds = map.getBounds();
  for (let z = Math.min(MAX_ZOOM, Math.floor(zoom)); z >= DETAIL_ZOOM; z--) {
    const n = 2 ** z, margin = .25;
    const x0 = Math.floor(mercX(bounds.getWest()) * n - margin);
    let x1 = Math.floor(mercX(bounds.getEast()) * n + margin);
    if (x1 < x0) x1 += n;
    const y0 = Math.max(0, Math.floor(mercY(bounds.getNorth()) * n - margin));
    const y1 = Math.min(n-1, Math.floor(mercY(bounds.getSouth()) * n + margin));
    const cols = x1-x0+1, rows = y1-y0+1;
    if (cols <= 7 && rows <= 7) return {z, n, x0, y0, cols, rows, key: `${z}/${x0}/${x1}/${y0}/${y1}`};
  }
  return null;
}

// Missing tiles carry zero weight. Fade at the edge of a missing neighbour so
// neither forecast nor historical colours treat absent elevation as sea level.
function mosaic(view, tiles) {
  const {n, x0, y0, cols, rows} = view;
  const width = cols * SIZE, height = rows * SIZE;
  const data = new Float32Array(width * height * 2);
  const feather = 20;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const i = row * cols + col, tile = tiles[i];
    if (!tile) continue;
    const left = col === 0 || !tiles[i-1], right = col === cols-1 || !tiles[i+1];
    const top = row === 0 || !tiles[i-cols], bottom = row === rows-1 || !tiles[i+cols];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const weight = Math.min(1, left ? x/feather : 1, right ? (SIZE-1-x)/feather : 1,
        top ? y/feather : 1, bottom ? (SIZE-1-y)/feather : 1);
      const p = ((row * SIZE + y) * width + col * SIZE + x) * 2;
      data[p] = tile.heights[y * SIZE + x] * weight;
      data[p+1] = weight;
    }
  }
  return {width, height, data, extent:[x0/n, y0/n, (x0+cols)/n, (y0+rows)/n]};
}

export function createAtlasTerrain() {
  let base, detailView;
  const tiles = new Map();
  const cooldown = new Map();
  const queue = [];
  let active = 0;

  function drain() {
    while (active < 8 && queue.length) {
      const {key, finish} = queue.shift();
      active++;
      (async () => {
        for (const endpoint of ENDPOINTS) {
          if ((cooldown.get(endpoint) || 0) > Date.now()) continue;
          try {
            const tile = await readTile(`${endpoint}/terrarium/${key}.png`);
            if (tile) return tile;
          } catch { cooldown.set(endpoint, Date.now() + 12000); }
        }
        return null;
      })().then(finish).finally(() => { active--; drain(); });
    }
  }

  function detail(z, x, y) {
    const key = tileKey(z, x, y);
    const previous = tiles.get(key);
    if (previous) {
      tiles.delete(key);
      tiles.set(key, previous);
      return previous;
    }
    let finish;
    const next = new Promise(resolve => { finish = resolve; });
    tiles.set(key, next);
    if (tiles.size > 100) tiles.delete(tiles.keys().next().value);
    queue.push({key, finish});
    drain();
    void next.then(result => {
      if (!result && tiles.get(key) === next) tiles.delete(key);
    });
    return next;
  }

  return {
    setBase(dem) { base = dem; },
    async image(url) {
      const match = /^landdem:\/\/(\d+)\/(-?\d+)\/(\d+)$/.exec(url);
      if (!match || !base) throw new Error('Invalid terrain tile');
      const [, z, x, y] = match.map(Number);
      const tile = z >= DETAIL_ZOOM ? await detail(z, x, y) : null;
      return {data: tile ? tile.bytes.slice(0) : await basePng(base, z, x, y)};
    },
    follow(map, update) {
      let timer, revision = 0, completed = '';
      function apply(value) {
        detailView = value;
        update(value);
      }
      function schedule() {
        clearTimeout(timer);
        const id = ++revision, view = viewTiles(map);
        if (!view) {
          completed = '';
          if (detailView) apply(null);
          return;
        }
        if (view.key === completed) return;
        timer = setTimeout(async () => {
          const values = await Promise.all(Array.from({length:view.cols * view.rows}, (_, i) =>
            detail(view.z, view.x0 + i % view.cols, view.y0 + Math.floor(i / view.cols))));
          if (id !== revision) return;
          if (values.every(Boolean)) completed = view.key;
          else completed = '';
          if (values.some(Boolean)) apply(mosaic(view, values));
          else if (detailView) apply(null);
        }, 150);
      }
      map.on('moveend', schedule);
      map.once('remove', () => { clearTimeout(timer); revision++; });
      schedule();
    },
    elevation(lon, lat) {
      if (!detailView) return null;
      const {extent, width, height, data} = detailView;
      const x = mercX(lon), wrapped = x + Math.round((extent[0]+extent[2])/2-x);
      const u = (wrapped - extent[0]) / (extent[2] - extent[0]);
      const v = (mercY(lat) - extent[1]) / (extent[3] - extent[1]);
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      const i = clamp(u * width - .5, 0, width - 1), j = clamp(v * height - .5, 0, height - 1);
      const col = Math.floor(i), row = Math.floor(j), right = Math.min(col+1,width-1), next = Math.min(row+1,height-1);
      const tx = i-col, ty = j-row;
      const sample = k => data[(row*width+col)*2+k]*(1-tx)*(1-ty) + data[(row*width+right)*2+k]*tx*(1-ty)
        + data[(next*width+col)*2+k]*(1-tx)*ty + data[(next*width+right)*2+k]*tx*ty;
      const weight = sample(1);
      return sample(0) + baseHeight(base, lon, lat) * (1-weight);
    },
  };
}
