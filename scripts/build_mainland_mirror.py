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


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one atlas source match: {old[:96]}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, value):
    a = text.index(start)
    b = text.index(end, a + len(start))
    return text[:a] + value + text[b:]


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
    app = LOCAL_STYLE + app
    encoded = app.encode()
    local_name = f"index-zh-CN-local-{hashlib.sha256(encoded).hexdigest()[:12]}.js"
    (entry.parent / local_name).write_bytes(encoded)
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
