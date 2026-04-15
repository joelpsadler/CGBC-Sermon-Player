#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const CSV_PATH = path.resolve(process.cwd(), "stats", "downloads_stats.csv");
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");
const MAX_PAGES = Number(process.env.PODBEAN_MAX_PAGES || 10);
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "/");
}

function toAbsolutePermalink(showUrl, permalink) {
  const root = normalizeUrl(showUrl);
  if (!permalink) return "";
  const raw = String(permalink).trim();
  if (/^https?:\/\//i.test(raw)) return normalizeUrl(raw);
  return normalizeUrl(root.replace(/\/$/, "") + "/" + raw.replace(/^\//, ""));
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
      "User-Agent": "CGBCInitialStateSeed/4.0",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }
  return html;
}

function extractInitialState(html) {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*"([\s\S]*?)"\s*<\/script>/i);
  if (!match) {
    throw new Error("Could not find window.__INITIAL_STATE__ in HTML");
  }

  const escaped = match[1];
  const decoded = JSON.parse('"' + escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  return JSON.parse(decoded);
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    visit(value);
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    for (const v of Object.values(value)) walk(v, visit);
  }
}

function findEpisodeRecords(state, showUrl) {
  const records = [];
  const seen = new Set();

  walk(state, (node) => {
    if (!Array.isArray(node) || !node.length) return;
    const looksLikeEpisodeArray = node.some((item) =>
      item &&
      typeof item === "object" &&
      ("downloadCount" in item) &&
      ("title" in item) &&
      ("permalink" in item || "permalink_url" in item)
    );

    if (!looksLikeEpisodeArray) return;

    for (const item of node) {
      if (!item || typeof item !== "object") continue;
      const permalink = toAbsolutePermalink(showUrl, item.permalink || item.permalink_url || "");
      const mediaUrl = String(item.mediaUrl || item.media_url || "").trim();
      const title = String(item.title || "").trim();
      if (!title || !permalink) continue;

      const key = permalink + "::" + mediaUrl;
      if (seen.has(key)) continue;
      seen.add(key);

      records.push({
        permalink_url: permalink,
        media_url: mediaUrl,
        title,
        title_key: normalizeTitle(title),
        download_count: Number(item.downloadCount || 0),
        publish_time: item.datePublished || item.publish_time || item.publishDate || null,
      });
    }
  });

  return records;
}

function findBaseInfo(state) {
  let best = null;
  walk(state, (node) => {
    if (
      node &&
      typeof node === "object" &&
      ("podcastDownloads" in node || "totalEpisodes" in node || "podcastTitle" in node)
    ) {
      best = node;
    }
  });
  return safeObject(best);
}

function findPaginationInfo(state) {
  let info = { listTotalPage: null, listPage: null, listTotalCount: null };
  walk(state, (node) => {
    if (!node || typeof node !== "object") return;
    if ("listTotalPage" in node || "listPage" in node || "listTotalCount" in node) {
      info = {
        listTotalPage: Number(node.listTotalPage || 0) || info.listTotalPage,
        listPage: Number(node.listPage || 0) || info.listPage,
        listTotalCount: Number(node.listTotalCount || 0) || info.listTotalCount,
      };
    }
  });
  return info;
}

function buildPageUrl(showUrl, pageNumber) {
  const root = normalizeUrl(showUrl);
  if (pageNumber <= 1) return root;
  return `${root}page/${pageNumber}/`;
}

async function scrapeInitialStatePages(showUrl) {
  const rootHtml = await fetchHtml(buildPageUrl(showUrl, 1));
  const rootState = extractInitialState(rootHtml);
  const baseInfo = findBaseInfo(rootState);
  const pagination = findPaginationInfo(rootState);
  const totalPages = Math.max(1, Math.min(MAX_PAGES, Number(pagination.listTotalPage || 1)));

  const byPermalink = new Map();
  let pagesFetched = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    const url = buildPageUrl(showUrl, page);
    const html = page === 1 ? rootHtml : await fetchHtml(url);
    const state = page === 1 ? rootState : extractInitialState(html);
    const records = findEpisodeRecords(state, showUrl);

    for (const record of records) {
      const existing = byPermalink.get(record.permalink_url);
      if (!existing || record.download_count > existing.download_count) {
        byPermalink.set(record.permalink_url, record);
      }
    }

    pagesFetched += 1;
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    baseInfo,
    pagination,
    pagesFetched,
    records: [...byPermalink.values()],
  };
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing CSV at ${CSV_PATH}`);
  }

  const existing = readExistingStats(STATS_PATH);
  const rows = readCsv(CSV_PATH);
  const scraped = await scrapeInitialStatePages(PODBEAN_SHOW_URL);
  const byPermalink = new Map(scraped.records.map((r) => [r.permalink_url, r]));
  const byTitle = new Map(scraped.records.map((r) => [r.title_key, r]));
  const now = new Date().toISOString();

  const episodes = safeObject(existing.episodes);
  let seeded = 0;
  let exactPermalinkMatches = 0;
  let titleMatches = 0;
  let csvFallbacks = 0;

  for (const row of rows) {
    const permalink = normalizeUrl(String(row["Episode URL"] || ""));
    const mediaUrl = String(row["Media URL"] || "").trim();
    const title = String(row["Episode"] || "").trim();
    const publishTime = String(row["Release Date"] || "").trim();
    const csvDownloads = Number(row["Downloads"] || 0);
    const titleKey = normalizeTitle(title);

    const publicRecord = byPermalink.get(permalink) || byTitle.get(titleKey) || null;
    if (byPermalink.get(permalink)) exactPermalinkMatches += 1;
    else if (publicRecord) titleMatches += 1;
    else csvFallbacks += 1;

    const chosen = publicRecord ? Number(publicRecord.download_count || 0) : csvDownloads;
    const current = safeObject(episodes[permalink]);

    episodes[permalink] = {
      ...current,
      identity_key: current.identity_key || permalink,
      episode_url: current.episode_url || permalink,
      permalink_url: current.permalink_url || permalink,
      media_url: current.media_url || mediaUrl || (publicRecord ? publicRecord.media_url : ""),
      title: current.title || title || (publicRecord ? publicRecord.title : ""),
      publish_time: current.publish_time || publishTime || (publicRecord ? publicRecord.publish_time : ""),
      plays_total: Math.max(Number(current.plays_total || current.downloads_total || 0), Number(chosen || 0)),
      downloads_total: Math.max(Number(current.downloads_total || current.plays_total || 0), Number(chosen || 0)),
      baseline_seeded_at: current.baseline_seeded_at || now,
      baseline_source: publicRecord ? "podbean_initial_state" : "csv_downloads",
      baseline_csv_downloads: csvDownloads,
      baseline_public_downloads: publicRecord ? Number(publicRecord.download_count || 0) : null,
      baseline_public_title: publicRecord ? publicRecord.title : null,
      baseline_public_title_key: publicRecord ? publicRecord.title_key : null,
      last_baseline_refresh_at: now,
      downloads_by_date: safeObject(current.downloads_by_date),
    };

    seeded += 1;
  }

  const baseInfo = scraped.baseInfo;
  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_initial_state_plus_csv",
      metric: "plays",
      strategy: "window_initial_state_seed",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: {
      ...(safeObject(existing.podcast_totals)),
      plays_total: Number(baseInfo.podcastDownloads || existing?.podcast_totals?.plays_total || 0),
      episodes_total: Number(baseInfo.totalEpisodes || existing?.podcast_totals?.episodes_total || 0),
      last_updated: now,
      source_url: PODBEAN_SHOW_URL,
    },
    episodes,
    summary: {
      total_csv_rows_seen: rows.length,
      total_baseline_seeded: seeded,
      total_initial_state_records_found: scraped.records.length,
      total_initial_state_permalink_matches: exactPermalinkMatches,
      total_initial_state_title_matches: titleMatches,
      total_csv_fallbacks: csvFallbacks,
      initial_state_pages_fetched: scraped.pagesFetched,
      initial_state_list_total_page: Number(scraped.pagination.listTotalPage || 0),
      initial_state_list_total_count: Number(scraped.pagination.listTotalCount || 0),
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
  console.log(
    `Summary -> seeded=${seeded}, records=${scraped.records.length}, permalinkMatches=${exactPermalinkMatches}, titleMatches=${titleMatches}, csvFallbacks=${csvFallbacks}, pagesFetched=${scraped.pagesFetched}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
