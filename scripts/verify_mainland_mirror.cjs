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
const backups = ['gcore.jsdelivr.net','fastly.jsdelivr.net','cdn.jsdelivr.net']
  .map(host=>`https://${host}/gh/xschen-beb/weather-atlas-zh-cn@${revision}/`);
const [backup] = backups;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json'};
const blocked = [];
const errors = [];
const startupAssetRequests = [];
const terrainUrl = /^https:\/\/elevation-tiles-prod\.s3(?:\.us-east-1)?\.amazonaws\.com\/terrarium\//;
const basemapUrl = /^https:\/\/tiles\.openfreemap\.org\/planet(?:\/|$)/;
let basemapAttempts = 0;
let browser;
let liteBrowser;
const takeScreenshot = (page, options) => process.env.ATLAS_SCREENSHOTS === '1' ? page.screenshot(options) : undefined;
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
    if (backups.some(base=>url.startsWith(base))) return route.abort('connectionreset');
    if (terrainUrl.test(url)) return route.abort();
    if (basemapUrl.test(url)) { basemapAttempts++; return route.abort(); }
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

async function denyStartupAssets(page, origin) {
  const prefix=origin+mount+'assets/';
  await page.route(url=>url.href.startsWith(prefix)&&/\.(js|css)$/.test(url.pathname),route=>{
    startupAssetRequests.push(route.request().url());
    return route.abort('connectionreset');
  });
}

async function verifyIndependentMapLayers(instance, origin) {
  const page = await startPage(instance,origin,{width:1000,height:700});
  await denyStartupAssets(page,origin);
  const requests = [
    ['data/dem.bin','海拔'],
    ['data/cities.json','城市列表'],
    ['data/coastline.json','海岸线'],
    ['data/china-map.geojson','中国地图边界'],
  ];
  const restored = new Set();
  for (const [relative] of requests) {
    await page.route(origin+mount+relative,route=>restored.has(relative)
      ? route.fallback() : route.fulfill({status:503,body:'temporarily unavailable'}));
  }
  const retry = name=>page.locator('#atlas-layer-status').getByRole('button',{name:`重试${name}`,exact:true});
  try {
    await page.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByRole('tab',{name:'按年统计',exact:true}).waitFor({timeout:20000});
    for (const [,name] of requests) await retry(name).waitFor({timeout:20000});
    await waitDefaultClimate(page);
    assert.equal(await page.evaluate(()=>window.__wa.field.ready),false,'No colours based on a placeholder elevation');
    await page.evaluate(()=>window.__wa.map.fire('click',{lngLat:{lng:116.4,lat:39.9}}));
    await page.locator('#card').getByText('海拔数据到齐后显示当地气候统计。',{exact:true}).waitFor();

    restored.add('data/dem.bin');
    await retry('海拔').click();
    await page.waitForFunction(()=>{
      const {climate,field,map}=window.__wa;
      return climate.dem?.q.length===6480000&&field.ready&&map.getLayoutProperty('hillshade','visibility')==='visible';
    },undefined,{timeout:30000});
    await page.locator('#card table').waitFor({timeout:30000});
    assert(await retry('城市列表').isVisible(),'Terrain and point climate recover independently of the city list');
    const restoredClimate = await page.evaluate(async()=>{
      const {data}=window.__wa.climate.result;
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
    });

    restored.add('data/cities.json');
    await retry('城市列表').click();
    await page.locator('#search').fill('北京');
    await page.locator('#searchResults li').filter({hasText:'北京'}).first().waitFor();
    await page.waitForFunction(()=>window.__wa.climate.cities.length===4598);
    for (const [relative,name] of requests.slice(2)) {
      restored.add(relative);
      await retry(name).click();
    }
    await page.locator('#atlas-layer-status').waitFor({state:'hidden'});
    await zoomTo(page,[115,22],3);
    await mapFeatures(page,['china-maritime-dashes','china-outline']);
    return {allFourFailedWithoutBlockingClimate:true,terrainAndCardRestoredIndependently:true,restoredClimate};
  } finally {
    await page.context().close();
  }
}

async function zoomTo(page, center, zoom) {
  await page.evaluate(({center,zoom})=>window.__wa.map.jumpTo({center,zoom}),{center,zoom});
}

