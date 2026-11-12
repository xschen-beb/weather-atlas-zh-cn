#!/usr/bin/env python3
"""Pack the optional static basemap (pyshp 2.3.1 and shapely 2.1.2)."""

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
from pathlib import Path
import zipfile

import shapefile
from shapely import line_merge, make_valid, set_precision, union_all
from shapely.geometry import Point, shape


MAPS = Path(__file__).resolve().parents[1] / "localization/maps"
SOURCES = {
    "roads": "880b235383a1e1ccf33f4ea6f82b6755a2ffbce07e3974e412b43e88fe954ae9",
    "rivers_lake_centerlines": "ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38",
    "countries": "5fed433373581fa648920435f937d95f2d3c0200e067409c6478dcdf1b853139",
    "country-lines": "16ead035f539c8b6c23650c5845d86ad3556553e7456bdf9b4730210f26aacbe",
    "state-lines": "86acd56ce6c0e47f5fa79725591533b5766f26d6ed1437b086f2b8d4028fe456",
    "state-areas": "efc59726337323058f9446210adc96673179cd344e053666ee3d28cb58ba2b05",
}
CHINA_CODES = {"CH1", "CHN", "TWN", "HKG", "MAC"}
NO_PROVINCE_LABEL = {"710000", "810000", "820000"}
OCEANS = [
    ["太平洋", 165, 0, 0], ["太平洋", -146, 5, 0], ["大西洋", -37, 12, 0],
    ["印度洋", 79, -17, 0], ["北冰洋", -15, 78, 1], ["南大洋", 42, -58, 1],
]


@contextmanager
def reader(directory, name):
    path = directory / f"{name}.zip"
    if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCES[name]:
        raise ValueError(f"Unexpected source archive: {path}")
    with zipfile.ZipFile(path) as archive:
        stem = next(n[:-4] for n in archive.namelist() if n.endswith(".shp"))
        with archive.open(stem + ".shp") as shp, archive.open(stem + ".dbf") as dbf:
            yield shapefile.Reader(shp=shp, dbf=dbf)


def encode_line(geometry, tolerance, zoom, destination):
    geom = geometry.simplify(tolerance, preserve_topology=True)
    if geom.geom_type in {"MultiLineString", "GeometryCollection"}:
        for part in geom.geoms:
            encode_line(part, 0, zoom, destination)
    elif geom.geom_type == "LineString" and not geom.is_empty:
        x = y = 0
        deltas = []
        for lon, lat in geom.coords:
            a, b = round(lon * 10_000), round(lat * 10_000)
            if not deltas or (x, y) != (a, b):
                deltas.extend((a - x, b - y))
                x, y = a, b
        if len(deltas) >= 4:
            destination.append([zoom, deltas])


def china_provinces():
    features = json.loads((MAPS / "china-standard.geojson").read_bytes())["features"]
    return [(f["properties"], make_valid(shape(f["geometry"]))) for f in features
            if f["geometry"]["type"] in {"Polygon", "MultiPolygon"}]


