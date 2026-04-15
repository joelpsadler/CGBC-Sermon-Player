#!/usr/bin/env node
/**
 * Seed baseline Plays from:
 * 1) stats/downloads_stats.csv (stable identity + fallback count)
 * 2) public Podbean episode pages (visible "Download N" number)
 *
 * Matching strategy:
 * - Use Episode URL from CSV as the identity key
 * - Use Media URL as a secondary stable reference
 * - Title is display text only and can change later
 *
 * Baseline strategy:
 * - Prefer the public site "Download N" count
 * - Fallback to the CSV Downloads column if scraping fails
 * - Conservative: do not invent higher values
 */

const fs = require("fs");
const path = require("path");

const CSV_PATH = path.resolve(process.cwd(), "stats", "downloads_stats.csv");
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_BASELINE_DELAY_MS || 700);

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
  const rows = [];

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cols[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function readExistingStats(statsPath) {
  if (!fs.existsSync(statsPath)) {
    return {
      generated_at: null,
      source: {},
      episodes: {},
      summary: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch {
    return {
      generated_at: null,
      source: {},
      episodes: {},
      summary: {},
    };
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCBaselineSeed/1.0",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }

  return text;
}

function extractPublicDownloadCount(html) {
  // First try a local/visible "Download N" match.
  const direct = html.match(/Download\s+(\d+)/i);
  if (direct) return Number(direct[1]);

  // Fallback: broader regex for nearby "download" tokens.
  const fallback = html.match(/download[^0-9]{0,20}(\d+)/i);
  if (fallback) return Number(fallback[1]);

  return null;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV file at ${CSV_PATH}`);
  }

  const existing = readExistingStats(STATS_PATH);
  const csvRows = readCsv(CSV_PATH);
  const episodes = safeObject(existing.episodes);
  const seededAt = new Date().toISOString();

  let seeded = 0;
  let failed = 0;

  for (const row of csvRows) {
    const title = normalizeTitle(row["Episode"]);
    const episodeUrl = normalizeUrl(row["Episode URL"]);
    const mediaUrl = normalizeUrl(row["Media URL"]);
    const releaseDate = normalizeUrl(row["Release Date"]);
    const csvDownloads = Number(row["Downloads"] || 0);

    if (!episodeUrl) {
      failed += 1;
      continue;
    }

    const key = episodeUrl;
    const existingRecord = safeObject(episodes[key]);

    let publicDownloads = null;
    let sourceUsed = "csv_downloads";

    try {
      const html = await fetchPage(episodeUrl);
      publicDownloads = extractPublicDownloadCount(html);
      if (Number.isFinite(publicDownloads)) {
        sourceUsed = "podbean_public_episode_page";
      }
    } catch (err) {
      // Keep going; we'll fall back to CSV.
    }

    const baselineCount = Number.isFinite(publicDownloads)
      ? publicDownloads
      : csvDownloads;

    episodes[key] = {
      ...existingRecord,
      identity_key: key,
      episode_url: episodeUrl,
      media_url: mediaUrl,
      title,
      publish_time: releaseDate || existingRecord.publish_time || "",
      plays_total: Number(existingRecord.plays_total || existingRecord.downloads_total || 0),
      downloads_total: Number(existingRecord.downloads_total || existingRecord.plays_total || 0),
      baseline_seeded_at: existingRecord.baseline_seeded_at || seededAt,
      baseline_source: sourceUsed,
      baseline_csv_downloads: csvDownloads,
      baseline_public_downloads: Number.isFinite(publicDownloads) ? publicDownloads : null,
      last_baseline_refresh_at: seededAt,
      downloads_by_date: safeObject(existingRecord.downloads_by_date),
    };

    // Seed only upward from existing zero/empty values.
    const current = Number(episodes[key].plays_total || 0);
    const next = Number(baselineCount || 0);

    if (next > current) {
      episodes[key].plays_total = next;
      episodes[key].downloads_total = next;
    }

    seeded += 1;
    console.log(`Seeded ${title} -> ${episodes[key].plays_total} (${sourceUsed})`);
    await sleep(REQUEST_DELAY_MS);
  }

  const output = {
    generated_at: seededAt,
    source: {
      provider: "podbean_public_site_plus_csv",
      metric: "plays",
      strategy: "baseline_seed",
    },
    episodes,
    summary: {
      total_csv_rows_seen: csvRows.length,
      total_baseline_seeded: seeded,
      total_baseline_failed: failed,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
