#!/usr/bin/env python3
"""Rebuild the map overlay from the preserved source. Requires shapely>=2."""
import json
from pathlib import Path
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely import make_valid
p=Path(__file__).resolve().parents[1]
j=json.loads((p/'localization/maps/china-standard.geojson').read_text())
polys=[make_valid(shape(f['geometry'])) for f in j['features'] if f['geometry']['type']=='MultiPolygon']
outline=unary_union(polys).boundary.simplify(.0002,preserve_topology=True)
dash=next(f for f in j['features'] if f['geometry']['type']=='MultiLineString' and len(f['geometry']['coordinates'])==10)
features=[{'type':'Feature','properties':{'kind':'outline','name':'中国'},'geometry':mapping(outline)},dict(dash,properties={'kind':'maritime-dashes','name':'南海断续线'})]
for name,xy in [('中国台湾省',[120.97,23.8]),('中国香港特别行政区',[114.17,22.32]),('中国澳门特别行政区',[113.55,22.19])]:
 features.append({'type':'Feature','properties':{'kind':'region-label','name':name},'geometry':{'type':'Point','coordinates':xy}})
(p/'dist/data/china-map.geojson').write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False,separators=(',',':'))+'\n')
print('Map overlay rebuilt from preserved source.')
