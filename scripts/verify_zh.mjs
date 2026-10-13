import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
assert(html.includes('lang="zh-CN"'));
assert(!/Climate finder|Live weather|Search a city|Controls/.test(html));
const bundlePath = html.match(/src="\.\/([^\"]+\.js)"/)[1];
const source = await fs.readFile(path.join(dist, bundlePath), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {};
    this.events = {}; this._text = ''; this.className = ''; this.value = ''; this.scrollTop = 0;
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  append(...children) { for (const child of children) if (child !== null && child !== undefined) { this.children.push(child); if (typeof child === 'object') child.parentNode = this; } }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0]; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); if (name === 'value') this.value = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, handler) { this.events[type] = handler; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 348, height: 117 }; }
}
const document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
                   body: new Element('body'), addEventListener() {}, querySelector: () => new Element('div') };
const context = vm.createContext({ H0: {}, Z0: value => value, document, navigator: { language: 'en-US' },
  localStorage: { getItem() { return null; }, setItem() {} }, window: { innerWidth: 1280, innerHeight: 900 },
  console, Intl, Date, performance, setTimeout, clearTimeout, structuredClone, URL,
});
const app = source.slice(source.indexOf('const Yc=Z0('), source.indexOf('const Lh='))
                  .replaceAll('import.meta.url', '"https://example.invalid/assets/index.js"');
try {
  vm.runInContext(app + '\nglobalThis.testApi={Og,Ht,dl,Ui,$c,ul,waZhHour,waZhTimeZone,waZhCityMatches,waZhError,Gc,vg,ox,lx,ex,cx,$v,ix,dx,nv};', context);
} catch (error) {
  console.error(error.name + ': ' + error.message);
  process.exit(1);
}
const api = context.testApi;
const upstreamSource = await fs.readFile(path.join(root, 'upstream/index-Dx2OKNjk.js'), 'utf8');
const upstreamContext = vm.createContext({ H0: {}, Z0: value => value, document,
  navigator: { language: 'zh-CN' }, localStorage: { getItem() { return null; }, setItem() {} },
  console, Intl, Date, performance, setTimeout, clearTimeout, structuredClone, URL });
const upstreamApp = upstreamSource.slice(upstreamSource.indexOf('const Yc=Z0('), upstreamSource.indexOf('const Lh='))
                                 .replaceAll('import.meta.url', '"https://example.invalid/assets/index.js"');
vm.runInContext(upstreamApp + '\nglobalThis.originalApi={Gc,vg};', upstreamContext);
const scientificConditions = conditions => conditions.map(({ v, q, kind, metric, imperial, edges, file, def }) => ({ v, q, kind, metric, imperial, edges, file, def }));
assert.equal(JSON.stringify(scientificConditions(api.Gc)), JSON.stringify(scientificConditions(upstreamContext.originalApi.Gc)), 'Filtering thresholds and decoder IDs remain unchanged');
assert.equal(JSON.stringify(api.vg.map(({ id, state }) => ({ id, state }))), JSON.stringify(upstreamContext.originalApi.vg.map(({ id, state }) => ({ id, state }))), 'Preset conditions remain unchanged');
assert.equal(api.Ui.system, 'metric', 'Chinese default must use metric even in an English browser');
assert.equal(api.dl('hours'), '小时');
assert.equal(api.dl('rate'), '毫米/小时');
assert.equal(api.Gc.find(item => item.v === 'dew').label, '露点温度');
assert.equal(api.Gc.find(item => item.v === 'daylight').label, '昼长');
assert.equal(api.Gc.find(item => item.v === 'sun').label, '日照时数');
assert.equal(api.Gc.find(item => item.v === 'precip').label, '日降水量');
assert.equal(api.vg.find(item => item.id === 'snowy').label, '有积雪');
assert.equal(api.Og(48).label, '雾（伴有雾凇）');
assert.equal(api.Og(56).label, '弱冻毛毛雨');
assert.equal(api.Og(66).label, '弱冻雨');
assert.equal(api.Og(77).label, '雪粒');
assert.equal(api.Og(97).label, '强雷暴');
assert.equal(api.Og(99).label, '雷暴伴强冰雹');
const midnight = Date.UTC(2026, 9, 13, 16);
assert.equal(api.waZhHour(midnight, 'Asia/Shanghai'), 0);
assert.equal(api.$c(304), '11月1日');
assert(api.waZhTimeZone('Asia/Shanghai').includes('中国'));
assert(!/[A-Za-z]/.test(api.waZhError('Failed to fetch')));

