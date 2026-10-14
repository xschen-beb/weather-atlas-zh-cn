const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const evidence = path.resolve('browser-evidence');
const report = { source_commit: process.env.GITHUB_SHA || null, engine: 'Chromium / WebGL', passed: false, checks: [], errors: [], screenshots: [] };
let browser, server, page;
const step = (name, details) => { report.checks.push({ name, passed: true, details }); console.log('CHECK_OK ' + name + ' ' + JSON.stringify(details)); };
(async () => {
  await fs.mkdir(evidence, { recursive: true });
  server = spawn('python3', ['-m', 'http.server', '8080', '--bind', '127.0.0.1', '--directory', 'dist'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:8080/')).ok) break; } catch {} await new Promise(r => setTimeout(r,100)); }
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
  page.on('pageerror', error => report.errors.push({ type: 'pageerror', text: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ type: 'console', text: message.text() }); });
  page.on('requestfailed', request => report.errors.push({ type: 'requestfailed', url: request.url(), text: request.failure()?.errorText }));
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wa?.map?.getLayer('city-labels'), undefined, { timeout: 90000 });
  await page.waitForFunction(() => window.__wa.map.isSourceLoaded('china-map'), undefined, { timeout: 90000 });
  const gl = await page.evaluate(() => { const g=window.__wa.map.getCanvas().getContext('webgl2'); return g ? { version:g.getParameter(g.VERSION), renderer:g.getParameter(g.RENDERER) } : null; });
  assert(gl, 'Actual WebGL 2 context required'); step('webgl2', gl);
  const screenshot = async (name) => {
    const target=path.join(evidence,name+'.jpg'); await page.screenshot({path:target,type:'jpeg',quality:82});
    report.screenshots.push(name+'.jpg');
    // CI logs retain a compact copy for connector-based verification.
    const content=(await fs.readFile(target)).toString('base64');
    console.log('EVIDENCE_BEGIN '+name+'.jpg');
    for(let i=0;i<content.length;i+=16000)console.log('EVIDENCE_DATA '+content.slice(i,i+16000));
    console.log('EVIDENCE_END '+name+'.jpg');
  };
  const view = async (bounds, zoom) => {
    await page.evaluate(({bounds,zoom}) => { const m=window.__wa.map; if(bounds)m.fitBounds(bounds,{animate:false,padding:{left:370,right:25,top:70,bottom:45}}); else m.jumpTo(zoom); },{bounds,zoom});
    await page.waitForFunction(() => window.__wa.map.isSourceLoaded('china-map') && window.__wa.map.isSourceLoaded('omt'), undefined, { timeout:60000 });
    // DEM requests can continue while live terrain refreshes; wait for the map
    // and vector labels under test, then wait for an actual rendered frame.
    assert(await page.evaluate(() => new Promise(resolve => { const t=setTimeout(()=>resolve(false),10000); window.__wa.map.once('render',()=>{clearTimeout(t);resolve(true)}); window.__wa.map.triggerRepaint(); })), 'Map must render a fresh frame');
  };
  const checkLabels = async () => {
    const labels=await page.evaluate(()=>window.__wa.map.queryRenderedFeatures({layers:['place-country']}).map(f=>f.properties));
    const excluded=/^(Taiwan|Republic of China|Hong Kong|Macao|Macau|台湾|臺灣|香港|澳门|澳門)(省|特别行政区|特別行政區)?$/i;
    for(const p of labels) { for(const k of ['name','name_en','name:en','name:zh','name:zh-Hans']) assert(!excluded.test(String(p[k]||'')), 'Independent country label: '+JSON.stringify(p)); assert(!['TW','HK','MO'].includes(p.iso_a2),'Independent country code'); }
    return labels.map(p=>p['name:zh-Hans']||p['name:zh']||p.name_en||p.name);
  };
  const checkRegionLabelsHidden = async () => {
    const result=await page.evaluate(()=>({
      custom:window.__wa.map.queryRenderedFeatures({layers:['china-region-labels']}).map(f=>f.properties.name),
      states:window.__wa.map.queryRenderedFeatures({layers:['place-state']}).map(f=>f.properties),
    }));
    assert.equal(result.custom.length,0,'Dedicated regional labels must not render');
    const excluded=/^(Taiwan|Republic of China|Hong Kong|Macao|Macau|台湾|臺灣|台灣|香港|澳门|澳門)(省|特别行政区|特別行政區)?$/i;
    for(const p of result.states) for(const k of ['name','name_en','name:en','name:zh','name:zh-Hans']) assert(!excluded.test(String(p[k]||'')),'Base map regional label: '+JSON.stringify(p));
    return result.custom;
  };
  const visibleCityNames=()=>window.__wa.map.queryRenderedFeatures({layers:['city-labels']}).map(f=>f.properties.name);
  await view([[70,0],[137,55]]);
  let visible=await page.evaluate(()=>({outline:window.__wa.map.queryRenderedFeatures({layers:['china-outline']}).length,dashes:window.__wa.map.queryRenderedFeatures({layers:['china-maritime-dashes']}).length}));
  assert(visible.outline>0 && visible.dashes>0,'China outline and maritime segments must be rendered');
  step('china-overview-rendered',{...visible,regions:await checkRegionLabelsHidden(),country_labels:await checkLabels()}); await screenshot('china-overview');
  await view([[105,1],[124,25]]);
  const renderedDashes=await page.evaluate(()=>window.__wa.map.queryRenderedFeatures({layers:['china-maritime-dashes']}).map(f=>f.geometry));
  assert(renderedDashes.length>0); step('south-sea-rendered',{visible_features:renderedDashes.length,regions:await checkRegionLabelsHidden(),country_labels:await checkLabels()}); await screenshot('south-sea');
  await view([[119,21.5],[123.5,26]]);
  await page.waitForFunction(()=>window.__wa.map.queryRenderedFeatures({layers:['city-labels']}).some(f=>f.properties.name==='台北'),undefined,{timeout:15000});
  let cities=await page.evaluate(visibleCityNames);
  assert(cities.includes('台北'),'Ordinary Taipei city label must remain visible'); step('taiwan-regional-label-hidden',{regions:await checkRegionLabelsHidden(),city_labels:cities,country_labels:await checkLabels()}); await screenshot('taiwan');
  await view([[113.35,22.05],[114.6,22.7]]);
  await page.waitForFunction(()=>{const names=window.__wa.map.queryRenderedFeatures({layers:['city-labels']}).map(f=>f.properties.name);return names.includes('香港')&&names.includes('澳门');},undefined,{timeout:15000});
  cities=await page.evaluate(visibleCityNames);
  assert(cities.includes('香港') && cities.includes('澳门'),'Ordinary Hong Kong and Macao city labels must remain visible');
  step('hong-kong-macao-regional-label-hidden',{regions:await checkRegionLabelsHidden(),city_labels:cities,country_labels:await checkLabels()}); await screenshot('hong-kong-macao');
  for(const [query,city,region] of [['Taipei','台北','台湾省'],['香港','香港','香港特别行政区'],['澳门','澳门','澳门特别行政区']]) {
    await page.locator('#search').fill(query);
    await page.locator('#searchResults li').first().waitFor();
    const choices=await page.locator('#searchResults').innerText(); assert(choices.includes(city)&&choices.includes('中国')&&choices.includes(region), 'City search regional grouping: '+choices);
    step('search-'+query,{text:choices}); await screenshot('search-'+({Taipei:'taipei','香港':'hong-kong','澳门':'macao'}[query]));
  }
  await page.locator('#search').fill('Taipei'); await page.locator('#searchResults li').first().click();
  await page.waitForFunction(()=>{const c=document.querySelector('#card');return c&&!c.classList.contains('hidden')&&c.textContent.includes('中国');},undefined,{timeout:45000});
  const detail=await page.locator('#card').innerText(); assert(detail.includes('中国')); step('taipei-detail',{text:detail.slice(0,180)}); await screenshot('taipei-detail');
  assert(!report.errors.some(e=>e.type==='pageerror'||/failed to compile|style.*invalid|filter.*invalid/i.test(e.text||'')),JSON.stringify(report.errors));
  report.passed=true;
})().catch(async error => {
  report.failure=error.stack||String(error); console.error('BROWSER_CHECK_FAILED '+report.failure); process.exitCode=1;
  if(page)try { const target=path.join(evidence,'failure.jpg'); await page.screenshot({path:target,type:'jpeg',quality:82}); report.screenshots.push('failure.jpg'); const b=(await fs.readFile(target)).toString('base64'); console.log('EVIDENCE_BEGIN failure.jpg'); for(let i=0;i<b.length;i+=16000)console.log('EVIDENCE_DATA '+b.slice(i,i+16000)); console.log('EVIDENCE_END failure.jpg'); }catch{}
}).finally(async () => {
  await fs.mkdir(evidence,{recursive:true}); await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('BROWSER_REPORT '+JSON.stringify(report));
  if(browser)await browser.close(); if(server)server.kill();
});