async function mapFeatures(page, ids) {
  return page.waitForFunction(ids=>{
    const m=window.__wa?.map;
    return ids.every(id=>m?.getLayer(id)&&m.queryRenderedFeatures({layers:[id]}).length>0);
  },ids,{timeout:45000});
}

async function verifyBasemap(page, origin, instance) {
  await zoomTo(page,[122,34],4);
  await mapFeatures(page,['china-outline','boundary-country','boundary-state','place-country','place-state']);
  const names=await page.evaluate(()=>{
    const m=window.__wa.map;
    return Object.fromEntries(['place-country','place-state','china-region-labels'].map(id=>[id,
      m.queryRenderedFeatures({layers:[id]}).map(f=>f.properties.name)]));
  });
  assert(names['place-country'].some(name=>['中国','蒙古','韩国','日本','朝鲜'].includes(name)));
  assert(names['place-state'].some(name=>['内蒙古自治区','辽宁省','山东省','陕西省','江西省','浙江省','广东省','福建省'].includes(name)));
  const hidden=/^(?:中国)?(?:台湾(?:省)?|臺灣(?:省)?|香港(?:特别行政区)?|澳门(?:特别行政区)?|Taiwan|Hong Kong|Macau|Macao)$/i;
  assert(![...names['place-country'],...names['place-state'],...names['china-region-labels']].some(name=>hidden.test(name)));

  await zoomTo(page,[113.9,22.5],7);
  await mapFeatures(page,['roads','waterway']);
  assert(basemapAttempts>0,'The local fallback must draw when the optional basemap is blocked');
  await page.context().close();

  const online=await startPage(instance,origin,{width:1280,height:860});
  await denyStartupAssets(online,origin);
  // Genuine OpenFreeMap Shenzhen tile, served at the fetch boundary. Holding
  // TileJSON proves the default result does not depend on the optional source.
  const tile=(await fs.readFile(path.join(__dirname,'fixtures/basemap-shenzhen.pbf'))).toString('base64');
  await online.addInitScript(tile=>{
    const fetchActual=globalThis.fetch.bind(globalThis);
    const bytes=Uint8Array.from(atob(tile),c=>c.charCodeAt(0));
    const wait=new Promise(resolve=>{window.releaseBasemap=resolve;});
    globalThis.fetch=async (input,init)=>{
      const url=String(input);
      if(url==='https://tiles.openfreemap.org/planet') {
        await wait;
        return Response.json({maxzoom:14,tiles:['https://tiles.openfreemap.org/planet/atlas_fixture/{z}/{x}/{y}.pbf'],
          vector_layers:['transportation','waterway','water','place','boundary'].map(id=>({id}))});
      }
      if(url.startsWith('https://tiles.openfreemap.org/planet/atlas_fixture/')) {
        return new Response(url.endsWith('/10/836/446.pbf')?bytes:new Uint8Array(),{
          headers:{'content-type':'application/vnd.mapbox-vector-tile'},
        });
      }
      return fetchActual(input,init);
    };
  },tile);
  await online.goto(origin+mount+'#map=10/22.55/114.05',{waitUntil:'domcontentloaded',timeout:30000});
  await waitDefaultClimate(online);
  assert.equal(await online.evaluate(()=>Boolean(window.__wa.map.getSource('atlas-vector-details'))),false);
  await online.evaluate(()=>{window.releaseBasemap();});
  const ids=['atlas-detail-roads','atlas-detail-waterway','atlas-detail-water','atlas-detail-coastline'];
  await mapFeatures(online,ids);
  const rendered=await online.evaluate(ids=>{
    const map=window.__wa.map;
    const allowed=map.getStyle().layers.filter(l=>l.source==='atlas-vector-details').map(l=>l['source-layer']);
    const features=Object.fromEntries(ids.map(id=>[id,map.queryRenderedFeatures({layers:[id]}).length]));
    const roadClasses=[...new Set(map.queryRenderedFeatures({layers:[ids[0]]}).map(f=>f.properties.class))];
    return {allowed,features,roadClasses};
  },ids);
  assert(rendered.allowed.every(id=>['transportation','waterway','water'].includes(id)));
  assert(rendered.roadClasses.every(kind=>['motorway','trunk','primary'].includes(kind)));
  await takeScreenshot(online,{path:'mainland-evidence/basemap.jpg',type:'jpeg',quality:82});
  await online.context().close();
  return {localFallback:true,blockedMetadataDidNotGateClimate:true,rendered};
}

