# Podbean baseline seed package

Replace/add these files in your repo:

- `scripts/seed-podbean-baseline.js`
- `.github/workflows/seed-podbean-baseline.yml`

Also upload your CSV to:
- `stats/downloads_stats.csv`

## What this does
- Reads `stats/downloads_stats.csv`
- Uses `Episode URL` as the identity key
- Scrapes the public Podbean episode page for the visible `Download N`
- Falls back to the CSV Downloads column if needed
- Seeds `stats/stats.json` with a baseline Plays value

## Why this is the right seed
- URLs are more stable than titles
- The public site count is the closest public baseline you have now
- Your running stats file becomes the source of truth after seeding

## After seeding
Run your normal daily sync workflow to keep growing the numbers over time.
