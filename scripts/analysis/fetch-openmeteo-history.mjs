// Open-Meteo hourly pollen history at the MeteoSwiss trap coordinates.
//
// The modelled side of Study A. See docs/hourly-forecast-verification-plan.md in
// the app repo for what this is for and — importantly — what it is NOT:
//
//   These are past-date values, which have been MEASURED to differ from the
//   forecast that was actually issued (up to +50% on a daily mean, and in one
//   case the same daily total redistributed across different hours). They are a
//   best-case upper bound on CAMS's hourly skill, not a record of what any user
//   was shown. Never label a number derived from this file as forecast skill.
//
// Requested in UTC to match how MeteoSwiss publishes measured hours, so the join
// needs no timezone conversion. A silent 1 h shift would corrupt the timing
// metric, which is the whole point.
//
// Only the three taxa that overlap MeteoSwiss's automatic network are fetched;
// the other three CAMS taxa have no measured counterpart here.
//
// Zero dependencies — Node 20+.
//
// Usage:
//   node scripts/analysis/fetch-openmeteo-history.mjs
//   node scripts/analysis/fetch-openmeteo-history.mjs --from=2023 --to=2026
//   node scripts/analysis/fetch-openmeteo-history.mjs --stations=PZH,PLU

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// The overlap with MeteoSwiss's automatic network. Verified 2026-08-12.
const TAXA = ['alder_pollen', 'birch_pollen', 'grass_pollen'];

// Open-Meteo pollen history begins in 2021 (2020 and earlier return all-null),
// and MeteoSwiss's automatic network begins 2023-01-01, which is the binding
// constraint — the earlier manual record is methodologically different.
const FIRST_YEAR = 2023;

const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const fromYear = Number(value('from', FIRST_YEAR));
const toYear = Number(value('to', new Date().getUTCFullYear()));
const stationFilter = value('stations', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

if (fromYear < 2021) {
  console.error(`--from=${fromYear} predates Open-Meteo's pollen history (starts 2021).`);
  process.exit(1);
}

async function fetchWithRetry(url, { attempts = 4, timeoutMs = 90_000 } = {}) {
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
      if (response.ok) return { ok: true, body: await response.json() };
      const text = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}${text ? ` — ${text.slice(0, 160)}` : ''}`;
      // 429 is worth backing off on; other 4xx will not fix themselves.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return { ok: false, error: lastError };
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message ?? e);
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  return { ok: false, error: lastError };
}

const { stations } = JSON.parse(
  await readFile(join(REPO_ROOT, 'stations-meteoswiss.json'), 'utf8')
);
const targets = stationFilter.length
  ? stations.filter((s) => stationFilter.includes(s.id))
  : stations;

const outDir = join(REPO_ROOT, 'measured', 'openmeteo-history');
await mkdir(outDir, { recursive: true });

console.log(
  `Open-Meteo hourly pollen history — ${targets.length} station(s), ${fromYear}–${toYear}, ` +
  `${TAXA.length} taxa, UTC.\nPast-date values: an upper bound on skill, NOT the issued forecast.\n`
);

let failures = 0;
const summary = [];

for (const station of targets) {
  for (let year = fromYear; year <= toYear; year++) {
    const start = `${year}-01-01`;
    // Open-Meteo rejects an end_date in the future; clamp to yesterday UTC.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const end = year === toYear && `${year}-12-31` > yesterday ? yesterday : `${year}-12-31`;
    if (start > end) continue;

    const url =
      `${AQ}?latitude=${station.lat}&longitude=${station.lng}` +
      `&hourly=${TAXA.join(',')}&start_date=${start}&end_date=${end}&timezone=UTC`;

    const result = await fetchWithRetry(url);
    if (!result.ok) {
      failures += 1;
      console.log(`  ${station.id} ${year}: FAILED — ${result.error}`);
      continue;
    }

    const hourly = result.body.hourly ?? {};
    const times = hourly.time ?? [];
    const counts = Object.fromEntries(
      TAXA.map((t) => [t, (hourly[t] ?? []).filter((v) => v !== null && v !== undefined).length])
    );

    const file = `openmeteo_${station.id}_${year}.json`;
    await writeFile(
      join(outDir, file),
      JSON.stringify({
        station: station.id,
        coords: { lat: station.lat, lng: station.lng },
        timezone: 'UTC',
        provenance:
          'Open-Meteo air-quality past-date values (CAMS Europe). MEASURED to differ from the ' +
          'issued forecast — treat as a best-case upper bound, never as forecast skill.',
        year,
        start,
        end,
        taxa: TAXA,
        hours: times.length,
        nonNull: counts,
        hourly,
      }) + '\n',
      'utf8'
    );

    summary.push({ station: station.id, year, hours: times.length, nonNull: counts });
    console.log(
      `  ${station.id} ${year}: ${times.length} hours  ` +
      TAXA.map((t) => `${t.split('_')[0]} ${counts[t]}`).join(', ')
    );

    // Be a good citizen on a free, unauthenticated API.
    await new Promise((r) => setTimeout(r, 400));
  }
}

await writeFile(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      fetchedAtUtc: new Date().toISOString(),
      source: 'Open-Meteo Air Quality API (CAMS Europe pollen), CC BY 4.0',
      timezone: 'UTC',
      taxa: TAXA,
      warning:
        'Past-date values are NOT the forecast that was issued (verified 2026-08-12 against ' +
        'archived snapshots). Upper bound on hourly skill only.',
      files: summary,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log(`\nWrote ${summary.length} file(s) + manifest.json to measured/openmeteo-history/`);
if (failures > 0) {
  console.error(`${failures} request(s) failed.`);
  process.exit(1);
}