async function mapFrame(page, patch, lonLat, radius=12) {
  return page.evaluate(({patch,lonLat,radius})=>{
    const {map,field}=window.__wa;
    if(patch.hillshade) map.setLayoutProperty('hillshade','visibility',patch.hillshade);
    if(patch.water) map.setLayoutProperty('water','visibility',patch.water);
    if(patch.opacity!==undefined) field.opacity=patch.opacity;
    if(patch.coarse) field.setLocalDem(null);
    // Read the composited map while its frame is still available. Taking a
    // full browser screenshot for each comparison is slow on software WebGL.
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('No map frame rendered')),5000);
      map.once('render',()=>{
        clearTimeout(timer);
        try {
          const canvas=map.getCanvas(), gl=canvas.getContext('webgl2');
          const point=map.project(lonLat), side=radius*2;
          const x=Math.round(point.x*gl.drawingBufferWidth/canvas.clientWidth)-radius;
          const y=gl.drawingBufferHeight-Math.round(point.y*gl.drawingBufferHeight/canvas.clientHeight)-radius;
          if(x<0||y<0||x+side>gl.drawingBufferWidth||y+side>gl.drawingBufferHeight) throw new Error('Map pixel sample is outside the viewport');
          const pixels=new Uint8Array(side*side*4);
          const previous=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
          gl.readPixels(x,y,side,side,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous);
          resolve(Array.from(pixels));
        } catch(error) { reject(error); }
      });
      map.triggerRepaint();
    });
  },{patch,lonLat,radius});
}

function pixelDifference(a,b) {
  return a.reduce((sum,x,i)=>sum+Math.abs(x-b[i]),0)/a.length;
}

async function verifyWaterCoverage(page) {
  // The old world-sized polygon reported these land points as dry to feature
  // queries, but its triangles painted them blue. Check the rendered pixels.
  const cases = [
    {name:'Australia overview',center:[141,-25],zoom:1.75,land:[146.6,-32.3],sea:[159.4,-37.6]},
    {name:'Australia regional',center:[141,-25],zoom:2.3,land:[146.6,-32.3],sea:[159.4,-37.6]},
    {name:'Japan regional',center:[132,27],zoom:2.3,land:[139.2,36.35],sea:[145.5,34.7]},
    {name:'Australia closer',center:[141,-25],zoom:3.2,land:[146.6,-32.3],sea:[159.4,-37.6]},
    {name:'Central America regional',center:[-89.5,14.5],zoom:4.15,land:[-89.63,14.21],sea:[-93,11.2]},
  ];
  const result = [];
  await page.evaluate(()=>window.__wa.map.setLayoutProperty('city-labels','visibility','none'));
  try {
    for(const {name,center,zoom,land,sea} of cases) {
      await zoomTo(page,center,zoom);
      await page.waitForFunction(sea=>{
        const m=window.__wa.map;
        return m.isSourceLoaded('water-mask')&&m.queryRenderedFeatures(m.project(sea),{layers:['water']}).length>0;
      },sea,{timeout:30000});
      const masked=await mapFrame(page,{water:'visible',opacity:1},land,3);
      const unmasked=await mapFrame(page,{water:'none',opacity:1},land,3);
      const plain=await mapFrame(page,{water:'visible',opacity:0},land,3);
      const seaPlain=await mapFrame(page,{opacity:0},sea,3);
      const seaClimate=await mapFrame(page,{opacity:1},sea,3);
      const waterOverLand=pixelDifference(masked,unmasked);
      const climateOnLand=pixelDifference(masked,plain);
      const climateAtSea=pixelDifference(seaPlain,seaClimate);
      assert(waterOverLand<2&&climateOnLand>5&&climateAtSea<2,
        `${name} z${zoom}: water over land ${waterOverLand}, land climate ${climateOnLand}, sea climate ${climateAtSea}`);
      result.push({name,zoom,waterOverLand,climateOnLand,climateAtSea});
    }
  } finally {
    await page.evaluate(()=>{
      const {map,field}=window.__wa;
      map.setLayoutProperty('city-labels','visibility','visible');
      map.setLayoutProperty('water','visibility','visible');
      field.opacity=1;
      map.triggerRepaint();
    });
  }
  return result;
}

