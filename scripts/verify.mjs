import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifestPath = await fs.access(path.join(root, 'active-manifest.json')).then(() => 'active-manifest.json', () => 'snapshot-manifest.json');
const manifest = JSON.parse(await fs.readFile(path.join(root, manifestPath), 'utf8'));
for (const file of manifest.files) {
  const bytes = await fs.readFile(path.join(dist, file.path));
  assert.equal(bytes.length, file.bytes, `File size: ${file.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `SHA256: ${file.path}`);
}
console.log(`All ${manifest.files.length} runtime files match downloaded SHA256 hashes.`);
const upstream = JSON.parse(await fs.readFile(path.join(root, 'snapshot-manifest.json'), 'utf8'));
for (const file of upstream.files.filter(file => file.path.startsWith('data/climate/') || /assets\/(?:climate|live)\.worker-/.test(file.path))) {
  const bytes = await fs.readFile(path.join(dist, file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Original scientific data/worker: ${file.path}`);
}

const messages = [];
let readRequests = 0;
const context = vm.createContext({
  self: { postMessage(message) { if (message.type !== 'progress') messages.push(message); } },
  fetch: async (url) => {
    const relative = new URL(url).pathname.replace(/^\/+/, '');
    const local = path.resolve(dist, relative);
    assert(local.startsWith(dist + path.sep), 'Fetch must remain inside snapshot');
    readRequests++;
    return new Response(await fs.readFile(local));
  },
  Response, Blob, DecompressionStream, performance,
});
const worker = manifest.files.find(file => /assets\/climate\.worker-.*\.js$/.test(file.path));
assert(worker, 'Climate worker exists');
vm.runInContext(await fs.readFile(path.join(dist, worker.path), 'utf8'), context, { filename: worker.path });

async function request(data, expectedType) {
  const start = messages.length;
  await context.self.onmessage({ data });
  const reply = messages.slice(start).find(message => message.type === expectedType || message.type === 'error');
  assert(reply, `Missing ${expectedType} reply`);
  assert.notEqual(reply.type, 'error', reply.error);
  return reply;
}

const ready = await request({ type: 'init', base: 'https://snapshot.invalid/' }, 'ready');
assert.equal(ready.meta.days, 365);
assert.equal(ready.meta.ncells, 18973);
assert.equal(ready.meta.sampleYears.length, 365);
const variables = Object.keys(ready.meta.vars);
await request({ type: 'need', id: 1, vars: variables }, 'loaded');
console.log(`All ${variables.length} climate variables decompressed and passed the original worker checksums.`);

const criteria = [{ v: 'tmax', lo: 20, hi: 30 }, { v: 'precip', lo: 0, hi: 1 }];
const details = [];
for (const spot of [
  { name: 'Shanghai', lon: 121.4737, lat: 31.2304, dem: 4 },
  { name: 'San Francisco', lon: -122.4194, lat: 37.7749, dem: 16 },
  { name: 'Hong Kong', lon: 114.1694, lat: 22.3193, dem: 10 },
]) {
  const empty = (await request({ type: 'detail', id: 2, ...spot, crit: [], vars: variables }, 'detail')).result;
  assert(empty, `Climate coverage at ${spot.name}`);
  assert(Math.abs(empty.perYear - 365) < 0.01, `No-filter result at ${spot.name}`);
  const result = (await request({ type: 'detail', id: 3, ...spot, crit: criteria, vars: variables }, 'detail')).result;
  assert(Number.isFinite(result.perYear) && result.perYear >= 0 && result.perYear <= 365);
  assert.equal(result.daily.length, 365);
  assert.equal(result.months.length, 12);
  assert(Array.from(result.daily).every(value => Number.isFinite(value) && value >= -1e-6 && value <= 1.000001));
  details.push({ place: spot.name, matching_days: result.perYear, contributing_cells: result.cells });
}
const map = await request({ type: 'query', id: 4, crit: criteria, mode: 'days', doy: 180, half: 10 }, 'result');
assert.equal(map.data.length, 9 * ready.meta.grid.nx * ready.meta.grid.ny * 2);
assert(map.coverage >= 0 && map.coverage <= 1);
const dateMap = await request({ type: 'query', id: 5, crit: criteria, mode: 'date', doy: 180, half: 10 }, 'result');
assert.equal(dateMap.scaleMax, 1);
assert.equal(dateMap.data.length, map.data.length);
console.log('Annual, date-window, and location-detail climate calculations passed.');

const report = {
  checked_at: new Date().toISOString(), runtime_files: manifest.files.length,
  runtime_bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
  sha256_verified: true, climate_checksums_verified: variables,
  climate_grid: ready.meta.grid, climate_days: ready.meta.days,
  sample_years: [Math.min(...ready.meta.sampleYears), Math.max(...ready.meta.sampleYears)],
  location_checks: details, annual_map_runtime_ms: map.ms, date_map_runtime_ms: dateMap.ms,
  local_fetches: readRequests,
  verification_limits: ['Browser rendering and WebGL interaction not tested in this environment.',
                        'Remote weather, terrain, and map services are not included in the snapshot.'],
};
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(details));
