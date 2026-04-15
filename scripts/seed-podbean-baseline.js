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
      "User-Agent": "CGBCVisibleTextSeed/3.0",
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

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "/");
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\|/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
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

function isNoiseLine(line) {
  return !line ||
    /^Likes$/i.test(line) ||
    /^Share$/i.test(line) ||
    /^Read more$/i.test(line) ||
    /^RSS$/i.test(line) ||
    /^Episodes$/i.test(line) ||
    /^Home$/i.test(line) ||
    /^Cancel$/i.test(line) ||
    /^Subscribe$/i.test(line) ||
    /^Profile$/i.test(line) ||
    /^\d+(?:\.\d+)?[KMB]?$/i.test(line) ||
    /^Downloads$/i.test(line);
}

function extractEpisodePairsFromVisibleText(visibleText) {
  const lines = visibleText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^Download\s+(\d+)$/i);
    if (!match) continue;

    const downloads = Number(match[1]);
    let title = null;

    for (let j = i - 1; j >= Math.max(0, i - 18); j -= 1) {
      const candidate = lines[j];
      if (isNoiseLine(candidate)) continue;
      if (/^Title:/i.test(candidate)) continue;
      if (/^Series:/i.test(candidate)) continue;
      if (/^Scripture:/i.test(candidate)) continue;
      if (/^by:/i.test(candidate)) continue;
      if (/^Date:/i.test(candidate)) continue;
      if (/^Video:/i.test(candidate)) continue;
      if (/^\d+\s+days?\s+ago$/i.test(candidate)) continue;
      if (/^[A-Za-z]{3,9}\s+[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}$/i.test(candidate)) continue;
      if (/^[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}$/i.test(candidate)) continue;
      if (/^CGBC\b/i.test(candidate)) continue;
      if (/^Established in/i.test(candidate)) continue;
      if (/^https?:\/\//i.test(candidate)) continue;

      title = candidate;
      break;
    }

    if (title) {
      out.push({
        title,
        title_key: normalizeTitle(title),
        downloads,
      });
    }
  }

  return out;
}

async function scrapeAllPages(showUrl) {
  const pages = pageCandidates(showUrl);
  const pairs = [];
  let pagesFetched = 0;

  for (const url of pages) {
    try {
      const html = await fetchHtml(url);
      pagesFetched += 1;
      const visibleText = htmlToVisibleText(html);

      const extracted = extractEpisodePairsFromVisibleText(visibleText);
      if (!extracted.length && url !== normalizeUrl(showUrl)) {
        break;
      }

      pairs.push(...extracted);
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      if (url === normalizeUrl(showUrl)) throw err;
      break;
    }
  }

  return {
    pagesFetched,
    pairs,
  };
}

function buildCsvRows(csvRows) {
  return csvRows.map((row) => {
    const episodeUrl = normalizeUrl(row["Episode URL"]);
    const mediaUrl = String(row["Media URL"] || "").trim();
    const title = String(row["Episode"] || "").trim();
    const releaseDate = String(row["Release Date"] || "").trim();
    const csvDownloads = Number(row["Downloads"] || 0);

    return {
      episodeUrl,
      mediaUrl,
      title,
      releaseDate,
      csvDownloads,
      titleKey: normalizeTitle(title),
    };
  }).filter((row) => row.episodeUrl);
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV at ${CSV_PATH}`);
  }

  const existing = readExistingStats(STATS_PATH);
  const csvRows = buildCsvRows(readCsv(CSV_PATH));
  const scrape = await scrapeAllPages(PODBEAN_SHOW_URL);

  const publicByTitle = new Map();
  for (const pair of scrape.pairs) {
    if (!publicByTitle.has(pair.title_key) || pair.downloads > publicByTitle.get(pair.title_key).downloads) {
      publicByTitle.set(pair.title_key, pair);
    }
  }

  const episodes = safeObject(existing.episodes);
  const now = new Date().toISOString();

  let seeded = 0;
  let publicMatches = 0;
  let csvFallbacks = 0;

  for (const row of csvRows) {
    const publicPair = publicByTitle.get(row.titleKey);
    const publicDownloads = publicPair ? Number(publicPair.downloads || 0) : null;

    const chosen = Number.isFinite(publicDownloads) ? publicDownloads : row.csvDownloads;
    const source = Number.isFinite(publicDownloads)
      ? "podbean_public_visible_text"
      : "csv_downloads";

    if (Number.isFinite(publicDownloads)) publicMatches += 1;
    else csvFallbacks += 1;

    const current = safeObject(episodes[row.episodeUrl]);

    episodes[row.episodeUrl] = {
      ...current,
      identity_key: current.identity_key || row.episodeUrl,
      episode_url: current.episode_url || row.episodeUrl,
      permalink_url: current.permalink_url || row.episodeUrl,
      media_url: current.media_url || row.mediaUrl,
      title: current.title || row.title,
      publish_time: current.publish_time || row.releaseDate,
      plays_total: Math.max(Number(current.plays_total || current.downloads_total || 0), Number(chosen || 0)),
      downloads_total: Math.max(Number(current.downloads_total || current.plays_total || 0), Number(chosen || 0)),
      baseline_seeded_at: current.baseline_seeded_at || now,
      baseline_source: source,
      baseline_csv_downloads: row.csvDownloads,
      baseline_public_downloads: Number.isFinite(publicDownloads) ? publicDownloads : null,
      baseline_public_title: publicPair ? publicPair.title : null,
      baseline_public_title_key: publicPair ? publicPair.title_key : null,
      last_baseline_refresh_at: now,
      downloads_by_date: safeObject(current.downloads_by_date),
    };

    seeded += 1;
    console.log(`Seeded ${row.title} -> ${episodes[row.episodeUrl].plays_total} (${source})`);
  }

  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_site_plus_csv",
      metric: "plays",
      strategy: "visible_text_block_seed",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: safeObject(existing.podcast_totals),
    episodes,
    summary: {
      total_csv_rows_seen: csvRows.length,
      total_baseline_seeded: seeded,
      total_public_title_matches: publicMatches,
      total_csv_fallbacks: csvFallbacks,
      listing_pages_fetched: scrape.pagesFetched,
      visible_text_pairs_found: scrape.pairs.length,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
  console.log(`Summary -> seeded=${seeded}, publicTitleMatches=${publicMatches}, csvFallbacks=${csvFallbacks}, visiblePairs=${scrape.pairs.length}, pagesFetched=${scrape.pagesFetched}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
