import { readFileSync, existsSync } from "fs";
import {
  readJson, writeJson, clean, slugify, simpleHash, splitPipeTitle,
  detectBibleBook, parseFlexibleDate, formatISODate, parseDurationToSeconds,
  extractYoutubeId
} from "./utils.js";

const config = JSON.parse(readFileSync(new URL("../config/resolver-config.json", import.meta.url), "utf-8"));
const variousDisplay = config?.displayRules?.variousScriptureDisplay || "Selected Scriptures";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function buildStableId(record) {
  if (record.mediaUrl) return `media-${simpleHash(record.mediaUrl)}`;
  if (record.rssGuid) return `guid-${simpleHash(record.rssGuid)}`;
  return `fallback-${simpleHash(`${record.pubDate}|${record.rssTitle}`)}`;
}

function resolveTitle(record) {
  const explicit = clean(record.notesFields?.["Title"]);
  const subtitle = clean(record.notesFields?.["Subtitle"]);
  const parts = splitPipeTitle(record.rssTitle);
  let episodeName = explicit || parts.left || clean(record.rssTitle) || "Untitled";

  if (!subtitle) {
    const match = episodeName.match(/^(.*)\(([^()]+)\)\s*$/);
    if (match) {
      episodeName = clean(match[1]);
      return {
        episodeName,
        subtitle: clean(match[2]),
        display: `${episodeName} (${clean(match[2])})`
      };
    }
  }

  return {
    episodeName,
    subtitle: subtitle || "",
    display: subtitle ? `${episodeName} (${subtitle})` : episodeName
  };
}

function mapSeriesType(raw) {
  const v = clean(raw).toLowerCase();
  if (!v) return null;
  if (v === "topical") return "topical";
  if (v === "expositional") return "expositional";
  if (v === "standalone") return "standalone";
  return null;
}

function deriveStudyFromSeries(seriesName) {
  const s = clean(seriesName);
  if (!s) return "";

  const chapterMatch = s.match(/^(.*?)(?:\s+chapter)?\s+\d+$/i);
  if (chapterMatch) return clean(chapterMatch[1]);

  if (s.includes(":")) return clean(s.split(":")[0]);

  const book = detectBibleBook(s);
  return book || "";
}

function inferSeriesType(seriesName, explicitStudy) {
  const s = clean(seriesName);
  const study = clean(explicitStudy);
  if (!s) return "standalone";
  if (s.includes(":")) return "topical";

  const bookish = detectBibleBook(s) || detectBibleBook(study);
  if (bookish && /(?:chapter\s*)?\d+$/i.test(s)) return "expositional";
  if (bookish && /pt\.?\s*\d+$/i.test(s)) return "expositional";
  return "standalone";
}

function deriveStudyType(studyName, seriesType) {
  if (!clean(studyName)) return "none";
  if (seriesType === "topical") return "topical_study";
  if (seriesType === "expositional") return detectBibleBook(studyName) ? "book_study" : "topical_study";
  return "none";
}

function resolveSeries(record) {
  const explicitSeries = clean(record.notesFields?.["Series"]);
  const parts = splitPipeTitle(record.rssTitle);
  const seriesName = explicitSeries || parts.right || "";
  const type = mapSeriesType(record.notesFields?.["Series Type"]) || inferSeriesType(seriesName, record.notesFields?.["Study"]);
  return {
    name: seriesName,
    key: slugify(seriesName),
    type
  };
}

function resolveStudy(record, series) {
  const explicitStudy = clean(record.notesFields?.["Study"]);
  const studyName = explicitStudy || deriveStudyFromSeries(series.name);
  return {
    name: studyName,
    key: slugify(studyName),
    type: deriveStudyType(studyName, series.type)
  };
}

function resolveScripture(record) {
  const raw = clean(record.notesFields?.["Scripture"]);
  if (!raw) return { raw: "", display: "", book: null, bookKey: null, isVarious: false };
  if (raw.toLowerCase() === "various") {
    return { raw: "Various", display: variousDisplay, book: null, bookKey: null, isVarious: true };
  }
  const book = detectBibleBook(raw);
  return {
    raw,
    display: raw,
    book: book || null,
    bookKey: book ? slugify(book) : null,
    isVarious: false
  };
}

function resolveBookTags(record) {
  const raw = clean(record.notesFields?.["Book Tags"]);
  if (!raw) return [];
  return raw.split(",").map(v => clean(v)).filter(Boolean).map(name => ({ name, key: slugify(name) }));
}

