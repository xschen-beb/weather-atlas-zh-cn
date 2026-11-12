const ORIGIN = 'https://tiles.openfreemap.org';
const SOURCE = 'atlas-vector-details';
const TILE = 'atlasvector://{z}/{x}/{y}';
const ADMIN = 'atlas-local-admin';
const PHYSICAL = 'atlas-local-physical';
const DETAIL = new Set(['roads', 'waterway', 'water', 'coastline']);
const LOCAL_ADMIN = new Set(['boundary-country', 'boundary-state', 'place-country', 'place-state', 'water-name']);
const LOCAL_PHYSICAL = new Set(['roads', 'waterway']);
const blank = () => ({type:'FeatureCollection',features:[]});

function unpack(data) {
  const features = [];
  for (const [kind, lines] of Object.entries(data.lines || {})) {
    for (const [minzoom, deltas] of lines) {
      let x = 0, y = 0;
      const coordinates = [];
      for (let i = 0; i < deltas.length; i += 2) {
        coordinates.push([(x += deltas[i]) / 10000, (y += deltas[i+1]) / 10000]);
      }
      features.push({type:'Feature', properties:{kind,minzoom}, geometry:{type:'LineString',coordinates}});
    }
  }
  for (const [kind, names] of Object.entries(data.labels || {})) {
    for (const [name, x, y, minzoom] of names) {
      features.push({type:'Feature',properties:{kind,name,minzoom},geometry:{type:'Point',coordinates:[x,y]}});
    }
  }
  return {type:'FeatureCollection',features};
}

async function remote(url, signal, timeout, consume) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  const timer = setTimeout(cancel,timeout);
  try {
    const response = await fetch(url,{signal:controller.signal,credentials:'omit',redirect:'error'});
    if (!response.ok) {
      void response.body?.cancel().catch(()=>{});
      throw new Error(`Basemap HTTP ${response.status}`);
    }
    return await consume(response);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',cancel);
  }
}