async function verifyTerrain(page, origin, instance) {
  const mountains=[102.1,29.6], sea=[114.33,22.26], land=[114.16,22.45];
  await zoomTo(page,mountains,9);
  await page.waitForFunction(()=>window.__wa.map.isSourceLoaded('dem')&&window.__wa.map.areTilesLoaded(),undefined,{timeout:30000});
  const shaded=await mapFrame(page,{opacity:0,hillshade:'visible'},mountains);
  const flat=await mapFrame(page,{opacity:0,hillshade:'none'},mountains);
  const reliefDelta=pixelDifference(shaded,flat);
  assert(reliefDelta>1,'Blocked external terrain must still leave visible local relief');
  await mapFrame(page,{opacity:1,hillshade:'visible'},mountains);
  await zoomTo(page,[114.24,22.38],10);
  await page.waitForFunction(p=>{
    const m=window.__wa.map;
    return m.queryRenderedFeatures(m.project(p),{layers:['water']}).length>0;
  },sea,{timeout:30000});
  const seaDelta=pixelDifference(await mapFrame(page,{opacity:0},sea),await mapFrame(page,{opacity:1},sea));
  const landDelta=pixelDifference(await mapFrame(page,{opacity:0},land),await mapFrame(page,{opacity:1},land));
  assert(seaDelta<3&&landDelta>10,`High zoom climate colours must cover land and spare ocean: ${seaDelta}, ${landDelta}`);

  const detail=await startPage(instance,origin,{width:1440,height:960});
  await denyStartupAssets(detail,origin);
  const png=await page.evaluate(async()=>{
    const image=new ImageData(256,256);
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){
      const value=32768+400+Math.floor(14*x+3*y), i=(y*256+x)*4;
      image.data.set([value>>8,value&255,0,255],i);
    }
    const canvas=new OffscreenCanvas(256,256);
    canvas.getContext('2d').putImageData(image,0,0);
    const bytes=new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    return btoa(Array.from(bytes, b=>String.fromCharCode(b)).join(''));
  });
  // Isolate texture/colour rendering from browser network interception timing.
  await detail.addInitScript(png=>{
    const nativeFetch=globalThis.fetch.bind(globalThis);
    const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
    const counts=window.terrainFixture={primary:0,alternate:0};
    globalThis.fetch=(input,init)=>{
      const url=String(input);
      if(!/^https:\/\/elevation-tiles-prod\.s3(?:\.us-east-1)?\.amazonaws\.com\/terrarium\//.test(url)) return nativeFetch(input,init);
      const fallback=url.includes('.s3.us-east-1.');
      if(fallback) counts.alternate++; else counts.primary++;
      return Promise.resolve(new Response(fallback?bytes:'unavailable',{
        status:fallback?200:503,headers:{'content-type':fallback?'image/png':'text/plain'},
      }));
    };
  },png);
  await detail.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  await waitDefaultClimate(detail);
  assert.deepEqual(await detail.evaluate(()=>window.terrainFixture),{primary:0,alternate:0},'Default climate must not fetch external terrain');
  await detail.evaluate(()=>window.__wa.map.setLayoutProperty('hillshade','visibility','none'));
  await zoomTo(detail,mountains,9);
  await detail.waitForFunction(()=>window.__wa.field.ldemExt[2]>window.__wa.field.ldemExt[0],undefined,{timeout:30000});
  const corrected=await mapFrame(detail,{},mountains);
  const coarse=await mapFrame(detail,{coarse:true},mountains);
  const correctionDelta=pixelDifference(corrected,coarse);
  const {primary,alternate}=await detail.evaluate(()=>window.terrainFixture);
  assert(primary>0&&alternate>0&&correctionDelta>1,'Detail fallback must change the actual climate pixels');
  await detail.context().close();
  return {reliefDelta,seaDelta,landDelta,correctionDelta,alternate};
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

async function verifyDataRoutes() {
  const {createAtlasDataReader}=await import('../localization/atlas-data.js');
  const fetchActual=globalThis.fetch;
  const locationActual=Object.getOwnPropertyDescriptor(globalThis,'location');
  const path='data/check.bin', contents=Uint8Array.of(10,20,30,40);
  const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',contents)),b=>b.toString(16).padStart(2,'0')).join('');
  const files={[path]:[contents.length,sha,'high']};
  Object.defineProperty(globalThis,'location',{value:{href:'https://weather.example.test/map/'},configurable:true});
  try {
    let stopped;
    const routes=[];
    globalThis.fetch=(url,init)=>{
      routes.push([url.hostname,init.credentials]);
      if(url.hostname!=='weather.example.test')return Promise.resolve(new Response(contents));
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{
        stopped=init.signal.reason;
        reject(stopped);
      },{once:true}));
    };
    const reader=createAtlasDataReader(files,backups);
    const [a,b]=await Promise.all([reader.bytes('./',path),reader.bytes('./',path)]);
    assert.deepEqual(new Uint8Array(a),contents);
    assert.notEqual(a,b,'One consumer can transfer its copy without detaching another');
    assert.deepEqual(routes,[['weather.example.test','same-origin'],['gcore.jsdelivr.net','omit']]);
    assert.match(stopped?.message||'',/Another data route succeeded/,'An early backup must win before the stalled primary times out');

    const called=[];
    globalThis.fetch=async (url)=>{
      called.push(url.hostname);
      return new Response(new ReadableStream({start(controller){
        controller.enqueue(contents.subarray(0,2));
        setTimeout(()=>{ controller.enqueue(contents.subarray(2)); controller.close(); },2050);
      }}));
    };
    assert.deepEqual(new Uint8Array(await reader.bytes('./',path)),contents);
    assert.deepEqual(called,['weather.example.test'],'A slow but progressing download should not start a duplicate');

    const verified=[];
    globalThis.fetch=async (url)=>{
      verified.push(url.hostname);
      if(url.hostname==='weather.example.test')return new Response('',{status:503});
      return new Response(url.hostname==='gcore.jsdelivr.net'?Uint8Array.of(10,20,30,41):contents);
    };
    assert.deepEqual(new Uint8Array(await reader.bytes('./',path)),contents);
    assert.deepEqual(verified,['weather.example.test','gcore.jsdelivr.net','fastly.jsdelivr.net']);

    const bounded=createAtlasDataReader({[path]:[...files[path],45]},backups);
    let deadline;
    globalThis.fetch=async (url,init)=>new Response(new ReadableStream({start(controller){
      controller.enqueue(contents.subarray(0,2));
      init.signal.addEventListener('abort',()=>{
        deadline=init.signal.reason;
        controller.error(deadline);
      },{once:true});
    }}));
    await assert.rejects(bounded.bytes('./',path),/Request timeout/);
    assert.match(deadline?.message||'',/Request timeout/,'A layer deadline aborts the active download');
    globalThis.fetch=async()=>new Response(contents);
    assert.deepEqual(new Uint8Array(await bounded.bytes('./',path)),contents,'A failed layer can start a fresh download');
  } finally {
    globalThis.fetch=fetchActual;
    if(locationActual)Object.defineProperty(globalThis,'location',locationActual);
    else delete globalThis.location;
  }
}