function resolveDate(record) {
  const raw = clean(record.notesFields?.["Date"]) || clean(record.pubDate);
  const dt = parseFlexibleDate(raw);
  return {
    raw,
    iso: formatISODate(dt),
    year: dt ? dt.getUTCFullYear() : null,
    month: dt ? dt.getUTCMonth() + 1 : null,
    monthName: dt ? MONTHS[dt.getUTCMonth()] : null,
    day: dt ? dt.getUTCDate() : null
  };
}

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

function buildStatsIndexes(statsDoc) {
  const byMediaUrl = new Map();
  const byEpisodeUrl = new Map();
  const byDayAndTitle = new Map();
  const byTitleKey = new Map();

  for (const episode of Object.values(statsDoc?.episodes || {})) {
    const mediaUrl = clean(episode.media_url);
    const episodeUrl = clean(episode.episode_url || episode.permalink_url);
    const titleKey = normalizeTitleKey(episode.public_listing_title || episode.title || "");
    const publishDay = toIsoDay(episode.publish_time);
    const compound = `${publishDay}|${titleKey}`;

    if (mediaUrl) byMediaUrl.set(mediaUrl, episode);
    if (episodeUrl) byEpisodeUrl.set(episodeUrl, episode);
    if (publishDay && titleKey && !byDayAndTitle.has(compound)) byDayAndTitle.set(compound, episode);
    if (titleKey && !byTitleKey.has(titleKey)) byTitleKey.set(titleKey, episode);
  }

  return { byMediaUrl, byEpisodeUrl, byDayAndTitle, byTitleKey };
}

function matchStats(record, statsIndexes) {
  const mediaUrl = clean(record.mediaUrl);
  const episodeUrl = clean(record.episodeUrl);
  const titleKey = normalizeTitleKey(record.rssTitle);
  const publishDay = toIsoDay(record.pubDate);
  const compound = `${publishDay}|${titleKey}`;

  if (mediaUrl && statsIndexes.byMediaUrl.has(mediaUrl)) {
    return { episode: statsIndexes.byMediaUrl.get(mediaUrl), strategy: "media_url" };
  }
  if (episodeUrl && statsIndexes.byEpisodeUrl.has(episodeUrl)) {
    return { episode: statsIndexes.byEpisodeUrl.get(episodeUrl), strategy: "episode_url" };
  }
  if (publishDay && titleKey && statsIndexes.byDayAndTitle.has(compound)) {
    return { episode: statsIndexes.byDayAndTitle.get(compound), strategy: "publish_day+title_key" };
  }
  if (titleKey && statsIndexes.byTitleKey.has(titleKey)) {
    return { episode: statsIndexes.byTitleKey.get(titleKey), strategy: "title_key" };
  }
  return { episode: null, strategy: "" };
}

function resolveAudio(record, statsMatch) {
  const statsEpisode = statsMatch?.episode;
  return {
    hasAudio: Boolean(record.mediaUrl),
    url: record.mediaUrl || null,
    plays: Number(statsEpisode?.plays_total || 0),
    durationSeconds: parseDurationToSeconds(record.itunesDuration),
    episodeArtSquare: record.episodeImage || null
  };
}

function resolveVideo(record, youtubeData) {
  const rawUrl = clean(record.notesFields?.["Video"]);
  const youtubeId = extractYoutubeId(rawUrl);
  const yt = youtubeId ? youtubeData[youtubeId] : null;
  return {
    hasVideo: Boolean(youtubeId),
    youtubeId: youtubeId || null,
    url: yt?.url || rawUrl || null,
    views: Number(yt?.views || 0),
    episodeArtWide: yt?.thumbnailWide || null
  };
}

function buildEpisodeArt(audio, video) {
  return {
    episode: {
      square: audio.episodeArtSquare || null,
      wide: video.episodeArtWide || null
    },
    series: {
      square: null,
      wide: null
    },
    study: {
      square: null,
      wide: null
    }
  };
}

function resolveMemberships(series, study, scripture, bookTags, date) {
  const bibleBooks = bookTags.length
    ? bookTags.map(t => t.key)
    : (scripture.bookKey ? [scripture.bookKey] : []);

  return {
    series: series.key ? [series.key] : [],
    studies: study.key ? [study.key] : [],
    bibleBooks,
    byYear: date.year ? [String(date.year)] : [],
    byMonth: (date.year && date.month) ? [`${date.year}-${String(date.month).padStart(2, "0")}`] : []
  };
}

function resolveBibleBooksMode(series, study, memberships) {
  if (!memberships.bibleBooks.length) return "none";
  if (series.type === "topical") return "episode_only";
  if (series.type === "standalone") return "episode_only";
  if (series.type === "expositional" && study.type === "book_study") return "series_group";
  return "episode_only";
}

