# Public Podbean totals package

Replace these files in your repo:
- `scripts/podbean-stats-sync.js`
- `.github/workflows/podbean-stats-sync.yml`

What this version does:
- Stops using the unreliable Podbean stats API for front-end totals
- Scrapes the public Podbean show page for:
  - total Plays
  - total Episodes
- Updates `stats/stats.json`
- Runs twice daily in GitHub Actions

This does not change your per-episode counts yet.
