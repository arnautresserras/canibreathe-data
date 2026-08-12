// Study A — does CAMS's hourly pollen shape carry day-specific information?
//
// See docs/hourly-forecast-verification-plan.md in the app repo. In short: the
// app's hourly chart and its "best time to go out" window rest on Open-Meteo
// hourly pollen for every European location, and that intraday shape has never
// been verified. MeteoSwiss's hourly measured counts are the only ground truth
// that can verify it.
//
// ⚠️ WHAT THIS CAN AND CANNOT CONCLUDE
// The modelled side is Open-Meteo's *past-date* values, which were measured on
// 2026-08-12 to differ from the forecast actually issued (up to +50% on a daily
// mean; in one case the same daily total redistributed across different hours).
// So this is a BEST-CASE upper bound. A failure here is decisive — if the shape
// carries no day-specific information even with hindsight, the shipped forecast
// cannot carry it either. A pass here is NOT a statement about shipped accuracy.
//
// Prerequisites:
//   node scripts/fetch-meteoswiss-measured.mjs --historical
//   node scripts/analysis/fetch-openmeteo-history.mjs
//
// Usage:
//   node scripts/analysis/study-a.mjs
//   node scripts/analysis/study-a.mjs --floor=20

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEASURED_DIR = join(REPO_ROOT, 'measured', 'meteoswiss');
const MODEL_DIR = join(REPO_ROOT, 'measured', 'openmeteo-history');

// MeteoSwiss hourly parameter -> app allergen key -> Open-Meteo variable.
const TAXA = [
  { key: 'alnus', ms: 'kaalnuh0', om: 'alder_pollen', label: 'alder' },
  { key: 'betula', ms: 'kabetuh0', om: 'birch_pollen', label: 'birch' },
  { key: 'poaceae', ms: 'khpoach0', om: 'grass_pollen', label: 'grass' },
];

const args = process.argv.slice(2);
const argVal = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;

// A diurnal *shape* is meaningless on a near-zero day: dividing noise by noise
// produces a random unit vector, and pooling those would bury any real signal.
// Floor is on the measured daily mean, in No/m3.
const FLOOR = Number(argVal('floor', 5));

// Candidate windows for the product proxy: 3 consecutive hours inside daytime.
// UTC, so this is roughly 08:00-22:00 Swiss local in summer.
const DAY_START = 6;
const DAY_END = 20;
const WINDOW_LEN = 3;

// ─── Stats helpers ────────────────────────────────────────────────────────────

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

/** Average correlations in Fisher-z space, which is the correct way to pool r. */
function fisherMean(rs) {
  const usable = rs.filter((r) => r !== null && Number.isFinite(r));
  if (!usable.length) return { r: NaN, n: 0 };
  const zs = usable.map((r) => Math.atanh(Math.max(-0.9999, Math.min(0.9999, r))));
  return { r: Math.tanh(mean(zs)), n: usable.length };
}

/**
 * Bootstrap CI resampling whole (station, taxon, year) blocks rather than days.
 * Hourly pollen is strongly autocorrelated, so a day-level resample would treat
 * neighbouring days as independent and produce an interval far too narrow.
 */
function blockBootstrapCI(blocks, iterations = 1000) {
  if (blocks.length < 2) return null;
  const estimates = [];
  // Deterministic LCG: a fixed seed keeps the reported interval reproducible.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < iterations; it++) {
    const pooled = [];
    for (let b = 0; b < blocks.length; b++) {
      pooled.push(...blocks[Math.floor(rand() * blocks.length)]);
    }
    const { r } = fisherMean(pooled);
    if (Number.isFinite(r)) estimates.push(r);
  }
  if (estimates.length < 100) return null;
  estimates.sort((a, b) => a - b);
  return [
    estimates[Math.floor(0.025 * estimates.length)],
    estimates[Math.floor(0.975 * estimates.length)],
  ];
}