function resolveFlags(series, video) {
  return {
    isStandaloneEpisode: series.type === "standalone",
    includeInAudioTotals: true,
    includeInVideoTotals: Boolean(video.hasVideo)
  };
}

// -----------------------------------------------------------------------------
// CURRENT SERIES AUTO-DETECTION
// -----------------------------------------------------------------------------
// Beginner note:
// This replaces the old hand-edited CURRENT_SERIES_KEYS list in index.html.
// The site usually has two active lanes:
//   - Sunday lane: newest regular Sunday series wins.
//   - Wednesday lane: newest regular Wednesday series wins.
// Specials and guest/one-off buckets are intentionally ignored so they do not
// accidentally replace an active sermon/study series.
//
// Optional override lives in config/resolver-config.json:
//   "currentSeries": {
//     "overrides": {
//       "sunday": null,
//       "wednesday": null
//     }
//   }
// Set either override to a series key, like "romans-chapter-12", only if the
// automatic detection ever needs a manual safety valve.

const DEFAULT_CURRENT_IGNORE_PATTERNS = [
  "special",
  "single events",
  "single sermons",
  "guest speaker",
  "guest speakers",
  "livestream",
  "shorts"
];

function getCurrentConfig() {
  return config?.currentSeries || {};
}

function getCurrentOverrides() {
  const overrides = getCurrentConfig()?.overrides || {};
  return {
    sunday: clean(overrides.sunday),
    wednesday: clean(overrides.wednesday)
  };
}

function currentIgnorePatterns() {
  const configured = getCurrentConfig()?.ignoreSeriesNamePatterns;
  const values = Array.isArray(configured) && configured.length ? configured : DEFAULT_CURRENT_IGNORE_PATTERNS;
  return values.map(v => String(v || "").trim()).filter(Boolean);
}

function currentLaneFromIsoDate(isoDate) {
  if (!isoDate) return null;
  const dt = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const day = dt.getUTCDay();
  if (day === 0) return "sunday";
  if (day === 3) return "wednesday";
  return null;
}

function isIgnoredCurrentSeries(item) {
  const seriesKey = clean(item?.series?.key);
  const seriesName = clean(item?.series?.name);
  if (!seriesKey || !seriesName) return true;
  if (seriesKey === "current" || seriesName.toLowerCase() === "current") return true;
  if (item?.series?.type === "native_youtube_shelf") return true;

  const haystack = `${seriesName} ${item?.study?.name || ""} ${item?.title?.display || ""}`.toLowerCase();
  return currentIgnorePatterns().some(pattern => haystack.includes(pattern.toLowerCase()));
}

function newestItemsFirst(items) {
  return [...items].sort((a, b) => {
    const aDate = a?.date?.iso || "";
    const bDate = b?.date?.iso || "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return clean(b?.title?.display).localeCompare(clean(a?.title?.display));
  });
}

function buildCurrentLaneFromItem(lane, item, source) {
  if (!item) return null;
  return {
    lane,
    seriesKey: item.series.key,
    seriesName: item.series.name,
    studyKey: item.study?.key || null,
    studyName: item.study?.name || null,
    detectedFromEpisode: item.stableId,
    detectedFromDate: item.date?.iso || null,
    detectedFromTitle: item.title?.display || null,
    source
  };
}

function findNewestItemForSeries(items, seriesKey) {
  return newestItemsFirst(items).find(item => clean(item?.series?.key) === seriesKey) || null;
}

function detectCurrentSeries(items) {
  const overrides = getCurrentOverrides();
  const lanes = { sunday: null, wednesday: null };
  const candidates = newestItemsFirst(items).filter(item => !isIgnoredCurrentSeries(item));

  for (const lane of ["sunday", "wednesday"]) {
    if (overrides[lane]) {
      const overrideItem = findNewestItemForSeries(candidates, overrides[lane]);
      if (overrideItem) {
        lanes[lane] = buildCurrentLaneFromItem(lane, overrideItem, "manual_override");
        continue;
      }
      lanes[lane] = {
        lane,
        seriesKey: overrides[lane],
        seriesName: overrides[lane],
        studyKey: null,
        studyName: null,
        detectedFromEpisode: null,
        detectedFromDate: null,
        detectedFromTitle: null,
        source: "manual_override_missing_matching_episode"
      };
      continue;
    }

    const newestInLane = candidates.find(item => currentLaneFromIsoDate(item?.date?.iso) === lane);
    lanes[lane] = newestInLane ? buildCurrentLaneFromItem(lane, newestInLane, "auto_detected_by_publish_day_lane") : null;
  }

  const seriesKeys = [];
  for (const lane of ["sunday", "wednesday"]) {
    const key = clean(lanes[lane]?.seriesKey);
    if (key && !seriesKeys.includes(key)) seriesKeys.push(key);
  }

  return {
    strategy: "auto_detect_by_sunday_wednesday_lanes",
    note: "Sunday and Wednesday current series are generated from the newest non-special, non-guest series in each lane. Overrides live in config/resolver-config.json.",
    overrides,
    seriesKeys,
    lanes
  };
}

