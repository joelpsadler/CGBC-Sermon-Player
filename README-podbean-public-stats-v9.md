# Podbean public stats v9 replacement

Replace these two files in the repo:

- `scripts/seed-podbean-baseline.js`
- `scripts/podbean-stats-sync.js`

Then run:

1. GitHub → Actions
2. `Build Sermon Library`
3. `Run workflow`

What this version does:

- Uses the public Podbean show page as the live source.
- Uses the exact public show-header tooltip/title number for the top podcast total. This is the number hidden behind the rounded `3.9K` / `4K` display.
- Uses public paginated episode-card data for individual episode counts.
- Walks Podbean pagination using `listTotalPage`, up to `PODBEAN_MAX_PAGES` (default `10`).
- Keys stats records by `media_url` so old duplicate Podbean ID/permalink keys are dropped.
- Does **not** use `downloads_stats.csv` for current counts.
- Keeps CSV-related fields set to ignored/null so older files cannot override live public counts.
- Writes a detailed `summary` block into `stats/stats.json` showing exactly where the total came from.

After the run, check `stats/stats.json` and look for:

```json
"source": {
  "strategy": "canonical_public_paginated_refresh_v9_header_tooltip_total"
}
```

Then check:

```json
"summary": {
  "podcast_total_source": "public_header_title_tooltip",
  "current_public_podcast_downloads_from_header_tooltip": 3961,
  "episode_count_source": "public_paginated_episode_cards",
  "csv_used": false
}
```

If the top total and summed episode totals disagree, the script will still use the public header tooltip for the top total and write a warning in `summary.warnings`.
