// Verify the project site offline and exercise the live sources with fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'mainland-dist');
const mount = '/weather-atlas-zh-cn/';
const revision = process.env.ATLAS_BACKUP_REVISION || '';
assert.match(revision,/^[a-f0-9]{40}$/,'Tests require the same pinned backup as the build');
const backup = `https://cdn.jsdelivr.net/gh/xschen-beb/weather-atlas-zh-cn@${revision}/`;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json'};
const blocked = [];
const errors = [];
let browser;
let liteBrowser;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(mount)) { res.writeHead(404).end(); return; }
    const rel = decodeURIComponent(url.pathname.slice(mount.length)) || 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root+path.sep)) { res.writeHead(404).end(); return; }
    const bytes = await fs.readFile(file);
    res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream',
      'content-length':bytes.length}).end(bytes);
  } catch { res.writeHead(404).end(); }
});

async function startPage(instance, origin, viewport) {
  const context = await instance.newContext({locale:'zh-CN',viewport,serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const url = route.request().url();
    if (url.startsWith(origin+mount)) return route.continue();
    blocked.push(url); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  return page;
}

async function waitDefaultClimate(page) {
  await page.waitForFunction(()=>{
    const climate=window.__wa?.climate;
    const r=climate?.result;
    return r?.mode==='days'&&r.scaleMax===365&&r.data.some((value,i)=>i%2===0&&value>0)&&!climate.inflight;
  },undefined,{timeout:90000});
}

function pointFixture() {
  const current = Math.floor(Date.now() / 900000) * 900;
  const firstHour = Math.floor(current / 3600) * 3600 - 7200;
  const time = Array.from({length:36},(_,i)=>firstHour+3600*i);
  return {timezone:'Asia/Shanghai',current:{time:current,temperature_2m:23.4,weather_code:0,is_day:1},
    hourly:{time,temperature_2m:time.map(()=>18.1),weather_code:time.map(()=>0),is_day:time.map(()=>1)}};
}

async function verifyRangeFallback() {
  const {readGfsRange,readForecastResponse}=await import('../localization/atlas-forecast.js');
  const realFetch=global.fetch;
  const requested=[];
  try {
    global.fetch=async (url,init)=>{
      requested.push([url,init.headers.Range]);
      if (requested.length===1) return new Response('not a partial response',{status:200});
      return new Response(new Uint8Array([71,82,73,66]),{status:206,headers:{'content-length':'4'}});
    };
    const bytes=await readGfsRange('https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.test/file',200,203);
    assert.equal(Buffer.from(bytes).toString('ascii'),'GRIB');
    assert.equal(requested.length,2);
    assert.match(requested[1][0],/\.s3\.us-east-1\.amazonaws\.com/);
    assert(requested.every(row=>row[1]==='bytes=200-203'));

    global.fetch=async (_,init)=>new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([71]));
        init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});
      },
    }));
    await assert.rejects(readForecastResponse('https://example.invalid',r=>r.text(),{timeout:30}),/timeout/i);
  } finally {
    global.fetch=realFetch;
  }
}

