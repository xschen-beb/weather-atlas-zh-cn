// Actual production site in a new Chromium context, with no account session.
// Do not inject tokens, cookies, request headers, or browser-signature overrides.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'https://weather-atlas-replica.crisppine128.chatgpt.site';
const evidence = path.resolve('public-site-evidence');
const report = { source_commit: process.env.GITHUB_SHA || null, site_url: origin,
  engine: 'Chromium / WebGL', fresh_context: true, passed: false,
  files: [], places: [], climate_failures: [] };
let browser, page;
(async () => {
  await fs.mkdir(evidence, { recursive: true });
  const manifest = JSON.parse(await fs.readFile('active-manifest.json', 'utf8'));
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
  assert.equal((await context.cookies()).length, 0, 'Start without any visitor session');
  page = await context.newPage();
  page.on('response', response => {
    if (response.url().startsWith(origin + '/data/climate/') && response.status() >= 400)
      report.climate_failures.push({ url: response.url(), status: response.status() });
  });
  const initial = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  report.home_status = initial.status();
  assert.equal(initial.status(), 200, 'Anonymous home page: ' + (await initial.text()).slice(0,400));
  assert.equal(new URL(page.url()).origin, origin, 'Must not redirect to account sign-in');
  report.files = await page.evaluate(async files => {
    const results = [];
    const appEntry = '/' + files.find(file=>/^assets\/index-zh-CN-.*\.js$/.test(file.path)).path;
    for(let i=0;i<files.length;i+=4) {
      results.push(...await Promise.all(files.slice(i,i+4).map(async file => {
        const pathname = file.path === 'index.html' ? '/' : '/' + file.path;
        const response = await fetch(new URL(pathname, location.href), { credentials: 'omit', cache: 'no-store' });
        const bytes = await response.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b=>b.toString(16).padStart(2,'0')).join('');
        const result = { file:file.path, status:response.status, bytes:bytes.byteLength,
          sha256_matches:digest===file.sha256, credentials:'omit' };
        if(file.path==='index.html') {
          // Hosting injects its own integration script into HTML. Verify the
          // expected application module; byte hashes remain strict for assets.
          const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes),'text/html');
          result.expected_app_entry = Array.from(doc.querySelectorAll('script[type="module"][src]')).some(script=>{
            const url=new URL(script.getAttribute('src'),location.href);
            return url.origin===location.origin&&url.pathname===appEntry;
          });
          result.expected_title = doc.title==='天气与气候地图';
        }
        return result;
      })));
    }
    return results;
  }, manifest.files);
  const validFile = file=>file.status===200&&(file.file==='index.html'
    ? file.expected_app_entry&&file.expected_title : file.sha256_matches);
  assert(report.files.every(validFile), 'Anonymous runtime file verification: '+JSON.stringify(report.files.filter(file=>!validFile(file))));
  await page.waitForFunction(()=>window.__wa?.climate?.meta,undefined,{timeout:90000});
  for (const spot of [{ name:'香港',lon:114.1694,lat:22.3193,dem:10 },
    { name:'邓州市',lon:111.99,lat:32.64,dem:121 },
    { name:'旧金山',lon:-122.4194,lat:37.7749,dem:16 }]) {
    const result = await page.evaluate(async spot => {
      const c = window.__wa.climate; await c.ready;
      const result = await c.detail(spot.lon,spot.lat,spot.dem,c.criteria(),Object.keys(c.meta.vars));
      return result && { name:spot.name, loaded:result.loaded, matching_days:result.perYear,
        months:result.months.length, dates:result.daily.length };
    },spot);
    assert(result&&result.loaded.length===11&&result.months===12&&result.dates===365,'Complete public climate details: '+spot.name);
    report.places.push(result);
  }
  await page.locator('#search').fill('香港');
  await page.locator('#searchResults li').first().click();
  await page.waitForFunction(()=>{const c=document.querySelector('#card');return c&&!c.classList.contains('hidden')&&c.textContent.includes('中国')&&c.querySelector('table');},undefined,{timeout:60000});
  assert(!(await page.locator('#card').innerText()).includes('数据加载失败'),'Visible public details must not show a data error');
  await page.screenshot({ path:path.join(evidence,'hong-kong-public.jpg'),type:'jpeg',quality:82 });
  assert.equal(report.climate_failures.length,0,'No climate requests may return 401/403 or other errors');
  report.passed = true;
})().catch(error=>{report.failure=error.stack||String(error);process.exitCode=1;}).finally(async()=>{
  if(page&&!report.passed)try{await page.screenshot({path:path.join(evidence,'failure.jpg'),type:'jpeg',quality:82});}catch{}
  await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('PUBLIC_SITE_REPORT '+JSON.stringify(report));
  if(browser)await browser.close();
});
