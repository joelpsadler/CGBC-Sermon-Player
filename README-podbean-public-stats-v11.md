# CGBC Podbean Public Stats v11

Replace these files in the repo:

- `scripts/seed-podbean-baseline.js`
- `scripts/podbean-stats-sync.js`

Then run:

- Actions → Build Sermon Library → Run workflow

What this version does:

- Uses the exact public Podbean header tooltip/title value for the big audio total when available.
- Uses public paginated episode cards for per-episode counts.
- Does not use CSV for current counts.
- Keeps media URL as the canonical episode key.
- Adds monotonic count protection:
  - the top podcast total only updates downward if there is no previous total; otherwise a lower scraped number is ignored.
  - each episode count only updates when the scraped public count is greater than or equal to the stored count.
- Writes summary/debug fields so you can see the scraped candidate and whether monotonic protection was used.

After the run, check `stats/stats.json`:

- `source.strategy` should be `canonical_public_paginated_refresh_v11_monotonic_public_totals`
- `summary.current_public_podcast_downloads_candidate` shows what Podbean returned this run
- `summary.current_public_podcast_downloads` shows what was published after monotonic protection
- `summary.current_public_podcast_downloads_monotonic_protected` tells whether a lower candidate was ignored
- `summary.episode_counts_monotonic_protected` tells how many episode counts were protected from going down
