Replace these files in your repo:

- scripts/podbean-stats-sync.js
- scripts/seed-podbean-baseline.js
- .github/workflows/podbean-stats-sync.yml

Then rerun:
1. Seed Podbean Baseline
2. Sync Podbean Stats

What changed:
- totals scraper now reads the public show page text and extracts `Downloads` + `Episodes`
- seed script now matches the public show listing titles to the CSV titles
- seed keeps Episode URL as the stored identity key
- sync runs twice daily
