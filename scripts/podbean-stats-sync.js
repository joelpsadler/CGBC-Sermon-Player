#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const CLIENT_ID = process.env.PODBEAN_CLIENT_ID;
const CLIENT_SECRET = process.env.PODBEAN_CLIENT_SECRET;

const PAGE_LIMIT = Math.min(100, Number(process.env.PODBEAN_LIMIT || 100));
const TRACK_WINDOW_DAYS = Number(process.env.PODBEAN_TRACK_WINDOW_DAYS || 60);

const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 1200);
const RETRY_BASE_DELAY_MS = Number(process.env.PODBEAN_RETRY_BASE_DELAY_MS || 4000);
const MAX_RETRIES = Number(process.env.PODBEAN_MAX_RETRIES || 5);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing PODBEAN_CLIENT_ID or PODBEAN_CLIENT_SECRET.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoDateToday() {
  return isoDate(new Date());
}

function isoDateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return isoDate(d);
}

function fetchStartDateForEpisode(publishDateIso, trackWindowDays) {
  const recentFloor = isoDateDaysAgo(trackWindowDays);
  if (!publishDateIso) return recentFloor;
  const publishedDay = String(publishDateIso).slice(0, 10);
  return publishedDay > recentFloor ? publishedDay : recentFloor;
}

function normalizeEpisodeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function fetchJson(url, options = {}, retryCount = 0) {
  const res = await fetch(url, options);
  const text = await res.text();

  if (res.status === 429) {
    if (retryCount >= MAX_RETRIES) {
      throw new Error(`Rate limited too many times for ${url}`);
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const waitMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);

    console.warn(`429 rate limit. Waiting ${waitMs}ms then retrying ${url}`);
    await sleep(waitMs);
    return fetchJson(url, options, retryCount + 1);
  }

  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}\n${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response for ${url}\n${text}`);
  }
}

async function getAccessToken() {
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const data = await fetchJson("https://api.podbean.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "CGBCMediaPlayerStatsSync/1.0",
    },
    body: form.toString(),
  });

  if (!data.access_token) {
    throw new Error("Podbean token response did not include access_token.");
  }

  return data.access_token;
}

function extractEpisodeList(data) {
  if (Array.isArray(data?.episodes)) return data.episodes;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.episodes)) return data.data.episodes;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data)) return data;
  return [];
}

async function getAllEpisodes(accessToken) {
  const episodes = [];
  let offset = 0;

  while (true) {
    const url = new URL("https://api.podbean.com/v1/episodes");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(PAGE_LIMIT));

    const data = await fetchJson(url.toString(), {
      headers: { "User-Agent": "CGBCMediaPlayerStatsSync/1.0" },
    });

    const list = extractEpisodeList(data);
    episodes.push(...list);

    console.log(`Fetched episode page offset=${offset}, count=${list.length}`);

    if (list.length < PAGE_LIMIT) break;

    offset += list.length;
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Total episodes fetched: ${episodes.length}`);
  return episodes;
}

async function getEpisodeDownloadsForRange(accessToken, episodeId, start, end) {
  const url = new URL("https://api.podbean.com/v1/podcastStats/stats");
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("episode_id", episodeId);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);

  const data = await fetchJson(url.toString(), {
    headers: { "User-Agent": "CGBCMediaPlayerStatsSync/1.0" },
  });

  const statsObj = safeObject(data?.stats);
  return Object.entries(statsObj)
    .map(([date, downloads]) => ({ date, downloads: Number(downloads || 0) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function readExistingStats(statsPath) {
  if (!fs.existsSync(statsPath)) {
    return { generated_at: null, source: {}, episodes: {}, summary: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch (err) {
    console.warn(`Could not parse existing stats.json, starting fresh: ${err.message}`);
    return { generated_at: null, source: {}, episodes: {}, summary: {} };
  }
}

function mergeEpisodeRecord(existingRecord, incomingMeta, dailyRows, todayIso) {
  const record = {
    podbean_episode_id: incomingMeta.podbean_episode_id,
    title: incomingMeta.title,
    permalink_url: incomingMeta.permalink_url,
    publish_time: incomingMeta.publish_time,
    tracking_started_at: existingRecord?.tracking_started_at || todayIso,
    last_successful_sync_at: todayIso,
    downloads_by_date: safeObject(existingRecord?.downloads_by_date),
  };

  for (const row of dailyRows) {
    record.downloads_by_date[row.date] = Number(row.downloads || 0);
  }

  const total = Object.values(record.downloads_by_date).reduce(
    (sum, value) => sum + Number(value || 0),
    0
  );

  record.plays_total = total;
  record.downloads_total = total;
  return record;
}

async function main() {
  const accessToken = await getAccessToken();
  const episodes = await getAllEpisodes(accessToken);

  const today = isoDateToday();
  const statsPath = path.resolve(process.cwd(), "stats", "stats.json");
  const existing = readExistingStats(statsPath);

  const output = {
    generated_at: new Date().toISOString(),
    source: {
      provider: "podbean",
      metric: "plays",
      window_days: TRACK_WINDOW_DAYS,
      strategy: "incremental_recent_window_merge",
    },
    episodes: safeObject(existing.episodes),
    summary: {
      total_episodes_seen: episodes.length,
      total_episodes_synced: 0,
      total_episodes_failed: 0,
      total_existing_records: Object.keys(safeObject(existing.episodes)).length,
    },
  };

  for (const ep of episodes) {
    const episodeId = ep?.id || "";
    if (!episodeId) continue;

    const title = normalizeEpisodeTitle(ep?.title);
    const permalink = ep?.permalink_url || ep?.link || "";
    const publishDateIso = ep?.publish_time ? new Date(ep.publish_time * 1000).toISOString() : "";

    const incomingMeta = {
      podbean_episode_id: episodeId,
      title,
      permalink_url: permalink,
      publish_time: publishDateIso,
    };

    const start = fetchStartDateForEpisode(publishDateIso, TRACK_WINDOW_DAYS);
    const end = today;

    try {
      const dailyRows = await getEpisodeDownloadsForRange(accessToken, episodeId, start, end);
      const existingRecord = safeObject(output.episodes[episodeId]);

      output.episodes[episodeId] = mergeEpisodeRecord(
        existingRecord,
        incomingMeta,
        dailyRows,
        today
      );

      output.summary.total_episodes_synced += 1;
      console.log(`Synced ${title} -> ${output.episodes[episodeId].plays_total}`);
    } catch (err) {
      const existingRecord = safeObject(output.episodes[episodeId]);
      output.episodes[episodeId] = {
        ...existingRecord,
        ...incomingMeta,
        downloads_by_date: safeObject(existingRecord.downloads_by_date),
        plays_total: Number(existingRecord.plays_total || existingRecord.downloads_total || 0),
        downloads_total: Number(existingRecord.downloads_total || existingRecord.plays_total || 0),
        tracking_started_at: existingRecord.tracking_started_at || today,
        last_successful_sync_at: existingRecord.last_successful_sync_at || null,
        last_failed_sync_at: today,
        last_error: err.message,
      };

      output.summary.total_episodes_failed += 1;
      console.warn(`Failed stats for ${title} (${episodeId}): ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  fs.writeFileSync(statsPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${statsPath}`);
  console.log(
    `Summary: seen=${output.summary.total_episodes_seen}, synced=${output.summary.total_episodes_synced}, failed=${output.summary.total_episodes_failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
