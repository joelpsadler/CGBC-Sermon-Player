# Podbean Stats Fix

Replace these two files in the repo:

- `scripts/seed-podbean-baseline.js`
- `scripts/podbean-stats-sync.js`

No workflow restructure is required. Your existing `Build Sermon Library` workflow already runs both scripts, mirrors `stats/stats.json` to `data/stats.json` and `public/stats.json`, then rebuilds the resolved library.

After replacing the files, run:

1. Actions → Build Sermon Library → Run workflow
2. Open the completed log and check the `Summary -> ...` line.

Expected improvement:

- `previousKeys` may be around the old duplicate count.
- `written` should be close to the public Podbean episode total.
- `removedLegacyKeys` should be greater than zero on the first clean run.
- `totalPlays` should reflect the current public Podbean total from the site.

What changed:

- Public Podbean `window.__INITIAL_STATE__` is now the source of truth for current per-episode counts.
- `stats/stats.json` is rebuilt cleanly every run instead of mutating the old `episodes` object.
- Legacy duplicate keys are dropped instead of being copied forward.
- `plays_total`, `downloads_total`, `public_listing_downloads`, and `podbean_public_download_count` are all updated to the current public count.
