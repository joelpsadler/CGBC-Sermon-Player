import { readFileSync, existsSync } from "fs";
import { XMLParser } from "fast-xml-parser";
import { clean, writeJson } from "./utils.js";

const config = JSON.parse(readFileSync(new URL("../config/resolver-config.json", import.meta.url), "utf-8"));
const RSS_URL = config.rssUrl;
const INPUT_PATH = process.env.PODBEAN_STATS_INPUT || "stats.json";
const OUTPUT_PATH = process.env.PODBEAN_STATS_OUTPUT || "data/stats.json";

function normalizeTitleKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDay(value) {
  const dt = new Date(value || "");
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseRssItems(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    trimValues: false
  });

  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  const items = Array.isArray(channel?.item) ? channel.item : (channel?.item ? [channel.item] : []);

  return items.map(item => {
    const enclosure = first(item.enclosure);
    const title = clean(first(item.title));
    const episodeUrl = clean(first(item.link));
    const mediaUrl = clean(enclosure?.url || "");
    const pubDate = clean(first(item.pubDate));

    return {
      rssTitle: title,
      titleKey: normalizeTitleKey(title),
      episodeUrl,
      mediaUrl,
      publishDay: toIsoDay(pubDate),
      pubDate
    };
  });
}

function enrichStats(statsDoc, rssItems) {
  const byEpisodeUrl = new Map();
  const byTitleKey = new Map();
  const byDayAndTitle = new Map();

  for (const item of rssItems) {
    if (item.episodeUrl) byEpisodeUrl.set(item.episodeUrl, item);
    if (item.titleKey && !byTitleKey.has(item.titleKey)) byTitleKey.set(item.titleKey, item);
    const compound = `${item.publishDay}|${item.titleKey}`;
    if (item.publishDay && item.titleKey && !byDayAndTitle.has(compound)) byDayAndTitle.set(compound, item);
  }

  for (const [episodeId, episode] of Object.entries(statsDoc.episodes || {})) {
    const permalink = clean(episode.permalink_url);
    const titleKey = normalizeTitleKey(episode.public_listing_title || episode.title || "");
    const publishDay = toIsoDay(episode.publish_time);

    let match = null;
    let matchStrategy = "";

    if (permalink && byEpisodeUrl.has(permalink)) {
      match = byEpisodeUrl.get(permalink);
      matchStrategy = "permalink_url";
    } else {
      const compound = `${publishDay}|${titleKey}`;
      if (publishDay && titleKey && byDayAndTitle.has(compound)) {
        match = byDayAndTitle.get(compound);
        matchStrategy = "publish_day+title_key";
      } else if (titleKey && byTitleKey.has(titleKey)) {
        match = byTitleKey.get(titleKey);
        matchStrategy = "title_key";
      }
    }

    episode.media_url = match?.mediaUrl || "";
    episode.episode_url = match?.episodeUrl || permalink || "";
    episode.share_url = episode.episode_url || permalink || "";
    episode.match_strategy = matchStrategy || "";
    episode.rss_title = match?.rssTitle || "";
  }

  return statsDoc;
}

async function main() {
  if (!existsSync(INPUT_PATH)) {
    throw new Error(`Missing stats input file: ${INPUT_PATH}`);
  }

  const statsDoc = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));
  const xml = await fetch(RSS_URL).then(r => {
    if (!r.ok) throw new Error(`RSS fetch failed: ${r.status}`);
    return r.text();
  });

  const rssItems = parseRssItems(xml);
  const enriched = enrichStats(statsDoc, rssItems);

  writeJson(OUTPUT_PATH, enriched);
  console.log(`Enriched stats episodes: ${Object.keys(enriched.episodes || {}).length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
