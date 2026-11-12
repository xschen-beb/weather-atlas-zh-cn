#!/usr/bin/env python3
"""Export the existing atlas as a static mirror with a same-origin base map."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

from embed_atlas_startup import embed_startup


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

LOCAL_STYLE = r'''
function waLocalMapStyle(style) {
  // Keep layer anchors and the original China geometry. Historical maps need
  // only the bundled coastline, cities, elevation and climate files.
  delete style.glyphs;
  delete style.sources.dem;
  style.sources.omt={type:"geojson",data:{type:"FeatureCollection",features:[]}};
  // These sources are filled by the same resilient reader as the climate data.
  for(const id of ["coast","china-map"]) style.sources[id].data={type:"FeatureCollection",features:[]};
  style.layers=style.layers.map(layer=>{
    if(layer.id==="hillshade") return {id:"hillshade",type:"background",paint:{"background-opacity":0}};
    if(layer.source==="omt") delete layer["source-layer"];
    if(layer.id==="coastline-ne") delete layer.maxzoom;
    return layer;
  });
  return style;
}
'''

STATIC_DATA_GLUE = r'''
const waDataNames={
  "data/coastline.json":"海岸线","data/china-map.geojson":"中国地图边界",
  "data/cities.json":"城市列表","data/dem.bin":"海拔数据",
  "data/climate/meta.json":"气候数据目录","data/climate/cells.bin":"气候网格",
  "data/climate/feels.bin":"体感温度","data/climate/sun.bin":"日照时数",
  "data/climate/precip.bin":"降水量","data/climate/tmax.bin":"最高温度",
  "data/climate/tmin.bin":"最低温度","data/climate/cloud.bin":"云量",
  "data/climate/dew.bin":"露点温度","data/climate/uv.bin":"紫外线指数",
  "data/climate/wind.bin":"风速","data/climate/snow.bin":"积雪","data/climate/sst.bin":"海温",
};
function waDataFailure(error) {
  const text=String(error?.message??error??"");
  const hit=/^Atlas data ([^:]+): ([\s\S]*)$/.exec(text);
  return hit?`${waDataNames[hit[1]]??"气候数据"}（${waZhError(hit[2])}）`:waZhError(text);
}
async function waReadDem(base) {
  const bytes=new Uint8Array(await waDataBytes(base,"data/dem.bin"));
  if(bytes[0]!==31||bytes[1]!==139) return bytes;
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function waClimateWorker(workerUrl) {
  const worker=new Worker(workerUrl,{type:"module"});
  const root=new URL("../",workerUrl);
  const directory=new URL("data/climate/",root);
  worker.addEventListener("message",async event=>{
    const request=event.data;
    if(request?.type!=="wa-climate-fetch") return;
    event.stopImmediatePropagation();
    const reply={type:"wa-climate-bytes",fetchId:request.fetchId};
    try {
      const url=new URL(request.url);
      if(url.origin!==location.origin||!url.href.startsWith(directory.href)||url.search||url.hash) {
        throw new Error("Unsupported climate data URL");
      }
      const name=url.pathname.slice(directory.pathname.length);
      if(!/^[a-z0-9]+\.(?:json|bin)$/.test(name)) throw new Error("Unsupported climate data file");
      const body=await waDataBytes(root,`data/climate/${name}`);
      worker.postMessage({...reply,status:200,headers:{
        "content-type":name.endsWith(".json")?"application/json":"application/octet-stream",
        "content-length":String(body.byteLength),
      },body},[body]);
    } catch(error) {
      worker.postMessage({...reply,error:String(error?.message||error)});
    }
  });
  return worker;
}
function waExtraClimateButton(load,render,megabytes) {
  const button=be("button",{class:"chip",style:"margin-top:10px"},
    `+ 查看云量、露点、紫外线、风速、积雪及海温（${megabytes.toFixed(1)} MB）`);
  const status=be("div",{class:"desc",role:"status"});
  status.hidden=true;
  button.onclick=async()=>{
    status.hidden=false;
    status.textContent="正在加载补充气候指标…";
    button.disabled=true;
    try { render(await load()); }
    catch(error) {
      status.textContent=`补充数据加载失败：${waDataFailure(error)}`;
      button.textContent="重试补充数据";
    } finally { button.disabled=false; }
  };
  return be("div",{},button,status);
}
'''

CYCLE_LOOKUP = r'''
async function Dv(now=Date.now(),horizon=72) {
  const recent=Math.floor(now/(6*Ch))*6*Ch;
  const checks=Array.from({length:4},(_,i)=>Cv(recent-i*6*Ch)).map(async cycle=>{
    try {
    const lead=Math.max(0,Math.floor((now-cycle.time)/Ch));
    const [current,future]=await Promise.all([
      readGfsIndex(Av(cycle,lead)+".idx"),
      readGfsIndex(Av(cycle,Math.min(lead+horizon,120))+".idx"),
    ]);
      return {cycle:current&&future?cycle:null};
    } catch(error) {
      return {error};
    }
  });
  let failure;
  for(const check of checks) {
    const {cycle,error}=await check;
    if(cycle) return cycle;
    failure??=error;
  }
  throw failure??new Error("No recent GFS cycle found");
}
'''

LIVE_BOOT = r'''
let waRequestedMode,waLivePromise;
async function waStartLive() {
  if(gn.waGridReady) return true;
  if(waLivePromise) return waLivePromise;
  gn.waGridError="";
  waLivePromise=gn.init().then(()=>{
    gn.waGridReady=true;
    return true;
  },error=>{
    gn.cycle=null;
    gn.waGridError=waZhError(error.message);
    return false;
  }).finally(()=>{waLivePromise=undefined;});
  return waLivePromise;
}
async function waActivateLive() {
  gn.waGridError="";
  gn.waFrameError="";
  ja.enter();
  const ready=await waStartLive();
  if(Zr!=="live") return;
  if(ready) {
    gn.activate();
    gn.updateCities();
  }
  Vc("",!1);
  ja.enter();
}
async function Rp(mode) {
  if(!Jn) {
    waRequestedMode=mode;
    Vc("正在准备地图…");
    return;
  }
  if(mode===Zr) return;
  const previous=Zr;
  Zr=mode;
  document.querySelectorAll("#modes button").forEach(button=>button.setAttribute("aria-selected",String(button.dataset.mode===mode)));
  $h();
  if(previous==="live"){gn.deactivate();ja.exit();}
  if(previous==="climate") Jn.exit();
  await Ba.fadeTo(0,160);
  if(Zr!==mode) return;
  mx(mode);
  gx();
  if(mode==="live") await waActivateLive();
  else await Jn.enter();
}
'''

LIVE_CARD = r'''
async showCard(lon,lat,place) {
  this.waCardAbort?.abort();
  const controller=new AbortController();
  this.waCardAbort=controller;
  const card=this.els.card;
  const time=this.c.waGridReady?this.c.time:Date.now();
  _n(card);
  card.classList.remove("hidden");
  const close=be("button",{class:"close","aria-label":"关闭",onclick:()=>{
    controller.abort();
    this.onCardClose();
  }},"✕");
  const heading=be("div",{class:"place"},"所选地点");
  const coords=be("div",{class:"coords"},Uh(lon,lat));
  const body=be("div",{class:"card-body"},be("div",{class:"desc",role:"status"},"正在加载当地天气…"));
  card.append(close,heading,coords,body);
  const stillOpen=()=>!controller.signal.aborted&&card.contains(body);
  Promise.resolve(place).then(result=>{
    if(!stillOpen()||!result) return;
    heading.textContent=result.name;
    coords.textContent=[result.detail,Uh(lon,lat)].filter(Boolean).join(" · ");
  }).catch(()=>{});
  try {
    let forecast;
    try { forecast=await Rv(lat,lon,controller.signal); }
    catch(error) {
      if(!stillOpen()||!this.c.waGridReady) throw error;
      body.replaceChildren(be("div",{class:"desc",role:"status"},"正在尝试 NOAA 地点预报…"));
      let timeout;
      try {
        forecast=await Promise.race([
          this.c.gfsPoint(lon,lat,cl(this.dem,lon,lat)),
          new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Request timeout")),12000);}),
        ]);
      } finally { clearTimeout(timeout); }
      forecast.hours=forecast.hours.filter(hour=>Number.isFinite(hour.temp));
      if(!forecast.hours.some(hour=>Math.abs(hour.t-time)<=90*60*1000)) throw new Error("Stale point forecast");
    }
    if(stillOpen()) body.replaceChildren(...$v(forecast,time,this.c.waGridReady));
  } catch(error) {
    if(!stillOpen()) return;
    body.replaceChildren(
      be("div",{class:"desc",role:"status"},`地点天气暂不可用：${waZhError(error.message)}`),
      be("button",{class:"chip",onclick:()=>this.showCard(lon,lat,place)},"重试地点天气"),
    );
  }
}}
'''

# Keep the original chart, table and ERA5 worker in both modes. Load the
# lightweight interface only on browsers that cannot start the full map.
START_MAP = r'''
function waStartLiteMap() {
  import(new URL("__LITE_MODULE__", import.meta.url).href).then(({startLite})=>startLite({
    base:new URL("./",location.href),
    loadCities:_v,loadElevation:gv,elevationAt:cl,nearestCity:yv,
    loadDataJson:waDataJson,
    makeWorker:()=>waClimateWorker(new URL("climate.session.worker-b2d359a84de5.js",import.meta.url)),
    presets:vg,
    criteria:state=>Object.entries(state).map(([v,range])=>{
      const [lo,hi]=px(Gc.find(option=>option.v===v),range);
      return {v,lo,hi};
    }),
    renderDetails:(data,elev,state)=>[ex(data),ix(data,-1,state),lx(data),cx(data,elev)],
    loadWeather:Rv,
    renderWeather:(data)=>$v(data,Date.now(),false),
    describeError:waDataFailure,
  })).catch(error=>{
    console.error(error);
    const notice=document.createElement("p");
    notice.setAttribute("role","alert");
    notice.style.cssText="position:fixed;z-index:100;left:1rem;right:1rem;top:4rem;background:white;padding:1rem";
    notice.textContent="地图暂时无法加载，请刷新后重试。";
    document.body.append(notice);
  });
}
function waHasWebGL() {
  try {
    const gl=document.createElement("canvas").getContext("webgl2");
    if(!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
if(new URL(location.href).searchParams.get("map")==="lite" || !waHasWebGL()) {
  waStartLiteMap();
} else {
  try { waStartRichMap(); }
  catch(error) {
    if(!/WebGL/i.test(String(error?.message))) throw error;
    waStartLiteMap();
  }
}
'''


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one atlas source match: {old[:96]}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, value):
    a = text.index(start)
    b = text.index(end, a + len(start))
    return text[:a] + value + text[b:]


def write_hashed(assets, stem, suffix, data):
    name = f"{stem}-{hashlib.sha256(data).hexdigest()[:12]}.{suffix}"
    (assets / name).write_bytes(data)
    return name


def patch_forecast(app, assets, transport):
    imports = f'import {{fetchPointForecast as Rv, readGfsIndex}} from "./{transport}";\n'
    worker, = assets.glob("live.worker-*.js")
    work = worker.read_text()
    work = replace_between(work, 'async function nt(', 'async function E(',
        'async function nt(e,t,n=!1){const s=V(e,t,n)+".idx";let p=B.get(s);'
        'if(!p){p=readGfsIndex(s).catch(error=>{B.delete(s);throw error});'
        'B.set(s,p);p.then(value=>{if(!value)B.delete(s)},()=>{});}return p;}')
    work = replace_once(work,
        'm=await fetch(V(e,t,o),{headers:{Range:`bytes=${w}-${i}`},signal:s});'
        'if(!m.ok)throw new Error(`GFS download failed (${m.status})`);const N=W(new Uint8Array(await m.arrayBuffer()));',
        'm=await readGfsRange(V(e,t,o),w,i,s);const N=W(new Uint8Array(m));')
    work = replace_between(work, 'function rt(e){', 'function ct(',
        'function rt(e){const url=e+".idx";let value=Y.get(url);if(!value){'
        'value=readForecastResponse(url,readForecastIndex,{timeout:5500}).catch(()=>null);Y.set(url,value);'
        'value.then(rows=>{if(!rows)Y.delete(url)});}return value;}')
    work = replace_once(work, 'M=await fetch(r,{headers:{Range:`bytes=${c[h][1]}-${u}`}});if(!M.ok)continue;'
        'const[d]=W(new Uint8Array(await M.arrayBuffer()))',
        'M=await readForecastRange(r,+c[h][1],u).catch(()=>null);if(!M)continue;const[d]=W(new Uint8Array(M))')
    worker_imports = f'import {{readGfsIndex,readGfsRange,readForecastIndex,readForecastRange,readForecastResponse}} from "./{transport}";\n'
    worker_name = write_hashed(assets, "live.worker-local", "js", (worker_imports + work).encode())
    app = replace_once(app, worker.name, worker_name)
    worker.unlink()

    # Merely opening historical mode should not start a forecast worker.
    app = replace_once(app, "pool=new Bv(2);", "pool=null;")
    if app.count("this.pool.request(") != 2:
        raise ValueError("Recheck live worker pool initialization")
    app = app.replace("this.pool.request(", "(this.pool??=new Bv(2)).request(")

    app = replace_between(app, 'async function mg(', 'const zv=', CYCLE_LOOKUP)
    app = replace_between(app, 'async function Rv(', 'function Og(', '')
    app = replace_once(app, 'this.pending.set(j,ae=>ae.error?ee(new Error(ae.error)):c(ae)),P.postMessage({id:j,cycle:I,fh:L,v:A,hrrr:R})',
        'const timer=setTimeout(()=>{this.pending.delete(j);ee(new Error("GFS worker timeout"));},45000);'
        'this.pending.set(j,ae=>{clearTimeout(timer);ae.error?ee(new Error(ae.error)):c(ae)});'
        'try{P.postMessage({id:j,cycle:I,fh:L,v:A,hrrr:R})}catch(error){clearTimeout(timer);this.pending.delete(j);ee(error)}')
    app = replace_once(app, 'this.layer=jh.find(L=>L.id===I),this.shown={a:"",b:"",alt:""},this.show(this.time,!0)',
        'this.layer=jh.find(L=>L.id===I),this.shown={a:"",b:"",alt:""},this.active&&this.show(this.time,!0)')
    app = replace_once(app, 'exit(){this.stop()}refreshUnits()', 'exit(){this.stop();this.waCardAbort?.abort()}refreshUnits()')
    app = replace_once(app, 'R?\x60起报时间：', 'this.c.waGridReady&&R?\x60起报时间：')
    app = replace_once(app, ':"正在加载…",be("br"),"点击地图任意地点查看当地预报。"))}',
        ':this.c.waGridError?"全球图层暂不可用："+this.c.waGridError:"正在加载全球图层…",'
        'be("br"),"点击地图或搜索城市可单独查看当地天气。",'
        'this.c.waFrameError?be("div",{},this.c.waFrameError):null,'
        'this.c.waGridError||this.c.waFrameError?be("button",{class:"chip",onclick:()=>this.c.waRetryGrid()},"重试全球图层"):null))}')
    app = replace_once(app, 'renderLegend(){const I=this.c.layer;', 'renderLegend(){if(!this.c.waGridReady){_n(this.els.legend);return}const I=this.c.layer;')
    app = replace_once(app, 'if(!L.cycle)return;const A=Math.round', 'if(!L.waGridReady||!L.cycle)return;const A=Math.round')
    app = replace_between(app, 'async showCard(I,L,A){const R=this.els.card,j=++this.cardToken', 'const Vg=36e5;', LIVE_CARD)
    app = replace_once(app, 'function $v(N,I){', 'function $v(N,I,gridSource){')
    app = replace_once(app, 'A<0&&(A=0);const R=N.hours[A],j=Math.abs(I-Date.now())<45*6e4,P=',
        'A<0&&(A=N.hours.length-1);const j=Math.abs(I-Date.now())<45*6e4,R=j&&N.current?N.current:N.hours[A],P=')
    app = replace_once(app, 'j?"现在":ul(R.t)))),be("h3",{},"未来 24 小时")',
        '`数据时刻：${Dh(R.t,L,{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}`))),'
        'be("h3",{},"未来 24 小时")')
    app = replace_once(app, 'Ht("rate",R.precip??0);return[', 'Number.isFinite(R.precip)?Ht("rate",R.precip):"—";return[')
    app = replace_once(app, '地点预报：Open-Meteo（按地点自动选择预报模式）', '地点天气：Open-Meteo（模式估计）')
    app = replace_once(app, '。地图预报：NOAA GFS。`', '。${gridSource?"地图预报：NOAA GFS。":""}`')
    app = replace_once(app, 'if(/abort|cancel/i.test(text))', 'if(/timeout/i.test(text))return"请求超时，请重试";'
        'if(/stale point forecast/i.test(text))return"没有足够新的地点天气数据";if(/abort|cancel/i.test(text))')

    # Queue clicks made before the coast, elevation and cities have loaded.
    # Point cards work as soon as the map is ready, regardless of grid status.
    app = replace_once(app, 'Jn,Zg=()=>{};const Wg=new Promise(N=>Zg=N);', 'Jn;')
    app = replace_between(app, 'async function Rp(N){', 'function gx(){', LIVE_BOOT)
    app = replace_once(app, 'gn.onStatus=(A,R)=>{Zr==="live"&&Vc(A,R,!R&&!!A)},',
        'gn.waRetryGrid=waActivateLive,gn.onStatus=(A,R)=>{if(Zr!=="live")return;'
        'if(!R&&(gn.waFrameError||A)&&gn.waGridReady){gn.waFrameError=A;ja.renderPanel();}Vc(A,R,!R&&!!A)},')
    app = replace_once(app, 'Jn.liveReady=Wg,', 'Jn.liveReady={then:(yes,no)=>waStartLive().then(ready=>{'
        'if(!ready)throw new Error("No recent GFS cycle found");}).then(yes,no)},')
    app = replace_between(app, 'const L=()=>gn.init().catch(', '}catch(N){console.error(N),Vc(`加载失败：',
        'await Rp(waRequestedMode??(new URL(location.href).searchParams.get("mode")==="live"?"live":"climate"))')
    return imports + app


def patch_data(app, assets, files, backup_revision):
    module = write_hashed(assets, "atlas-data", "js", (ROOT / "localization" / "atlas-data.js").read_bytes())
    table = {x["path"]: [x["bytes"], x["sha256"]] for x in files if x["path"].startswith("data/")}
    backup = f"https://cdn.jsdelivr.net/gh/xschen-beb/weather-atlas-zh-cn@{backup_revision}/" if backup_revision else None
    app = replace_between(app, "function waClimateWorker(workerUrl)", "const waZhMapLocale=", STATIC_DATA_GLUE)
    app = replace_once(app, 'const I=await mv(`${N}data/dem.bin`);', 'const I=await waReadDem(N);')
    app = replace_once(app, '(await(await fetch(`${N}data/cities.json`)).json()).rows',
                       '(await waDataJson(N,"data/cities.json")).rows')
    app = replace_once(app, 'const[N,I]=await Promise.all([gv(Lh),_v(Lh)]);',
        'const[N,I,coast,china]=await Promise.all([gv(Lh),_v(Lh),waDataJson(Lh,"data/coastline.json"),'
        'waDataJson(Lh,"data/china-map.geojson")]);qt.getSource("coast").setData(coast);qt.getSource("china-map").setData(china);')
    app = replace_once(app, 'qc.append(zp);function Vc(N,I=!0,L=!1,A){',
        'const waRetry=be("button",{class:"chip hidden",type:"button",style:"pointer-events:auto;margin-left:8px"},"重试");qc.append(waRetry,zp);'
        'function Vc(N,I=!0,L=!1,A,retry){waRetry.classList.toggle("hidden",!retry);waRetry.onclick=retry??null;')
    app = replace_once(app, 'Vc(`加载失败：${waZhError(N.message)}`,!1,!0)',
        'Vc(`加载失败：${waDataFailure(N)}`,!1,!0,void 0,()=>location.reload())')
    app = replace_once(app, 'this.setStatus(`气候数据暂不可用：${waZhError(I.message)}`,!1,!0);return',
        'this.active&&this.setStatus(`气候数据暂不可用：${waDataFailure(I)}`,!1,!0,void 0,()=>location.reload());return')
    app = replace_once(app, '.catch(j=>this.setStatus(`筛选计算失败：${waZhError(j.message)}`,!1,!0))',
        '.catch(j=>this.active&&this.setStatus(`气候筛选暂不可用：${waDataFailure(j)}`,!1,!0,void 0,()=>this.requery()))')
    app = replace_once(app, '),await this.ready;const[ae,oe]=',
        ');try{await this.ready}catch(error){if(this.cardAt?.[0]===I&&this.cardAt?.[1]===L)j.querySelector(".desc")?.replaceChildren('
        '`气候数据暂不可用：${waDataFailure(error)}`);return}const[ae,oe]=')
    app = replace_once(app,
        'j.append(be("button",{class:"chip",style:"margin-top:10px",onclick:()=>this.detail(I,L,fe,pe,[...Te,...we,"feels","tmax","tmin","precip","sun","cloud"]).then(De)},`+ 查看云量、露点、紫外线、风速、积雪及海温（${Fe.toFixed(1)} MB）`))',
        'j.append(waExtraClimateButton(()=>this.detail(I,L,fe,pe,[...Te,...we,"feels","tmax","tmin","precip","sun","cloud"]),De,Fe))')
    app = replace_once(app, 'j.querySelector(".desc")?.replaceChildren(`数据加载失败：${waZhError(Ee.message)}`)',
        'this.cardAt?.[0]===I&&this.cardAt?.[1]===L&&j.append(be("div",{class:"desc",role:"status"},'
        '`地点数据加载失败：${waDataFailure(Ee)}`),be("button",{class:"chip",onclick:()=>this.showCard(I,L,!1,R)},"重试地点数据"))')
    config = (
        f'import {{createAtlasDataReader}} from "./{module}";\n'
        f'const {{bytes:waDataBytes,json:waDataJson}}=createAtlasDataReader({json.dumps(table)},{json.dumps(backup)});\n'
    )
    return config + app


def build(output, backup_revision=None):
    if backup_revision and not re.fullmatch(r"[a-f0-9]{40}", backup_revision):
        raise ValueError("The backup must pin a full GitHub commit SHA")
    output = output.resolve()
    if output.exists() or output.is_relative_to(DIST):
        raise ValueError("Choose a new output directory outside dist")
    manifest = json.loads((ROOT / "active-manifest.json").read_text())
    # Export only files intended for publication, never Site identity/config.
    for entry in manifest["files"]:
        rel = Path(entry["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError("Invalid manifest path")
        src = DIST / rel
        data = src.read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"Runtime integrity check failed: {rel}")
        dst = output / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)

    entry, = (output / "assets").glob("index-zh-CN-*.js")
    app = entry.read_text()
    app = replace_once(app, 'style:nv(new URL(`${Lh}data/coastline.json`,location.href).href)',
                       'style:waLocalMapStyle(nv(new URL(`${Lh}data/coastline.json`,location.href).href))')
    app = replace_once(app, 'new pv(qt,A=>Ba.setLocalDem(A)),', '')
    app = replace_between(app, 'async function Lg(', 'class pv{', 'async function Lg(){return null}')
    app = replace_between(app, 'async function Bg(', 'const ka=120,',
        'async function Bg(N,I,L){const P=yv(L,N,I,35);return P?{name:Math.abs(P.lon-N)+Math.abs(P.lat-I)<1e-5?P.name:`${P.name}附近`,detail:P.country}:null}')
    app = replace_between(app, 'function mx(N){', 'async function Rp(N){',
        'function mx(N){if(qt.getLayer("water"))qt.setPaintProperty("water","fill-opacity",N==="live"?.18:.995)}')

    lite = ROOT / "localization"
    transport = write_hashed(entry.parent, "atlas-forecast", "js", (lite / "atlas-forecast.js").read_bytes())
    app = patch_forecast(app, entry.parent, transport)
    app = patch_data(app, entry.parent, manifest["files"], backup_revision)
    css_name = write_hashed(entry.parent, "atlas-lite", "css", (lite / "atlas-lite.css").read_bytes())
    lite_js = replace_once((lite / "atlas-lite.js").read_text(), "__LITE_STYLES__", css_name)
    lite_name = write_hashed(entry.parent, "atlas-lite", "js", lite_js.encode())
    boot = 'const Lh="./",Hc='
    app = replace_once(app, boot, "function waStartRichMap(){\n" + boot) + "\n}\n"
    app = LOCAL_STYLE + app + replace_once(START_MAP, "__LITE_MODULE__", lite_name)
    local_name = write_hashed(entry.parent, "index-zh-CN-local", "js", app.encode())
    html = (output / "index.html").read_text()
    html = replace_once(html, entry.name, local_name)
    html = replace_once(html, '>实时天气</button>', '>实时天气（联网）</button>')
    html = embed_startup(html, app, entry.parent, local_name, lite_name, css_name)
    (output / "index.html").write_text(html)
    entry.unlink()
    (output / ".nojekyll").touch()

    files = []
    for path in sorted(output.rglob("*")):
        if path.is_file():
            data = path.read_bytes()
            files.append({"path": path.relative_to(output).as_posix(), "bytes": len(data),
                          "sha256": hashlib.sha256(data).hexdigest()})
    (output / "mirror-manifest.json").write_text(json.dumps({"files": files}, indent=2) + "\n")
    print(f"Static mirror: {len(files)} files, {sum(x['bytes'] for x in files):,} bytes")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("output", type=Path, help="new directory for the exported site")
    cli.add_argument("--backup-revision", help="immutable public data revision for the optional CDN backup")
    args = cli.parse_args()
    build(args.output, args.backup_revision)
