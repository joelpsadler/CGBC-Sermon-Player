#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");

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
    console.warn(`Could not parse existing stats.json: ${err.message}`);
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
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }
  return html;
}

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToVisibleText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/section>/gi, "\n")
      .replace(/<\/article>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function parseCompactNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;

  const n = Number(match[1]);
  const suffix = match[2] || "";
  const scale = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
  return Math.round(n * scale);
}

function extractPodcastTotals(visibleText) {
  const compact = visibleText.replace(/\n/g, " ");

  let plays = null;
  let episodes = null;

  const pairMatch = compact.match(/(\d+(?:\.\d+)?[KMB]?)\s+Downloads\s+(\d+)\s+Episodes/i);
  if (pairMatch) {
    plays = parseCompactNumber(pairMatch[1]);
    episodes = Number(pairMatch[2]);
  }

  if (!Number.isFinite(plays)) {
    const playsMatch = compact.match(/(\d+(?:\.\d+)?[KMB]?)\s+Downloads/i);
    if (playsMatch) plays = parseCompactNumber(playsMatch[1]);
  }

  if (!Number.isFinite(episodes)) {
    const epMatch = compact.match(/(\d+)\s+Episodes/i);
    if (epMatch) episodes = Number(epMatch[1]);
  }

  return {
    plays: Number.isFinite(plays) ? plays : null,
    episodes: Number.isFinite(episodes) ? episodes : null,
  };
}

async function main() {
  const existing = readExistingStats(STATS_PATH);
  const html = await fetchHtml(PODBEAN_SHOW_URL);
  const visibleText = htmlToVisibleText(html);
  const totals = extractPodcastTotals(visibleText);

  const now = new Date().toISOString();

  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_site",
      metric: "plays",
      strategy: "public_show_totals_scrape",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: {
      ...(safeObject(existing.podcast_totals)),
      plays_total: Number.isFinite(totals.plays)
        ? totals.plays
        : Number(existing?.podcast_totals?.plays_total || 0),
      episodes_total: Number.isFinite(totals.episodes)
        ? totals.episodes
        : Number(existing?.podcast_totals?.episodes_total || 0),
      last_updated: now,
    },
    episodes: safeObject(existing.episodes),
    summary: {
      ...(safeObject(existing.summary)),
      sync_type: "podcast_totals_only",
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${STATS_PATH}`);
  console.log(
    `Totals -> plays=${output.podcast_totals.plays_total}, episodes=${output.podcast_totals.episodes_total}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
