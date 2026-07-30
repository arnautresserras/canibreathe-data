// Daily forecast snapshotter for canIbreathe.
//
// Captures what each pollen source *predicted* on a given day, so that the
// measured concentration data from PIA (which arrives ~2 weeks later) can be
// paired against it for forecast-skill and bias analysis.
//
// The PIA public forecast is ephemeral — it is overwritten every week and
// archived nowhere. Every day this job does not run is a day of verification
// data that cannot be recovered later. Google Pollen is likewise unarchived.
// Open-Meteo is *partially* recoverable retroactively, but its air-quality
// endpoint returns re-analysed past values rather than the forecast that was
// actually issued, so it is captured here too.
//
// Zero dependencies — Node 20+ (global fetch, native Intl).
//
// Usage:
//   node scripts/snapshot-forecasts.mjs
//   SNAPSHOT_DATE=2026-07-29 node scripts/snapshot-forecasts.mjs   # label override
//   SOURCES=pia,openmeteo node scripts/snapshot-forecasts.mjs      # subset

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PIA_BASE = 'https://aerobiologia.cat/api/v0/forecast';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const OPEN_METEO_WX = 'https://api.open-meteo.com/v1/forecast';
const GOOGLE_POLLEN = 'https://pollen.googleapis.com/v1/forecast:lookup';

// PIA station traps sit in Catalonia / the Balearics; all forecast validity
// windows and daily boundaries are local, so the archive is keyed on local dates.
const TZ = 'Europe/Madrid';

// CAMS Europe pollen variables carried by Open-Meteo. Kept in sync with
// POLLEN_VARIABLES in the app's openMeteoService.ts.
const OPEN_METEO_POLLEN = [
  'alder_pollen',
  'birch_pollen',
  'grass_pollen',
  'mugwort_pollen',
  'olive_pollen',
  'ragweed_pollen',
];

// Daily weather aggregates for the eventual weather/concentration correlation
// work. Stored verbatim as returned, so adding a variable here needs no parsing
// changes. Anything Open-Meteo doesn't recognise makes the request 400, so only
// add documented daily variables.
const OPEN_METEO_WEATHER_DAILY = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'relative_humidity_2m_mean',
  'precipitation_sum',
  'rain_sum',
  'precipitation_hours',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'shortwave_radiation_sum',
  'et0_fao_evapotranspiration',
];

const FORECAST_DAYS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Today's date in the stations' local timezone, as YYYY-MM-DD. */
function localToday() {
  // en-CA formats as YYYY-MM-DD, which is what we want for sortable filenames.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Fetch with a timeout and bounded retries. Returns {ok, status, body|error}. */
async function fetchWithRetry(url, { attempts = 3, timeoutMs = 20_000, json = false } = {}) {
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'canibreathe-data-snapshotter/1 (+https://github.com/arnautresserras/canibreathe-data)' },
      });
      clearTimeout(timer);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // 4xx won't fix itself on retry; bail out immediately.
        if (response.status >= 400 && response.status < 500) {
          return { ok: false, status: response.status, error: lastError };
        }
      } else {
        const body = json ? await response.json() : await response.text();
        return { ok: true, status: response.status, body };
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message ?? e);
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { ok: false, status: null, error: lastError };
}

async function writeSnapshot(source, date, payload) {
  const dir = join(REPO_ROOT, 'snapshots', source, date.slice(0, 4));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return path;
}