def administrative(directory):
    provinces = china_provinces()
    # Suppress third-party administrative geometry around the vetted outlines.
    guard = set_precision(union_all([p for _, p in provinces]).buffer(.22).simplify(.055), .0001)
    data = {"lines": {"boundary-country": [], "boundary-state": []},
            "labels": {"place-country": [], "place-state": [], "water-name": OCEANS}}
    labels = data["labels"]
    lines = data["lines"]
    for i, (props, poly) in enumerate(provinces):
        if props["code"] in NO_PROVINCE_LABEL:
            continue
        largest = max(poly.geoms, key=lambda p: p.area) if poly.geom_type == "MultiPolygon" else poly
        anchor = largest.representative_point()
        labels["place-state"].append([props["name"], round(anchor.x, 4), round(anchor.y, 4), 4])
        for other, neighbor in provinces[:i]:
            if other["code"] not in NO_PROVINCE_LABEL:
                shared = line_merge(poly.boundary.intersection(neighbor.boundary))
                encode_line(shared, .004, 3, lines["boundary-state"])

    with reader(directory, "country-lines") as dataset:
        for item in dataset.iterShapeRecords(fields=["FEATURECLA", "ADM0_A3_L", "ADM0_A3_R"]):
            row = item.record.as_dict()
            if item.shape.points and row["FEATURECLA"] == "International boundary (verify)" and not CHINA_CODES.intersection((row["ADM0_A3_L"], row["ADM0_A3_R"])):
                encode_line(shape(item.shape.__geo_interface__).difference(guard), .012, 0, lines["boundary-country"])
    with reader(directory, "state-lines") as dataset:
        for item in dataset.iterShapeRecords(fields=["FEATURECLA", "ADM0_A3", "SOV_A3", "MIN_ZOOM"]):
            row = item.record.as_dict()
            if item.shape.points and row["FEATURECLA"] == "Admin-1 boundary" and not CHINA_CODES.intersection((row["ADM0_A3"], row["SOV_A3"])):
                zoom = min(8, max(3, round(row["MIN_ZOOM"] or 3)))
                encode_line(shape(item.shape.__geo_interface__).difference(guard), .018, zoom, lines["boundary-state"])

    translated = json.loads((MAPS.parent / "country-names.zh-CN.json").read_bytes())
    fields = ["NAME_EN", "NAME_ZH", "ADMIN", "ADM0_A3", "SOV_A3", "ISO_A2", "TYPE", "LABEL_X", "LABEL_Y", "MIN_LABEL"]
    with reader(directory, "countries") as dataset:
        for record in dataset.iterRecords(fields=fields):
            row = record.as_dict()
            if row["ADM0_A3"] in CHINA_CODES or row["SOV_A3"] in CHINA_CODES or row["ISO_A2"] in {"CN", "TW", "HK", "MO"}:
                continue
            if row["TYPE"] not in {"Sovereign country", "Country", "Sovereignty"}:
                continue
            name = translated.get(row["NAME_EN"]) or translated.get(row["ADMIN"]) or row["NAME_ZH"]
            if name and row["LABEL_X"] is not None and abs(row["LABEL_Y"]) <= 85:
                labels["place-country"].append([name, round(row["LABEL_X"], 4), round(row["LABEL_Y"], 4), max(0, min(6, row["MIN_LABEL"] or 0))])
    labels["place-country"].append(["中国", 104, 35, 0])

    with reader(directory, "state-areas") as dataset:
        fields = ["name_zh", "longitude", "latitude", "scalerank", "adm0_a3", "sov_a3"]
        for record in dataset.iterRecords(fields=fields):
            row = record.as_dict()
            x, y = row["longitude"], row["latitude"]
            if not row["name_zh"] or x is None or y is None or not (-180 <= x <= 180 and abs(y) <= 85):
                continue
            if CHINA_CODES.intersection((row["adm0_a3"], row["sov_a3"])) or guard.covers(Point(x, y)):
                continue
            zoom = 4 + max(0, (row["scalerank"] or 4) - 6) * .5
            labels["place-state"].append([row["name_zh"], round(x, 4), round(y, 4), zoom])
    return data


def physical(directory):
    lines = {"roads": [], "waterway": []}
    with reader(directory, "roads") as dataset:
        for item in dataset.iterShapeRecords(fields=["type", "sov_a3", "scalerank"]):
            row = item.record.as_dict()
            if item.shape.points and (row["type"] == "Major Highway" or (row["type"] in {"Road", "Unknown", "Secondary Highway"}
                    and row["scalerank"] <= (7 if row["sov_a3"] in CHINA_CODES else 5))):
                encode_line(shape(item.shape.__geo_interface__), .004, 6, lines["roads"])
    with reader(directory, "rivers_lake_centerlines") as dataset:
        for item in dataset.iterShapeRecords(fields=["featurecla"]):
            if item.shape.points and item.record[0] in {"River", "River (Intermittent)", "Canal"}:
                encode_line(shape(item.shape.__geo_interface__), .004, 6, lines["waterway"])
    return {"lines": lines}


def write(data, path):
    packed = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(gzip.compress(packed, mtime=0))
    print(f"{path.name}: {path.stat().st_size:,} compressed bytes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path, help="directory containing the verified Natural Earth source archives")
    parser.add_argument("output_dir", type=Path, nargs="?", default=MAPS)
    args = parser.parse_args()
    write(administrative(args.source_dir), args.output_dir / "basemap-admin.json.gz")
    write(physical(args.source_dir), args.output_dir / "basemap-physical.json.gz")
