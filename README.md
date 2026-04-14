# Podbean Stats Automation Scaffold

This package adds a private stats sync layer without changing the working player yet.

## Files
- `scripts/podbean-stats-sync.js`
- `.github/workflows/podbean-stats-sync.yml`
- `stats/stats.json`

## GitHub setup
Add repo secrets:
- `PODBEAN_CLIENT_ID`
- `PODBEAN_CLIENT_SECRET`

## Why this structure
- No Podbean secret in browser code
- Player still loads from RSS first
- `stats.json` is optional and can fail safely
- Easy to schedule with GitHub Actions

## Next front-end step
The player can fetch `/stats/stats.json` after render and merge `downloads_total` into episodes.
