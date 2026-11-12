#!/usr/bin/env python3
"""Regenerate the Natural Earth mask (pyshp 2.3.1 and shapely 2.1.2)."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import zipfile

import shapefile
from shapely import box, make_valid, orient_polygons, set_precision
from shapely.geometry import shape


SOURCES = {
    "ocean": "db626fcd5d50b096b156c78a2cc95011b39f32a61b4e47d147e3f7a77b8b2719",
    "lakes": "0803a06f9c3cb4671d89b68c48b142aad9366ba40f665245e12a913fbc61722a",
}


def encode_ring(ring):
    previous_x = previous_y = 0
    deltas = []
    for lon, lat in ring.coords:
        x, y = round(lon * 10_000), round(lat * 10_000)
        deltas.extend((x - previous_x, y - previous_y))
        previous_x, previous_y = x, y
    return deltas


def build(source_dir, output):
    polygons = []
    world = box(-180, -85.05112878, 180, 85.05112878)
    for name, sha in SOURCES.items():
        src = source_dir / f"ne_10m_{name}.zip"
        if hashlib.sha256(src.read_bytes()).hexdigest() != sha:
            raise ValueError(f"Unexpected Natural Earth archive: {src}")
        with zipfile.ZipFile(src) as archive, archive.open(f"ne_10m_{name}.shp") as shp:
            for item in shapefile.Reader(shp=shp).iterShapes():
                geom = shape(item.__geo_interface__)
                if not geom.is_valid:
                    geom = make_valid(geom, method="structure", keep_collapsed=False)
                if name == "ocean":
                    geom = geom.intersection(world)
                geom = orient_polygons(set_precision(geom.simplify(.002, preserve_topology=True), .0001))
                if not geom.is_empty:
                    if geom.geom_type not in {"Polygon", "MultiPolygon"}:
                        raise ValueError(f"Unexpected water geometry: {geom.geom_type}")
                    for poly in geom.geoms if geom.geom_type == "MultiPolygon" else (geom,):
                        polygons.append([encode_ring(poly.exterior), *(encode_ring(ring) for ring in poly.interiors)])
    data = json.dumps(polygons, separators=(",", ":")).encode()
    output.write_bytes(gzip.compress(data, mtime=0))
    print(f"{len(polygons):,} water polygons, {output.stat().st_size:,} compressed bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path, help="directory containing ne_10m_ocean.zip and ne_10m_lakes.zip")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.source_dir, args.output)
