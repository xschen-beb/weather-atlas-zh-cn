// Verify the static mirror as a project site with external requests disabled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'mainland-dist');
const mount = '/weather-atlas-zh-cn/';
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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.ATLAS_TEST_CHROMIUM;
  browser = await chromium.launch({headless:true,executablePath,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await startPage(browser, origin, {width:1440,height:960});
  await page.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>window.__wa?.climate?.meta,undefined,{timeout:90000});
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

  liteBrowser = await chromium.launch({headless:true,executablePath,args:['--disable-webgl']});
  const lite = await startPage(liteBrowser, origin, {width:390,height:844});
  let simulateUnavailable = true;
  await lite.route('**/data/climate/cells.bin', async route => {
    if (!simulateUnavailable) return route.fallback();
    simulateUnavailable = false;
    await route.fulfill({status:503,contentType:'text/plain',body:'temporarily unavailable'});
  });
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
  await lite.getByText('数据加载失败：服务器返回状态码 503',{exact:true}).waitFor();
  await lite.getByRole('button',{name:'重试',exact:true}).click();
  await lite.getByRole('table').waitFor({timeout:60000});
  const months = await lite.locator('table thead th[scope="col"]').count();
  assert.equal(months,12);
  await lite.getByRole('rowheader',{name:'最高温度',exact:true}).waitFor();
  await lite.getByRole('rowheader',{name:'日照（小时）',exact:true}).waitFor();
  await lite.getByText(/基于 ERA5 2001—2025 年/).waitFor();
  await lite.screenshot({path:'mainland-evidence/lite.jpg',type:'jpeg',quality:82,fullPage:true});

  assert.deepEqual(errors,[]);
  assert.deepEqual(blocked,[],'Historical mode must not attempt third-party requests');
  const report={passed:true,subpath:mount,third_party_requests:blocked.length,details,
    lite:{webgl:false,viewport:'390×844',place:'香港',months,recovered_from_http:503}};
  await fs.writeFile('mainland-evidence/report.json',JSON.stringify(report,null,2)+'\n');
  console.log('MAINLAND_MIRROR_REPORT '+JSON.stringify(report));
})().catch(error=>{console.error(error);console.error(JSON.stringify({blocked,errors}));process.exitCode=1;})
  .finally(async()=>{await Promise.all([browser?.close(),liteBrowser?.close()]);server.close();});
