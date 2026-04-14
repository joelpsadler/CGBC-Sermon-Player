#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const CLIENT_ID = process.env.PODBEAN_CLIENT_ID;
const CLIENT_SECRET = process.env.PODBEAN_CLIENT_SECRET;
const STATS_DAYS = Number(process.env.PODBEAN_STATS_DAYS || 3650);
const PAGE_LIMIT = Math.min(100, Number(process.env.PODBEAN_LIMIT || 100));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing PODBEAN_CLIENT_ID or PODBEAN_CLIENT_SECRET.");
  process.exit(1);
}

function isoDateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function isoDateToday() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}\n${text}`);
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

  if (!data.access_token) throw new Error("Podbean token response did not include access_token.");
  return data.access_token;
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

    const list = Array.isArray(data.episodes) ? data.episodes : [];
    episodes.push(...list);
    if (list.length < PAGE_LIMIT) break;
    offset += list.length;
  }

  return episodes;
}

async function getEpisodeDownloads(accessToken, episodeId, start, end) {
  const url = new URL("https://api.podbean.com/v1/podcastStats/stats");
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("episode_id", episodeId);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);

  const data = await fetchJson(url.toString(), {
    headers: { "User-Agent": "CGBCMediaPlayerStatsSync/1.0" },
  });

  const stats = Array.isArray(data.stats) ? data.stats : [];
  const total = stats.reduce((sum, row) => sum + Number(row.downloads || 0), 0);

  return { total_downloads: total };
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
    source: { provider: "podbean", metric: "downloads", start, end },
    episodes: {},
  };

  for (const ep of episodes) {
    const episodeId = ep.id || "";
    const title = normalizeEpisodeTitle(ep.title);
    const permalink = ep.permalink_url || ep.link || "";
    const publishDate = ep.publish_time ? new Date(ep.publish_time * 1000).toISOString() : "";
    if (!episodeId) continue;

    try {
      const stats = await getEpisodeDownloads(accessToken, episodeId, start, end);
      output.episodes[episodeId] = {
        podbean_episode_id: episodeId,
        title,
        permalink_url: permalink,
        publish_time: publishDate,
        downloads_total: stats.total_downloads,
      };
      console.log(`Synced ${title} -> ${stats.total_downloads}`);
    } catch (err) {
      console.warn(`Failed stats for ${title} (${episodeId}): ${err.message}`);
    }
  }

  const outFile = path.resolve(process.cwd(), "stats", "stats.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
