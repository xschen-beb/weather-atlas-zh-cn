#!/usr/bin/env python3
"""Collect the public runtime of Weather Atlas, preserving served asset bytes."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://weather.theojaffee.net/"


def fetch(path: str) -> tuple[bytes, dict]:
    for attempt in range(3):
        try:
            request = urllib.request.Request(ORIGIN + path, headers={"User-Agent": "WeatherAtlas-Reproduction/1.0"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
                headers = dict(response.headers.items())
            if path and headers.get("Content-Type", "").startswith("text/html"):
                raise RuntimeError("Expected an asset, received HTML")
            return data, headers
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("unreachable")


def save(path: str, dist: Path) -> dict:
    data, headers = fetch(path)
    destination = dist / (path or "index.html")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return {"path": path or "index.html", "url": ORIGIN + path, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "content_type": headers.get("Content-Type")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    dist = args.dist.resolve()
    dist.mkdir(parents=True, exist_ok=True)
    records = [save("", dist)]
    html = (dist / "index.html").read_text()
    asset_paths = sorted(set(re.findall(r'(?:src|href)="\./(assets/[^\"]+)"', html)))
    for path in asset_paths:
        records.append(save(path, dist))
    worker_paths = set()
    for path in asset_paths:
        if path.endswith(".js"):
            for name in re.findall(r'new URL\("([^\"]+\.js)"', (dist / path).read_text()):
                worker_paths.add("assets/" + name)
    meta_path = "data/climate/meta.json"
    records.append(save(meta_path, dist))
    metadata = json.loads((dist / meta_path).read_text())
    paths = sorted(worker_paths | {
        "data/cities.json", "data/coastline.json", "data/dem.bin", "data/climate/cells.bin",
        *("data/climate/" + item["file"] for item in metadata["vars"].values()),
    })
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(save, path, dist): path for path in paths}
        for future in concurrent.futures.as_completed(futures):
            record = future.result()
            records.append(record)
            print(f"Downloaded {record['path']}: {record['bytes']:,} bytes", flush=True)
    manifest = {"origin": ORIGIN, "retrieved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "kind": "public deployment snapshot, not original authoring source",
                "files": sorted(records, key=lambda item: item["path"])}
    (ROOT / "snapshot-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Snapshot: {len(records)} files, {sum(item['bytes'] for item in records):,} bytes", flush=True)


if __name__ == "__main__":
    main()
