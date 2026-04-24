#!/usr/bin/env node
import fs from "fs";
import path from "path";

const SCRIPT_LABEL = process.env.PODBEAN_SCRIPT_LABEL || "Seed Podbean Baseline";
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

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanHtmlText(value) {
  return clean(String(value || "").replace(/<[^>]*>/g, " "));
}

function parseInteger(value) {
  const raw = clean(value).replace(/,/g, "");
  if (!/^\d+$/.test(raw)) return 0;
  return Number(raw);
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

function withCacheBust(url) {
  const marker = `cgbc_stats_ts=${Date.now()}`;
  return url.includes("?") ? `${url}&${marker}` : `${url}?${marker}`;
}

async function fetchHtml(url) {
  const requestUrl = withCacheBust(url);
  const res = await fetch(requestUrl, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CGBCPodbeanPublicStats/2026.04-v10; +https://cgbclebanontn.org)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache, no-store, max-age=0",
      "Pragma": "no-cache",
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

function extractHeaderExactCountsFromHtml(html) {
  // Podbean visibly rounds the show header total, e.g. "3.9K" or "4K", but the
  // exact public number sits in the title="3961" tooltip on the same counter.
  // This parser targets the real Podbean markup first:
  //   <div class="download-data ..."><p title="3961" ...>3.9K</p><p ...>Downloads</p></div>
  // Then it falls back to nearby title/label searches.
  const counts = {
    downloads: 0,
    episodes: 0,
    downloads_source: "not_found",
    episodes_source: "not_found",
  };

  const downloadBlock = html.match(/<div\b[^>]*class=["'][^"']*download-data[^"']*["'][^>]*>[\s\S]{0,700}?<p\b[^>]*title=["']([0-9,]+)["'][^>]*>[\s\S]{0,300}?<\/div>/i);
  if (downloadBlock) {
    counts.downloads = parseInteger(downloadBlock[1]);
    counts.downloads_source = "public_header_download_data_title";
  }

  const episodeBlock = html.match(/<div\b[^>]*class=["'][^"']*episode-data[^"']*["'][^>]*>[\s\S]{0,700}?<p\b[^>]*title=["']([0-9,]+)["'][^>]*>[\s\S]{0,300}?<\/div>/i);
  if (episodeBlock) {
    counts.episodes = parseInteger(episodeBlock[1]);
    counts.episodes_source = "public_header_episode_data_title";
  }

  if (!counts.downloads) {
    const strictDownloads = html.match(/<p\b[^>]*title=["']([0-9,]+)["'][^>]*>[\s\S]*?<\/p>\s*<p\b[^>]*>[\s\S]*?Downloads[\s\S]*?<\/p>/i);
    if (strictDownloads) {
      counts.downloads = parseInteger(strictDownloads[1]);
      counts.downloads_source = "public_header_title_next_downloads_label";
    }
  }

  if (!counts.episodes) {
    const strictEpisodes = html.match(/<p\b[^>]*title=["']([0-9,]+)["'][^>]*>[\s\S]*?<\/p>\s*<p\b[^>]*>[\s\S]*?Episodes[\s\S]*?<\/p>/i);
    if (strictEpisodes) {
      counts.episodes = parseInteger(strictEpisodes[1]);
      counts.episodes_source = "public_header_title_next_episodes_label";
    }
  }

  if (!counts.downloads) {
    const idx = html.search(/Downloads/i);
    if (idx >= 0) {
      const chunk = html.slice(Math.max(0, idx - 1200), idx + 300);
      const titles = [...chunk.matchAll(/title=["']([0-9,]+)["']/gi)].map(m => parseInteger(m[1])).filter(Boolean);
      if (titles.length) {
        counts.downloads = Math.max(...titles);
        counts.downloads_source = "public_header_near_downloads_label";
      }
    }
  }

  if (!counts.episodes) {
    const idx = html.search(/Episodes/i);
    if (idx >= 0) {
      const chunk = html.slice(Math.max(0, idx - 1200), idx + 300);
      const titles = [...chunk.matchAll(/title=["']([0-9,]+)["']/gi)].map(m => parseInteger(m[1])).filter(Boolean);
      if (titles.length) {
        counts.episodes = Math.min(...titles);
        counts.episodes_source = "public_header_near_episodes_label";
      }
    }
  }

  return counts;
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
  const rootUrl = buildPageUrl(showUrl, 1);
  const rootHtml = await fetchHtml(rootUrl);
  const rootState = extractInitialState(rootHtml);
  const headerCounts = extractHeaderExactCountsFromHtml(rootHtml);
  const baseInfo = findBaseInfo(rootState);
  const pagination = findPaginationInfo(rootState);

  // Pagination is known today through listTotalPage, but this scraper is careful:
  // it will fetch the known public pages, never use CSV, and report if fewer
  // public records are found than Podbean says should exist.
  const expectedPages = Number(pagination.listTotalPage || 0);
  const pagesToAttempt = expectedPages > 0 ? Math.min(MAX_PAGES, expectedPages) : MAX_PAGES;

  const byKey = new Map();
  const pageSummaries = [];
  let pagesFetched = 0;

  for (let page = 1; page <= pagesToAttempt; page += 1) {
    const url = buildPageUrl(showUrl, page);
    const html = page === 1 ? rootHtml : await fetchHtml(url);
    const state = page === 1 ? rootState : extractInitialState(html);
    const records = findEpisodeRecords(state, showUrl);
    let newUniqueRecords = 0;

    for (const record of records) {
      const key = record.media_url || record.permalink_url || record.identity_key;
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) newUniqueRecords += 1;
      if (!existing || record.plays_total >= Number(existing.plays_total || 0)) {
        byKey.set(key, record);
      }
    }

    pagesFetched += 1;
    pageSummaries.push({ page, url, records_found: records.length, new_unique_records: newUniqueRecords });

    // If Podbean stops returning fresh page data and we have no known total page
    // count, stop rather than looping through empty/duplicate pages.
    if (!expectedPages && page > 1 && records.length === 0) break;
    if (page < pagesToAttempt) await sleep(REQUEST_DELAY_MS);
  }

  return { baseInfo, pagination, headerCounts, pagesFetched, pageSummaries, records: [...byKey.values()] };
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

function finalizeEpisode(record, existingMatch, now) {
  const currentPublicCount = Number(record.plays_total || record.downloads_total || 0);

  return {
    ...(safeObject(existingMatch)),

    // Canonical identity for the resolved library lookup. The stats object is
    // rebuilt fresh on every run, so old Podbean-ID/permalink duplicate keys are dropped.
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

    // Current public Podbean listing count is the per-episode source of truth.
    plays_total: currentPublicCount,
    downloads_total: currentPublicCount,
    public_listing_downloads: currentPublicCount,
    baseline_public_downloads: currentPublicCount,
    podbean_public_download_count: currentPublicCount,

    baseline_seeded_at: existingMatch.baseline_seeded_at || now,
    baseline_source: "podbean_public_paginated_episode_cards",
    baseline_csv_downloads: null,
    csv_used: false,
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

function choosePodcastTotal({ headerDownloads, episodeDownloadsTotal, baseInfoDownloads, previousDownloads, publicRecordsWritten, expectedEpisodeCount }) {
  if (headerDownloads > 0) {
    return { value: headerDownloads, source: "public_header_title_tooltip" };
  }

  // Public episode total is the next-best fallback only when the scrape appears complete.
  if (episodeDownloadsTotal > 0 && (!expectedEpisodeCount || publicRecordsWritten >= expectedEpisodeCount)) {
    return { value: episodeDownloadsTotal, source: "public_paginated_episode_sum_complete" };
  }

  if (baseInfoDownloads > 0) {
    return { value: baseInfoDownloads, source: "podbean_initial_state_baseInfo_fallback" };
  }

  if (previousDownloads > 0) {
    return { value: previousDownloads, source: "previous_stats_fallback" };
  }

  return { value: 0, source: "none" };
}

function buildWarnings({ scraped, podcastTotal, publicRecordsWritten, expectedEpisodeCount, episodeDownloadsTotal }) {
  const warnings = [];
  const expectedPages = Number(scraped.pagination.listTotalPage || 0);

  if (expectedPages && scraped.pagesFetched < expectedPages) {
    warnings.push(`Fetched ${scraped.pagesFetched} public pages, but Podbean reported ${expectedPages} pages.`);
  }

  if (expectedEpisodeCount && publicRecordsWritten !== expectedEpisodeCount) {
    warnings.push(`Public episode count scrape found ${publicRecordsWritten} episodes, but Podbean reported ${expectedEpisodeCount}.`);
  }

  if (podcastTotal.source === "public_header_title_tooltip" && episodeDownloadsTotal > 0) {
    const diff = podcastTotal.value - episodeDownloadsTotal;
    if (diff !== 0) {
      warnings.push(`Header tooltip total (${podcastTotal.value}) differs from summed public episode counts (${episodeDownloadsTotal}) by ${diff}.`);
    }
  }

  if (!scraped.headerCounts.downloads) {
    warnings.push("Could not find exact public header downloads tooltip; used fallback total source.");
  }

  return warnings;
}

function buildCleanStatsDocument(existing, scraped, now) {
  const existingIndexes = buildExistingIndexes(existing.episodes || {});
  const episodes = {};

  let publicRecordsWritten = 0;
  let existingMatches = 0;

  for (const record of scraped.records) {
    const key = record.media_url || record.permalink_url || record.identity_key;
    if (!key) continue;

    const existingMatch = findExistingMatch(record, existingIndexes);
    if (Object.keys(safeObject(existingMatch)).length) existingMatches += 1;

    episodes[key] = finalizeEpisode(record, existingMatch, now);
    publicRecordsWritten += 1;
  }

  const baseInfo = safeObject(scraped.baseInfo);
  const headerDownloads = Number(scraped.headerCounts.downloads || 0);
  const headerEpisodes = Number(scraped.headerCounts.episodes || 0);
  const baseInfoDownloads = Number(baseInfo.podcastDownloads || 0);
  const baseInfoEpisodes = Number(baseInfo.totalEpisodes || 0);
  const paginationEpisodeCount = Number(scraped.pagination.listTotalCount || 0);
  const expectedEpisodeCount = headerEpisodes || paginationEpisodeCount || baseInfoEpisodes || publicRecordsWritten;
  const episodeDownloadsTotal = Object.values(episodes).reduce((sum, ep) => sum + Number(ep.plays_total || 0), 0);
  const previousDownloads = Number(existing?.podcast_totals?.plays_total || 0);
  const podcastTotal = choosePodcastTotal({
    headerDownloads,
    episodeDownloadsTotal,
    baseInfoDownloads,
    previousDownloads,
    publicRecordsWritten,
    expectedEpisodeCount,
  });

  const warnings = buildWarnings({
    scraped,
    podcastTotal,
    publicRecordsWritten,
    expectedEpisodeCount,
    episodeDownloadsTotal,
  });

  return {
    generated_at: now,
    source: {
      provider: "podbean_public_site",
      metric: "plays",
      strategy: "canonical_public_paginated_refresh_v10_exact_header_total_no_cache",
      show_url: PODBEAN_SHOW_URL,
      note: "Top total comes from the exact public Podbean header tooltip/title when available, fetched with no-cache/cache-buster headers. Episode counts come from public paginated episode cards. CSV is not used for current counts.",
    },
    podcast_totals: {
      plays_total: podcastTotal.value,
      episodes_total: expectedEpisodeCount || Number(existing?.podcast_totals?.episodes_total || publicRecordsWritten),
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
      existing_matches: existingMatches,

      csv_used: false,
      csv_policy: "ignored_for_current_counts",

      pages_fetched: scraped.pagesFetched,
      pages_attempted: scraped.pageSummaries.length,
      page_summaries: scraped.pageSummaries,
      list_total_page: Number(scraped.pagination.listTotalPage || 0),
      list_total_count: paginationEpisodeCount || null,

      podcast_total_source: podcastTotal.source,
      current_public_podcast_downloads: podcastTotal.value || null,
      current_public_podcast_downloads_source: podcastTotal.source,
      current_public_podcast_downloads_from_header_tooltip: headerDownloads || null,
      current_public_podcast_downloads_from_base_info: baseInfoDownloads || null,
      current_public_total_episodes: expectedEpisodeCount || null,
      current_public_total_episodes_from_header_tooltip: headerEpisodes || null,
      current_public_total_episodes_from_pagination: paginationEpisodeCount || null,

      episode_count_source: "public_paginated_episode_cards",
      calculated_episode_downloads_total: episodeDownloadsTotal,
      calculated_episode_downloads_difference_from_header: headerDownloads ? headerDownloads - episodeDownloadsTotal : null,
      warnings,
    },
  };
}

async function main() {
  const now = new Date().toISOString();
  const existing = readExistingStats(STATS_PATH);
  const scraped = await scrapePublicPodbeanStats(PODBEAN_SHOW_URL);
  const output = buildCleanStatsDocument(existing, scraped, now);

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`${SCRIPT_LABEL}: wrote ${STATS_PATH}`);
  console.log(
    `Summary -> previousKeys=${output.summary.previous_episode_key_count}, publicRecords=${output.summary.public_records_found}, written=${output.summary.public_records_written}, removedLegacyKeys=${output.summary.duplicate_legacy_keys_removed}, pagesFetched=${output.summary.pages_fetched}, totalPlays=${output.podcast_totals.plays_total}, totalSource=${output.summary.podcast_total_source}, totalEpisodes=${output.podcast_totals.episodes_total}`
  );

  if (output.summary.warnings.length) {
    console.warn("Warnings:");
    for (const warning of output.summary.warnings) console.warn(`- ${warning}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
