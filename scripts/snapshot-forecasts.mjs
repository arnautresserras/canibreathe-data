// Daily forecast snapshotter for canIbreathe.
//
// Captures what each pollen source *predicted* on a given day, so it can be
// paired against measured concentrations for forecast-skill and bias analysis.
// Two pairings are in scope:
//   1. PIA measured dailies (arrive ~2 weeks late) vs. the daily forecast.
//   2. MeteoSwiss measured *hourly* vs. the hourly forecast — the only way to
//      verify the intraday shape behind the app's hourly chart and its "best
//      time to go out" window, which every European location depends on.
// (2) is why the full hourly series is retained as of 2026-08-12; see
// snapshotOpenMeteo below.
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
import { serializeSnapshot } from './lib/compact-json.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PIA_BASE = 'https://aerobiologia.cat/api/v0/forecast';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const OPEN_METEO_WX = 'https://api.open-meteo.com/v1/forecast';
const GOOGLE_POLLEN = 'https://pollen.googleapis.com/v1/forecast:lookup';

// PIA station traps sit in Catalonia / the Balearics; all forecast validity
// windows and daily boundaries are local, so the archive is keyed on local dates.
const TZ = 'Europe/Madrid';

// Per-station timezone for the gridded sampling. PIA stations use TZ above.
// The MeteoSwiss traps use UTC on purpose: MeteoSwiss publishes measured
// timestamps in UTC, so sampling the forecast in UTC removes a conversion from
// the pairing step — and a silent 1 h shift would corrupt the timing metric,
// which is the primary thing the hourly capture exists to measure.
// (Switzerland and Spain share the CET/CEST offset year-round, so this is a
// labelling choice, not a different set of hours.)
const DEFAULT_TZ = TZ;

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
  await writeFile(path, serializeSnapshot(payload) + '\n', 'utf8');
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

/**
 * Per-variable count of hours that actually carry a value, plus the last such
 * timestamp. This is the truncation diagnostic: CAMS pollen does not reach the
 * end of the requested window — a run captured on 2026-08-12 carried 24/24/24/3
 * hours for days 1-4 and nothing at all for day 5. Without this, a short day is
 * indistinguishable from a genuinely calm one, because both aggregate to a low
 * number. Cheap to store and it answers "how far does pollen really go?" for
 * every day of the archive.
 */
