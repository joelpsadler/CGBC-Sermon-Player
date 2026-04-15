#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const CSV_PATH = path.resolve(process.cwd(), "stats", "downloads_stats.csv");
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");

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
      "User-Agent": "CGBCBaselineSeed/2.0",
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

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractListingCounts(visibleText) {
  const lines = visibleText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const titleToCount = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line === "Episodes" || line === "Load more") continue;
    if (/^Download\s+\d+$/i.test(line)) continue;
    if (/^Likes$/i.test(line)) continue;
    if (/^Share$/i.test(line)) continue;
    if (/^Read more$/i.test(line)) continue;
    if (/^RSS$/i.test(line)) continue;

    const next = lines[i + 1] || "";
    if (/^Download\s+\d+$/i.test(next)) {
      const titleKey = normalizeTitle(line);
      const count = Number(next.replace(/[^\d]/g, ""));
      if (titleKey && Number.isFinite(count)) {
        titleToCount.set(titleKey, count);
      }
    }
  }

  return titleToCount;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV at ${CSV_PATH}`);
  }

  const existing = readExistingStats(STATS_PATH);
  const rows = readCsv(CSV_PATH);

  const html = await fetchHtml(PODBEAN_SHOW_URL);
  const visibleText = htmlToVisibleText(html);
  const titleToCount = extractListingCounts(visibleText);

  const episodes = safeObject(existing.episodes);
  const now = new Date().toISOString();

  let seeded = 0;
  let matchedPublic = 0;
  let fellBackToCsv = 0;

  for (const row of rows) {
    const episodeUrl = String(row["Episode URL"] || "").trim();
    const mediaUrl = String(row["Media URL"] || "").trim();
    const title = String(row["Episode"] || "").trim();
    const releaseDate = String(row["Release Date"] || "").trim();
    const csvDownloads = Number(row["Downloads"] || 0);

    if (!episodeUrl) continue;

    const titleKey = normalizeTitle(title);
    const publicDownloads = titleToCount.has(titleKey) ? titleToCount.get(titleKey) : null;
    const chosen = Number.isFinite(publicDownloads) ? publicDownloads : csvDownloads;
    const source = Number.isFinite(publicDownloads)
      ? "podbean_public_show_listing"
      : "csv_downloads";

    if (Number.isFinite(publicDownloads)) matchedPublic += 1;
    else fellBackToCsv += 1;

    const current = safeObject(episodes[episodeUrl]);

    episodes[episodeUrl] = {
      ...current,
      identity_key: episodeUrl,
      episode_url: episodeUrl,
      media_url: mediaUrl,
      title,
      publish_time: releaseDate || current.publish_time || "",
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
      strategy: "listing_page_title_match_seed",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: safeObject(existing.podcast_totals),
    episodes,
    summary: {
      total_csv_rows_seen: rows.length,
      total_baseline_seeded: seeded,
      total_public_title_matches: matchedPublic,
      total_csv_fallbacks: fellBackToCsv,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
  console.log(`Summary -> seeded=${seeded}, publicMatches=${matchedPublic}, csvFallbacks=${fellBackToCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
