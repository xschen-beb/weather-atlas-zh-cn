import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { Worker as Thread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'active-manifest.json'), 'utf8'));
const adapter = manifest.files.find(f => /assets\/climate\.session\.worker-.*\.js$/.test(f.path));
const original = manifest.files.find(f => /assets\/climate\.worker-.*\.js$/.test(f.path));
const origin = 'https://atlas.invalid';
const workers = [];
const reads = [];
let failTmin = true;
class BrowserWorker extends EventTarget {
  constructor(url) {
    super();
    const filename = path.join(dist, new URL(url).pathname);
    this.thread = new Thread(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { pathToFileURL } = require('node:url');
      const events = new EventTarget();
      globalThis.self = globalThis;
      globalThis.addEventListener = events.addEventListener.bind(events);
      globalThis.dispatchEvent = events.dispatchEvent.bind(events);
      globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
      Object.defineProperty(globalThis, 'onmessage', { set(fn) { events.addEventListener('message', fn); } });
      // A worker alone has no page-session access in this regression fixture.
      globalThis.fetch = async () => new Response('Page session required', { status: 401 });
      parentPort.on('message', data => events.dispatchEvent(new MessageEvent('message', { data })));
      import(pathToFileURL(workerData).href).catch(error => { throw error; });
    `, { eval: true, workerData: filename });
    this.thread.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
    this.thread.on('error', error => this.dispatchEvent(new ErrorEventShim(error)));
    this.transportReplies = [];
    workers.push(this);
  }
  postMessage(data, transfer) {
    if (data.type === 'wa-climate-bytes') this.transportReplies.push({ fetchId: data.fetchId, error: data.error });
    this.thread.postMessage(data, transfer);
  }
  terminate() { return this.thread.terminate(); }
}
class ErrorEventShim extends Event { constructor(error) { super('error'); this.error = error; } }
const context = vm.createContext({ Worker: BrowserWorker, URL, location: { origin }, AbortController,
  setTimeout, clearTimeout, fetch: async (url, options) => {
    assert.equal(new URL(url).origin, origin, 'Only the current site can receive visitor credentials');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store', 'A cached unauthorized response must not be reused');
    assert.equal(options.redirect, 'error');
    reads.push(new URL(url).pathname);
    if (url.endsWith('/tmin.bin') && failTmin) { failTmin = false; return new Response('Expired session', { status: 401 }); }
    return new Response(await fs.readFile(path.join(dist, new URL(url).pathname)));
  } });
vm.runInContext(await fs.readFile(path.join(root, 'localization/climate-transport.js'), 'utf8'), context);
const transported = vm.runInContext(`waClimateWorker(new URL(${JSON.stringify(origin + '/' + adapter.path)}))`, context);
let sequence = 0;
function request(worker, data) {
  const id = data.type === 'init' ? undefined : ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('Worker reply timeout')); }, 30000);
    const clean = () => { clearTimeout(timer); worker.removeEventListener('message', receive); };
    const receive = event => {
      const result = event.data;
      if (result.type === 'progress' || result.type.startsWith('wa-climate-')) return;
      if (result.id !== id) return;
      clean(); resolve(result);
    };
    worker.addEventListener('message', receive);
    worker.postMessage({ ...data, id });
  });
}
try {
  // Send init immediately, before the adapter's asynchronous import completes.
  const ready = await request(transported, { type: 'init', base: origin + '/' });
  assert.equal(ready.type, 'ready', ready.error);
  assert.equal(ready.meta.ncells, 18973);
  const spot = { lon: 111.99, lat: 32.64, dem: 121, crit: [] };
  const basic = (await request(transported, { type: 'detail', ...spot, vars: ['feels', 'sun', 'precip'] })).result;
  assert(basic && basic.perYear === 365);
  const unauthorized = await request(transported, { type: 'detail', ...spot, vars: ['tmax', 'tmin'] });
  assert.equal(unauthorized.type, 'error');
  assert.match(unauthorized.error, /HTTP 401/, 'Preserve the real HTTP status');
  const retry = await request(transported, { type: 'detail', ...spot, vars: Object.keys(ready.meta.vars) });
  assert.equal(retry.type, 'detail', retry.error);
  assert.equal(retry.result.loaded.length, 11);
  assert.equal(retry.result.daily.length, 365);
  assert.equal(retry.result.months.length, 12);
  assert.equal(retry.result.perYear, 365);
  assert(reads.filter(p => p.endsWith('/tmin.bin')).length === 2, 'Failed files must be retryable');

  const count = reads.length;
  for (const [i, url] of ['https://other.invalid/data/climate/meta.json',
    origin + '/private.json', origin + '/data/climate/meta.json?redirect=1',
    origin + '/data/climate/unknown.bin'].entries()) {
    const fetchId = -i - 1;
    transported.dispatchEvent(new MessageEvent('message', { data: { type: 'wa-climate-fetch', fetchId, url } }));
    assert(transported.transportReplies.some(r => r.fetchId === fetchId && r.error), 'Reject out-of-scope URL');
  }
  assert.equal(reads.length, count, 'Invalid requests must never reach authenticated fetch');

  // The unchanged worker cannot load even its metadata without page access.
  const bare = new BrowserWorker(origin + '/' + original.path);
  const bareResult = await request(bare, { type: 'init', base: origin + '/' });
  assert.equal(bareResult.type, 'error');
  console.log(JSON.stringify({ passed: true, climate_variables: retry.result.loaded,
    checked_place: '邓州市', page_session_transport: true, immediate_init: true,
    unauthorized_retry: true, credential_scope: true, unchanged_worker: original.path }));
} finally {
  await Promise.all(workers.map(worker => worker.terminate()));
}
