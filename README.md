# canibreathe-data

Static data repository for the [canIbreathe](https://github.com/arnautresserras/canIbreathe) app. Calendar data is fetched at runtime so it can be updated independently of any app release.

## Files

| File | Description |
|---|---|
| `season-calendars.json` | Per-station pollen season windows for all 9 PIA stations — **fetched by the app at runtime** |
| `stations.json` | PIA station list + fallback coordinates, used by the snapshot job |
| `snapshots/` | Daily archive of what each source *forecast* — see [Forecast snapshots](#forecast-snapshots) |

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
| Open-Meteo | Hourly grains/m³ for 6 CAMS taxa, 5-day horizon | Aggregated to per-day mean/max. Hourly is dropped on purpose — the measured data is a daily total, so hourly adds size without adding anything verifiable. |
| Google Pollen | Daily UPI index, 5-day horizon | Requested with `plantsDescription=false` to drop static boilerplate. |

Gridded sources are sampled at each trap's **exact coordinates as reported by the
PIA API**, not the app's rounded constants — several differ by 2–4 km.

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
