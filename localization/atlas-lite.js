// The static mirror can show historical and current point data without WebGL.
const svgNS = 'http://www.w3.org/2000/svg';
const views = {china: [70, -56, 70, 55], world: [-180, -86, 360, 172]};

function svg(tag, attrs = {}) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function linePath(lines) {
  return lines.map(line => line.map(([lon, lat], i) => `${i ? 'L' : 'M'}${lon},${-lat}`).join('')).join('');
}

async function json(base, path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function climateSession(makeWorker, base, onProgress) {
  const worker = makeWorker();
  const pending = new Map();
  let sequence = 0;
  let broken;
  const ready = new Promise((resolve, reject) => {
    function fail(error) {
      broken = error;
      reject(error);
      for (const {reject} of pending.values()) reject(error);
      pending.clear();
      worker.terminate();
    }
    worker.onmessage = ({data}) => {
      if (data.type === 'ready') resolve(data.meta);
      else if (data.type === 'progress') onProgress(data);
      else if (data.type === 'error' && data.id == null) fail(new Error(data.error));
      else if (pending.has(data.id)) {
        const {resolve, reject} = pending.get(data.id);
        pending.delete(data.id);
        if (data.type === 'error') reject(new Error(data.error));
        else resolve(data.result);
      }
    };
    worker.onerror = event => fail(new Error(event.message));
    worker.postMessage({type: 'init', base: base.href});
  });
  return {
    get broken() { return Boolean(broken); },
    async detail({lon, lat}, dem, crit) {
      const meta = await ready;
      if (broken) throw broken;
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {resolve, reject});
        worker.postMessage({type: 'detail', id, lon, lat, dem, crit, vars: Object.keys(meta.vars)});
      });
    },
  };
}