/** Pull the trap's own coordinates out of a PIA XML report. */
function parsePiaStationMeta(xml) {
  const pick = (tag) => xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`))?.[1]?.trim();
  const lat = Number(pick('latitude'));
  const lng = Number(pick('longitude'));
  const validFrom = xml.match(/<start>([^<]+)<\/start>/)?.[1]?.trim();
  const validTo = xml.match(/<end>([^<]+)<\/end>/)?.[1]?.trim();
  return {
    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

/** Group hourly series into per-local-date {mean, max} aggregates. */
function aggregateHourlyByDay(hourly, variables) {
  const times = hourly?.time ?? [];
  const byDate = {};
  for (let i = 0; i < times.length; i++) {
    const date = String(times[i]).slice(0, 10);
    const bucket = (byDate[date] ??= {});
    for (const variable of variables) {
      const value = hourly[variable]?.[i];
      if (value === null || value === undefined || Number.isNaN(value)) continue;
      const acc = (bucket[variable] ??= { sum: 0, n: 0, max: -Infinity });
      acc.sum += value;
      acc.n += 1;
      if (value > acc.max) acc.max = value;
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  const out = {};
  for (const [date, bucket] of Object.entries(byDate)) {
    out[date] = {};
    for (const variable of variables) {
      const acc = bucket[variable];
      out[date][variable] = acc && acc.n > 0
        ? { mean: round(acc.sum / acc.n), max: round(acc.max), hours: acc.n }
        : null;
    }
  }
  return out;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

/**
 * PIA public broadcast. Stored as raw XML, verbatim — the XML *is* the archive
 * and carries its own credit/licence block, taxon list and validity window.
 * Do not replace it with a parsed form: the taxon set varies week to week and
 * re-parsing later must be possible against the exact bytes that were served.
 */
async function snapshotPia(stations, date) {
  const results = {};
  const meta = {};
  for (const station of stations) {
    const result = await fetchWithRetry(`${PIA_BASE}/${station.id}/en/xml`);
    if (result.ok) {
      results[station.id] = { ok: true, xml: result.body };
      meta[station.id] = parsePiaStationMeta(result.body);
      console.log(`  pia/${station.id}: ok (${result.body.length} bytes)`);
    } else {
      results[station.id] = { ok: false, error: result.error, httpStatus: result.status };
      console.warn(`  pia/${station.id}: FAILED — ${result.error}`);
    }
  }
  return { results, meta };
}

async function snapshotOpenMeteo(stations, date) {
  const results = {};
  for (const station of stations) {
    const coords = `latitude=${station.lat}&longitude=${station.lng}`;
    const pollenUrl =
      `${OPEN_METEO_AQ}?${coords}&hourly=${[...OPEN_METEO_POLLEN, 'european_aqi'].join(',')}` +
      `&forecast_days=${FORECAST_DAYS}&timezone=${encodeURIComponent(TZ)}`;
    const weatherUrl =
      `${OPEN_METEO_WX}?${coords}&daily=${OPEN_METEO_WEATHER_DAILY.join(',')}` +
      `&forecast_days=${FORECAST_DAYS}&timezone=${encodeURIComponent(TZ)}`;

    const [pollen, weather] = await Promise.all([
      fetchWithRetry(pollenUrl, { json: true }),
      fetchWithRetry(weatherUrl, { json: true }),
    ]);

    const entry = { ok: pollen.ok, coords: { lat: station.lat, lng: station.lng } };
    if (pollen.ok) {
      // Hourly pollen is aggregated to daily mean/max on purpose: the measured
      // PIA data is a daily total per taxon, so hourly resolution adds size
      // without adding anything verifiable. Flip to storing `pollen.body.hourly`
      // verbatim if that ever changes.
      entry.pollen = aggregateHourlyByDay(pollen.body.hourly, [...OPEN_METEO_POLLEN, 'european_aqi']);
      entry.units = pollen.body.hourly_units;
    } else {
      entry.pollenError = pollen.error;
    }
    if (weather.ok) {
      entry.weather = weather.body.daily;
      entry.weatherUnits = weather.body.daily_units;
    } else {
      entry.weatherError = weather.error;
    }
    results[station.id] = entry;
    console.log(`  openmeteo/${station.id}: pollen ${pollen.ok ? 'ok' : `FAILED (${pollen.error})`}, weather ${weather.ok ? 'ok' : `FAILED (${weather.error})`}`);
  }
  return results;
}

async function snapshotGoogle(stations, date, apiKey) {
  const results = {};
  for (const station of stations) {
    const url =
      `${GOOGLE_POLLEN}?key=${apiKey}&location.latitude=${station.lat}` +
      `&location.longitude=${station.lng}&days=${FORECAST_DAYS}` +
      `&plantsDescription=false&languageCode=en`;
    const result = await fetchWithRetry(url, { json: true });
    if (result.ok) {
      // regionCode + dailyInfo is the whole payload once plant boilerplate is
      // suppressed; store it as-is.
      results[station.id] = { ok: true, response: result.body };
      console.log(`  google/${station.id}: ok`);
    } else {
      results[station.id] = { ok: false, error: result.error, httpStatus: result.status };
      console.warn(`  google/${station.id}: FAILED — ${result.error}`);
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const date = process.env.SNAPSHOT_DATE || localToday();
const fetchedAtUtc = new Date().toISOString();
const requested = (process.env.SOURCES || 'pia,openmeteo,google')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const { stations } = JSON.parse(await readFile(join(REPO_ROOT, 'stations.json'), 'utf8'));

console.log(`Snapshotting ${requested.join(', ')} for ${date} (${TZ}) at ${fetchedAtUtc}`);

const written = [];
let piaSucceeded = 0;
// PIA reports each trap's exact coordinates; prefer those over the fallbacks in
// stations.json so the gridded sources are sampled at the trap, not near it.
let sampleStations = stations;

if (requested.includes('pia')) {
  const { results, meta } = await snapshotPia(stations, date);
  piaSucceeded = Object.values(results).filter((r) => r.ok).length;
  written.push(await writeSnapshot('pia', date, {
    schema: 1,
    source: 'PIA — Punt d\'Informació Aerobiològica (aerobiologia.cat), CC BY-NC-SA 4.0',
    note: 'Raw API payloads, verbatim. The weekly forecast is one level (0-4) plus a trend symbol per taxon; the taxon set varies week to week.',
    date,
    fetchedAtUtc,
    stationMeta: meta,
    stations: results,
  }));
  sampleStations = stations.map((s) => ({ ...s, ...(meta[s.id]?.lat ? { lat: meta[s.id].lat, lng: meta[s.id].lng } : {}) }));
}

if (requested.includes('openmeteo')) {
  written.push(await writeSnapshot('openmeteo', date, {
    schema: 1,
    source: 'Open-Meteo (CAMS Europe pollen + ICON/best-match weather)',
    note: `Hourly pollen aggregated to per-day mean/max. Forecast horizon ${FORECAST_DAYS} days from ${date}.`,
    date,
    fetchedAtUtc,
    stations: await snapshotOpenMeteo(sampleStations, date),
  }));
}

if (requested.includes('google')) {
  const apiKey = process.env.GOOGLE_POLLEN_API_KEY;
  if (!apiKey) {
    console.warn('  google: skipped — GOOGLE_POLLEN_API_KEY not set (repo secret missing, or scoped to an environment the job does not declare)');
  } else {
    written.push(await writeSnapshot('google', date, {
      schema: 1,
      source: 'Google Pollen API',
      note: `plantsDescription=false. Forecast horizon ${FORECAST_DAYS} days from ${date}.`,
      date,
      fetchedAtUtc,
      stations: await snapshotGoogle(sampleStations, date, apiKey),
    }));
  }
}

console.log(`\nWrote ${written.length} file(s):`);
for (const path of written) console.log(`  ${path}`);

// A total PIA outage is the one failure worth waking up for: it is the only
// irreplaceable source here, and a silent green run would hide weeks of loss.
if (requested.includes('pia') && piaSucceeded === 0) {
  console.error('\nAll PIA stations failed — the irreplaceable source captured nothing.');
  process.exit(1);
}
