# canibreathe-data

Static data repository for the [canIbreathe](https://github.com/arnautresserras/canIbreathe) app. Calendar data is fetched at runtime so it can be updated independently of any app release.

## Files

| File | Description |
|---|---|
| `season-calendars.json` | Per-station pollen season windows for all 9 PIA stations |

## Fetch URL

```
https://raw.githubusercontent.com/arnautresserras/canibreathe-data/main/season-calendars.json
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

All possible keys, matching the app's internal identifiers:

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
| `betula` | BETU | Birch |
| `artemisia` | — | Mugwort |
| `ambrosia` | — | Ragweed |

---

## How to update

1. Open the relevant PIA station calendar PDF from [aerobiologia.cat](https://aerobiologia.cat/pia/ca/bibliography#calendars).
2. Edit `season-calendars.json` — update the affected station's allergen arrays.
3. Set `updatedAt` to today's date.
4. Commit and push to `main`. The app picks up the new data within 7 days (cache TTL).

### Encoding guidelines

- Read each month cell from the PDF calendar and write its colour-band value (0–4) directly into the array at the corresponding index (Jan = 0, Dec = 11).
- Year-wrapping seasons (e.g. cupressaceae Dec–Mar): write the December value at index 11 and the Jan–Mar values at indices 0–2, e.g. `[3, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2]`.
- Year-round presence: fill all 12 slots with their respective values, e.g. `[1, 1, 1, 2, 3, 3, 2, 1, 1, 1, 1, 1]`.
- Allergens absent from a station's calendar: leave all 12 values as `0`.
