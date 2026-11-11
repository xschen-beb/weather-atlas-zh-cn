// Read-only browser audit of the public Pages build. The 503 is a browser
// fixture, not a change to the deployed site or its upstream files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const base = 'https://xschen-beb.github.io/weather-atlas-zh-cn/';
const conditions = [
  ['feels','午后体感温度'], ['tmax','日间最高温度'], ['tmin','夜间最低温度'],
  ['dew','露点温度'], ['cloud','云量'], ['sun','日照时数'],
  ['uv','紫外线指数'], ['precip','日降水量'], ['wind','风速'],
  ['snow','地面积雪'], ['sst','海表温度'], ['daylight','昼长'],
];
const extraLabels = ['露点温度','日照（小时）','紫外线峰值','少云日数','降水日数','积雪日数'];
const blocked = [];
const errors = [];
const report = {url:base, points:[], controls:[], dateControls:[]};
let gl, lite;

async function open(browser) {
  const context = await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:960},serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  return page;
}

let seed = 20261111;
function random() {
  seed = (Math.imul(1664525,seed)+1013904223)>>>0;
  return seed / 2**32;
}
function point(name, west, east, south, north) {
  return {name, lon:+(west+(east-west)*random()).toFixed(3),lat:+(south+(north-south)*random()).toFixed(3)};
}

async function chooseMapPoint(page, place) {
  const pos=await page.evaluate(({lon,lat})=>{
    const m=window.__wa.map;
    m.jumpTo({center:[lon,lat],zoom:6});
    const p=m.project([lon,lat]), r=m.getCanvas().getBoundingClientRect();
    return {x:r.left+p.x,y:r.top+p.y};
  },place);
  assert(pos.x>365 && pos.x<1060 && pos.y>90 && pos.y<800,JSON.stringify(pos));
  await page.mouse.click(pos.x,pos.y);
}

async function readRows(page) {
  const table=page.locator('#card table.normals');
  await table.waitFor({timeout:40000});
  return table.evaluate(t=>Array.from(t.querySelectorAll('tbody tr')).flatMap(row=>{
    const label=row.querySelector('th[scope=row]')?.textContent.trim();
    return label?[[label,Array.from(row.querySelectorAll('td'),td=>td.textContent.trim())]]:[];
  }));
}

function verifyRows(entries) {
  const rows=new Map(entries);
  const limits=new Map([
    ['日照（小时）',[0,24]], ['紫外线峰值',[0,30]], ['少云日数',[0,31]],
    ['降水日数',[0,31]], ['积雪日数',[0,31]], ['露点温度',[-100,60]],
  ]);
  for (const label of extraLabels) {
    const cells=rows.get(label);
    assert.equal(cells?.length,12,label+' must have twelve months');
    const [min,max]=limits.get(label);
    assert(cells.every(v=>Number.isFinite(parseFloat(v)) && parseFloat(v)>=min && parseFloat(v)<=max),label+': '+cells);
  }
  const wind=entries.find(([label])=>label.startsWith('风速（'))?.[1];
  assert.equal(wind?.length,12);
  assert(wind.every(v=>Number.isFinite(parseFloat(v))&&parseFloat(v)>=0));
  return {monthlyMetrics:entries.map(([label])=>label),sstMonths:(rows.get('海温')||[]).filter(v=>Number.isFinite(parseFloat(v))).length};
}

async function waitGrid(page, mode, key = '', enabled = false) {
  await page.waitForFunction(({mode,key,enabled})=>{
    const c=window.__wa?.climate;
    return c?.active && c.meta && c.result?.mode===mode && !c.inflight && !c.dirty
      && (!key || ((key in c.state)===enabled));
  },{mode,key,enabled},{timeout:60000});
  return page.evaluate(()=>{
    const c=window.__wa.climate, data=c.result.data;
    let total=0, count=0, valid=true;
    for(let i=0;i<data.length;i+=2) if(data[i+1]>0) {
      const v=data[i];
      valid &&= Number.isFinite(v)&&v>=0&&v<=1.00001;
      total+=v;
      count++;
    }
    return {total,count,valid,scale:c.result.scaleMax};
  });
}

async function add(page,key,label,mode) {
  const panel=page.locator('#panel');
  await panel.getByRole('button',{name:'添加条件',exact:true}).click();
  await panel.getByRole('menuitemcheckbox',{name:new RegExp('^'+label)}).click();
  const initial=await waitGrid(page,mode,key,true);
  assert(initial.valid && initial.count>0 && initial.total>0,label);
  return initial;
}

async function remove(page,key,label,mode) {
  await page.locator('#panel').getByRole('button',{name:'移除'+label+'条件',exact:true}).click();
  return waitGrid(page,mode,key,false);
}

