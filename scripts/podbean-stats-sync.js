#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL = process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 1200);

const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readExistingStats(statsPath) {
  if (!fs.existsSync(statsPath)) {
    return {
      generated_at: null,
      source: {},
      podcast_totals: {},
      episodes: {},
      summary: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch (err) {
    console.warn(`Could not parse existing stats.json, starting fresh: ${err.message}`);
    return {
      generated_at: null,
      source: {},
      podcast_totals: {},
      episodes: {},
      summary: {},
    };
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCPublicTotalsSync/1.0",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }

  return text;
}

function parseCompactNumber(value) {
  const clean = String(value || "").trim().toUpperCase().replace(/,/g, "");
  if (!clean) return null;

  const match = clean.match(/^(\d+(?:\.\d+)?)([KM]?)$/);
  if (!match) return null;

  const num = Number(match[1]);
  const suffix = match[2];

  if (!Number.isFinite(num)) return null;
  if (suffix === "K") return Math.round(num * 1000);
  if (suffix === "M") return Math.round(num * 1000000);
  return Math.round(num);
}

function extractPodcastTotals(html) {
  // These labels appear on the public Podbean show page.
  const downloadsMatch = html.match(/([0-9][0-9.,KkMm]*)\s*Downloads/i);
  const episodesMatch = html.match(/([0-9][0-9.,KkMm]*)\s*Episodes/i);

  return {
    plays_total: downloadsMatch ? parseCompactNumber(downloadsMatch[1]) : null,
    episodes_total: episodesMatch ? parseCompactNumber(episodesMatch[1]) : null,
  };
}

async function main() {
  const existing = readExistingStats(STATS_PATH);
  const html = await fetchHtml(PODBEAN_SHOW_URL);
  await sleep(REQUEST_DELAY_MS);

  const extracted = extractPodcastTotals(html);

  const todayIso = new Date().toISOString();

  const output = {
    generated_at: todayIso,
    source: {
      ...safeObject(existing.source),
      provider: "podbean_public_listing_page",
      metric: "plays",
      strategy: "public_totals_scrape",
    },
    podcast_totals: {
      plays_total: Number.isFinite(extracted.plays_total)
        ? extracted.plays_total
        : Number(safeObject(existing.podcast_totals).plays_total || 0),
      episodes_total: Number.isFinite(extracted.episodes_total)
        ? extracted.episodes_total
        : Number(safeObject(existing.podcast_totals).episodes_total || 0),
      last_updated: todayIso,
      source_url: PODBEAN_SHOW_URL,
    },
    episodes: safeObject(existing.episodes),
    summary: {
      ...safeObject(existing.summary),
      totals_sync_status: Number.isFinite(extracted.plays_total) || Number.isFinite(extracted.episodes_total)
        ? "success"
        : "no_match_found_keep_existing",
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${STATS_PATH}`);
  console.log(`Totals -> plays=${output.podcast_totals.plays_total}, episodes=${output.podcast_totals.episodes_total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