const l1 = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * MeteoSwiss hourly CSV -> Map<'YYYY-MM-DDTHH', {taxonKey: number|null}>.
 *
 * Parsed by header NAME, never by column index: the live header orders birch
 * before grasses before alder, so index-based parsing silently mislabels taxa.
 * Timestamps are 'DD.MM.YYYY HH:MM' in UTC and are NOT ISO — a naive Date()
 * parse is invalid or engine-dependent, and a 1 h shift would corrupt the
 * timing metric this study exists to produce.
 * An empty cell means "not reported"; 0 is a real zero.
 */
function parseMeasuredCsv(text, into) {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(';');
  const colOf = {};
  for (const taxon of TAXA) {
    const i = header.indexOf(taxon.ms);
    if (i >= 0) colOf[taxon.key] = i;
  }
  const tsCol = header.indexOf('reference_timestamp');
  if (tsCol < 0) throw new Error('reference_timestamp column missing');

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const cells = line.split(';');
    const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(cells[tsCol] ?? '');
    if (!m) continue;
    const key = `${m[3]}-${m[2]}-${m[1]}T${m[4]}`;
    const row = into.get(key) ?? {};
    for (const taxon of TAXA) {
      const raw = cells[colOf[taxon.key]];
      if (raw === undefined || raw === '') continue; // not reported
      const v = Number(raw);
      if (Number.isFinite(v)) row[taxon.key] = v;
    }
    into.set(key, row);
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

const measured = new Map(); // station -> Map<hourKey, {taxon: value}>
for (const file of (await readdir(MEASURED_DIR)).filter((f) => /_h_(recent|historical)/.test(f))) {
  const station = /ogd-pollen_([a-z]{3})_/.exec(file)?.[1]?.toUpperCase();
  if (!station) continue;
  const into = measured.get(station) ?? new Map();
  parseMeasuredCsv(await readFile(join(MEASURED_DIR, file), 'utf8'), into);
  measured.set(station, into);
}

const model = new Map(); // station -> Map<hourKey, {taxon: value}>
for (const file of (await readdir(MODEL_DIR)).filter((f) => f.startsWith('openmeteo_'))) {
  const payload = JSON.parse(await readFile(join(MODEL_DIR, file), 'utf8'));
  const into = model.get(payload.station) ?? new Map();
  const times = payload.hourly?.time ?? [];
  for (let i = 0; i < times.length; i++) {
    const key = String(times[i]).slice(0, 13); // 'YYYY-MM-DDTHH'
    const row = into.get(key) ?? {};
    for (const taxon of TAXA) {
      const v = payload.hourly?.[taxon.om]?.[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) row[taxon.key] = v;
    }
    into.set(key, row);
  }
  model.set(payload.station, into);
}

console.log(`Loaded measured: ${measured.size} stations, model: ${model.size} stations`);
console.log(`Shape floor: measured daily mean >= ${FLOOR} No/m3\n`);

// ─── Build per-day paired records ─────────────────────────────────────────────

/** For one station+taxon: Map<'YYYY-MM-DD', {m: number[24], f: number[24]}> (complete days only). */
function pairedDays(station, taxonKey) {
  const ms = measured.get(station);
  const md = model.get(station);
  if (!ms || !md) return new Map();
  const days = new Map();
  for (const [hourKey, mrow] of ms) {
    const mv = mrow[taxonKey];
    const fv = md.get(hourKey)?.[taxonKey];
    if (mv === undefined || fv === undefined) continue;
    const date = hourKey.slice(0, 10);
    const hour = Number(hourKey.slice(11, 13));
    const rec = days.get(date) ?? { m: new Array(24).fill(null), f: new Array(24).fill(null) };
    rec.m[hour] = mv;
    rec.f[hour] = fv;
    days.set(date, rec);
  }
  for (const [date, rec] of days) {
    if (rec.m.some((v) => v === null) || rec.f.some((v) => v === null)) days.delete(date);
  }
  return days;
}

/**
 * Main Pollen Season by the 95% method (cumulative 2.5% -> 97.5%) on the MEASURED
 * series, per year — the definition already specified in the PIA plan's Phase 2.
 * Aggregate statistics that include the out-of-season zeros are meaningless: a
 * model that is perfect in December and blind at peak scores well overall.
 */
function inSeasonDates(days) {
  const byYear = new Map();
  for (const [date, rec] of days) {
    const year = date.slice(0, 4);
    (byYear.get(year) ?? byYear.set(year, []).get(year)).push([date, rec.m.reduce((a, b) => a + b, 0)]);
  }
  const keep = new Set();
  for (const [, entries] of byYear) {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const total = entries.reduce((s, e) => s + e[1], 0);
    if (total <= 0) continue;
    let cum = 0;
    for (const [date, daily] of entries) {
      const before = cum / total;
      cum += daily;
      const after = cum / total;
      if (after >= 0.025 && before <= 0.975) keep.add(date);
    }
  }
  return keep;
}

const shapeOf = (v) => {
  const s = v.reduce((a, b) => a + b, 0);
  return s > 0 ? v.map((x) => x / s) : null;
};

// ─── Metric 1+3: shape information content and timing ─────────────────────────

const perTaxon = new Map();

for (const taxon of TAXA) {
  const rows = [];       // qualifying day records
  for (const station of measured.keys()) {
    const days = pairedDays(station, taxon.key);
    const season = inSeasonDates(days);
    for (const [date, rec] of days) {
      if (!season.has(date)) continue;
      const dailyMeanM = rec.m.reduce((a, b) => a + b, 0) / 24;
      if (dailyMeanM < FLOOR) continue;
      const sm = shapeOf(rec.m), sf = shapeOf(rec.f);
      if (!sm || !sf) continue;
      rows.push({ station, date, year: date.slice(0, 4), rec, sm, sf, dailyMeanM });
    }
  }
  perTaxon.set(taxon.key, rows);
}

console.log('='.repeat(96));
console.log('METRIC 1 — DIURNAL SHAPE: does the model know THIS day\'s shape?');
console.log('='.repeat(96));
console.log('Dispersion = mean L1 distance of a day\'s shape from that station-taxon\'s mean shape.');
console.log('Range 0-2. Near 0 for the model = a fixed profile stamped on a daily total.\n');
console.log('taxon  station-days  disp(measured)  disp(model)  ratio   anomaly r  95% CI            peak-hour offset');
console.log('-'.repeat(96));

const summary = {};

for (const taxon of TAXA) {
  const rows = perTaxon.get(taxon.key);
  if (rows.length < 10) {
    console.log(`${taxon.label.padEnd(7)}${String(rows.length).padStart(11)}   (too few qualifying days)`);
    continue;
  }

  // Climatological mean shape per station+taxon, computed on qualifying days.
  const climM = new Map(), climF = new Map();
  for (const st of new Set(rows.map((r) => r.station))) {
    const sub = rows.filter((r) => r.station === st);
    climM.set(st, Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.sm[h]))));
    climF.set(st, Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.sf[h]))));
  }

  const dispM = [], dispF = [], anomalyR = [], peakOffset = [];
  const blocks = new Map();

  for (const r of rows) {
    const cm = climM.get(r.station), cf = climF.get(r.station);
    dispM.push(l1(r.sm, cm));
    dispF.push(l1(r.sf, cf));

    const am = r.sm.map((v, h) => v - cm[h]);
    const af = r.sf.map((v, h) => v - cf[h]);
    const rr = pearson(am, af);
    anomalyR.push(rr);

    const blockKey = `${r.station}|${r.year}`;
    (blocks.get(blockKey) ?? blocks.set(blockKey, []).get(blockKey)).push(rr);

    const pm = r.sm.indexOf(Math.max(...r.sm));
    const pf = r.sf.indexOf(Math.max(...r.sf));
    let d = pf - pm;
    if (d > 12) d -= 24;
    if (d < -12) d += 24;
    peakOffset.push(d);
  }

  const { r: rBar, n } = fisherMean(anomalyR);
  const ci = blockBootstrapCI([...blocks.values()]);
  const dM = mean(dispM), dF = mean(dispF);
  const offsets = peakOffset.slice().sort((a, b) => a - b);
  const medianOffset = offsets[Math.floor(offsets.length / 2)];
  const within1 = peakOffset.filter((d) => Math.abs(d) <= 1).length / peakOffset.length;

  summary[taxon.key] = { n, dM, dF, rBar, ci, medianOffset, within1 };

  console.log(
    taxon.label.padEnd(7) +
    String(rows.length).padStart(11) +
    dM.toFixed(3).padStart(16) +
    dF.toFixed(3).padStart(13) +
    (dF / dM).toFixed(2).padStart(8) +
    rBar.toFixed(3).padStart(11) +
    '  ' + (ci ? `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : 'n/a').padEnd(18) +
    `median ${medianOffset >= 0 ? '+' : ''}${medianOffset}h, ${(within1 * 100).toFixed(0)}% within 1h`
  );
}

// ─── Metric 2 proxy: does the "best window" recommendation work? ──────────────

console.log('\n' + '='.repeat(96));
console.log('METRIC 2 (proxy) — BEST-WINDOW RECOMMENDATION');
console.log('='.repeat(96));
console.log(`Lowest-mean ${WINDOW_LEN}h window inside ${DAY_START}:00-${DAY_END}:00 UTC, chosen from the model,`);
console.log('then scored against what was actually measured. Not the app\'s windowHelpers — a proxy for it.\n');
console.log('taxon  days   overlap  model-pick percentile   harm rate   climatology-pick harm   first-window harm');
console.log('-'.repeat(96));

function windowMeans(v) {
  const out = [];
  for (let s = DAY_START; s + WINDOW_LEN <= DAY_END; s++) {
    out.push({ start: s, mean: mean(v.slice(s, s + WINDOW_LEN)) });
  }
  return out;
}

for (const taxon of TAXA) {
  const rows = perTaxon.get(taxon.key);
  if (rows.length < 10) continue;

  // Fixed climatological pick per station: the window a no-information baseline
  // would choose every day.
  const climPick = new Map();
  for (const st of new Set(rows.map((r) => r.station))) {
    const sub = rows.filter((r) => r.station === st);
    const avg = Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.rec.f[h])));
    climPick.set(st, windowMeans(avg).sort((a, b) => a.mean - b.mean)[0].start);
  }

  let overlapSum = 0, pctSum = 0, harm = 0, harmClim = 0, harmFirst = 0, n = 0;

  for (const r of rows) {
    const truth = windowMeans(r.rec.m).sort((a, b) => a.mean - b.mean);
    const truthByStart = new Map(truth.map((w) => [w.start, w.mean]));
    const nCand = truth.length;
    const worstTertile = new Set(truth.slice(Math.ceil(nCand * 2 / 3)).map((w) => w.start));

    const pick = windowMeans(r.rec.f).sort((a, b) => a.mean - b.mean)[0].start;
    const best = truth[0].start;

    const a = new Set(Array.from({ length: WINDOW_LEN }, (_, i) => pick + i));
    const b = new Set(Array.from({ length: WINDOW_LEN }, (_, i) => best + i));
    overlapSum += [...a].filter((h) => b.has(h)).length / WINDOW_LEN;

    // Percentile of the picked window among candidates by measured concentration
    // (0% = genuinely the best available hours, 100% = the worst).
    const rank = truth.findIndex((w) => w.start === pick);
    pctSum += rank / (nCand - 1);

    if (worstTertile.has(pick)) harm += 1;
    if (worstTertile.has(climPick.get(r.station))) harmClim += 1;
    if (worstTertile.has(DAY_START)) harmFirst += 1;
    n += 1;
    void truthByStart;
  }

  console.log(
    taxon.label.padEnd(7) +
    String(n).padStart(6) +
    (overlapSum / n).toFixed(2).padStart(9) +
    `${(pctSum / n * 100).toFixed(0)}%`.padStart(23) +
    `${(harm / n * 100).toFixed(0)}%`.padStart(12) +
    `${(harmClim / n * 100).toFixed(0)}%`.padStart(24) +
    `${(harmFirst / n * 100).toFixed(0)}%`.padStart(20)
  );
}

// ─── Is the timing defect fixable? Re-score the window after a per-taxon shift ─

console.log('\n' + '='.repeat(96));
console.log('METRIC 2b — DOES A PER-TAXON HOUR SHIFT RESCUE THE WINDOW?');
console.log('='.repeat(96));
console.log('The cheapest possible correction: rotate the model\'s diurnal curve by the median');
console.log('peak-hour offset and re-score. If this closes the gap to the trivial baselines, the');
console.log('feature is repairable with a static coefficient. If not, the premise is the problem.\n');
console.log('taxon  shift   harm (raw)   harm (shifted)   best trivial baseline   verdict');
console.log('-'.repeat(96));

const rotate = (v, by) => v.map((_, i) => v[(i - by + 24 * 4) % 24]);

for (const taxon of TAXA) {
  const rows = perTaxon.get(taxon.key);
  const s = summary[taxon.key];
  if (!rows || rows.length < 10 || !s) continue;
  const shift = -s.medianOffset; // undo the model's lateness/earliness

  let harmRaw = 0, harmShift = 0, harmClim = 0, harmFirst = 0, n = 0;
  const climPick = new Map();
  for (const st of new Set(rows.map((r) => r.station))) {
    const sub = rows.filter((r) => r.station === st);
    const avg = Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.rec.f[h])));
    climPick.set(st, windowMeans(avg).sort((a, b) => a.mean - b.mean)[0].start);
  }

  for (const r of rows) {
    const truth = windowMeans(r.rec.m).sort((a, b) => a.mean - b.mean);
    const worst = new Set(truth.slice(Math.ceil(truth.length * 2 / 3)).map((w) => w.start));
    const pickRaw = windowMeans(r.rec.f).sort((a, b) => a.mean - b.mean)[0].start;
    const pickShift = windowMeans(rotate(r.rec.f, shift)).sort((a, b) => a.mean - b.mean)[0].start;
    if (worst.has(pickRaw)) harmRaw += 1;
    if (worst.has(pickShift)) harmShift += 1;
    if (worst.has(climPick.get(r.station))) harmClim += 1;
    if (worst.has(DAY_START)) harmFirst += 1;
    n += 1;
  }

  const bestTrivial = Math.min(harmClim, harmFirst) / n;
  const shifted = harmShift / n;
  const verdict =
    shifted <= bestTrivial * 0.9 ? 'shift wins — worth shipping'
      : shifted <= bestTrivial * 1.1 ? 'ties the trivial rule'
        : 'still loses to a trivial rule';

  console.log(
    taxon.label.padEnd(7) +
    `${shift >= 0 ? '+' : ''}${shift}h`.padStart(6) +
    `${(harmRaw / n * 100).toFixed(0)}%`.padStart(13) +
    `${(shifted * 100).toFixed(0)}%`.padStart(17) +
    `${(bestTrivial * 100).toFixed(0)}%`.padStart(24) +
    '   ' + verdict
  );
}

// ─── Metric 4: magnitude, in-season hourly ────────────────────────────────────

console.log('\n' + '='.repeat(96));
console.log('METRIC 4 — MAGNITUDE (in-season hours, all stations pooled)');
console.log('='.repeat(96));
console.log('taxon     hours    log1p bias   log1p MAE   Spearman rho   measured mean   model mean');
console.log('-'.repeat(96));

for (const taxon of TAXA) {
  const ms = [], fs = [];
  for (const station of measured.keys()) {
    const days = pairedDays(station, taxon.key);
    const season = inSeasonDates(days);
    for (const [date, rec] of days) {
      if (!season.has(date)) continue;
      for (let h = 0; h < 24; h++) { ms.push(rec.m[h]); fs.push(rec.f[h]); }
    }
  }
  if (ms.length < 100) { console.log(`${taxon.label.padEnd(9)} too few`); continue; }
  const lm = ms.map((v) => Math.log1p(Math.max(0, v)));
  const lf = fs.map((v) => Math.log1p(Math.max(0, v)));
  const bias = mean(lf.map((v, i) => v - lm[i]));
  const mae = mean(lf.map((v, i) => Math.abs(v - lm[i])));
  const rho = spearman(ms, fs);
  console.log(
    taxon.label.padEnd(9) +
    String(ms.length).padStart(7) +
    bias.toFixed(3).padStart(13) +
    mae.toFixed(3).padStart(12) +
    (rho ?? NaN).toFixed(3).padStart(15) +
    mean(ms).toFixed(1).padStart(16) +
    mean(fs).toFixed(1).padStart(13)
  );
}

// ─── Noise floor: what do two real traps achieve against each other? ──────────

console.log('\n' + '='.repeat(96));
console.log('NOISE FLOOR — measured vs measured at nearby station pairs');
console.log('='.repeat(96));
console.log('One rooftop trap is not an 11 km grid-cell mean, so some disagreement is irreducible.');
console.log('Whatever two real traps achieve against each other bounds what any model can reach.\n');
console.log('pair          km   taxon   days   anomaly r   log1p MAE   Spearman rho');
console.log('-'.repeat(96));

const PAIRS = [
  { a: 'PLU', b: 'PLO', km: 20, note: 'Lugano-Locarno, both south of the Alps' },
  { a: 'PBE', b: 'PPY', km: 40, note: 'Bern-Payerne, both plateau' },
  { a: 'PZH', b: 'PLZ', km: 45, note: 'Zurich-Luzern' },
];

for (const pair of PAIRS) {
  for (const taxon of TAXA) {
    const A = measured.get(pair.a), B = measured.get(pair.b);
    if (!A || !B) continue;

    const days = new Map();
    for (const [hourKey, rowA] of A) {
      const va = rowA[taxon.key], vb = B.get(hourKey)?.[taxon.key];
      if (va === undefined || vb === undefined) continue;
      const date = hourKey.slice(0, 10), hour = Number(hourKey.slice(11, 13));
      const rec = days.get(date) ?? { m: new Array(24).fill(null), f: new Array(24).fill(null) };
      rec.m[hour] = va; rec.f[hour] = vb;
      days.set(date, rec);
    }
    for (const [d, rec] of days) if (rec.m.some((v) => v === null) || rec.f.some((v) => v === null)) days.delete(d);

    const season = inSeasonDates(days);
    const rs = [], ms = [], fs = [];
    const qualifying = [];
    for (const [date, rec] of days) {
      if (!season.has(date)) continue;
      for (let h = 0; h < 24; h++) { ms.push(rec.m[h]); fs.push(rec.f[h]); }
      if (rec.m.reduce((x, y) => x + y, 0) / 24 < FLOOR) continue;
      const sa = shapeOf(rec.m), sb = shapeOf(rec.f);
      if (sa && sb) qualifying.push({ sa, sb });
    }
    if (qualifying.length < 10) continue;

    const ca = Array.from({ length: 24 }, (_, h) => mean(qualifying.map((q) => q.sa[h])));
    const cb = Array.from({ length: 24 }, (_, h) => mean(qualifying.map((q) => q.sb[h])));
    for (const q of qualifying) {
      rs.push(pearson(q.sa.map((v, h) => v - ca[h]), q.sb.map((v, h) => v - cb[h])));
    }
    const { r } = fisherMean(rs);
    const lm = ms.map((v) => Math.log1p(Math.max(0, v)));
    const lf = fs.map((v) => Math.log1p(Math.max(0, v)));

    console.log(
      `${pair.a}-${pair.b}`.padEnd(14) +
      String(pair.km).padStart(3) +
      '   ' + taxon.label.padEnd(8) +
      String(qualifying.length).padStart(5) +
      r.toFixed(3).padStart(12) +
      mean(lf.map((v, i) => Math.abs(v - lm[i]))).toFixed(3).padStart(12) +
      (spearman(ms, fs) ?? NaN).toFixed(3).padStart(15)
    );
  }
}

// ─── Segmentation: splice check by year, transferability by region ────────────

console.log('\n' + '='.repeat(96));
console.log('SEGMENTATION — splice check (by year) and transferability (by region)');
console.log('='.repeat(96));
console.log('2023 returned only ~5.4k of 8760 non-null model hours while 2024+ returned all of them,');
console.log('so the product may change character across the window. A stable r by year argues against');
console.log('a splice mattering. Region: S = south of the Alps, the closest analogue to Catalonia.\n');

const { stations: stationMeta } = JSON.parse(
  await readFile(join(REPO_ROOT, 'stations-meteoswiss.json'), 'utf8')
);
const alpsOf = new Map(stationMeta.map((s) => [s.id, s.alps]));

function anomalyRFor(rows) {
  if (rows.length < 10) return { r: NaN, n: rows.length };
  const climM = new Map(), climF = new Map();
  for (const st of new Set(rows.map((r) => r.station))) {
    const sub = rows.filter((r) => r.station === st);
    climM.set(st, Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.sm[h]))));
    climF.set(st, Array.from({ length: 24 }, (_, h) => mean(sub.map((r) => r.sf[h]))));
  }
  const rs = rows.map((r) => {
    const cm = climM.get(r.station), cf = climF.get(r.station);
    return pearson(r.sm.map((v, h) => v - cm[h]), r.sf.map((v, h) => v - cf[h]));
  });
  const { r, n } = fisherMean(rs);
  return { r, n };
}

for (const dimension of ['year', 'region']) {
  console.log(`  by ${dimension}:`);
  const header = dimension === 'year' ? ['2023', '2024', '2025', '2026'] : ['N', 'S', 'A'];
  console.log('    taxon   ' + header.map((h) => `${h} (r / n)`.padStart(18)).join(''));
  for (const taxon of TAXA) {
    const rows = perTaxon.get(taxon.key);
    const cells = header.map((bucket) => {
      const sub = rows.filter((r) =>
        dimension === 'year' ? r.year === bucket : alpsOf.get(r.station) === bucket
      );
      const { r, n } = anomalyRFor(sub);
      return (Number.isFinite(r) ? `${r.toFixed(3)} / ${n}` : `– / ${sub.length}`).padStart(18);
    });
    console.log('    ' + taxon.label.padEnd(8) + cells.join(''));
  }
  console.log('');
}

console.log('\n' + '='.repeat(96));
console.log('READ THIS BEFORE QUOTING ANY NUMBER ABOVE');
console.log('='.repeat(96));
console.log(`
The modelled side is Open-Meteo's past-date values, verified on 2026-08-12 to
differ from the forecast that was actually issued. These are therefore an UPPER
BOUND on hourly skill, not a measurement of what the app showed anyone.

  - A weak result here IS decisive: no shipped forecast can beat its own hindcast.
  - A strong result here says nothing about shipped accuracy. That needs Study B,
    which began accumulating issued hourly forecasts on 2026-08-13.

Still open: whether CAMS assimilates pollen observations. If Swiss counts feed the
model, this comparison is partly self-comparison and BOTH studies are invalid.
Confirm against CAMS regional documentation before publishing.
`);
