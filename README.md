# canibreathe-data

Static data repository for the [canIbreathe](https://github.com/arnautresserras/canIbreathe) app. Calendar data is fetched at runtime so it can be updated independently of any app release.

## Files

| File | Description |
|---|---|
| `season-calendars.json` | Per-station pollen season windows for all 9 PIA stations — **fetched by the app at runtime** |
| `stations.json` | PIA station list + fallback coordinates, used by the snapshot job |
| `stations-meteoswiss.json` | The 15 MeteoSwiss automatic pollen traps. Sample points only — nothing is fetched *from* MeteoSwiss by the daily job. See [Hourly forecast verification](#hourly-forecast-verification) |
| `snapshots/` | Daily archive of what each source *forecast* — see [Forecast snapshots](#forecast-snapshots) |
| `measured/` | **Gitignored.** On-demand mirror of MeteoSwiss measured data — see [Hourly forecast verification](#hourly-forecast-verification) |

## Fetch URL

```
https://raw.githubusercontent.com/arnautresserras/canibreathe-data/master/season-calendars.json
```

---

## season-calendars.json schema

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `version` | `number` | Schema version. Increment if the structure changes in a breaking way. |
| `updatedAt` | `string` | ISO date of last edit (`YYYY-MM-DD`). |
| `source.name` | `string` | Name of the source publication. |
| `source.url` | `string` | URL of the source. |
| `source.year` | `number` | Year of the source publication. |
| `stations` | `object` | Keyed by station ID (see below). |

### Station IDs

Matches the PIA API station identifiers used in the app:

`barcelona` · `bellaterra` · `girona` · `lleida` · `manresa` · `roquetes` · `tarragona` · `vielha` · `balears`

### Per-allergen entry

Each allergen key inside a station maps to a 12-element array of monthly pollen levels, where index 0 = January and index 11 = December. Each value is an integer from 0 (absent) to 4 (very high).

```json
"poaceae": [0, 0, 0, 2, 3, 3, 2, 0, 0, 0, 0, 0]
```

The pollen level scale:

| Value | Level |
|---|---|
| `0` | Absent |
| `1` | Low |
| `2` | Moderate |
| `3` | High |
| `4` | Very High |

**If an allergen does not appear at a station, set all 12 values to `0`. Do not remove the key.**

### Allergen keys

All possible keys, in the same order as `AllergenKey` in
[`src/services/pollenData/pollenDataTypes.ts`](https://github.com/arnautresserras/canIbreathe/blob/master/src/services/pollenData/pollenDataTypes.ts).
Keep the two lists in sync — this table is the contract for `season-calendars.json`,
and a key the app doesn't know is silently ignored at runtime.

`artemisia` and `ambrosia` have no PIA code: no station traps them, so their calendar
rows come from the EAN European Pollen Calendar rather than a PIA PDF.

| Key | PIA code | Common name |
|---|---|---|
| `poaceae` | GRAM | Grasses |
| `parietaria` | URTI | Pellitory |
| `olea` | OLEA | Olive |
| `cruciferae` | CRUC | Mustard family |
| `platanus` | PLAT | Plane tree |
| `cupressaceae` | CUPR | Cypress family |
| `quercus` | QTOT | Oak |
| `alnus` | ALNU | Alder |
| `fraxinus` | FRAX | Ash |
| `ulmus` | ULMU | Elm |
| `corylus` | CORY | Hazel |
| `acer` | ACER | Maple |
| `pistacia` | PIST | Pistachio |
| `mercurialis` | MERC | Mercury |
| `moraceae` | MORA | Mulberry family |
| `pinus` | PINU | Pine |
| `plantago` | PLAN | Plantain |
| `populus` | POPU | Poplar |
| `salix` | SALI | Willow |
| `alternaria` | ALTE | Alternaria (fungal spore) |
| `cladosporium` | CLAD | Cladosporium (fungal spore) |
| `amaranthaceae` | QUAM | Goosefoot family |
| `fagus` | FAGU | Beech |
| `palmae` | PALM | Palm |
| `castanea` | CAST | Chestnut |
| `ligustrum` | LIGU | Privet |
| `betula` | BETU | Birch |
| `artemisia` | — | Mugwort |
| `ambrosia` | — | Ragweed |

---

## How to update

1. Open the relevant PIA station calendar PDF from [aerobiologia.cat](https://aerobiologia.cat/pia/ca/bibliography#calendars).
2. Edit `season-calendars.json` — update the affected station's allergen arrays.
3. Set `updatedAt` to today's date.
4. Commit and push to `master`. The app picks up the new data within 7 days (cache TTL).

### Encoding guidelines

- Read each month cell from the PDF calendar and write its colour-band value (0–4) directly into the array at the corresponding index (Jan = 0, Dec = 11).
- Year-wrapping seasons (e.g. cupressaceae Dec–Mar): write the December value at index 11 and the Jan–Mar values at indices 0–2, e.g. `[3, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2]`.
- Year-round presence: fill all 12 slots with their respective values, e.g. `[1, 1, 1, 2, 3, 3, 2, 1, 1, 1, 1, 1]`.
- Allergens absent from a station's calendar: leave all 12 values as `0`.

---

## Forecast snapshots

`snapshots/` is an append-only archive of what each pollen source **predicted** on
a given day. It exists so that PIA's measured concentration data — which arrives
roughly two weeks behind the forecast — can be paired against the forecast that
was actually published, for forecast-skill and bias analysis.

**Why this has to run every day:** the PIA public broadcast is overwritten every
week and archived nowhere reachable. Google Pollen is likewise unarchived. A day
without a snapshot is verification data that cannot be recovered later. Open-Meteo
is partially recoverable retroactively, but its air-quality endpoint returns
re-analysed past values rather than the forecast that was issued, so it is
captured here too.

### Layout

```
snapshots/pia/2026/2026-07-29.json         — raw XML per station, verbatim
snapshots/openmeteo/2026/2026-07-29.json   — daily mean/max per taxon + daily weather
snapshots/google/2026/2026-07-29.json      — raw response per station
```

One file per source per day, all 9 stations inside. Every file carries `date`
(local, Europe/Madrid) and `fetchedAtUtc`.

### What each source actually gives you

| Source | Granularity | Notes |
|---|---|---|
| PIA | One level `0`–`4` per taxon **per week**, plus a trend symbol (`A` increase, `=` stable, `D` decrease, `!` exceptional) | Not a per-day numeric forecast. The taxon set varies week to week, so it is stored as raw XML and re-parsed at analysis time. `stationMeta` records each week's validity window. |
| Open-Meteo | Hourly grains/m³ for 6 CAMS taxa, 5-day horizon | Per-day mean/max **plus the full hourly series** (schema 2, retained from 2026-08-12) and `hourlyCoverage`. Hourly used to be dropped; see [Hourly forecast verification](#hourly-forecast-verification) for why that changed. Hourly `european_aqi` is still dropped — nothing verifies it. |
| Google Pollen | Daily UPI index, 5-day horizon | Requested with `plantsDescription=false` to drop static boilerplate. |

Gridded sources are sampled at each trap's **exact coordinates as reported by the
PIA API**, not the app's rounded constants — several differ by 2–4 km.

Open-Meteo is additionally sampled at the **15 MeteoSwiss traps**, so 24 stations
appear in each `openmeteo` file, each tagged with its own `network` (`pia` /
`meteoswiss`) and `timezone`. PIA and Google are **not** widened to the Swiss
points: PIA has nothing to say about them, and Google is metered — the billed
volume stays at 9 calls/day.

---

## Hourly forecast verification

### Why hourly is now retained

The app's hourly pollen chart and its **"best time to go out"** window are built on
Open-Meteo's hourly pollen — for **every European location, including PIA ones**,
because PIA publishes one level per taxon per *week* and has no sub-day
granularity at all. That intraday shape has never been verified by anyone.

It couldn't be, until now: PIA's measured data is a **daily total**, and so is
Google's index and every regional source evaluated for this project. **MeteoSwiss
publishes real hourly measured concentrations** — free, no key, CC BY — for 7 taxa
across 15 stations since 2023-01-01. Three of those taxa (`alnus`, `betula`,
`poaceae`) overlap Open-Meteo/CAMS, which makes the hourly comparison possible for
the first time.

So the 15 Swiss traps are **an instrument, not an audience** — Switzerland has
approximately no app users. What they validate is a model that serves everyone in
Europe.

### The one thing that is unrecoverable

Only the **issued forecast** is ephemeral. The air-quality endpoint's past window
returns **re-analysed** values, not the forecast that was published, so a day not
captured here can never be paired against what a user was actually shown.

MeteoSwiss measurements, by contrast, are permanently archived by MeteoSwiss
(`_recent`, `_historical`). They are therefore **deliberately not snapshotted
daily** — doing so would add megabytes a day to a public repo to duplicate
something already durable. Pull them on demand instead:

```
node scripts/fetch-meteoswiss-measured.mjs                 # hourly, current year
node scripts/fetch-meteoswiss-measured.mjs --historical     # + archived blocks
node scripts/fetch-meteoswiss-measured.mjs --now --stations=PZH   # quick probe
```

Output lands in `measured/meteoswiss/` with a `manifest.json`, and is **gitignored**.

### Swiss traps are sampled in UTC

MeteoSwiss publishes its measured timestamps in **UTC**, so the forecast is
sampled in UTC at those coordinates while PIA traps stay on `Europe/Madrid`. Both
countries share the CET/CEST offset, so this is a labelling choice rather than a
different set of hours — but it removes a timezone conversion from the pairing
step, and a silent 1 h shift would corrupt the timing metric that is the whole
point of the exercise. Every station records its own `timezone`.

### Reading the archive

- **Parse MeteoSwiss CSVs by header name, never by column index.** The live header
  orders birch before grasses before alder — neither alphabetical nor the
  documented order.
- MeteoSwiss timestamps are `DD.MM.YYYY HH:MM` in UTC. **Not ISO** — `new Date()`
  on that string is invalid or engine-dependent.
- In a MeteoSwiss CSV, an **empty cell means "not reported"**; `0` is a real zero.
  Conflating them deflates every statistic with no error to alert you.
- Prefer the `*d1` daily variant (00→00 UTC) over `*d0` (06→06 UTC) when a daily
  aggregate is needed.

### `hourlyCoverage`, and what it already found

Each station records how many hours each taxon actually carries, plus the last
such timestamp. CAMS pollen **does not reach the end of the requested window**,
and without this a short day is indistinguishable from a genuinely calm one —
both aggregate to a low number.

It immediately showed something about the 05:10 UTC runs: on **14 of the 15 days
archived so far**, the hour counts per forecast day were `[24, 24, 24, 3, 0]`. The
4th day carries **three early-morning hours**, and the 5th nothing at all. Since
pollen typically peaks around midday, any daily figure derived from those three
hours under-reports. Worth keeping in mind before trusting the tail of any
Open-Meteo forecast day, here or in the app.

### Archive cost

~270 KB/day raw, but small repeated numbers compress well: **~18 KB/day compressed,
roughly 6 MB/year**. Two levers exist if that ever matters — hoist the shared
`time` axis (saves ~20 %, at the cost of putting an indirection between a value
and its hour, which is a bad trade for timing data), or prune years already
analysed. Neither is needed now. CI is unaffected: `actions/checkout` fetches a
shallow tree, not history.

### Running it

Automatically at 05:10 UTC daily via `.github/workflows/snapshot-forecasts.yml`,
or on demand from the Actions tab. Locally:

```
node scripts/snapshot-forecasts.mjs                          (all sources, today)
SOURCES=pia,openmeteo node scripts/snapshot-forecasts.mjs     (subset)
SNAPSHOT_DATE=2026-07-29 node scripts/snapshot-forecasts.mjs  (label override)
```

Node 20+, zero dependencies. The job exits non-zero only when **all** PIA stations
fail, since PIA is the one irreplaceable source; partial failures are recorded per
station inside the snapshot file and still committed.

### Google Pollen uses its own key

The keys shipped in the app binary (`EXPO_PUBLIC_GOOGLE_POLLEN_API_KEY_IOS` and
`..._ANDROID`) carry Android/iOS application restrictions and **are rejected from
CI**. Google capture therefore uses a third, server-side key — bare
`GOOGLE_POLLEN_API_KEY`, set as a **repository** secret (in place since
2026-07-30).

That key has no application restriction, since GitHub-hosted runners draw from
thousands of rotating IP ranges. Its containment is instead:

- an API restriction to the **Pollen API only**, and
- a **daily quota cap** — 9 stations × 1 call/day, worst case 27 with 5xx retries,
  so ~50/day leaves room for manual backfills while still tripping on abuse.
  Note that Pollen API quotas are **per Cloud project, not per key**: capping a
  project shared with the app keys would throttle the apps too.

Two things to keep in mind when touching this:

- **A missing key is a warning, not a failure.** The job skips Google, stays
  green, and the day's Google forecast is gone. The likeliest cause is creating
  the secret as an *environment* secret while the workflow declares no
  `environment:` — `secrets.GOOGLE_POLLEN_API_KEY` then resolves to `''`.
- **The key travels in the URL query string.** Snapshots are committed to this
  public repo, so never write a request URL into a snapshot payload or error
  field — that would publish the key permanently in git history.

### Measured concentration data does not belong here

This repository is public. PIA's non-public **measured** concentration data must
not be committed here unless its redistribution terms explicitly allow it. Keep it
in a private repository.

---

## Attribution

PIA data is © Punt d'Informació Aerobiològica
([aerobiologia.cat](https://aerobiologia.cat/pia/en/aboutus)), licensed
**CC BY-NC-SA 4.0**. Each archived payload carries its own credit block. Weather
and air-quality data from [Open-Meteo](https://open-meteo.com) (CC BY 4.0).