(async()=>{
  gl=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await open(gl);
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:45000});
  await waitGrid(page,'days');
  const activeAsset=await page.locator('script[type=module][src]').getAttribute('src');
  report.entry=activeAsset;
  assert(activeAsset?.includes('index-zh-CN-local-'));
  await page.locator('#map .maplibregl-canvas').waitFor();
  const panel=page.locator('#panel'), card=page.locator('#card');
  const places=[
    point('豫中平原',113.23,113.80,32.65,33.35),
    point('川西高地',99.55,100.08,30.30,31.02),
    point('珠江口沿海',113.90,114.20,22.48,22.64),
  ];
  const ocean=point('南太平洋远洋',-152,-147,-33,-30);

  await chooseMapPoint(page,places[0]);
  await readRows(page);
  const more=card.getByRole('button',{name:/查看云量、露点、紫外线/});
  await more.waitFor();
  const before=await card.getByRole('rowheader',{name:'紫外线峰值',exact:true}).count();
  assert.equal(before,0,'UV should be loaded by the additional metrics button');
  let injected=false;
  await page.route('**/data/climate/uv.bin',route=>{
    if(injected)return route.fallback();
    injected=true;
    return route.fulfill({status:503,contentType:'text/plain',body:'audit fixture: temporary outage'});
  });
  const failure=page.waitForResponse(r=>r.url().endsWith('/uv.bin')&&r.status()===503,{timeout:20000});
  await more.click();
  await failure;
  await page.waitForFunction(()=>window.__wa?.climate?.pending.size===0,undefined,{timeout:40000});
  const failureText=await card.innerText();
  report.additionalLoad={injected503:injected,visibleError:/加载失败|暂不可用|重试/.test(failureText)};
  await more.click();
  await card.getByRole('rowheader',{name:'紫外线峰值',exact:true}).waitFor({timeout:40000});
  await more.waitFor({state:'hidden'});
  report.additionalLoad.retryLoaded=true;
  report.points.push({...places[0],...verifyRows(await readRows(page))});
  for (const p of places.slice(1)) {
    await chooseMapPoint(page,p);
    await card.getByRole('rowheader',{name:'紫外线峰值',exact:true}).waitFor({timeout:40000});
    report.points.push({...p,...verifyRows(await readRows(page))});
  }
  assert.equal(report.points[0].sstMonths,0,'Inland sea temperature should be absent');
  assert(report.points[2].sstMonths>0,'Coastal sea temperature did not appear');
  await chooseMapPoint(page,ocean);
  await card.getByText('此处没有气候数据（远洋或南极洲）。',{exact:true}).waitFor({timeout:25000});
  report.ocean={...ocean,coverageMessage:true};
  await card.getByRole('button',{name:'关闭',exact:true}).click();

  for(const key of ['feels','sun','precip']) await remove(page,key,conditions.find(c=>c[0]===key)[1],'days');
  const baseline=await waitGrid(page,'days');
  await panel.getByRole('button',{name:'添加条件',exact:true}).click();
  const menu=await panel.locator('.add-menu .mi-label').allTextContents();
  assert.deepEqual([...menu].sort(),conditions.map(e=>e[1]).sort());
  await panel.getByRole('button',{name:'添加条件',exact:true}).click();
  for(const [key,label] of conditions) {
    const initial=await add(page,key,label,'days');
    assert(initial.total<baseline.total-0.0001,label+' should change the annual grid');
    const range=await page.evaluate(v=>window.__wa.climate.state[v].map(String),key);
    const lower=range[1]==='Infinity';
    await panel.getByRole('slider',{name:label+(lower?' 下限':' 上限'),exact:true}).press(lower?'ArrowRight':'ArrowLeft');
    const narrowed=await waitGrid(page,'days',key,true);
    const updated=await page.evaluate(v=>window.__wa.climate.state[v].map(String),key);
    assert.notDeepEqual(range,updated,label+' did not change its threshold');
    assert(narrowed.valid && narrowed.total<initial.total-0.0001,label+' did not recalculate with the new threshold');
    const restored=await remove(page,key,label,'days');
    assert(Math.abs(restored.total-baseline.total)<0.0001,label+' did not clear');
    report.controls.push({key,label,added:true,thresholdChanged:true,removed:true});
  }
  await panel.getByRole('tab',{name:'按日期',exact:true}).click();
  const dateBaseline=await waitGrid(page,'date');
  assert.equal(dateBaseline.scale,1);
  for(const [key,label] of conditions.filter(([key])=>['sun','uv','cloud'].includes(key))) {
    const selected=await add(page,key,label,'date');
    assert(selected.total<dateBaseline.total,label+' did not recalculate for the date');
    await remove(page,key,label,'date');
    report.dateControls.push(label);
  }
  console.log('FULL_CLIMATE_AUDIT '+JSON.stringify(report));

  lite=await chromium.launch({headless:true,args:['--disable-webgl']});
  const light=await open(lite);
  await light.goto(base,{waitUntil:'domcontentloaded',timeout:45000});
  await light.getByText('轻量版 · 历史气候',{exact:true}).waitFor();
  await light.getByRole('button',{name:'全球',exact:true}).click();
  await light.getByText(/点击地图上的城市或任意位置/).waitFor();
  const coords=await light.locator('svg.lite-map').evaluate((svg,p)=>{
    const pt=new DOMPoint(p.lon,-p.lat).matrixTransform(svg.getScreenCTM());
    return {x:pt.x,y:pt.y};
  },ocean);
  await light.mouse.click(coords.x,coords.y);
  await light.getByText(/数据加载失败|此处没有气候数据/).waitFor({timeout:45000});
  report.liteOceanNotice=await light.locator('.lite-detail-status').innerText();
  report.browserErrors=errors;
  report.offsiteRequests=blocked;
  assert.deepEqual(blocked,[],'Historical filtering should be same-origin');
  assert(errors.every(message=>/uv\.bin.*HTTP 503|HTTP 503/.test(message)),JSON.stringify(errors));
  console.log('CLIMATE_CONTROLS_AUDIT '+JSON.stringify(report));
})().catch(error=>{console.error(error);console.error(JSON.stringify({report,errors,blocked}));process.exitCode=1;})
  .finally(async()=>{
    await fs.mkdir('climate-control-evidence',{recursive:true});
    await fs.writeFile('climate-control-evidence/report.json',JSON.stringify({report,errors,blocked},null,2)+'\n');
    await Promise.all([gl?.close(),lite?.close()]);
  });
