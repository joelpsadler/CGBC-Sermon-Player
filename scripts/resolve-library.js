import { readFileSync } from "fs";
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
  if (s.includes(":")) return clean(s.split(":")[0]);
  const m = s.match(/^(.+?)\s+\d+$/);
  if (m) return clean(m[1]);
  const book = detectBibleBook(s);
  return book || "";
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
  const type = mapSeriesType(record.notesFields?.["Series Type"]) || (seriesName ? "standalone" : "standalone");
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
  if (!raw) {
    return { raw: "", display: "", book: null, bookKey: null, isVarious: false };
  }
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

function resolveAudio(record) {
  return {
    hasAudio: Boolean(record.mediaUrl),
    url: record.mediaUrl || null,
    plays: 0,
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

function main() {
  const rss = readJson("data/raw-rss.json");
  const youtube = readJson("data/raw-youtube-data.json");

  const items = rss.map(record => {
    const stableId = buildStableId(record);
    const title = resolveTitle(record);
    const series = resolveSeries(record);
    const study = resolveStudy(record, series);
    const scripture = resolveScripture(record);
    const bookTags = resolveBookTags(record);
    const date = resolveDate(record);
    const audio = resolveAudio(record);
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
        durationSeconds: audio.durationSeconds
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
    items
  };

  writeJson("data/library-resolved.json", output);
  console.log(`Resolved archive items: ${items.length}`);
}

main();