function hourlyCoverage(hourly, variables) {
  const times = hourly?.time ?? [];
  const out = {};
  for (const variable of variables) {
    const values = hourly?.[variable] ?? [];
    let hours = 0;
    let lastIndex = -1;
    for (let i = 0; i < times.length; i++) {
      const value = values[i];
      if (value === null || value === undefined || Number.isNaN(value)) continue;
      hours += 1;
      lastIndex = i;
    }
    out[variable] = { hours, lastHour: lastIndex >= 0 ? times[lastIndex] : null };
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
    const tz = station.tz ?? DEFAULT_TZ;
    const coords = `latitude=${station.lat}&longitude=${station.lng}`;
    const pollenUrl =
      `${OPEN_METEO_AQ}?${coords}&hourly=${[...OPEN_METEO_POLLEN, 'european_aqi'].join(',')}` +
      `&forecast_days=${FORECAST_DAYS}&timezone=${encodeURIComponent(tz)}`;
    const weatherUrl =
      `${OPEN_METEO_WX}?${coords}&daily=${OPEN_METEO_WEATHER_DAILY.join(',')}` +
      `&forecast_days=${FORECAST_DAYS}&timezone=${encodeURIComponent(tz)}`;

    const [pollen, weather] = await Promise.all([
      fetchWithRetry(pollenUrl, { json: true }),
      fetchWithRetry(weatherUrl, { json: true }),
    ]);

    const entry = {
      ok: pollen.ok,
      coords: { lat: station.lat, lng: station.lng },
      timezone: tz,
      ...(station.network ? { network: station.network } : {}),
    };
    if (pollen.ok) {
      // Daily mean/max, as before — every existing consumer reads this.
      entry.pollen = aggregateHourlyByDay(pollen.body.hourly, [...OPEN_METEO_POLLEN, 'european_aqi']);
      entry.units = pollen.body.hourly_units;
      // Full hourly series, verbatim. Retained since 2026-08-12 (schema 2).
      //
      // It used to be discarded, on the reasoning that "the measured PIA data is
      // a daily total, so hourly adds size without adding anything verifiable."
      // That was true while PIA was the only ground truth in view. MeteoSwiss
      // publishes *hourly* measured concentrations, free and CC BY, so the
      // intraday shape is now verifiable — and it is what the app's hourly chart
      // and its "best time to go out" window are built on, for every European
      // location including PIA ones (PIA has no sub-day granularity).
      //
      // This is the one part of the payload that cannot be reconstructed later:
      // the air-quality endpoint's past window returns re-analysed values, not
      // the forecast that was issued. A day missed here is a day that can never
      // be paired against what a user was actually shown.
      // Pollen only — hourly european_aqi is dropped (its daily mean/max above is
      // kept). The app surfaces AQI as a single daily figure, and no part of the
      // hourly verification touches it, so retaining 120 values x 24 stations of
      // it every day would be pure archive weight.
      // `time` is kept per station on purpose, even though every station in a run
      // currently shares the same labels: this study's primary metric is *timing*,
      // and hoisting the axis to save ~50 KB/day would put an indirection between
      // a value and its hour. Wrong trade for this data.
      const { european_aqi: _hourlyAqi, ...pollenHourly } = pollen.body.hourly;
      entry.hourly = pollenHourly;
      entry.hourlyCoverage = hourlyCoverage(pollen.body.hourly, OPEN_METEO_POLLEN);
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

// MeteoSwiss traps are *sample points only* — nothing is fetched from MeteoSwiss
// here. They exist so the gridded forecast is captured where an hourly measured
// series also exists, which is what makes the intraday comparison possible.
// Measured values themselves are NOT snapshotted: MeteoSwiss archives its own
// history (_recent / _historical, 2023 onwards), so unlike the forecast they can
// be downloaded at any later date — see scripts/fetch-meteoswiss-measured.mjs.
const { stations: swissTraps } = JSON.parse(
  await readFile(join(REPO_ROOT, 'stations-meteoswiss.json'), 'utf8')
);

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
  // PIA traps (Catalonia/Balearics, local dates) + MeteoSwiss traps (UTC). Only
  // Open-Meteo is sampled at the Swiss points: PIA has nothing to say about them
  // and Google is metered, so widening it there would triple the billed volume
  // for data this study does not use.
  const openMeteoStations = [
    ...sampleStations.map((s) => ({ ...s, network: 'pia' })),
    ...swissTraps.map((s) => ({ ...s, network: 'meteoswiss' })),
  ];
  written.push(await writeSnapshot('openmeteo', date, {
    schema: 2,
    source: 'Open-Meteo (CAMS Europe pollen + ICON/best-match weather)',
    note:
      `Per-day mean/max plus the full hourly series (schema 2, hourly retained from 2026-08-12). ` +
      `Forecast horizon ${FORECAST_DAYS} days from ${date}. Sampled at ${sampleStations.length} PIA traps ` +
      `(timezone ${TZ}) and ${swissTraps.length} MeteoSwiss traps (timezone UTC, matching how MeteoSwiss ` +
      `publishes measured hours). Each station records its own 'timezone' and 'network'. ` +
      `'hourlyCoverage' reports how many hours each taxon actually carries — CAMS pollen runs out ` +
      `before the end of the requested window, so a short day is not a calm day.`,
    date,
    fetchedAtUtc,
    stations: await snapshotOpenMeteo(openMeteoStations, date),
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