(async () => {
  await verifyRangeFallback();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.ATLAS_TEST_CHROMIUM;
  browser = await chromium.launch({headless:true,executablePath,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await startPage(browser, origin, {width:1440,height:960});
  let sunAttempts=0, demAttempts=0;
  await page.route(origin+mount+'data/climate/sun.bin',route=>
    ++sunAttempts===1?route.abort('connectionreset'):route.fallback());
  await page.route(origin+mount+'data/dem.bin',route=>
    ++demAttempts===1?route.fulfill({status:503,body:'temporarily unavailable'}):route.fallback());
  await page.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  await waitDefaultClimate(page);
  assert.equal(sunAttempts,2,'Default climate must recover from a reset on the site');
  assert.equal(demAttempts,2,'The basemap must recover from a transient download failure');
  await page.evaluate(()=>window.__wa.map.fitBounds([[72,1],[138,55]],{animate:false,padding:{left:360,right:24,top:65,bottom:35}}));
  await page.waitForFunction(()=>window.__wa.map.queryRenderedFeatures({layers:['china-maritime-dashes']}).length>0,undefined,{timeout:30000});
  assert.equal(await page.evaluate(()=>window.__wa.map.queryRenderedFeatures({layers:['china-region-labels']}).length),0);
  const points = [{name:'香港',lon:114.1694,lat:22.3193,dem:10},
    {name:'邓州市',lon:111.99,lat:32.64,dem:121},{name:'旧金山',lon:-122.4194,lat:37.7749,dem:16}];
  const details = await page.evaluate(async points=>{
    const c=window.__wa.climate;
    return Promise.all(points.map(async p=>{
      const d=await c.detail(p.lon,p.lat,p.dem,c.criteria(),Object.keys(c.meta.vars));
      return {place:p.name,variables:d.loaded.length,months:d.months.length,dates:d.daily.length,days:d.perYear};
    }));
  },points);
  assert(details.every(d=>d.variables===11&&d.months===12&&d.dates===365&&Number.isFinite(d.days)));
  await page.locator('#search').fill('香港');
  await page.locator('#searchResults li').first().click();
  await page.waitForFunction(()=>document.querySelector('#card table')&&document.querySelector('#card').innerText.includes('中国'),undefined,{timeout:40000});
  assert(!(await page.locator('#card').innerText()).includes('数据加载失败'));
  await fs.mkdir('mainland-evidence',{recursive:true});
  await page.screenshot({path:'mainland-evidence/mirror.jpg',type:'jpeg',quality:82});

  const fallbackPage = await startPage(browser,origin,{width:1440,height:960});
  const sun=await fs.readFile(path.join(root,'data/climate/sun.bin'));
  const corrupt=Buffer.from(sun);
  corrupt[0]^=1;
  let failedSite=0, backupAttempts=0;
  await fallbackPage.route(origin+mount+'data/climate/sun.bin',route=>{
    failedSite++;
    return route.abort('connectionreset');
  });
  await fallbackPage.route(backup+'data/climate/sun.bin',route=>route.fulfill({
    status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/octet-stream',
    body:++backupAttempts===1?corrupt:sun,
  }));
  await fallbackPage.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  await fallbackPage.getByText(/^气候筛选暂不可用：日照时数/).waitFor({timeout:40000});
  assert.equal(backupAttempts,1);
  assert.equal(await fallbackPage.evaluate(()=>Boolean(window.__wa.climate.result)),false,'Reject a wrong checksum');
  await fallbackPage.locator('#status').getByRole('button',{name:'重试',exact:true}).click();
  await waitDefaultClimate(fallbackPage);
  assert.equal(failedSite,4);
  assert.equal(backupAttempts,2);
  await fallbackPage.locator('#status').waitFor({state:'hidden'});

  liteBrowser = await chromium.launch({headless:true,executablePath,args:['--disable-webgl']});
  const lite = await startPage(liteBrowser, origin, {width:390,height:844});
  let cellsAttempts=0;
  await lite.route('**/data/climate/cells.bin', async route => {
    if (++cellsAttempts!==1) return route.fallback();
    await route.fulfill({status:503,contentType:'text/plain',body:'temporarily unavailable'});
  });
  let supplementBlocked=true;
  const failSupplement=route=>route.fulfill({status:503,headers:{'Access-Control-Allow-Origin':'*'},body:'temporarily unavailable'});
  await lite.route(origin+mount+'data/climate/uv.bin',route=>supplementBlocked?failSupplement(route):route.fallback());
  await lite.route(backup+'data/climate/uv.bin',failSupplement);
  await lite.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  assert.equal(await lite.evaluate(()=>Boolean(document.createElement('canvas').getContext('webgl2'))),false);
  await lite.getByText('轻量版 · 历史气候',{exact:true}).waitFor();
  await lite.locator('.lite-maritime-dashes').waitFor();
  const dashes = await lite.locator('.lite-maritime-dashes').getAttribute('d');
  assert.equal(dashes.match(/M/g).length,10,'Nine South China Sea segments and the segment east of Taiwan');
  assert.equal(await lite.locator('.lite-map text').count(),0);
  await lite.getByRole('searchbox',{name:'搜索城市'}).fill('香港');
  await lite.getByRole('button',{name:/香港.*中国/}).first().click();
  await lite.getByRole('heading',{name:'香港',exact:true}).waitFor();
  await lite.getByRole('table').waitFor({timeout:60000});
  const months = await lite.locator('table thead th[scope="col"]').count();
  assert.equal(months,12);
  assert.equal(cellsAttempts,2);
  await lite.getByText(/补充数据加载失败：紫外线指数/).waitFor();
  assert(await lite.getByRole('table').isVisible(),'A supplement failure must keep the default results');
  supplementBlocked=false;
  await lite.getByRole('button',{name:'重试补充数据',exact:true}).click();
  await lite.getByRole('rowheader',{name:'最高温度',exact:true}).waitFor();
  await lite.getByRole('rowheader',{name:'日照（小时）',exact:true}).waitFor();
  await lite.getByRole('rowheader',{name:'紫外线峰值',exact:true}).waitFor();
  await lite.getByText(/基于 ERA5 2001—2025 年/).waitFor();
  await lite.screenshot({path:'mainland-evidence/lite.jpg',type:'jpeg',quality:82,fullPage:true});

  let liteForecastAttempts=0;
  await lite.route('https://api.open-meteo.com/v1/forecast?**', async route => {
    liteForecastAttempts++;
    const headers={'Access-Control-Allow-Origin':'*'};
    if (liteForecastAttempts===1) return route.fulfill({status:503,headers,body:'temporarily unavailable'});
    return route.fulfill({status:200,headers,json:pointFixture()});
  });
  await lite.getByRole('button',{name:'实时天气',exact:true}).click();
  await lite.getByText('地点天气暂不可用：服务器返回状态码 503',{exact:true}).waitFor();
  await lite.getByRole('button',{name:'重试',exact:true}).click();
  await lite.getByText(/数据时刻：/).waitFor();
  await lite.getByText(/地点天气：Open-Meteo（模式估计）/).waitFor();
  assert.match(await lite.locator('.now .big').innerText(),/^23/);

  // Reproduce a click before the local elevation file has loaded. Hold the
  // global index requests until we have verified the independent point card.
  const live=await startPage(browser,origin,{width:1440,height:960});
  let releaseTerrain, releaseGrid, sawTerrain;
  const terrain=new Promise(resolve=>{releaseTerrain=resolve;});
  const grid=new Promise(resolve=>{releaseGrid=resolve;});
  const terrainRequested=new Promise(resolve=>{sawTerrain=resolve;});
  let gridRequests=0;
  await live.route('**/data/dem.bin',async route=>{sawTerrain();await terrain;await route.fallback();});
  await live.route(/^https:\/\/noaa-gfs-bdp-pds\.s3(?:\.us-east-1)?\.amazonaws\.com\//, async route=>{
    gridRequests++;
    await grid;
    return route.fulfill({status:503,headers:{'Access-Control-Allow-Origin':'*'},body:'temporarily unavailable'});
  });
  await live.route('https://api.open-meteo.com/v1/forecast?**',route=>
    route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},json:pointFixture()}));
  try {
    await live.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
    await Promise.race([terrainRequested,live.getByText('正在加载地形…',{exact:true}).waitFor({timeout:20000})]);
    await live.getByRole('tab',{name:'实时天气（联网）',exact:true}).click();
    await live.getByText('正在准备地图…',{exact:true}).waitFor();
    releaseTerrain();
    await live.getByText('正在加载全球图层…',{exact:false}).first().waitFor();
    await live.locator('#search').fill('北京');
    await live.locator('#searchResults li').first().click();
    await live.locator('#card').getByText(/数据时刻：/).waitFor();
    assert.match(await live.locator('#card .now .big').innerText(),/^23/);
    assert(gridRequests>0);
    assert.equal(await live.getByRole('button',{name:'重试全球图层',exact:true}).count(),0);
    releaseGrid();
    const gridRetry=live.getByRole('button',{name:'重试全球图层',exact:true});
    await gridRetry.waitFor({timeout:15000});
    const firstAttempts=gridRequests;
    await gridRetry.click();
    await gridRetry.waitFor({timeout:15000});
    assert(gridRequests>firstAttempts,'Retry must perform a fresh grid lookup');
    assert.match(await live.locator('#card .now .big').innerText(),/^23/);
  } finally {
    releaseTerrain();
    releaseGrid();
  }

  assert.deepEqual(errors,[]);
  assert.deepEqual(blocked,[],'Only mocked weather services may be contacted in live mode');
  const report={passed:true,subpath:mount,third_party_requests:blocked.length,details,
    lite:{webgl:false,viewport:'390×844',place:'香港',months,recovered_from_http:503},
    resilience:{cold_start_site_retry:true,verified_backup:true,wrong_checksum_rejected:true,manual_retry:true,lite_base_survives_supplement:true},
    live:{early_mode_click:true,point_with_grid_pending:true,global_retry:true,lite_point_retry:true,strict_range:true}};
  await fs.writeFile('mainland-evidence/report.json',JSON.stringify(report,null,2)+'\n');
  console.log('MAINLAND_MIRROR_REPORT '+JSON.stringify(report));
})().catch(error=>{console.error(error);console.error(JSON.stringify({blocked,errors}));process.exitCode=1;})
  .finally(async()=>{await Promise.all([browser?.close(),liteBrowser?.close()]);server.close();});
