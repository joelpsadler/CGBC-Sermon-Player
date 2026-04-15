#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const CSV_PATH = path.resolve(process.cwd(), "stats", "downloads_stats.csv");
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");
const MAX_PAGES = Number(process.env.PODBEAN_MAX_PAGES || 20);
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 600);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }

  out.push(cur);
  return out.map((s) => s.trim());
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? "";
    });
    return row;
  });
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
      "User-Agent": "CGBCEpisodeSeed/3.0",
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
  return String(url || "").trim().replace(/\/+$/, "/");
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
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV at ${CSV_PATH}`);
  }

  const rows = readCsv(CSV_PATH);
  const existing = readExistingStats(STATS_PATH);
  const listing = await scrapeAllListingPages(PODBEAN_SHOW_URL);

  const episodes = safeObject(existing.episodes);
  const now = new Date().toISOString();

  let seeded = 0;
  let publicMatches = 0;
  let csvFallbacks = 0;

  for (const row of rows) {
    const episodeUrl = normalizeUrl(row["Episode URL"]);
    const mediaUrl = String(row["Media URL"] || "").trim();
    const title = String(row["Episode"] || "").trim();
    const releaseDate = String(row["Release Date"] || "").trim();
    const csvDownloads = Number(row["Downloads"] || 0);

    if (!episodeUrl) continue;

    const publicCard = listing.byUrl.get(episodeUrl);
    const publicDownloads = publicCard ? Number(publicCard.downloads || 0) : null;

    const chosen = Number.isFinite(publicDownloads) ? publicDownloads : csvDownloads;
    const source = Number.isFinite(publicDownloads)
      ? "podbean_public_show_listing"
      : "csv_downloads";

    if (Number.isFinite(publicDownloads)) publicMatches += 1;
    else csvFallbacks += 1;

    const current = safeObject(episodes[episodeUrl]);

    episodes[episodeUrl] = {
      ...current,
      identity_key: current.identity_key || episodeUrl,
      episode_url: current.episode_url || episodeUrl,
      permalink_url: current.permalink_url || episodeUrl,
      media_url: current.media_url || mediaUrl,
      title: current.title || title,
      publish_time: current.publish_time || releaseDate,
      plays_total: Math.max(Number(current.plays_total || current.downloads_total || 0), Number(chosen || 0)),
      downloads_total: Math.max(Number(current.downloads_total || current.plays_total || 0), Number(chosen || 0)),
      baseline_seeded_at: current.baseline_seeded_at || now,
      baseline_source: source,
      baseline_csv_downloads: csvDownloads,
      baseline_public_downloads: Number.isFinite(publicDownloads) ? publicDownloads : null,
      last_baseline_refresh_at: now,
      downloads_by_date: safeObject(current.downloads_by_date),
    };

    seeded += 1;
    console.log(`Seeded ${title} -> ${episodes[episodeUrl].plays_total} (${source})`);
  }

  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_site_plus_csv",
      metric: "plays",
      strategy: "listing_page_url_match_seed",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: safeObject(existing.podcast_totals),
    episodes,
    summary: {
      total_csv_rows_seen: rows.length,
      total_baseline_seeded: seeded,
      total_public_url_matches: publicMatches,
      total_csv_fallbacks: csvFallbacks,
      listing_pages_fetched: listing.pagesFetched,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
  console.log(`Summary -> seeded=${seeded}, publicUrlMatches=${publicMatches}, csvFallbacks=${csvFallbacks}, pagesFetched=${listing.pagesFetched}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
