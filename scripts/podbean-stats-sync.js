#!/usr/bin/env node
import fs from "fs";
import path from "path";

const SCRIPT_LABEL = process.env.PODBEAN_SCRIPT_LABEL || "Sync Podbean Public Stats";
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

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "/");
}

function normalizeMediaUrl(url) {
  return String(url || "").trim();
}

function toAbsolutePermalink(showUrl, permalink) {
  const root = normalizeUrl(showUrl);
  if (!permalink) return "";
  const raw = String(permalink).trim();
  if (/^https?:\/\//i.test(raw)) return normalizeUrl(raw);
  return normalizeUrl(root.replace(/\/$/, "") + "/" + raw.replace(/^\//, ""));
}

function normalizeTitleKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\|/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDay(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 100000000000 ? value : value * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) return toIsoDay(Number(text));
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
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
  if (!fs.existsSync(filePath)) return [];

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
    return { generated_at: null, source: {}, podcast_totals: {}, episodes: {}, summary: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch {
    return { generated_at: null, source: {}, podcast_totals: {}, episodes: {}, summary: {} };
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCPodbeanPublicStats/2026.04",
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
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*("(?:\\.|[^"\\])*")/i);
  if (!match) {
    throw new Error("Could not find window.__INITIAL_STATE__ in Podbean HTML");
  }

  const decoded = JSON.parse(match[1]);
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
      ("permalink" in item || "permalink_url" in item || "url" in item || "mediaUrl" in item)
    );
    if (!looksLikeEpisodeArray) return;

    for (const item of node) {
      if (!item || typeof item !== "object") continue;

      const permalink = toAbsolutePermalink(showUrl, item.permalink || item.permalink_url || item.url || "");
      const mediaUrl = normalizeMediaUrl(item.mediaUrl || item.media_url || item.contentUrl || item.content_url || "");
      const title = clean(item.title || item.name || "");
      const downloadCount = Number(item.downloadCount ?? item.download_count ?? 0);
      const publishDay =
        toIsoDay(item.publishTimestamp) ||
        toIsoDay(item.datePublished) ||
        toIsoDay(item.publish_time) ||
        toIsoDay(item.publishDate) ||
        null;

      if (!title || (!permalink && !mediaUrl)) continue;

      const dedupeKey = mediaUrl || permalink || `${publishDay}|${normalizeTitleKey(title)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      records.push({
        podbean_episode_id: clean(item.id || item.episodeId || item.idTag || ""),
        identity_key: dedupeKey,
        episode_url: permalink,
        permalink_url: permalink,
        media_url: mediaUrl,
        title,
        public_listing_title: title,
        public_listing_title_key: normalizeTitleKey(title),
        publish_time: publishDay,
        plays_total: downloadCount,
        downloads_total: downloadCount,
        public_listing_downloads: downloadCount,
        baseline_public_downloads: downloadCount,
        podbean_public_download_count: downloadCount,
        podbean_public_title: title,
        podbean_public_title_key: normalizeTitleKey(title),
        podbean_public_share_link: clean(item.shareLink || item.share_link || ""),
        podbean_public_deep_link: clean(item.deepLink || item.deep_link || ""),
        share_url: permalink,
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

async function scrapePublicPodbeanStats(showUrl) {
  const rootHtml = await fetchHtml(buildPageUrl(showUrl, 1));
  const rootState = extractInitialState(rootHtml);
  const baseInfo = findBaseInfo(rootState);
  const pagination = findPaginationInfo(rootState);
  const totalPages = Math.max(1, Math.min(MAX_PAGES, Number(pagination.listTotalPage || 1)));

  const byKey = new Map();
  let pagesFetched = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    const url = buildPageUrl(showUrl, page);
    const html = page === 1 ? rootHtml : await fetchHtml(url);
    const state = page === 1 ? rootState : extractInitialState(html);
    const records = findEpisodeRecords(state, showUrl);

    for (const record of records) {
      const key = record.media_url || record.permalink_url || record.identity_key;
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || record.plays_total >= Number(existing.plays_total || 0)) {
        byKey.set(key, record);
      }
    }

    pagesFetched += 1;
    if (page < totalPages) await sleep(REQUEST_DELAY_MS);
  }

  return { baseInfo, pagination, pagesFetched, records: [...byKey.values()] };
}

function buildExistingIndexes(existingEpisodes) {
  const byMedia = new Map();
  const byPermalink = new Map();
  const byTitleDay = new Map();
  const byTitle = new Map();

  for (const episode of Object.values(safeObject(existingEpisodes))) {
    const media = normalizeMediaUrl(episode.media_url);
    const permalink = normalizeUrl(episode.episode_url || episode.permalink_url || "");
    const titleKey = normalizeTitleKey(episode.public_listing_title || episode.title || episode.rss_title || "");
    const day = toIsoDay(episode.publish_time);

    if (media && !byMedia.has(media)) byMedia.set(media, episode);
    if (permalink && !byPermalink.has(permalink)) byPermalink.set(permalink, episode);
    if (titleKey && day && !byTitleDay.has(`${day}|${titleKey}`)) byTitleDay.set(`${day}|${titleKey}`, episode);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, episode);
  }

  return { byMedia, byPermalink, byTitleDay, byTitle };
}

function findExistingMatch(record, indexes) {
  const media = normalizeMediaUrl(record.media_url);
  const permalink = normalizeUrl(record.permalink_url || record.episode_url || "");
  const titleKey = normalizeTitleKey(record.title || record.public_listing_title || "");
  const day = toIsoDay(record.publish_time);

  if (media && indexes.byMedia.has(media)) return indexes.byMedia.get(media);
  if (permalink && indexes.byPermalink.has(permalink)) return indexes.byPermalink.get(permalink);
  if (titleKey && day && indexes.byTitleDay.has(`${day}|${titleKey}`)) return indexes.byTitleDay.get(`${day}|${titleKey}`);
  if (titleKey && indexes.byTitle.has(titleKey)) return indexes.byTitle.get(titleKey);
  return {};
}

function buildCsvIndexes(rows) {
  const byMedia = new Map();
  const byPermalink = new Map();
  const byTitleDay = new Map();
  const byTitle = new Map();

  for (const row of rows) {
    const episode = clean(row["Episode"] || row["Title"] || "");
    const media = normalizeMediaUrl(row["Media URL"] || "");
    const permalink = normalizeUrl(row["Episode URL"] || "");
    const day = toIsoDay(row["Release Date"] || row["Date"] || "");
    const titleKey = normalizeTitleKey(episode);
    const downloads = Number(row["Downloads"] || 0);
    const item = { episode, media, permalink, day, titleKey, downloads };

    if (media && !byMedia.has(media)) byMedia.set(media, item);
    if (permalink && !byPermalink.has(permalink)) byPermalink.set(permalink, item);
    if (titleKey && day && !byTitleDay.has(`${day}|${titleKey}`)) byTitleDay.set(`${day}|${titleKey}`, item);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, item);
  }

  return { byMedia, byPermalink, byTitleDay, byTitle };
}

function findCsvMatch(record, indexes) {
  const media = normalizeMediaUrl(record.media_url);
  const permalink = normalizeUrl(record.permalink_url || record.episode_url || "");
  const titleKey = normalizeTitleKey(record.title || record.public_listing_title || "");
  const day = toIsoDay(record.publish_time);

  if (media && indexes.byMedia.has(media)) return indexes.byMedia.get(media);
  if (permalink && indexes.byPermalink.has(permalink)) return indexes.byPermalink.get(permalink);
  if (titleKey && day && indexes.byTitleDay.has(`${day}|${titleKey}`)) return indexes.byTitleDay.get(`${day}|${titleKey}`);
  if (titleKey && indexes.byTitle.has(titleKey)) return indexes.byTitle.get(titleKey);
  return null;
}

function finalizeEpisode(record, existingMatch, csvMatch, now) {
  const currentPublicCount = Number(record.plays_total || record.downloads_total || 0);
  const csvDownloads = csvMatch ? Number(csvMatch.downloads || 0) : null;

  return {
    ...(safeObject(existingMatch)),

    // Canonical identity for the resolved library lookup. The object is rebuilt fresh
    // on every run, so old Podbean-ID/permalink duplicate keys are dropped.
    identity_key: record.media_url || record.permalink_url || record.identity_key,
    podbean_episode_id: record.podbean_episode_id || existingMatch.podbean_episode_id || "",

    title: record.title || existingMatch.title || "",
    public_listing_title: record.public_listing_title || record.title || existingMatch.public_listing_title || "",
    public_listing_title_key: record.public_listing_title_key || normalizeTitleKey(record.title),
    rss_title: existingMatch.rss_title || record.title || "",

    episode_url: record.episode_url || existingMatch.episode_url || existingMatch.permalink_url || "",
    permalink_url: record.permalink_url || record.episode_url || existingMatch.permalink_url || "",
    media_url: record.media_url || existingMatch.media_url || "",
    share_url: record.share_url || existingMatch.share_url || record.permalink_url || record.episode_url || "",

    publish_time: record.publish_time || existingMatch.publish_time || null,

    // Current public Podbean listing count is now the source of truth.
    plays_total: currentPublicCount,
    downloads_total: currentPublicCount,
    public_listing_downloads: currentPublicCount,
    baseline_public_downloads: currentPublicCount,
    podbean_public_download_count: currentPublicCount,

    baseline_seeded_at: existingMatch.baseline_seeded_at || now,
    baseline_source: "podbean_public_initial_state_current",
    baseline_csv_downloads: csvDownloads,
    baseline_public_title: record.title || null,
    baseline_public_title_key: normalizeTitleKey(record.title),
    last_baseline_refresh_at: now,
    last_public_listing_sync_at: now,
    last_public_sync_at: now,

    podbean_public_title: record.title || null,
    podbean_public_title_key: normalizeTitleKey(record.title),
    podbean_public_share_link: record.podbean_public_share_link || existingMatch.podbean_public_share_link || "",
    podbean_public_deep_link: record.podbean_public_deep_link || existingMatch.podbean_public_deep_link || "",

    match_strategy: record.media_url ? "podbean_public_media_url" : "podbean_public_permalink_url",
    downloads_by_date: safeObject(existingMatch.downloads_by_date),
  };
}

function buildCleanStatsDocument(existing, rows, scraped, now) {
  const existingIndexes = buildExistingIndexes(existing.episodes || {});
  const csvIndexes = buildCsvIndexes(rows);
  const episodes = {};

  let publicRecordsWritten = 0;
  let csvMatches = 0;
  let existingMatches = 0;

  for (const record of scraped.records) {
    const key = record.media_url || record.permalink_url || record.identity_key;
    if (!key) continue;

    const existingMatch = findExistingMatch(record, existingIndexes);
    const csvMatch = findCsvMatch(record, csvIndexes);
    if (Object.keys(safeObject(existingMatch)).length) existingMatches += 1;
    if (csvMatch) csvMatches += 1;

    episodes[key] = finalizeEpisode(record, existingMatch, csvMatch, now);
    publicRecordsWritten += 1;
  }

  const baseInfo = safeObject(scraped.baseInfo);
  const podcastDownloads = Number(baseInfo.podcastDownloads || 0);
  const podcastEpisodes = Number(baseInfo.totalEpisodes || scraped.pagination.listTotalCount || scraped.records.length || 0);

  return {
    generated_at: now,
    source: {
      provider: "podbean_public_initial_state",
      metric: "plays",
      strategy: "canonical_public_listing_refresh_v8",
      show_url: PODBEAN_SHOW_URL,
      note: "Counts are refreshed from Podbean public window.__INITIAL_STATE__; stats episodes are rebuilt each run to remove duplicate legacy keys.",
    },
    podcast_totals: {
      plays_total: podcastDownloads || Number(existing?.podcast_totals?.plays_total || 0),
      episodes_total: podcastEpisodes || Number(existing?.podcast_totals?.episodes_total || publicRecordsWritten),
      last_updated: now,
      source_url: PODBEAN_SHOW_URL,
    },
    episodes,
    summary: {
      script_label: SCRIPT_LABEL,
      previous_episode_key_count: Object.keys(safeObject(existing.episodes)).length,
      public_records_found: scraped.records.length,
      public_records_written: publicRecordsWritten,
      duplicate_legacy_keys_removed: Math.max(0, Object.keys(safeObject(existing.episodes)).length - publicRecordsWritten),
      csv_rows_seen: rows.length,
      csv_matches: csvMatches,
      existing_matches: existingMatches,
      pages_fetched: scraped.pagesFetched,
      list_total_page: Number(scraped.pagination.listTotalPage || 0),
      list_total_count: Number(scraped.pagination.listTotalCount || 0),
      current_public_podcast_downloads: podcastDownloads || null,
      current_public_total_episodes: podcastEpisodes || null,
    },
  };
}

async function main() {
  const now = new Date().toISOString();
  const existing = readExistingStats(STATS_PATH);
  const rows = readCsv(CSV_PATH);
  const scraped = await scrapePublicPodbeanStats(PODBEAN_SHOW_URL);
  const output = buildCleanStatsDocument(existing, rows, scraped, now);

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`${SCRIPT_LABEL}: wrote ${STATS_PATH}`);
  console.log(
    `Summary -> previousKeys=${output.summary.previous_episode_key_count}, publicRecords=${output.summary.public_records_found}, written=${output.summary.public_records_written}, removedLegacyKeys=${output.summary.duplicate_legacy_keys_removed}, pagesFetched=${output.summary.pages_fetched}, totalPlays=${output.podcast_totals.plays_total}, totalEpisodes=${output.podcast_totals.episodes_total}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
