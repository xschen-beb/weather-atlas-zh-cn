// Test-only private-hosting fixture. The marker is not a production credential;
// the server deliberately grants climate-file access only to window.fetch.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
let browser, server;
const requests = [];
let rejectTminOnce = true;
(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'active-manifest.json'), 'utf8'));
  const adapter = manifest.files.find(f => /assets\/climate\.session\.worker-.*\.js$/.test(f.path));
  const original = manifest.files.find(f => /assets\/climate\.worker-.*\.js$/.test(f.path));
  const helper = await fs.readFile(path.join(root, 'localization/climate-transport.js'), 'utf8');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/transport-test.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><title>气候详情加载核验</title><script>' + helper + '</script></html>');
      return;
    }
    if (url.pathname.startsWith('/data/climate/')) {
      const permitted = req.headers['x-test-page-session'] === 'page-session-fixture';
      const transient = permitted && url.pathname.endsWith('/tmin.bin') && rejectTminOnce;
      if (transient) rejectTminOnce = false;
      const status = permitted && !transient ? 200 : 401;
      requests.push({ file: url.pathname, status, page_session: permitted });
      if (status === 401) { res.writeHead(401, { 'cache-control': 'no-store' }); res.end('Page session required'); return; }
    }
    const filename = path.resolve(dist, '.' + url.pathname);
    if (!filename.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const bytes = await fs.readFile(filename);
      const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/data/climate/')) {
        const headers = new Headers(options.headers);
        headers.set('X-Test-Page-Session', 'page-session-fixture');
        return nativeFetch(input, { ...options, headers });
      }
      return nativeFetch(input, options);
    };
  });
  await page.goto(origin + '/transport-test.html');
  const result = await page.evaluate(async ({ adapterPath, originalPath }) => {
    const ask = (worker, message) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clean(); reject(new Error('Worker timeout')); }, 30000);
      const clean = () => { clearTimeout(timeout); worker.removeEventListener('message', receive); worker.removeEventListener('error', failed); };
      const failed = event => { clean(); reject(new Error(event.message)); };
      const receive = event => { const reply = event.data; if (reply.type === 'progress' || reply.id !== message.id) return; clean(); resolve(reply); };
      worker.addEventListener('message', receive); worker.addEventListener('error', failed);
      worker.postMessage(message);
    });
    const bare = new Worker(new URL('/' + originalPath, location.href), { type: 'module' });
    const baseline = await ask(bare, { type: 'init', base: location.origin + '/' }); bare.terminate();
    const worker = waClimateWorker(new URL('/' + adapterPath, location.href));
    try {
      const ready = await ask(worker, { type: 'init', base: location.origin + '/' });
      if (ready.type !== 'ready') throw new Error(ready.error);
      const spot = { lon: 111.99, lat: 32.64, dem: 121, crit: [] };
      const basic = await ask(worker, { type: 'detail', id: 1, ...spot, vars: ['feels', 'sun', 'precip'] });
      const interrupted = await ask(worker, { type: 'detail', id: 2, ...spot, vars: ['tmax', 'tmin'] });
      const complete = await ask(worker, { type: 'detail', id: 3, ...spot, vars: Object.keys(ready.meta.vars) });
      if (complete.type !== 'detail') throw new Error(complete.error);
      return { baseline_error: baseline.type === 'error', basic_loaded: basic.result?.loaded,
        retry_error: interrupted.error, complete_loaded: complete.result.loaded,
        matching_days: complete.result.perYear, dates: complete.result.daily.length,
        months: complete.result.months.length };
    } finally { worker.terminate(); }
  }, { adapterPath: adapter.path, originalPath: original.path });
  assert(result.baseline_error, 'The regression must reproduce unauthorized worker requests');
  assert.match(result.retry_error, /HTTP 401/);
  assert.equal(result.basic_loaded.length, 3);
  assert.equal(result.complete_loaded.length, 11);
  assert.equal(result.matching_days, 365);
  assert.equal(result.dates, 365); assert.equal(result.months, 12);
  assert(requests.some(r => r.status === 401 && !r.page_session));
  assert(requests.filter(r => r.file.endsWith('/tmin.bin') && r.page_session).some(r => r.status === 200));
  const report = { source_commit: process.env.GITHUB_SHA || null, passed: true,
    scope: 'Actual Chromium Worker with page-only authorization; real bundled climate files and original calculations',
    checked_place: '邓州市', ...result, requests };
  await fs.mkdir(path.join(root, 'browser-evidence'), { recursive: true });
  await fs.writeFile(path.join(root, 'browser-evidence/auth-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('AUTH_BROWSER_REPORT ' + JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
});
