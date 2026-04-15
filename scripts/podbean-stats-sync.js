#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");
const MAX_PAGES = Number(process.env.PODBEAN_MAX_PAGES || 20);
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 600);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      "User-Agent": "CGBCPublicEpisodeSync/2.0",
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
  return String(str || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(str) {
  return decodeEntities(
    String(str || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  const s = String(url || "").trim();
  return s.replace(/\/+$/, "/");
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

function pageCandidates(baseUrl) {
  const root = normalizeUrl(baseUrl);
  const out = [root];
  for (let i = 2; i <= MAX_PAGES; i += 1) {
    out.push(`${root}page/${i}/`);
  }
  return out;
}

function extractEpisodeCards(html) {
  const cards = [];

  // Podbean/WordPress style articles with links and nearby Download N text.
  const articleRegex = /<article[\s\S]*?<\/article>/gi;
  const articleMatches = html.match(articleRegex) || [];

  for (const article of articleMatches) {
    const hrefMatches = [...article.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const visible = htmlToVisibleText(article);
    const downloadMatch = visible.match(/\bDownload\s+(\d+)\b/i);
    if (!downloadMatch) continue;

    let bestHref = null;
    let bestTitle = null;

    for (const match of hrefMatches) {
      const href = normalizeUrl(match[1]);
      const title = stripTags(match[2]);
      if (!href || !title) continue;
      if (/\/feed\/?$/i.test(href)) continue;
      if (/\.mp3($|\?)/i.test(href)) continue;
      if (/podbean\.com\/e\//i.test(href) || /\/\d{6,}\/?$/i.test(href)) {
        bestHref = href;
        bestTitle = title;
        break;
      }
    }

    if (bestHref && Number.isFinite(Number(downloadMatch[1]))) {
      cards.push({
        episode_url: bestHref,
        title: bestTitle || "",
        downloads: Number(downloadMatch[1]),
      });
    }
  }

  return cards;
}

async function scrapeAllListingPages(showUrl) {
  const pages = pageCandidates(showUrl);
  const byUrl = new Map();
  let pagesFetched = 0;

  for (const url of pages) {
    try {
      const html = await fetchHtml(url);
      pagesFetched += 1;

      const cards = extractEpisodeCards(html);
      if (!cards.length && url !== normalizeUrl(showUrl)) {
        break;
      }

      for (const card of cards) {
        const key = normalizeUrl(card.episode_url);
        const current = byUrl.get(key);
        if (!current || card.downloads > current.downloads) {
          byUrl.set(key, card);
        }
      }

      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      if (url === normalizeUrl(showUrl)) throw err;
      break;
    }
  }

  return {
    byUrl,
    pagesFetched,
  };
}

async function main() {
  const existing = readExistingStats(STATS_PATH);
  const homeHtml = await fetchHtml(PODBEAN_SHOW_URL);
  const visibleText = htmlToVisibleText(homeHtml);
  const totals = extractPodcastTotals(visibleText);
  const listing = await scrapeAllListingPages(PODBEAN_SHOW_URL);

  const now = new Date().toISOString();
  const episodes = safeObject(existing.episodes);

  let matchedEpisodes = 0;

  for (const [key, card] of listing.byUrl.entries()) {
    const current = safeObject(episodes[key]);

    episodes[key] = {
      ...current,
      identity_key: current.identity_key || key,
      episode_url: current.episode_url || key,
      permalink_url: current.permalink_url || key,
      title: current.title || card.title || "",
      plays_total: Math.max(Number(current.plays_total || current.downloads_total || 0), Number(card.downloads || 0)),
      downloads_total: Math.max(Number(current.downloads_total || current.plays_total || 0), Number(card.downloads || 0)),
      public_listing_downloads: Number(card.downloads || 0),
      last_public_listing_sync_at: now,
      public_listing_source: PODBEAN_SHOW_URL,
      downloads_by_date: safeObject(current.downloads_by_date),
    };

    matchedEpisodes += 1;
  }

  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_site",
      metric: "plays",
      strategy: "public_show_totals_and_episode_listing_scrape",
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
      source_url: PODBEAN_SHOW_URL,
    },
    episodes,
    summary: {
      ...(safeObject(existing.summary)),
      sync_type: "podcast_totals_plus_episode_listing",
      pages_fetched: listing.pagesFetched,
      episode_listing_matches: matchedEpisodes,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${STATS_PATH}`);
  console.log(
    `Totals -> plays=${output.podcast_totals.plays_total}, episodes=${output.podcast_totals.episodes_total}, matchedEpisodes=${matchedEpisodes}, pagesFetched=${listing.pagesFetched}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
