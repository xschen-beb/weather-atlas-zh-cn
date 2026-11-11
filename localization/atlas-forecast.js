// Public forecast data; the historical ERA5 worker uses a separate transport.
const GFS_ORIGINS = [
  'https://noaa-gfs-bdp-pds.s3.amazonaws.com',
  'https://noaa-gfs-bdp-pds.s3.us-east-1.amazonaws.com',
];
const HOUR = 3600000;
const MAX_RANGE = 16 * 1024 * 1024;

export async function readForecastResponse(url, read, {timeout = 8000, signal, ...init} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('Request timeout')), timeout);
  try {
    const response = await fetch(url, {...init, credentials: 'omit', signal: controller.signal});
    return await read(response);
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function readGfs(url, read, options) {
  const path = new URL(url).pathname;
  let error;
  for (const origin of GFS_ORIGINS) {
    try {
      return await readForecastResponse(origin + path, read, {...options, redirect: 'error'});
    } catch (failure) {
      if (options.signal?.aborted) throw failure;
      error = failure;
    }
  }
  throw error;
}

export async function readForecastIndex(response) {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const lines = (await response.text()).trim().split('\n');
  if (!/^\d+:\d+:d=\d+:/.test(lines[0] || '')) throw new Error('Invalid forecast index');
  return lines.map(line => line.split(':'));
}

export function readGfsIndex(url, signal) {
  return readGfs(url, readForecastIndex, {timeout: 9000, signal});
}

function rangeOptions(start, end, signal) {
  const length = end === '' ? null : end - start + 1;
  if (!Number.isSafeInteger(start) || start < 0 ||
      (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_RANGE))) {
    throw new Error('Invalid forecast byte range');
  }
  return {headers: {Range: `bytes=${start}-${end}`}, signal, timeout: 12000};
}

function readRange(start, end) {
  return async response => {
    const length = end === '' ? null : end - start + 1;
    const reported = Number(response.headers.get('content-length') || 0);
    if (response.status !== 206 || reported > MAX_RANGE || (reported && length !== null && reported !== length)) {
      void response.body?.cancel().catch(() => {});
      throw new Error(response.ok ? 'Invalid forecast byte range response' : `HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_RANGE || (length !== null && bytes.byteLength !== length)) {
      throw new Error('Invalid forecast byte range response');
    }
    return bytes;
  };
}

export function readGfsRange(url, start, end, signal) {
  return readGfs(url, readRange(start, end), rangeOptions(start, end, signal));
}

export function readForecastRange(url, start, end, signal) {
  return readForecastResponse(url, readRange(start, end), rangeOptions(start, end, signal));
}

const currentFields = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code',
  'precipitation', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'is_day',
];
const hourlyFields = [...currentFields, 'precipitation_probability'];
const finite = value => Number.isFinite(value) ? value : undefined;

export async function fetchPointForecast(lat, lon, signal) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  url.search = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    current: currentFields.join(','), hourly: hourlyFields.join(','),
    daily: 'temperature_2m_max,temperature_2m_min,sunshine_duration,uv_index_max',
    past_days: '1', forecast_days: '5', timezone: 'auto', timeformat: 'unixtime',
  });
  return readForecastResponse(url, async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error || !Array.isArray(data.hourly?.time)) throw new Error('Invalid point forecast');
    const h = data.hourly;
    const hours = h.time.map((t, i) => ({
      t: t * 1000, temp: finite(h.temperature_2m?.[i]), feels: finite(h.apparent_temperature?.[i]),
      code: finite(h.weather_code?.[i]) ?? -1, isDay: h.is_day?.[i] === 1,
      pop: finite(h.precipitation_probability?.[i]), precip: finite(h.precipitation?.[i]),
      cloud: finite(h.cloud_cover?.[i]), humidity: finite(h.relative_humidity_2m?.[i]),
      wind: finite(h.wind_speed_10m?.[i]), gust: finite(h.wind_gusts_10m?.[i]),
    })).filter(point => Number.isFinite(point.t) && Number.isFinite(point.temp));
    const now = Date.now();
    const near = hours.find(point => point.t >= now - HOUR / 2 && point.t <= now + HOUR);
    const c = data.current;
    const current = Number.isFinite(c?.temperature_2m) && Math.abs(c.time * 1000 - now) <= 1.5 * HOUR ? {
      t: c.time * 1000, temp: c.temperature_2m, feels: finite(c.apparent_temperature),
      code: finite(c.weather_code) ?? -1, isDay: c.is_day === 1,
      // Hourly amount/probability. The current field has a shorter interval.
      pop: near?.pop, precip: near?.precip,
      cloud: finite(c.cloud_cover), humidity: finite(c.relative_humidity_2m),
      wind: finite(c.wind_speed_10m), gust: finite(c.wind_gusts_10m),
    } : null;
    if (!near || (!current && Math.abs(near.t - now) > HOUR)) throw new Error('Stale point forecast');
    const d = data.daily;
    const daily = d?.time?.map((t, i) => ({
      t: t * 1000, max: finite(d.temperature_2m_max?.[i]), min: finite(d.temperature_2m_min?.[i]),
      sun: Number.isFinite(d.sunshine_duration?.[i]) ? d.sunshine_duration[i] / 3600 : undefined,
      uv: finite(d.uv_index_max?.[i]),
    })).filter(day => Number.isFinite(day.t) && Number.isFinite(day.max) && Number.isFinite(day.min)) ?? [];
    return {source: 'Open-Meteo', timezone: data.timezone, hours, daily, current};
  }, {signal, timeout: 8000});
}