const citiesData = JSON.parse(await fs.readFile(path.join(dist, 'data/cities.json'), 'utf8'));
const originalCities = JSON.parse(await fs.readFile(path.join(root, 'upstream/cities.json'), 'utf8'));
assert.equal(citiesData.rows.length, 4598);
const cities = citiesData.rows.map((row, index) => {
  assert(/[\u3400-\u9fff]/.test(row[0]), `Chinese city: ${row[8]}`);
  assert(/[\u3400-\u9fff]/.test(row[1]), `Chinese region: ${row[9]}`);
  assert.deepEqual(row.slice(2, 8), originalCities.rows[index].slice(2, 8), 'Geographical and statistical inputs remain unchanged');
  return { name: row[0], country: row[1], aliases: [row[8], row[9]] };
});
for (const [query, wanted] of [['上海', '上海'], ['Shanghai', '上海'], ['北京', '北京'], ['Shenzhen', '深圳'], ['San Francisco', '旧金山']]) {
  assert.equal(api.waZhCityMatches(cities, query)[0].name, wanted, `Bilingual city search: ${query}`);
}

const panel = Object.create(api.dx.prototype);
Object.assign(panel, { els: { panel: new Element('aside') }, state: Object.fromEntries(api.Gc.map(item => [item.v, [...item.def]])),
  mode: 'days', menuOpen: true, meta: JSON.parse(await fs.readFile(path.join(dist, 'data/climate/meta.json'), 'utf8')),
  preset: 'perfect', cut: { days: 0, date: 0 } });
panel.renderPanel();
const panelText = panel.els.panel.textContent;
assert(panelText.includes('露点温度') && panelText.includes('昼长') && panelText.includes('日照时数'));
assert(!/Overnight|Humidity|Sunshine|Daylight|Loading/.test(panelText), panelText);
panel.mode = 'now'; panel.renderPanel();
assert(panel.els.panel.textContent.includes('降水强度（折算日量）'));
panel.mode = 'days';

const monthly = Array.from({ length: 12 }, () => ({ match: 15, feels: 24, tmax: 28, tmin: 18, dew: 12,
  sun: 7.5, uv: 6, sunnyDays: 18, rainDays: 6, precip: 50, snowDays: 0, wind: 15, sst: 24, why: [] }));
const result = { months: monthly, daily: new Float32Array(365).fill(0.5), perYear: 182.5,
  cells: 4, cellLat: 31.5, cellLon: 121.5, cellElev: 15, shift: -0.1 };
const table = api.lx(result);
const tableText = table.textContent;
assert(tableText.includes('日照（小时）') && tableText.includes('露点温度'));
const walk = element => [element, ...element.children.filter(child => typeof child === 'object').flatMap(walk)];
const tableMonthHeaders = walk(table).filter(element => element.attributes.scope === 'col').map(element => element.textContent);
assert.deepEqual(tableMonthHeaders, ['1','2','3','4','5','6','7','8','9','10','11','12']);
const chart = api.ix(result, 180, panel.state);
const axisLabels = walk(chart).filter(element => element.className === 'ax').map(element => element.textContent);
assert(axisLabels.includes('10') && axisLabels.includes('11') && axisLabels.includes('12'));
const climateNote = api.cx(result, 12).textContent;
assert(climateNote.includes('365 个样本日'));

const start = Math.floor(Date.now() / 3600000) * 3600000;
const forecast = { source: 'Open-Meteo', timezone: 'Asia/Shanghai',
  hours: Array.from({ length: 30 }, (_, index) => ({ t: start + index * 3600000, temp: 22, feels: 23,
    code: index ? 0 : 77, isDay: true, pop: 20, precip: 0.2, wind: 12, gust: 18, humidity: 65, cloud: 20 })),
  daily: [{ t: start - 3600000, max: 26, min: 18, sun: 7, uv: 6 }] };
const forecastText = api.$v(forecast, start).map(element => element.textContent).join(' ');
assert(forecastText.includes('雪粒') && forecastText.includes('相对湿度') && forecastText.includes('阵风'));
assert(!/Forecast|Feels|Humidity|gusts|Sunshine/.test(forecastText), forecastText);
const style = api.nv('https://example.invalid/coastline.json');
assert(style.layers.find(layer => layer.id === 'place-country').layout['text-field'].some(value => Array.isArray(value) && value[1] === 'name:zh'));

const report = { language: 'zh-CN', cities_checked: cities.length, terminology_checked: true,
  bilingual_search_checked: true, dates_hours_and_months_checked: true,
  climate_panel_checked: true, monthly_table_checked: true, forecast_text_checked: true,
  checks: 'Non-browser execution of the localized presentation logic and scientific-input comparison.',
  verification_limit: 'No browser/WebGL rendering check was performed.',
};
await fs.writeFile(path.join(root, 'localization-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