(async () => {
  await verifyRangeFallback();
  await verifyDataRoutes();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.ATLAS_TEST_CHROMIUM;
  browser = await chromium.launch({headless:true,executablePath,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await startPage(browser, origin, {width:1440,height:960});
  await denyStartupAssets(page,origin);
  let sunAttempts=0, demAttempts=0;
  await page.route(origin+mount+'data/climate/sun.bin',route=>
    ++sunAttempts===1?route.abort('connectionreset'):route.fallback());
  await page.route(origin+mount+'data/dem.bin',route=>
    ++demAttempts===1?route.fulfill({status:503,body:'temporarily unavailable'}):route.fallback());
  await page.goto(origin+mount,{waitUntil:'domcontentloaded',timeout:30000});
  await waitDefaultClimate(page);
  const startupClimate = await page.evaluate(async ()=>{
    const r=window.__wa.climate.result;
    const hash=await crypto.subtle.digest('SHA-256',r.data);
    return {scale:r.scaleMax,samples:r.data.length,
      sha256:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')};
  });
  assert.equal(sunAttempts,2,'Default climate must recover from a reset on the site');
  await page.waitForFunction(()=>window.__wa?.field?.hasDem,undefined,{timeout:30000});
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
  await takeScreenshot(page,{path:'mainland-evidence/mirror.jpg',type:'jpeg',quality:82});
  await page.locator('#card').getByRole('button',{name:'关闭',exact:true}).click();
  const waterCoverage=await verifyWaterCoverage(page);
  const terrainRender=await verifyTerrain(page,origin,browser);
  const basemapRender=await verifyBasemap(page,origin,browser);
  const mapLayers=await verifyIndependentMapLayers(browser,origin);
  assert.equal(mapLayers.restoredClimate,startupClimate.sha256,'Layer errors and retries must preserve climate values');

  const fallbackPage = await startPage(browser,origin,{width:1440,height:960});
  const index=await fs.readFile(path.join(root,'index.html'),'utf8');
  const unpackFailure=index.replace(/data-bytes="\d+" data-sha256=/,'data-bytes="0" data-sha256=');
  assert.notEqual(index,unpackFailure,'The test must break the embedded decoder check');
  let externalEntryLoads=0;
  fallbackPage.on('request',request=>{
    if (request.url().startsWith(origin+mount+'assets/index-zh-CN-local-')) externalEntryLoads++;
  });
  await fallbackPage.route(origin+mount,route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:unpackFailure}));
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
  assert.equal(failedSite,3);
  assert.equal(backupAttempts,2);
  await fallbackPage.locator('#status').waitFor({state:'hidden'});
  assert.equal(externalEntryLoads,1,'A decoder failure should use the same-origin compatibility entry once');
  await fallbackPage.context().close();

  liteBrowser = await chromium.launch({headless:true,executablePath,args:['--disable-webgl']});
  const lite = await startPage(liteBrowser, origin, {width:390,height:844});
  await denyStartupAssets(lite,origin);
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
  await takeScreenshot(lite,{path:'mainland-evidence/lite.jpg',type:'jpeg',quality:82,fullPage:true});

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
  await lite.context().close();

  // Hold the elevation download and global index requests while switching
  // mode and opening a point weather card.
  const live=await startPage(browser,origin,{width:1440,height:960});
  await denyStartupAssets(live,origin);
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
    await terrainRequested;
    await live.getByRole('tab',{name:'实时天气（联网）',exact:true}).click();
    await live.getByText('正在加载全球图层…',{exact:false}).first().waitFor();
    await live.locator('#search').fill('北京');
    await live.locator('#searchResults li').first().click();
    await live.locator('#card').getByText(/数据时刻：/).waitFor();
    assert.match(await live.locator('#card .now .big').innerText(),/^23/);
    assert.equal(await live.evaluate(()=>Boolean(window.__wa.field.hasDem)),false,'Point weather must work while terrain is held');
    assert(gridRequests>0);
    assert.equal(await live.getByRole('button',{name:'重试全球图层',exact:true}).count(),0);
    releaseTerrain();
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
  assert.deepEqual(startupAssetRequests,[],'Full and lightweight historical mode must boot without any HTTP JS or CSS asset');
  const report={passed:true,subpath:mount,third_party_requests:blocked.length,details,
    lite:{webgl:false,viewport:'390×844',place:'香港',months,recovered_from_http:503},
    waterCoverage,terrain:terrainRender,basemap:basemapRender,mapLayers,startup:{webgl_and_lite_assets_denied:true,http_js_css_requests:startupAssetRequests.length,
      compatibility_entry:true,climate:startupClimate},
    resilience:{cold_start_site_retry:true,verified_backup:true,early_fallback:true,slow_stream_kept:true,wrong_checksum_rejected:true,manual_retry:true,lite_base_survives_supplement:true},
    live:{early_mode_click:true,point_with_grid_pending:true,global_retry:true,lite_point_retry:true,strict_range:true}};
  await fs.writeFile('mainland-evidence/report.json',JSON.stringify(report,null,2)+'\n');
  console.log('MAINLAND_MIRROR_REPORT '+JSON.stringify(report));
})().catch(error=>{console.error(error);console.error(JSON.stringify({blocked,errors}));process.exitCode=1;})
  .finally(async()=>{await Promise.all([browser?.close(),liteBrowser?.close()]);server.close();});
