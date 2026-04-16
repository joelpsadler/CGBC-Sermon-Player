import { readFileSync } from "fs";
import { readJson, writeJson, extractYoutubeId, chunk } from "./utils.js";

const config = JSON.parse(readFileSync(new URL("../config/resolver-config.json", import.meta.url), "utf-8"));
const API_KEY = process.env.YOUTUBE_API_KEY || "";
const PREF = config.youtubeThumbnailPreference || ["maxres", "standard", "high", "medium", "default"];

function pickBestYoutubeThumb(thumbnails = {}) {
  for (const key of PREF) {
    if (thumbnails?.[key]?.url) return thumbnails[key].url;
  }
  return null;
}

async function fetchVideos(ids) {
  const params = new URLSearchParams({
    part: "snippet,statistics",
    id: ids.join(","),
    key: API_KEY
  });
  const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`YouTube fetch failed: ${resp.status}`);
  const json = await resp.json();
  return json.items || [];
}

async function main() {
  if (!API_KEY) {
    console.log("No YOUTUBE_API_KEY found. Writing empty raw-youtube-data.json");
    writeJson("data/raw-youtube-data.json", {});
    return;
  }

  const rss = readJson("data/raw-rss.json");
  const ids = [...new Set(
    rss.map(r => extractYoutubeId(r.notesFields?.["Video"] || "")).filter(Boolean)
  )];

  const out = {};
  for (const batch of chunk(ids, 50)) {
    const items = await fetchVideos(batch);
    for (const item of items) {
      out[item.id] = {
        youtubeId: item.id,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        views: Number(item?.statistics?.viewCount || 0),
        thumbnailWide: pickBestYoutubeThumb(item?.snippet?.thumbnails || {})
      };
    }
  }

  writeJson("data/raw-youtube-data.json", out);
  console.log(`YouTube items written: ${Object.keys(out).length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