export function createAtlasBasemap() {
  const detailLayers = [];

  function style(base) {
    // Keep the original style and layer positions. Only approved, separately
    // prepared local data may draw administrative lines in this map.
    base.sources[ADMIN] = {type:'geojson',data:blank(),maxzoom:9};
    base.sources[PHYSICAL] = {type:'geojson',data:blank(),maxzoom:9};
    for (const layer of base.layers) {
      if (layer.source !== 'omt') continue;
      const id = layer.id;
      if (DETAIL.has(id)) detailLayers.push(structuredClone(layer));
      const source = LOCAL_ADMIN.has(id) ? ADMIN : LOCAL_PHYSICAL.has(id) ? PHYSICAL : null;
      if (!source) continue;
      layer.source = source;
      delete layer['source-layer'];
      layer.filter = ['all',['==',['get','kind'],id],['<=',['get','minzoom'],['zoom']]];
      if (layer.type === 'symbol') {
        layer.layout['text-field'] = ['get','name'];
        layer.layout['text-transform'] = 'none';
        layer.layout['symbol-sort-key'] = ['get','minzoom'];
      }
    }
    return base;
  }

  function setWeatherMode(map, mode) {
    const id = 'atlas-detail-water';
    if (map.getLayer(id)) map.setPaintProperty(id,'fill-opacity',mode === 'live' ? .12 : .995);
  }

  function start(map, register, read) {
    let template, adminPending, physicalPending, detailPending;
    let adminReady = false, physicalReady = false, connected = false, degraded = false, alive = true;
    let nextAdmin = 0, nextPhysical = 0, nextDetail = 0, nextReload = 0, revision = 0;
    let fallbackTimer;

    function local(source, path) {
      return read(path).then(data=>{
        if (alive) map.getSource(source)?.setData(unpack(data));
        return data;
      });
    }

    function loadAdmin() {
      if (!alive || adminReady || adminPending || Date.now() < nextAdmin) return;
      adminPending = local(ADMIN,'data/basemap-admin.json.gz').then(()=>{ adminReady = true; })
        .catch(()=>{ nextAdmin = Date.now() + 15000; }).finally(()=>{ adminPending = undefined; });
    }

    function loadPhysical() {
      if (!alive || physicalReady || physicalPending || Date.now() < nextPhysical) return;
      physicalPending = local(PHYSICAL,'data/basemap-physical.json.gz').then(()=>{ physicalReady = true; })
        .catch(()=>{ nextPhysical = Date.now() + 15000; }).finally(()=>{ physicalPending = undefined; });
    }

    function updateFallback() {
      if (!alive) return;
      const fallback = !connected || degraded;
      for (const id of LOCAL_PHYSICAL) {
        const visibility = fallback ? 'visible' : 'none';
        if (map.getLayoutProperty(id,'visibility') !== visibility) map.setLayoutProperty(id,'visibility',visibility);
      }
      if (fallback && map.getZoom() >= 6) loadPhysical();
    }

    register(async (request, abortController)=>{
      const match = /^atlasvector:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
      if (!template || !match) return {data:new ArrayBuffer(0)};
      const id = revision;
      const url = template.replace('{z}',match[1]).replace('{x}',match[2]).replace('{y}',match[3]);
      try {
        const data = await remote(url,abortController?.signal,8500,async response=>{
          const type = response.headers.get('content-type') || '';
          if (!/protobuf|mapbox-vector-tile|octet-stream/i.test(type)) throw new Error('Unexpected basemap response');
          return response.arrayBuffer();
        });
        if (id === revision && data.byteLength && !connected) {
          connected = true;
          queueMicrotask(updateFallback);
        }
        return {data};
      } catch (error) {
        if (abortController?.signal.aborted) throw error;
        if (id === revision && !degraded) {
          degraded = true;
          queueMicrotask(updateFallback);
        }
        // A map tile is optional; the local map and original weather field stay mounted.
        return {data:new ArrayBuffer(0)};
      }
    });

    function loadDetails() {
      if (!alive || map.getZoom() < 5 || detailPending || map.getSource(SOURCE) || Date.now() < nextDetail) return;
      detailPending = remote(`${ORIGIN}/planet`,undefined,7000,r=>r.json()).then(meta=>{
        const valid = /^https:\/\/tiles\.openfreemap\.org\/planet\/[\w.-]+\/\{z\}\/\{x\}\/\{y\}\.pbf$/;
        template = Array.isArray(meta.tiles) ? meta.tiles.find(url=>typeof url === 'string' && valid.test(url)) : undefined;
        const available = new Set((meta.vector_layers || []).map(layer=>layer.id));
        if (!template || !['transportation','waterway','water'].every(id=>available.has(id))) throw new Error('Invalid basemap TileJSON');
        if (!alive) return;
        map.addSource(SOURCE,{type:'vector',tiles:[TILE],minzoom:0,maxzoom:Math.min(14,Number(meta.maxzoom)||14)});
        for (const layer of detailLayers) {
          if (!available.has(layer['source-layer'])) continue;
          const details = {...layer,id:`atlas-detail-${layer.id}`,source:SOURCE};
          if (layer.id === 'water') details.minzoom = 5;
          map.addLayer(details,layer.id);
        }
        setWeatherMode(map,map.getPaintProperty('water','fill-opacity') < .5 ? 'live' : 'climate');
      }).catch(()=>{
        nextDetail = Date.now() + 12000;
        updateFallback();
      }).finally(()=>{ detailPending = undefined; });
    }

    function refresh() {
      if (!alive) return;
      loadAdmin();
      loadDetails();
      const source = map.getSource(SOURCE);
      const now = Date.now();
      if (source && degraded && now >= nextReload && map.getZoom() >= 5) {
        nextReload = now + 20000;
        revision++;
        connected = degraded = false;
        updateFallback();
        source.setTiles([TILE]);
      }
      clearTimeout(fallbackTimer);
      if (map.getZoom() >= 6 && !physicalReady) fallbackTimer = setTimeout(updateFallback,1800);
    }
    map.on('moveend',refresh);
    window.addEventListener('online',refresh);
    map.once('remove',()=>{
      alive = false;
      clearTimeout(fallbackTimer);
      window.removeEventListener('online',refresh);
    });
    refresh();
  }

  return {style,start,setWeatherMode};
}
