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

Each allergen key inside a station maps to a season window object:

```json
"poaceae": {
  "startMonth": 4,
  "endMonth": 7,
  "peakMonths": [5, 6],
  "intensity": "high"
}
```

| Field | Type | Values | Description |
|---|---|---|---|
| `startMonth` | `number` | 1–12 | First month of season (January = 1). |
| `endMonth` | `number` | 1–12 | Last month of season. If less than `startMonth`, the season wraps the year boundary (e.g. cupressaceae: Dec→Mar is `startMonth: 12, endMonth: 3`). |
| `peakMonths` | `number[]` | 1–12 | Months of highest typical intensity. |
| `intensity` | `string` | `"low"` · `"moderate"` · `"high"` | Maximum intensity level for this allergen at this station, corresponding to the color scale in the PIA calendar. |

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

**If an allergen does not appear in a station's calendar, remove its entry from that station's object entirely.** Do not leave placeholder (`0`) values in a published file.

---

## How to update

1. Open the relevant PIA station calendar PDF from [aerobiologia.cat](https://aerobiologia.cat/pia/ca/bibliography#calendars).
2. Edit `season-calendars.json` — update the affected station's allergen entries.
3. Remove any allergen keys that do not appear in that station's calendar.
4. Set `updatedAt` to today's date.
5. Commit and push to `main`. The app picks up the new data within 7 days (cache TTL).

### Intensity mapping

The PIA calendars use a colour-coded scale. Map it as follows:

| Calendar colour | `intensity` value |
|---|---|
| Light / sparse dots | `"low"` |
| Medium / moderate shading | `"moderate"` |
| Dark / dense shading | `"high"` |
