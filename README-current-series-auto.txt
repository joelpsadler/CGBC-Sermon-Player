# CGBC Current Series Auto-Detection Patch

Replace these files in the repo:

- `scripts/resolve-library.js`
- `config/resolver-config.json`
- `index.html`

Then run:

1. GitHub → Actions
2. `Build Sermon Library`
3. `Run workflow`

What changed:

- The build now writes `current` data into `data/library-resolved.json` / `public/library-resolved.json`.
- The frontend now reads `library-resolved.json.current.seriesKeys` instead of relying only on the old hardcoded `CURRENT_SERIES_KEYS` list.
- Current series are auto-detected by lane:
  - newest regular Sunday series = Sunday current
  - newest regular Wednesday series = Wednesday current
- Specials, guest speakers, livestreams, and shorts are ignored for current detection.
- Manual override is available in `config/resolver-config.json`:

```json
"currentSeries": {
  "overrides": {
    "sunday": null,
    "wednesday": null
  }
}
```

If automatic detection ever needs help, set one lane to the exact series key, for example:

```json
"sunday": "romans-chapter-12"
```

Leave the value as `null` for normal automatic behavior.

Expected output example in `library-resolved.json`:

```json
"current": {
  "strategy": "auto_detect_by_sunday_wednesday_lanes",
  "seriesKeys": ["romans-chapter-12", "the-rapture"],
  "lanes": {
    "sunday": { "seriesKey": "romans-chapter-12" },
    "wednesday": { "seriesKey": "the-rapture" }
  }
}
```
