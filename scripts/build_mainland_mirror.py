#!/usr/bin/env python3
"""Export the existing atlas as a static mirror with a same-origin base map."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

LOCAL_STYLE = r'''
function waLocalMapStyle(style) {
  // Keep layer anchors and the original China geometry. Historical maps need
  // only the bundled coastline, cities, elevation and climate files.
  delete style.glyphs;
  delete style.sources.dem;
  style.sources.omt={type:"geojson",data:{type:"FeatureCollection",features:[]}};
  style.layers=style.layers.map(layer=>{
    if(layer.id==="hillshade") return {id:"hillshade",type:"background",paint:{"background-opacity":0}};
    if(layer.source==="omt") delete layer["source-layer"];
    if(layer.id==="coastline-ne") delete layer.maxzoom;
    return layer;
  });
  return style;
}
'''

# Keep the original chart, table and ERA5 worker in both modes. Load the
# lightweight interface only on browsers that cannot start the full map.
START_MAP = r'''
function waStartLiteMap() {
  import(new URL("__LITE_MODULE__", import.meta.url).href).then(({startLite})=>startLite({
    base:new URL("./",location.href),
    loadCities:_v,loadElevation:gv,elevationAt:cl,nearestCity:yv,
    makeWorker:()=>waClimateWorker(new URL("climate.session.worker-b2d359a84de5.js",import.meta.url)),
    presets:vg,
    criteria:state=>Object.entries(state).map(([v,range])=>{
      const [lo,hi]=px(Gc.find(option=>option.v===v),range);
      return {v,lo,hi};
    }),
    renderDetails:(data,elev,state)=>[ex(data),ix(data,-1,state),lx(data),cx(data,elev)],
    describeError:waZhError,
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


def build(output):
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

    # Initialize the online forecast only when the visitor requests it.
    app = replace_once(app, 'const Wg=new Promise(N=>Zg=N);',
                       'let waStartLive=()=>Promise.resolve();const Wg=new Promise(N=>Zg=N);')
    app = replace_once(app, 'async function Rp(N){if(N===Zr)return;',
                       'async function Rp(N){if(N==="live")waStartLive();if(N===Zr)return;')
    app = replace_once(app, 'Jn.liveReady=Wg,', 'Jn.liveReady={then:(yes,no)=>waStartLive().then(yes,no)},')
    app = replace_once(app, 'const L=()=>gn.init().catch(', 'let waLivePromise;waStartLive=()=>waLivePromise??=gn.init().catch(')
    app = replace_once(app, '?(L(),await Rp("live")):(await Rp("climate"),L())',
                       '?await Rp("live"):await Rp("climate")')
    lite = ROOT / "localization"
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
    build(cli.parse_args().output)
