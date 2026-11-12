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
PRECISION = .0001
MAX_SPAN = 22.5
MAX_HOLES = 64
MAX_VERTICES = 12_000


def polygon_parts(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == "Polygon":
        yield geometry
    elif geometry.geom_type in {"MultiPolygon", "GeometryCollection"}:
        for part in geometry.geoms:
            yield from polygon_parts(part)


def renderable_parts(poly):
    """Partition large water features before the browser's tile clipping."""
    west, south, east, north = poly.bounds
    width, height = east - west, north - south
    vertices = len(poly.exterior.coords) + sum(len(r.coords) for r in poly.interiors)
    if max(width, height) <= MAX_SPAN and len(poly.interiors) <= MAX_HOLES and vertices <= MAX_VERTICES:
        yield poly
        return

    # A single world ocean feature otherwise makes tile clipping/triangulation
    # join thousands of land holes to tile edges, occasionally filling land.
    # Snap the two cuts to the same coordinate lattice so adjacent pieces meet.
    if width >= height:
        middle = round((west + east) / 2, 4)
        if not west < middle < east:
            raise ValueError("Water polygon cannot be subdivided further")
        tiles = (box(west, south, middle, north), box(middle, south, east, north))
    else:
        middle = round((south + north) / 2, 4)
        if not south < middle < north:
            raise ValueError("Water polygon cannot be subdivided further")
        tiles = (box(west, south, east, middle), box(west, middle, east, north))
    for tile in tiles:
        for part in polygon_parts(poly.intersection(tile, grid_size=PRECISION)):
            yield from renderable_parts(part)


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
                geom = set_precision(geom.simplify(.002, preserve_topology=True), PRECISION)
                for part in polygon_parts(geom):
                    for poly in renderable_parts(part):
                        poly = orient_polygons(poly)
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
