#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const CLIENT_ID = process.env.PODBEAN_CLIENT_ID;
const CLIENT_SECRET = process.env.PODBEAN_CLIENT_SECRET;
const STATS_DAYS = Number(process.env.PODBEAN_STATS_DAYS || 3650);
const PAGE_LIMIT = Math.min(100, Number(process.env.PODBEAN_LIMIT || 100));
const CHUNK_DAYS = 60;

const REQUEST_DELAY_MS = 700;
const RETRY_BASE_DELAY_MS = 2500;
const MAX_RETRIES = 4;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing PODBEAN_CLIENT_ID or PODBEAN_CLIENT_SECRET.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoDateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return isoDate(d);
}

function isoDateToday() {
  return isoDate(new Date());
}

function parseIsoDate(str) {
  return new Date(`${str}T00:00:00.000Z`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function buildDateChunks(startStr, endStr, chunkDays = CHUNK_DAYS) {
  const chunks = [];
  let cursor = parseIsoDate(startStr);
  const end = parseIsoDate(endStr);

  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    let chunkEnd = addDays(chunkStart, chunkDays - 1);

    if (chunkEnd > end) {
      chunkEnd = new Date(end);
    }

    chunks.push({
      start: isoDate(chunkStart),
      end: isoDate(chunkEnd),
    });

    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
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

    console.warn(
      `429 rate limit hit. Waiting ${waitMs}ms before retry ${retryCount + 1} for ${url}`
    );
    await sleep(waitMs);
    return fetchJson(url, options, retryCount + 1);
  }

  if (!res.ok) {
    throw new Error(
      `Request failed ${res.status} ${res.statusText} for ${url}\n${text}`
    );
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
      headers: {
        "User-Agent": "CGBCMediaPlayerStatsSync/1.0",
      },
    });

    const list = extractEpisodeList(data);

    episodes.push(...list);

    console.log(`Fetched episode page offset=${offset}, count=${list.length}`);

    if (list.length < PAGE_LIMIT) {
      break;
    }

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
    headers: {
      "User-Agent": "CGBCMediaPlayerStatsSync/1.0",
    },
  });

  const statsObj =
    data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats)
      ? data.stats
      : {};

  const daily = Object.entries(statsObj).map(([date, downloads]) => ({
    date,
    downloads: Number(downloads || 0),
  }));

  const total = daily.reduce((sum, row) => sum + row.downloads, 0);

  return {
    total_downloads: total,
    daily,
  };
}

async function getEpisodeDownloadsChunked(accessToken, episodeId, start, end) {
  const chunks = buildDateChunks(start, end, CHUNK_DAYS);
  const byDate = new Map();

  for (const chunk of chunks) {
    const result = await getEpisodeDownloadsForRange(
      accessToken,
      episodeId,
      chunk.start,
      chunk.end
    );

    for (const row of result.daily) {
      byDate.set(row.date, (byDate.get(row.date) || 0) + row.downloads);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const daily = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, downloads]) => ({
      date,
      downloads,
    }));

  const total = daily.reduce((sum, row) => sum + row.downloads, 0);

  return {
    total_downloads: total,
    daily,
  };
}

function normalizeEpisodeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function main() {
  const accessToken = await getAccessToken();
  const episodes = await getAllEpisodes(accessToken);

  const start = isoDateDaysAgo(STATS_DAYS);
  const end = isoDateToday();

  const output = {
    generated_at: new Date().toISOString(),
    source: {
      provider: "podbean",
      metric: "downloads",
      start,
      end,
      chunk_days: CHUNK_DAYS,
    },
    episodes: {},
    summary: {
      total_episodes_seen: episodes.length,
      total_episodes_synced: 0,
      total_episodes_failed: 0,
    },
  };

  for (const ep of episodes) {
    const episodeId = ep?.id || "";
    const title = normalizeEpisodeTitle(ep?.title);
    const permalink = ep?.permalink_url || ep?.link || "";
    const publishDate = ep?.publish_time
      ? new Date(ep.publish_time * 1000).toISOString()
      : "";

    if (!episodeId) {
      continue;
    }

    try {
      const episodeStart = publishDate
        ? publishDate.slice(0, 10)
        : start;

      const stats = await getEpisodeDownloadsChunked(
        accessToken,
        episodeId,
        episodeStart,
        end
      );

      output.episodes[episodeId] = {
        podbean_episode_id: episodeId,
        title,
        permalink_url: permalink,
        publish_time: publishDate,
        downloads_total: stats.total_downloads,
      };

      output.summary.total_episodes_synced += 1;
      console.log(`Synced ${title} -> ${stats.total_downloads}`);
    } catch (err) {
      output.summary.total_episodes_failed += 1;
      console.warn(`Failed stats for ${title} (${episodeId}): ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const outFile = path.resolve(process.cwd(), "stats", "stats.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${outFile}`);
  console.log(
    `Summary: seen=${output.summary.total_episodes_seen}, synced=${output.summary.total_episodes_synced}, failed=${output.summary.total_episodes_failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