function applyInheritedArt(items) {
  const sorted = [...items].sort((a, b) => {
    const aDate = a.date.iso || "9999-99-99";
    const bDate = b.date.iso || "9999-99-99";
    return aDate.localeCompare(bDate);
  });

  const firstBySeries = new Map();
  const firstByStudy = new Map();

  for (const item of sorted) {
    if (item.series.key && !firstBySeries.has(item.series.key)) firstBySeries.set(item.series.key, item);
    if (item.study.key && !firstByStudy.has(item.study.key)) firstByStudy.set(item.study.key, item);
  }

  for (const item of items) {
    const s = item.series.key ? firstBySeries.get(item.series.key) : null;
    const st = item.study.key ? firstByStudy.get(item.study.key) : null;
    item.art.series.square = s?.art?.episode?.square || null;
    item.art.series.wide = s?.art?.episode?.wide || null;
    item.art.study.square = st?.art?.episode?.square || null;
    item.art.study.wide = st?.art?.episode?.wide || null;
  }
}

function readStatsDoc() {
  const preferred = ["stats/stats.json", "data/stats.json", "stats.json"];
  for (const path of preferred) {
    if (existsSync(path)) return readJson(path);
  }
  return null;
}

function main() {
  const rss = readJson("data/raw-rss.json");
  const youtube = readJson("data/raw-youtube-data.json");
  const statsDoc = readStatsDoc();
  const statsIndexes = buildStatsIndexes(statsDoc || { episodes: {} });

  const items = rss.map(record => {
    const stableId = buildStableId(record);
    const title = resolveTitle(record);
    const series = resolveSeries(record);
    const study = resolveStudy(record, series);
    const scripture = resolveScripture(record);
    const bookTags = resolveBookTags(record);
    const date = resolveDate(record);
    const statsMatch = matchStats(record, statsIndexes);
    const audio = resolveAudio(record, statsMatch);
    const video = resolveVideo(record, youtube);
    const art = buildEpisodeArt(audio, video);
    const memberships = resolveMemberships(series, study, scripture, bookTags, date);
    const bibleBooksMode = resolveBibleBooksMode(series, study, memberships);
    const flags = resolveFlags(series, video);

    return {
      stableId,
      sourceKey: {
        mediaUrl: record.mediaUrl || null,
        rssGuid: record.rssGuid || null
      },
      links: {
        episodeUrl: record.episodeUrl || statsMatch?.episode?.episode_url || statsMatch?.episode?.permalink_url || null,
        shareUrl: statsMatch?.episode?.share_url || statsMatch?.episode?.episode_url || statsMatch?.episode?.permalink_url || record.episodeUrl || null
      },
      title,
      series,
      study,
      scripture,
      bookTags,
      speaker: clean(record.notesFields?.["by"]) || null,
      date,
      audio: {
        hasAudio: audio.hasAudio,
        url: audio.url,
        plays: audio.plays,
        durationSeconds: audio.durationSeconds,
        statsMatchStrategy: statsMatch.strategy || ""
      },
      video: {
        hasVideo: video.hasVideo,
        youtubeId: video.youtubeId,
        url: video.url,
        views: video.views
      },
      art,
      memberships,
      presentation: {
        bibleBooksMode
      },
      flags
    };
  });

  applyInheritedArt(items);

  const output = {
    generatedAt: new Date().toISOString(),
    version: 1,
    sourceSummary: {
      rssItems: rss.length,
      archiveItems: items.length,
      videoMatchedItems: items.filter(i => i.video.hasVideo).length
    },
    totals: {
      audioPlaysTotal: Number(statsDoc?.podcast_totals?.plays_total || 0),
      audioEpisodesTotal: Number(statsDoc?.podcast_totals?.episodes_total || items.length)
    },
    current: detectCurrentSeries(items),
    items
  };

  writeJson("data/library-resolved.json", output);
  console.log(`Resolved archive items: ${items.length}`);
}

main();