export function startLite(atlas) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('__LITE_STYLES__', import.meta.url).href;
  document.head.append(css);
  document.documentElement.classList.add('atlas-lite');

  const app = document.createElement('main');
  app.className = 'lite-shell';
  app.innerHTML = `
    <header class="lite-header">
      <h1>天气与气候地图</h1>
      <span>轻量版 · 历史气候</span>
    </header>
    <div class="lite-layout">
      <section class="lite-surface" aria-labelledby="lite-map-title">
        <div class="lite-map-tools">
          <h2 id="lite-map-title">气候地图</h2>
          <div class="lite-switch" role="group" aria-label="地图范围">
            <button type="button" data-view="china" aria-pressed="true">中国</button>
            <button type="button" data-view="world" aria-pressed="false">全球</button>
          </div>
        </div>
        <div class="lite-switch lite-modes" role="group" aria-label="查看内容">
          <button type="button" data-mode="climate" aria-pressed="true">历史气候</button>
          <button type="button" data-mode="live" aria-pressed="false">实时天气</button>
        </div>
        <div class="lite-search">
          <label for="lite-city">搜索城市</label>
          <input id="lite-city" type="search" placeholder="输入中文或英文，例如：北京" autocomplete="off" aria-describedby="lite-search-status" disabled>
          <p id="lite-search-status" role="status">正在加载城市列表…</p>
          <ul class="lite-matches" aria-label="城市搜索结果" hidden></ul>
        </div>
        <div class="lite-map-frame"></div>
        <p class="lite-map-hint" role="status">正在加载地图…</p>
      </section>
      <section class="lite-surface lite-card" aria-labelledby="lite-place">
        <p class="lite-kicker">ERA5 历史气候</p>
        <h2 id="lite-place">选择一个地点</h2>
        <p class="lite-place-meta">查看各月的气温、日照、降水等数据。</p>
        <label class="lite-preset">天气偏好 <select aria-label="天气偏好" disabled></select></label>
        <p class="lite-detail-status" role="status"></p>
        <button class="lite-retry" type="button" hidden>重试</button>
        <div class="lite-detail"></div>
      </section>
    </div>`;
  document.body.replaceChildren(app);

  const find = selector => app.querySelector(selector);
  const search = find('#lite-city');
  const searchStatus = find('#lite-search-status');
  const matches = find('.lite-matches');
  const mapHint = find('.lite-map-hint');
  const map = svg('svg', {class: 'lite-map', role: 'group', 'aria-label': '气候地图'});
  const baseLines = svg('g', {'aria-hidden': 'true'});
  const cityDots = svg('g', {'aria-label': '主要城市'});
  const pin = svg('circle', {r: '.65', class: 'lite-pin', visibility: 'hidden', 'aria-hidden': 'true'});
  map.append(baseLines, cityDots, pin);
  find('.lite-map-frame').append(map);
  const viewButtons = [...app.querySelectorAll('[data-view]')];
  const modeButtons = [...app.querySelectorAll('[data-mode]')];
  const place = find('#lite-place');
  const placeMeta = find('.lite-place-meta');
  const preset = find('.lite-preset select');
  const detailStatus = find('.lite-detail-status');
  const retry = find('.lite-retry');
  const details = find('.lite-detail');

  let view = 'china';
  let mode = 'climate';
  let mapReady = false;
  let cities = [];
  let selected;
  let seq = 0;
  let loading = false;
  let session;
  let demPromise;
  let weatherRequest;
  const progress = new Map();
  const normalize = text => text.normalize('NFKC').trim().toLowerCase();
  const coords = ({lon, lat}) => `${lat < 0 ? '南' : '北'}纬 ${Math.abs(lat).toFixed(2)}° · ${lon < 0 ? '西' : '东'}经 ${Math.abs(lon).toFixed(2)}°`;

  for (const {id, label, icon} of atlas.presets) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${icon} ${label}`;
    preset.append(option);
  }
  preset.addEventListener('change', showDetails);
  retry.addEventListener('click', showDetails);
  for (const button of modeButtons) button.addEventListener('click', () => switchMode(button.dataset.mode));

  function switchMode(next) {
    mode = next;
    const live = mode === 'live';
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    find('.lite-header span').textContent = live ? '轻量版 · 实时天气' : '轻量版 · 历史气候';
    find('.lite-kicker').textContent = live ? '地点天气与预报' : 'ERA5 历史气候';
    preset.parentElement.hidden = live;
    if (selected) void showDetails();
    else placeMeta.textContent = live ? '搜索城市或点选地图，查看当前天气和未来 24 小时预报。' : '查看各月的气温、日照、降水等数据。';
    if (mapReady) showMapHint();
    const url = new URL(location.href);
    if (live) url.searchParams.set('mode', 'live');
    else url.searchParams.delete('mode');
    history.replaceState(null, '', url);
  }
  function showMapHint() {
    mapHint.textContent = mode === 'live' ? '点击地图上的城市或任意位置，查看当地天气。' : '点击地图上的城市或任意位置，查看该地点的历史气候。';
  }
  if (new URL(location.href).searchParams.get('mode') === 'live') switchMode('live');

  function inView({lon, lat}, scope) {
    const [x, y, w, h] = views[scope];
    return lon >= x && lon <= x + w && -lat >= y && -lat <= y + h;
  }
  function drawView(scope) {
    view = scope;
    map.setAttribute('viewBox', views[scope].join(' '));
    for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === scope));
    const visible = cities.filter(c => inView(c, scope) && c.pop >= (scope === 'china' ? 1e6 : 4e6)).slice(0, 50);
    cityDots.replaceChildren(...visible.map(city => {
      const dot = svg('circle', {cx: city.lon, cy: -city.lat, r: scope === 'china' ? '.28' : '1.05',
        class: 'lite-dot', tabindex: 0, role: 'button', 'aria-label': city.name});
      const title = svg('title');
      title.textContent = city.name;
      dot.append(title);
      const choose = () => selectPoint(city);
      dot.addEventListener('click', event => { event.stopPropagation(); choose(); });
      dot.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      });
      return dot;
    }));
    if (selected) {
      pin.setAttribute('cx', selected.lon);
      pin.setAttribute('cy', -selected.lat);
      pin.setAttribute('r', scope === 'china' ? '.65' : '2');
    }
    pin.setAttribute('visibility', selected && inView(selected, scope) ? 'visible' : 'hidden');
  }
  for (const button of viewButtons) button.addEventListener('click', () => drawView(button.dataset.view));
  drawView(view);

  async function loadMap() {
    mapHint.textContent = '正在加载地图…';
    try {
      const [coast, boundaries] = await Promise.all([
        json(atlas.base, 'data/coastline.json'), json(atlas.base, 'data/china-map.geojson'),
      ]);
      const layers = [svg('path', {class: 'lite-coast', d: linePath(coast.geometry.coordinates)})];
      for (const feature of boundaries.features) {
        const kind = feature.properties.kind;
        if ((kind === 'outline' || kind === 'maritime-dashes') && feature.geometry.type === 'MultiLineString') {
          layers.push(svg('path', {class: `lite-${kind}`, d: linePath(feature.geometry.coordinates)}));
        }
      }
      baseLines.replaceChildren(...layers);
      mapReady = true;
      showMapHint();
    } catch (error) {
      retryResource(mapHint, `地图加载失败：${atlas.describeError(error.message)}`, loadMap);
    }
  }
  function retryResource(status, message, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '重试';
    button.addEventListener('click', action);
    status.replaceChildren(message, ' ', button);
  }
  async function loadCities() {
    searchStatus.textContent = '正在加载城市列表…';
    try {
      cities = (await atlas.loadCities(atlas.base.href)).map(city => ({
        ...city, terms: [city.name, ...city.aliases].map(normalize),
      }));
      search.disabled = false;
      searchStatus.textContent = '';
      drawView(view);
    } catch (error) {
      retryResource(searchStatus, `城市列表加载失败：${atlas.describeError(error.message)}`, loadCities);
    }
  }
  void loadMap();
  void loadCities();

  function clearSearch() {
    matches.replaceChildren();
    matches.hidden = true;
    searchStatus.textContent = '';
  }
  search.addEventListener('input', () => {
    clearSearch();
    const query = normalize(search.value);
    if (!query) return;
    const score = term => term === query ? 3 : term.startsWith(query) ? 2 : term.includes(query) ? 1 : 0;
    const results = cities.map(city => ({city, rank: Math.max(...city.terms.map(score))}))
      .filter(item => item.rank).sort((a, b) => b.rank - a.rank || b.city.pop - a.city.pop).slice(0, 8);
    if (!results.length) {
      searchStatus.textContent = '未找到城市，可直接点选地图。';
      return;
    }
    for (const {city} of results) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      const region = document.createElement('small');
      button.type = 'button';
      region.textContent = city.country;
      button.append(city.name, region);
      button.addEventListener('click', () => {
        search.value = city.name;
        clearSearch();
        selectPoint(city);
      });
      li.append(button);
      matches.append(li);
    }
    matches.hidden = false;
    searchStatus.textContent = `找到 ${results.length} 个搜索结果。`;
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') clearSearch();
    if (event.key === 'Enter' && !matches.hidden) {
      event.preventDefault();
      matches.querySelector('button')?.click();
    }
  });
  map.addEventListener('click', event => {
    const matrix = map.getScreenCTM();
    if (!mapReady || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const p = {lon: point.x, lat: -point.y};
    if (!inView(p, view)) return;
    const nearest = atlas.nearestCity(cities, p.lon, p.lat, 35);
    selectPoint({...p, name: nearest ? `${nearest.name}附近` : '所选地点', country: nearest?.country});
  });

  function selectPoint(point) {
    selected = point;
    drawView(inView(point, view) ? view : 'world');
    place.textContent = point.name;
    placeMeta.textContent = [point.country, coords(point)].filter(Boolean).join(' · ');
    preset.disabled = false;
    if (matchMedia('(max-width: 820px)').matches) find('.lite-card').scrollIntoView({block: 'start'});
    void showDetails();
  }
  function onProgress({v, loaded, total}) {
    progress.set(v, [loaded, total]);
    if (!loading || mode !== 'climate') return;
    const bytes = [...progress.values()].reduce((sum, [n]) => sum + n, 0);
    detailStatus.textContent = `正在下载历史气候数据… ${(bytes / 1e6).toFixed(1)} MB`;
  }
  async function showDetails() {
    if (!selected) return;
    const point = selected;
    const id = ++seq;
    const live = mode === 'live';
    weatherRequest?.abort();
    weatherRequest = live ? new AbortController() : undefined;
    loading = true;
    retry.hidden = true;
    detailStatus.textContent = live ? '正在加载当地天气…' : '正在加载历史气候数据…';
    details.setAttribute('aria-busy', 'true');
    details.replaceChildren();
    try {
      if (live) {
        const weather = await atlas.loadWeather(point.lat, point.lon, weatherRequest.signal);
        if (id !== seq) return;
        details.append(...atlas.renderWeather(weather));
        detailStatus.textContent = '';
        return;
      }
      const state = atlas.presets.find(item => item.id === preset.value).state;
      let elev = point.elev;
      if (!Number.isFinite(elev)) {
        demPromise ??= atlas.loadElevation(atlas.base.href).catch(error => { demPromise = undefined; throw error; });
        elev = atlas.elevationAt(await demPromise, point.lon, point.lat);
      }
      if (id !== seq) return;
      if (!session || session.broken) {
        progress.clear();
        session = climateSession(atlas.makeWorker, atlas.base, onProgress);
      }
      const data = await session.detail(point, elev, atlas.criteria(state));
      if (id !== seq) return;
      const [summary, chart, table, note] = atlas.renderDetails(data, elev, state);
      const scroller = document.createElement('div');
      scroller.className = 'lite-table';
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', '各月气候数据');
      scroller.append(table);
      details.append(summary, chart, scroller, note);
      detailStatus.textContent = '';
    } catch (error) {
      if (id !== seq) return;
      detailStatus.textContent = `${live ? '地点天气暂不可用' : '数据加载失败'}：${atlas.describeError(error.message)}`;
      retry.hidden = false;
    } finally {
      if (id === seq) {
        loading = false;
        details.removeAttribute('aria-busy');
      }
    }
  }
}
