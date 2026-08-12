// MeteoSwiss measured hourly pollen — on-demand bulk download.
//
// NOT part of the daily snapshot job, and that is the point. Only the *issued
// forecast* is ephemeral: MeteoSwiss keeps its own archive of measurements
// (_recent = current year, _historical = earlier years in ten-year blocks, the
// automatic network running since 2023-01-01), so measured data can be pulled at
// any later date without loss. Snapshotting it daily would add megabytes a day
// to a public repo to duplicate something already permanently published.
//
// Output is written to measured/meteoswiss/ and is gitignored: it is a mirror of
// a stable public archive, re-downloadable in a couple of minutes, so committing
// ~25 MB of it would be archive weight with no durability benefit.
//
// Licence: CC BY. Attribution wording is "Source: MeteoSwiss". Any published
// figure derived from this data must carry it.
//
// Zero dependencies — Node 20+.
//
// Usage:
//   node scripts/fetch-meteoswiss-measured.mjs                  # hourly, recent (current year)
//   node scripts/fetch-meteoswiss-measured.mjs --now             # hourly, today only (a quick probe)
//   node scripts/fetch-meteoswiss-measured.mjs --historical      # hourly, all archived blocks
//   node scripts/fetch-meteoswiss-measured.mjs --granularity=d   # daily instead of hourly
//   node scripts/fetch-meteoswiss-measured.mjs --stations=PZH,PLU

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-pollen';
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-pollen';

// The 7 automatic taxa, keyed by the hourly parameter id. Only the first three
// overlap Open-Meteo/CAMS, so only those three are verifiable against a forecast
// — the rest are recorded because they cost nothing and are the only source of
// truth for taxa no forecast covers at all.
const PARAMETERS = {
  kaalnuh0: { taxon: 'alnus',    label: 'Alder',      inCams: true },
  kabetuh0: { taxon: 'betula',   label: 'Birch',      inCams: true },
  khpoach0: { taxon: 'poaceae',  label: 'Grasses',    inCams: true },
  kacoryh0: { taxon: 'corylus',  label: 'Hazel',      inCams: false },
  kafaguh0: { taxon: 'fagus',    label: 'Beech',      inCams: false },
  kafraxh0: { taxon: 'fraxinus', label: 'Ash',        inCams: false },
  kaquerh0: { taxon: 'quercus',  label: 'Oak',        inCams: false },
};

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const granularity = value('granularity', 'h'); // h | d | y
const stationFilter = value('stations', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// `now` is today-so-far, `recent` the current year up to yesterday, `historical`
// the earlier ten-year blocks. Default to `recent`: it is the smallest file that
// still contains complete days, which is what pairing needs.
const frequencies = flag('now')
  ? ['now']
  : flag('historical')
    ? ['recent', 'historical']
    : ['recent'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, { attempts = 3, timeoutMs = 60_000 } = {}) {
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'canibreathe-data/1 (+https://github.com/arnautresserras/canibreathe-data)' },
      });
      clearTimeout(timer);
      if (response.ok) return { ok: true, body: await response.text() };
      lastError = `HTTP ${response.status}`;
      // A missing historical block is a 404 and a legitimate answer, not a fault.
      if (response.status >= 400 && response.status < 500) {
        return { ok: false, status: response.status, error: lastError };
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message ?? e);
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return { ok: false, status: null, error: lastError };
}

/**
 * Sanity-check a downloaded CSV without parsing it into memory.
 *
 * Deliberately checks the *header* rather than trusting column order. The live
 * header orders birch before grasses before alder — neither alphabetical nor the
 * order the documentation lists — so any analysis that indexes by position
 * instead of by name is silently wrong the day MeteoSwiss reorders a column.
 * Reported here so a reorder shows up at download time, not in a metric.
 */
function inspectCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split(';');
  const known = header.filter((h) => PARAMETERS[h]);
  const unknown = header.filter(
    (h) => !PARAMETERS[h] && h !== 'station_abbr' && h !== 'reference_timestamp'
  );
  const first = lines[1]?.split(';')[1];
  const last = lines.at(-1)?.split(';')[1];
  return { rows: Math.max(0, lines.length - 1), header, known, unknown, first, last };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const { stations } = JSON.parse(
  await readFile(join(REPO_ROOT, 'stations-meteoswiss.json'), 'utf8')
);
const targets = stationFilter.length
  ? stations.filter((s) => stationFilter.includes(s.id))
  : stations;

if (targets.length === 0) {
  console.error(`No stations matched --stations=${stationFilter.join(',')}`);
  process.exit(1);
}

const outDir = join(REPO_ROOT, 'measured', 'meteoswiss');
await mkdir(outDir, { recursive: true });

console.log(
  `MeteoSwiss measured pollen — ${targets.length} station(s), granularity '${granularity}', ` +
  `frequency ${frequencies.join(' + ')}\nSource: MeteoSwiss (CC BY). Writing to measured/meteoswiss/ (gitignored).\n`
);

const summary = [];
let failures = 0;
const unknownColumns = new Set();

for (const station of targets) {
  const abbr = station.id.toLowerCase();
  for (const frequency of frequencies) {
    const file = `ogd-pollen_${abbr}_${granularity}_${frequency}.csv`;
    const result = await fetchWithRetry(`${BASE}/${abbr}/${file}`);

    if (!result.ok) {
      // `historical` legitimately doesn't exist for a station whose automatic
      // record starts inside the current decade, so a 404 there isn't a failure.
      const benign = frequency === 'historical' && result.status === 404;
      if (!benign) failures += 1;
      console.log(`  ${station.id}/${frequency}: ${benign ? 'not published' : `FAILED — ${result.error}`}`);
      continue;
    }

    await writeFile(join(outDir, file), result.body, 'utf8');
    const info = inspectCsv(result.body);
    info.unknown.forEach((c) => unknownColumns.add(c));
    summary.push({ station: station.id, frequency, ...info, bytes: result.body.length });
    console.log(
      `  ${station.id}/${frequency}: ${info.rows} rows, ${info.known.length} known taxa, ` +
      `${(result.body.length / 1024).toFixed(0)} KB  [${info.first ?? '-'} → ${info.last ?? '-'}]`
    );
  }
}

// A manifest makes the download reproducible and records the header actually
// served, so a later column reorder is visible in a diff rather than inferred.
await writeFile(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      fetchedAtUtc: new Date().toISOString(),
      source: 'MeteoSwiss Open Government Data (CC BY) — attribution: "Source: MeteoSwiss"',
      collection: STAC,
      granularity,
      frequencies,
      note:
        'Timestamps are UTC in DD.MM.YYYY HH:MM format — not ISO. Parse by header name, never by ' +
        'column index. An empty cell means "not reported"; 0 is a real zero, and conflating the two ' +
        'deflates every statistic with no error to alert you.',
      parameters: PARAMETERS,
      files: summary,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log(`\nWrote ${summary.length} file(s) + manifest.json to measured/meteoswiss/`);

if (unknownColumns.size > 0) {
  console.warn(
    `\n⚠ Unrecognised columns served: ${[...unknownColumns].join(', ')} — ` +
    `MeteoSwiss may have added a taxon. Update PARAMETERS before analysing.`
  );
}
if (failures > 0) {
  console.error(`\n${failures} download(s) failed.`);
  process.exit(1);
}
