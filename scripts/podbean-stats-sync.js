#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
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

function readExistingStats(statsPath) {
  if (!fs.existsSync(statsPath)) {
    return { generated_at: null, source: {}, podcast_totals: {}, episodes: {}, summary: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch (err) {
    console.warn(`Could not parse existing stats.json: ${err.message}`);
    return { generated_at: null, source: {}, podcast_totals: {}, episodes: {}, summary: {} };
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCInitialStateSync/5.0",
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
  const decoded = escaped
    .replace(/\\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");

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
      item && typeof item === "object" &&
      ("downloadCount" in item) &&
      ("title" in item) &&
      ("permalink" in item || "permalink_url" in item || "url" in item)
    );
    if (!looksLikeEpisodeArray) return;

    for (const item of node) {
      if (!item || typeof item !== "object") continue;
      const permalink = toAbsolutePermalink(showUrl, item.permalink || item.permalink_url || item.url || "");
      const mediaUrl = normalizeMediaUrl(item.mediaUrl || item.media_url || item.contentUrl || item.content_url || "");
      const title = String(item.title || "").trim();
      if (!title || (!permalink && !mediaUrl)) continue;

      const dedupeKey = `${permalink}::${mediaUrl}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      records.push({
        permalink_url: permalink,
        media_url: mediaUrl,
        title,
        title_key: normalizeTitle(title),
        download_count: Number(item.downloadCount || 0),
        publish_time: item.datePublished || item.publish_time || item.publishDate || null,
        publish_timestamp: Number(item.publishTimestamp || 0) || null,
        deep_link: item.deepLink || null,
        share_link: item.shareLink || null,
        status: item.status || null,
      });
    }
  });

  return records;
}

function findBaseInfo(state) {
  let best = null;
  walk(state, (node) => {
    if (node && typeof node === "object" &&
      ("podcastDownloads" in node || "totalEpisodes" in node || "podcastTitle" in node)) {
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

  const byKey = new Map();
  let pagesFetched = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    const url = buildPageUrl(showUrl, page);
    const html = page === 1 ? rootHtml : await fetchHtml(url);
    const state = page === 1 ? rootState : extractInitialState(html);
    const records = findEpisodeRecords(state, showUrl);

    for (const record of records) {
      const key = record.media_url || record.permalink_url;
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || record.download_count > existing.download_count) {
        byKey.set(key, record);
      }
    }

    pagesFetched += 1;
    await sleep(REQUEST_DELAY_MS);
  }

  return { baseInfo, pagination, pagesFetched, records: [...byKey.values()] };
}

function buildIndexes(episodes) {
  const mediaIndex = new Map();
  const permalinkIndex = new Map();
  const titleIndex = new Map();

  for (const [key, raw] of Object.entries(episodes || {})) {
    const episode = safeObject(raw);
    const media = normalizeMediaUrl(episode.media_url || "");
    const permalink = normalizeUrl(episode.permalink_url || episode.episode_url || key || "");
    const titleKey = normalizeTitle(episode.title || "");

    if (media) mediaIndex.set(media, { key, episode });
    if (permalink) permalinkIndex.set(permalink, { key, episode });
    if (titleKey) {
      if (!titleIndex.has(titleKey)) titleIndex.set(titleKey, []);
      titleIndex.get(titleKey).push({ key, episode });
    }
  }

  return { mediaIndex, permalinkIndex, titleIndex };
}

async function main() {
  const existing = readExistingStats(STATS_PATH);
  const scraped = await scrapeInitialStatePages(PODBEAN_SHOW_URL);
  const episodes = safeObject(existing.episodes);
  const indexes = buildIndexes(episodes);
  const now = new Date().toISOString();

  let mediaMatches = 0;
  let permalinkMatches = 0;
  let titleMatches = 0;
  let insertedNew = 0;

  for (const record of scraped.records) {
    let match = null;
    let matchType = null;

    if (record.media_url && indexes.mediaIndex.has(record.media_url)) {
      match = indexes.mediaIndex.get(record.media_url);
      matchType = "media";
    } else if (record.permalink_url && indexes.permalinkIndex.has(record.permalink_url)) {
      match = indexes.permalinkIndex.get(record.permalink_url);
      matchType = "permalink";
    } else if (record.title_key && (indexes.titleIndex.get(record.title_key) || []).length) {
      match = indexes.titleIndex.get(record.title_key)[0];
      matchType = "title";
    }

    if (match) {
      const current = safeObject(match.episode);
      const newValue = Math.max(
        Number(current.plays_total || current.downloads_total || 0),
        Number(record.download_count || 0)
      );

      episodes[match.key] = {
        ...current,
        permalink_url: current.permalink_url || record.permalink_url,
        episode_url: current.episode_url || record.permalink_url,
        media_url: current.media_url || record.media_url,
        title: current.title || record.title,
        publish_time: current.publish_time || record.publish_time,
        plays_total: newValue,
        downloads_total: newValue,
        podbean_public_download_count: Number(record.download_count || 0),
        podbean_public_title: record.title,
        podbean_public_title_key: record.title_key,
        podbean_public_share_link: record.share_link,
        podbean_public_deep_link: record.deep_link,
        last_public_sync_at: now,
        downloads_by_date: safeObject(current.downloads_by_date),
      };

      if (matchType === "media") mediaMatches += 1;
      else if (matchType === "permalink") permalinkMatches += 1;
      else titleMatches += 1;
      continue;
    }

    const key = record.media_url || record.permalink_url;
    if (!key) continue;

    episodes[key] = {
      identity_key: key,
      episode_url: record.permalink_url || "",
      permalink_url: record.permalink_url || "",
      media_url: record.media_url || "",
      title: record.title,
      publish_time: record.publish_time,
      plays_total: Number(record.download_count || 0),
      downloads_total: Number(record.download_count || 0),
      podbean_public_download_count: Number(record.download_count || 0),
      podbean_public_title: record.title,
      podbean_public_title_key: record.title_key,
      podbean_public_share_link: record.share_link,
      podbean_public_deep_link: record.deep_link,
      inserted_from_initial_state: true,
      last_public_sync_at: now,
      downloads_by_date: {},
    };
    insertedNew += 1;
  }

  const baseInfo = scraped.baseInfo;
  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_initial_state",
      metric: "plays",
      strategy: "window_initial_state_parser_v5",
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
      ...(safeObject(existing.summary)),
      sync_type: "podcast_totals_plus_initial_state_episode_records_v5",
      pages_fetched: scraped.pagesFetched,
      initial_state_records_found: scraped.records.length,
      initial_state_media_matches: mediaMatches,
      initial_state_permalink_matches: permalinkMatches,
      initial_state_title_matches: titleMatches,
      initial_state_new_records_inserted: insertedNew,
      initial_state_list_total_page: Number(scraped.pagination.listTotalPage || 0),
      initial_state_list_total_count: Number(scraped.pagination.listTotalCount || 0),
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${STATS_PATH}`);
  console.log(
    `Totals -> plays=${output.podcast_totals.plays_total}, episodes=${output.podcast_totals.episodes_total}, records=${scraped.records.length}, mediaMatches=${mediaMatches}, permalinkMatches=${permalinkMatches}, titleMatches=${titleMatches}, insertedNew=${insertedNew}, pagesFetched=${scraped.pagesFetched}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
