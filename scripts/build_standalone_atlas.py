#!/usr/bin/env python3
"""Embed a verified static release's data into one portable map HTML file."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re


ACCESSOR = '''<script>
globalThis.waReadEmbeddedData=path=>{
  const packed=document.getElementById("atlas-local:"+path);
  if(!packed)throw new Error("Local map data not found");
  if(Uint8Array.fromBase64)return Uint8Array.fromBase64(packed.textContent).buffer;
  const source=atob(packed.textContent), bytes=new Uint8Array(source.length);
  for(let i=0;i<source.length;i++)bytes[i]=source.charCodeAt(i);
  return bytes.buffer;
};
</script>'''


def build(site, output):
    manifest = json.loads((site / "mirror-manifest.json").read_text())
    html = (site / "index.html").read_text()
    if 'id="atlas-startup-code"' not in html or html.count("</body>") != 1:
        raise ValueError("Expected the self-contained startup from a mainland mirror build")

    blocks = [ACCESSOR]
    for entry in manifest["files"]:
        name = entry["path"]
        if not name.startswith("data/"):
            continue
        if not re.fullmatch(r"data/[a-z0-9][a-z0-9/.\-]*", name) or ".." in Path(name).parts:
            raise ValueError(f"Invalid static data path: {name}")
        raw = (site / name).read_bytes()
        if len(raw) != entry["bytes"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise ValueError(f"Runtime integrity check failed: {name}")
        packed = base64.b64encode(raw).decode("ascii")
        blocks.append(f'<script type="application/octet-stream" id="atlas-local:{name}">{packed}</script>')

    output.write_text(html.replace("</body>","\n".join(blocks)+"\n</body>"),encoding="utf-8")
    print(f"Standalone atlas: {len(blocks)-1} data files, {output.stat().st_size:,} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site",type=Path,help="verified static release directory")
    parser.add_argument("output",type=Path,help="HTML file to write")
    args = parser.parse_args()
    build(args.site,args.output)
