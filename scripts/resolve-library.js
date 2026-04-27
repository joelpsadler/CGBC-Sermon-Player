import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import {
  readJson, writeJson, clean, slugify, simpleHash, splitPipeTitle,
  detectBibleBook, parseFlexibleDate, formatISODate, parseDurationToSeconds,
  extractYoutubeId
} from "./utils.js";

const config = JSON.parse(readFileSync(new URL("../config/resolver-config.json", import.meta.url), "utf-8"));

function readOptionalJson(path, fallback = {}) {
  try {
    if (existsSync(path)) return readJson(path);
  } catch (err) {
    console.warn(`Could not read optional JSON file ${path}: ${err.message}`);
  }
  return fallback;
}

const collectionsConfig = readOptionalJson("config/collections-config.json", { collections: {} });
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


// -----------------------------------------------------------------------------
// SCRIPTURE / REFERENCE SEARCH EXPANSION
// -----------------------------------------------------------------------------
// Beginner note:
// "Scripture" stays clean for display. The optional "References" note field can
// hold all extra cross-references covered in the sermon. These helpers quietly
// expand ranges like "Matthew 28:18-20" into searchable tokens:
//   Matthew 28:18, Matthew 28:19, Matthew 28:20
// This lets somebody search for a verse inside a range without making the cards
// show a giant block of references.

const BIBLE_BOOK_NAMES = [
  "Song of Solomon", "1 Thessalonians", "2 Thessalonians", "1 Corinthians", "2 Corinthians",
  "1 Chronicles", "2 Chronicles", "1 Timothy", "2 Timothy", "1 Samuel", "2 Samuel",
  "1 Kings", "2 Kings", "1 Peter", "2 Peter", "1 John", "2 John", "3 John",
  "Deuteronomy", "Ecclesiastes", "Lamentations", "Philippians", "Colossians",
  "Thessalonians", "Corinthians", "Chronicles", "Revelation", "Zephaniah",
  "Habakkuk", "Zechariah", "Malachi", "Matthew", "Genesis", "Exodus", "Leviticus",
  "Numbers", "Joshua", "Judges", "Samuel", "Kings", "Ezra", "Nehemiah", "Esther",
  "Psalms", "Psalm", "Proverbs", "Isaiah", "Jeremiah", "Ezekiel", "Daniel", "Hosea",
  "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Haggai", "Mark", "Luke",
  "John", "Acts", "Romans", "Galatians", "Ephesians", "Timothy", "Titus", "Philemon",
  "Hebrews", "James", "Peter", "Jude", "Ruth", "Job"
].sort((a, b) => b.length - a.length);

function normalizeReferenceSpacing(value) {
  return clean(value)
    .replace(/[–—]/g, "-")
    .replace(/\s*:\s*/g, ":")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function findReferenceBook(segment) {
  const normalized = normalizeReferenceSpacing(segment);
  const lower = normalized.toLowerCase();
  for (const book of BIBLE_BOOK_NAMES) {
    const bookLower = book.toLowerCase();
    if (lower === bookLower || lower.startsWith(`${bookLower} `)) {
      return {
        book,
        rest: normalized.slice(book.length).trim()
      };
    }
  }
  return { book: "", rest: normalized };
}

function addUniqueToken(tokens, value) {
  const token = normalizeReferenceSpacing(value);
  if (token && !tokens.includes(token)) tokens.push(token);
}

function expandVerseExpression(book, chapter, verseExpression, tokens) {
  const cleanBook = clean(book);
  const cleanChapter = String(chapter || "").trim();
  const expr = normalizeReferenceSpacing(verseExpression);
  if (!cleanBook || !cleanChapter || !expr) return;

  addUniqueToken(tokens, `${cleanBook} ${cleanChapter}:${expr}`);

  for (const piece of expr.split(/\s*,\s*/).map(v => v.trim()).filter(Boolean)) {
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 200) {
        for (let verse = start; verse <= end; verse += 1) {
          addUniqueToken(tokens, `${cleanBook} ${cleanChapter}:${verse}`);
        }
      }
      continue;
    }

    const single = piece.match(/^\d+$/);
    if (single) addUniqueToken(tokens, `${cleanBook} ${cleanChapter}:${piece}`);
  }
}

function expandScriptureReferences(rawValue) {
  const raw = normalizeReferenceSpacing(rawValue);
  if (!raw || raw.toLowerCase() === "various") return [];

  const tokens = [];
  let currentBook = "";
  let currentChapter = "";

  // Split on commas and semicolons. Carry the previous book/chapter forward so
  // "2 Timothy 2:1-2, 11-15, 3:16-17" expands correctly.
  for (const originalSegment of raw.split(/[;,]/).map(v => v.trim()).filter(Boolean)) {
    const found = findReferenceBook(originalSegment);
    let rest = found.rest;
    if (found.book) currentBook = found.book;
    if (!currentBook) continue;

    rest = normalizeReferenceSpacing(rest);
    if (!rest) {
      addUniqueToken(tokens, currentBook);
      continue;
    }

    const chapterVerse = rest.match(/^(\d+)\s*:\s*(.+)$/);
    if (chapterVerse) {
      currentChapter = chapterVerse[1];
      expandVerseExpression(currentBook, currentChapter, chapterVerse[2], tokens);
      continue;
    }

    // Verse-only continuation, such as "11-15" after "2 Timothy 2:1-2".
    if (currentChapter && /^\d+(?:-\d+)?$/.test(rest)) {
      expandVerseExpression(currentBook, currentChapter, rest, tokens);
      continue;
    }

    // Chapter-only fallback.
    const chapterOnly = rest.match(/^(\d+)$/);
    if (chapterOnly) {
      currentChapter = chapterOnly[1];
      addUniqueToken(tokens, `${currentBook} ${currentChapter}`);
    }
  }

  return tokens;
}

function resolveReferences(record, scripture) {
  const rawReferences = clean(record.notesFields?.["References"]);
  const scriptureTokens = expandScriptureReferences(scripture?.raw || "");
  const referenceTokens = expandScriptureReferences(rawReferences);
  const allTokens = [];

  for (const token of [...scriptureTokens, ...referenceTokens]) addUniqueToken(allTokens, token);

  return {
    raw: rawReferences,
    display: rawReferences,
    tokens: referenceTokens,
    searchTokens: allTokens
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

// -----------------------------------------------------------------------------
// CURATED COLLECTIONS
// -----------------------------------------------------------------------------
// Beginner note:
// Add optional RSS metadata like:
//   Collections: Spiritual Gifts, Church Body
// This does not duplicate the media. It just lets the same episode appear inside
// curated topical collection paths. Collection art can be stored in GitHub at:
//   assets/collections/<collection-key>/square.jpg
//   assets/collections/<collection-key>/wide.jpg
// Optional display/order overrides live in config/collections-config.json.

function collectionConfigForKey(key) {
  return collectionsConfig?.collections?.[key] || {};
}

function collectionArtForKey(key) {
  const configured = collectionConfigForKey(key)?.art || {};
  const squarePath = configured.square || `assets/collections/${key}/square.jpg`;
  const widePath = configured.wide || `assets/collections/${key}/wide.jpg`;
  return {
    square: existsSync(squarePath) ? squarePath : (configured.square || null),
    wide: existsSync(widePath) ? widePath : (configured.wide || null)
  };
}

function resolveCollections(record) {
  const raw = clean(record.notesFields?.["Collections"]);
  if (!raw) return [];
  return raw
    .split(",")
    .map(v => clean(v))
    .filter(Boolean)
    .map(name => {
      const key = slugify(name);
      const cfg = collectionConfigForKey(key);
      return {
        name: clean(cfg.name) || name,
        key,
        description: clean(cfg.description) || "",
        sortOrder: Number.isFinite(Number(cfg.sortOrder)) ? Number(cfg.sortOrder) : 999,
        art: collectionArtForKey(key)
      };
    });
}

function buildCollectionsSummary(items) {
  const map = new Map();
  for (const item of items) {
    for (const collection of item.collections || []) {
      if (!collection?.key) continue;
      if (!map.has(collection.key)) {
        map.set(collection.key, {
          key: collection.key,
          name: collection.name,
          description: collection.description || "",
          sortOrder: collection.sortOrder ?? 999,
          art: collection.art || { square: null, wide: null },
          count: 0
        });
      }
      map.get(collection.key).count += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
  });
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


// -----------------------------------------------------------------------------
// TRANSCRIPT INGEST SYSTEM - FCP SRT DROP ZONE
// -----------------------------------------------------------------------------
// Beginner note:
// This is the first transcript data layer. It does NOT change the website UI yet.
// Weekly workflow:
//   1. Export an SRT from Final Cut Pro.
//   2. Put it in GitHub at: transcripts_incoming/YYYY-MM-DD.srt
//      Example: transcripts_incoming/2026-04-22.srt
//   3. Run the normal Build Sermon Library workflow.
//   4. This resolver cleans the SRT, matches it to the RSS episode by date,
//      writes a canonical clean SRT, and writes timed JSON for the site.
//
// Why date-only incoming names?
// The incoming folder is meant to be easy for humans. The script already knows
// the real episode title from RSS/Podbean metadata, so it creates the final slug.
//
// Why strip tags here?
// Final Cut Pro may export captions like:
//   <font color="#ffffff">Turn in your Bibles...</font>
// That is valid-ish caption styling, but it is bad search data. We strip HTML-ish
// tags so the transcript can safely become searchable text.

const TRANSCRIPT_DEFAULT_LANGUAGE = "en";
const TRANSCRIPT_INCOMING_DIR = "transcripts_incoming";
const TRANSCRIPT_CLEAN_DIR = "transcripts_clean";
const TRANSCRIPT_DISPLAY_DIR = "transcripts_display";
const TRANSCRIPT_JSON_DIR = "data/transcripts";

// -----------------------------------------------------------------------------
// FUTURE LANGUAGE FOLDER PLAN
// -----------------------------------------------------------------------------
// Beginner note:
// We are keeping today's English workflow simple:
//   transcripts_incoming/2026-04-22.srt
//
// But every generated transcript now lands in a language folder:
//   transcripts_clean/en/...
//   transcripts_display/en/...
//   data/transcripts/en/...
//
// Later, translated subtitles can use the same structure:
//   transcripts_clean/es/...
//   transcripts_display/es/...
//   data/transcripts/es/...
//
// That means the frontend can eventually load:
//   episode.transcript.languages.en
//   episode.transcript.languages.es
// without redesigning the data model.

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function cleanTranscriptText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function srtTimestampToSeconds(value) {
  const match = String(value || "").trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return (hours * 3600) + (minutes * 60) + seconds + (millis / 1000);
}

function secondsToSrtTimestamp(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0")
  ].join(":") + `,${String(millis).padStart(3, "0")}`;
}

function parseSrt(rawSrt) {
  const normalized = String(rawSrt || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalized) return [];

  return normalized
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
      let cursor = 0;

      // SRT blocks normally begin with a numeric counter. Keep parsing even if
      // Final Cut or another tool omits/mangles that counter.
      if (/^\d+$/.test(lines[0] || "")) cursor = 1;

      const timingLine = lines[cursor] || "";
      const timingMatch = timingLine.match(/^(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/);
      if (!timingMatch) return null;

      const startRaw = timingMatch[1].trim();
      const endRaw = timingMatch[2].trim();
      const text = cleanTranscriptText(lines.slice(cursor + 1).join(" "));

      if (!text) return null;

      return {
        index: index + 1,
        start: srtTimestampToSeconds(startRaw),
        end: srtTimestampToSeconds(endRaw),
        startTime: startRaw,
        endTime: endRaw,
        text
      };
    })
    .filter(Boolean)
    .map((segment, index) => ({ ...segment, index: index + 1 }));
}

function buildCleanSrt(segments) {
  return segments
    .map((segment, index) => [
      String(index + 1),
      `${secondsToSrtTimestamp(segment.start)} --> ${secondsToSrtTimestamp(segment.end)}`,
      segment.text
    ].join("\n"))
    .join("\n\n") + "\n";
}

function buildTranscriptPlainText(segments) {
  return cleanTranscriptText(segments.map(segment => segment.text).join(" "));
}
function isFillerOnlyTranscriptText(value) {
  const normalized = cleanTranscriptText(value)
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]{}]/g, "")
    .trim();

  return [
    "uh",
    "um",
    "uhm",
    "ah",
    "er",
    "hmm",
    "mm",
    "mmm"
  ].includes(normalized);
}

function cleanDisplayTranscriptText(value) {
  return cleanTranscriptText(value)
    .replace(/\b(?:uh|um|uhm|ah|er)\b[,.]?\s*/gi, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildDisplaySegments(rawSegments) {
  const displaySegments = [];

  for (const segment of rawSegments || []) {
    const displayText = cleanDisplayTranscriptText(segment.text);

    // Remove tiny filler-only captions from the display layer only.
    // The faithful raw/clean transcript stays untouched.
    if (!displayText || isFillerOnlyTranscriptText(segment.text)) continue;

    const previous = displaySegments[displaySegments.length - 1];
    const shortFragment = displayText.length < 45;
    const closeToPrevious = previous && (segment.start - previous.end) <= 1.25;
    const previousLooksOpen = previous && !/[.!?]$/.test(previous.text);

    if (previous && shortFragment && closeToPrevious && previousLooksOpen) {
      previous.end = segment.end;
      previous.endTime = secondsToSrtTimestamp(segment.end);
      previous.text = cleanTranscriptText(`${previous.text} ${displayText}`);
      continue;
    }

    displaySegments.push({
      ...segment,
      index: displaySegments.length + 1,
      text: displayText
    });
  }

  return displaySegments.map((segment, index) => ({ ...segment, index: index + 1 }));
}


function blankTranscript() {
  return {
    hasTranscript: false,
    defaultLanguage: TRANSCRIPT_DEFAULT_LANGUAGE,
    languages: {},
    incomingFile: null,
    cleanFile: null,
    displayFile: null,
    jsonFile: null,
    displayJsonFile: null,
    segmentCount: 0,
    displaySegmentCount: 0
  };
}

function resolveTranscript(stableId, title, date) {
  if (!date?.iso) return { transcript: blankTranscript(), searchText: "" };

  const language = TRANSCRIPT_DEFAULT_LANGUAGE;
  const incomingFile = `${TRANSCRIPT_INCOMING_DIR}/${date.iso}.srt`;
  if (!existsSync(incomingFile)) return { transcript: blankTranscript(), searchText: "" };

  const titleSlug = slugify(title?.episodeName || title?.display || "episode");
  const baseName = `${date.iso}_${titleSlug || "episode"}`;

  const cleanLanguageDir = `${TRANSCRIPT_CLEAN_DIR}/${language}`;
  const displayLanguageDir = `${TRANSCRIPT_DISPLAY_DIR}/${language}`;
  const jsonLanguageDir = `${TRANSCRIPT_JSON_DIR}/${language}`;

  const cleanFile = `${cleanLanguageDir}/${baseName}.srt`;
  const displayFile = `${displayLanguageDir}/${baseName}.srt`;
  const jsonFile = `${jsonLanguageDir}/${baseName}.json`;
  const displayJsonFile = `${jsonLanguageDir}/${baseName}.display.json`;

  const rawSrt = readFileSync(incomingFile, "utf-8");
  const segments = parseSrt(rawSrt);
  const displaySegments = buildDisplaySegments(segments);

  const plainText = buildTranscriptPlainText(segments);
  const displayText = buildTranscriptPlainText(displaySegments);

  ensureDirectory(cleanLanguageDir);
  ensureDirectory(displayLanguageDir);
  ensureDirectory(jsonLanguageDir);

  writeFileSync(cleanFile, buildCleanSrt(segments), "utf-8");
  writeFileSync(displayFile, buildCleanSrt(displaySegments), "utf-8");

  writeJson(jsonFile, {
    generatedAt: new Date().toISOString(),
    stableId,
    language,
    title: title?.display || title?.episodeName || "",
    date: date.iso,
    source: {
      type: "fcp_srt",
      incomingFile,
      cleanFile
    },
    outputKind: "faithful_clean",
    note: "Faithful cleaned transcript. FCP formatting tags removed, but filler words and original caption segmentation are preserved.",
    segmentCount: segments.length,
    plainText,
    segments
  });

  writeJson(displayJsonFile, {
    generatedAt: new Date().toISOString(),
    stableId,
    language,
    title: title?.display || title?.episodeName || "",
    date: date.iso,
    source: {
      type: "derived_from_faithful_clean",
      incomingFile,
      cleanFile,
      displayFile
    },
    outputKind: "display_clean",
    note: "Display-clean transcript. Light filler-only cleanup and small fragment merging for website reading comfort. Do not treat as the archival source.",
    segmentCount: displaySegments.length,
    plainText: displayText,
    segments: displaySegments
  });

  const languagePayload = {
    language,
    incomingFile,
    cleanFile,
    displayFile,
    jsonFile,
    displayJsonFile,
    segmentCount: segments.length,
    displaySegmentCount: displaySegments.length
  };

  return {
    transcript: {
      hasTranscript: true,
      defaultLanguage: language,
      languages: {
        [language]: languagePayload
      },
      // Backward-compatible top-level fields for the current frontend/search code.
      incomingFile,
      cleanFile,
      displayFile,
      jsonFile,
      displayJsonFile,
      segmentCount: segments.length,
      displaySegmentCount: displaySegments.length
    },
    // Search uses the faithful transcript so no real words are accidentally lost.
    searchText: plainText
  };
}


function buildTranscriptSearchIndex(items) {
  ensureDirectory(TRANSCRIPT_JSON_DIR);

  const entries = items
    .filter(item => item?.transcript?.hasTranscript)
    .map(item => ({
      stableId: item.stableId,
      date: item.date?.iso || null,
      title: item.title?.display || item.title?.episodeName || "",
      series: item.series?.name || "",
      study: item.study?.name || "",
      scripture: item.scripture?.display || "",
      defaultLanguage: item.transcript?.defaultLanguage || TRANSCRIPT_DEFAULT_LANGUAGE,
      transcriptJson: item.transcript?.jsonFile || null,
      transcriptDisplayJson: item.transcript?.displayJsonFile || null,
      transcriptCleanSrt: item.transcript?.cleanFile || null,
      transcriptDisplaySrt: item.transcript?.displayFile || null,
      languages: item.transcript?.languages || {},
      text: item.search?.transcriptText || ""
    }));

  writeJson(`${TRANSCRIPT_JSON_DIR}/search-index.json`, {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries
  });

  return entries.length;
}

// -----------------------------------------------------------------------------
// QUOTE BANK GENERATOR - HIDDEN / FUTURE FEATURE DATA LAYER
// -----------------------------------------------------------------------------
// Beginner note:
// This creates a reusable "quote candidate" dataset from display-clean
// transcripts. Nothing on the visible website has to use this yet.
//
// Future uses:
//   - hidden logo-click random quote page
//   - approval/reject workflow
//   - jump quote back to audio/video timestamp
//   - featured quote sections by episode, series, or scripture
//   - quote cards / share graphics
//
// Important:
// These are quote CANDIDATES, not pastor-approved final quotes. The script scores
// likely-good moments, then a later UI can save/approve or dismiss/reject them.

const QUOTE_DATA_DIR = "data/quotes";
const QUOTE_DEFAULT_LANGUAGE = TRANSCRIPT_DEFAULT_LANGUAGE;

const QUOTE_STRONG_TERMS = [
  "amen", "bible", "christ", "church", "cross", "faith", "father", "gospel",
  "grace", "holy spirit", "jesus", "lord", "mercy", "promise", "redemption",
  "repent", "resurrection", "salvation", "scripture", "sin", "truth", "word",
  "worship", "wrath", "love", "hope", "peace", "righteousness", "sanctification",
  "tribulation", "rapture", "revelation", "kingdom", "glory"
];

const QUOTE_BAD_STARTERS = [
  "and", "but", "so", "because", "then", "now", "well", "okay", "alright",
  "therefore", "also", "or", "if", "when", "right", "amen", "anyway",
  "listen", "look", "remember"
];

const QUOTE_LOW_VALUE_PATTERNS = [
  /\bturn (with me )?(in your bibles? )?to\b/i,
  /\bchapter\s+\d+\b/i,
  /\bverse\s+\d+\b/i,
  /\blook at\b/i,
  /\bas we read\b/i,
  /\bwe're going to read\b/i,
  /\bi want to show you\b/i,
  /\bthis morning\b/i,
  /\bthis evening\b/i,
  /\blast week\b/i,
  /\bnext week\b/i,
  /\bchart\b/i,
  /\bslide\b/i
];

function normalizeQuoteWhitespace(value) {
  return cleanTranscriptText(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?])\s+([a-z])/g, (_, punc, letter) => `${punc} ${letter.toUpperCase()}`)
    .trim();
}

function quoteWordCount(value) {
  return normalizeQuoteWhitespace(value).split(/\s+/).filter(Boolean).length;
}

function firstQuoteWord(value) {
  const match = normalizeQuoteWhitespace(value).toLowerCase().match(/[a-z0-9']+/);
  return match ? match[0] : "";
}

function quoteHasSentenceEnding(value) {
  return /[.!?]["')\]]?$/.test(normalizeQuoteWhitespace(value));
}

function quoteStrongTermHits(value) {
  const lower = normalizeQuoteWhitespace(value).toLowerCase();
  return QUOTE_STRONG_TERMS.filter(term => lower.includes(term)).slice(0, 8);
}

function quoteLowValuePenalty(value) {
  return QUOTE_LOW_VALUE_PATTERNS.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
}

function quoteLooksFragmentary(value) {
  const text = normalizeQuoteWhitespace(value);
  const first = firstQuoteWord(text);
  if (!text) return true;
  if (QUOTE_BAD_STARTERS.includes(first)) return true;
  if (/^(it|this|that|these|those|they|he|she|we|you)\b/i.test(text) && !quoteHasSentenceEnding(text)) return true;
  if (!/[a-z]/i.test(text)) return true;
  return false;
}

function quoteCandidateScore(text, wordCount, durationSeconds, strongTerms, lowValuePenalty) {
  let score = 0;

  if (wordCount >= 15 && wordCount <= 45) score += 25;
  if (wordCount >= 20 && wordCount <= 34) score += 10;
  if (quoteHasSentenceEnding(text)) score += 12;

  score += Math.min(strongTerms.length * 6, 24);

  if (durationSeconds >= 6 && durationSeconds <= 24) score += 8;
  if (durationSeconds > 35) score -= 12;

  score -= lowValuePenalty * 10;

  if (/\b(not|never|always|cannot|must|truth|remember|because|therefore)\b/i.test(text)) score += 6;

  return score;
}

function buildQuoteDisplayText(value) {
  // Light presentation cleanup only. This does not rewrite doctrine or invent
  // wording. It removes common conversational wrappers that look awkward on
  // quote cards while preserving the actual spoken statement.
  return normalizeQuoteWhitespace(value)
    .replace(/^(?:[.\-–—,;:!?]\s*)+/g, "")
    .replace(/^(?:(?:amen|okay|anyway|right|listen|look)\??[,.]?\s*)+/i, "")
    .replace(/^(?:so|and|but)[,.]?\s+/i, "")
    .replace(/\b(?:okay|anyway)\b[,.]?\s*/gi, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^(?:[.\-–—,;:!?]\s*)+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteStartsCleanly(value) {
  const text = normalizeQuoteWhitespace(value);
  if (!text) return false;

  const first = firstQuoteWord(text);
  if (QUOTE_BAD_STARTERS.includes(first)) return false;

  if (/^(?:[.\-–—,;!?]|\d+\s|chapter\s|verse\s)/i.test(text)) return false;
  if (/^(?:right\?|amen\?|okay\?|you know|does that make sense)\b/i.test(text)) return false;
  if (/^[a-z]/.test(text)) return false;

  return true;
}

function quoteSentenceCompleteness(value) {
  const text = normalizeQuoteWhitespace(value);
  return {
    startsCleanly: quoteStartsCleanly(text),
    endsCleanly: quoteHasSentenceEnding(text),
    hasOrphanLeadingPunctuation: /^[.\-–—,;:!?]/.test(text),
    beginsLowercase: /^[a-z]/.test(text)
  };
}

function splitQuoteIntoThoughts(value) {
  const text = normalizeQuoteWhitespace(value);
  if (!text) return [];

  // First split on sentence punctuation, then also split on common sermon
  // transition phrases. This helps avoid quote-card sprawl.
  const sentencePieces = text
    .split(/(?<=[.!?])\s+/)
    .map(v => normalizeQuoteWhitespace(v))
    .filter(Boolean);

  const thoughts = [];
  const transitionPattern = /\b(?:First|Second|Third|Fourth|Therefore|Remember|Again|Now|In other words|Listen|Look)\b[, ]+/g;

  for (const piece of sentencePieces) {
    let last = 0;
    let match = null;
    const startsWithTransition = /^(?:First|Second|Third|Fourth|Therefore|Remember|Again|Now|In other words|Listen|Look)\b/i.test(piece);

    if (!startsWithTransition) {
      while ((match = transitionPattern.exec(piece)) !== null) {
        if (match.index > last) {
          const before = normalizeQuoteWhitespace(piece.slice(last, match.index));
          if (before) thoughts.push(before);
        }
        last = match.index;
      }
    }

    const tail = normalizeQuoteWhitespace(piece.slice(last));
    if (tail) thoughts.push(tail);
  }

  return thoughts.length ? thoughts : [text];
}

function chooseBestQuoteThought(rawText) {
  const thoughts = splitQuoteIntoThoughts(rawText);
  let best = "";
  let bestScore = -999;

  for (const thought of thoughts) {
    const cleaned = buildQuoteDisplayText(thought);
    const words = quoteWordCount(cleaned);
    if (words < 8 || words > 38) continue;

    const strongTerms = quoteStrongTermHits(cleaned);
    const lowPenalty = quoteLowValuePenalty(cleaned);
    const sentence = quoteSentenceCompleteness(cleaned);

    let score = 0;
    if (words >= 12 && words <= 30) score += 25;
    if (sentence.startsCleanly) score += 18;
    if (sentence.endsCleanly) score += 10;
    score += Math.min(strongTerms.length * 6, 24);
    score -= lowPenalty * 12;

    if (/\b(gospel|faith|christ|church|grace|truth|wrath|tribulation|rapture|scripture|word|salvation)\b/i.test(cleaned)) score += 10;
    if (/\b(let's pray|father|in jesus name|thank you lord)\b/i.test(cleaned)) score -= 18;
    if (/\b(turn your bibles|we're gonna read|chapter|verse)\b/i.test(cleaned)) score -= 12;
    if (/^(First|Second|Third|Therefore|Remember|Again|In other words)\b/i.test(cleaned)) score += 4;

    if (score > bestScore) {
      bestScore = score;
      best = cleaned;
    }
  }

  return best || buildQuoteDisplayText(rawText);
}

function quoteCategoryFromFlags(flags) {
  if (flags.prayer) return "prayer";
  if (flags.doctrinal && flags.scriptureDense) return "scripture_doctrine";
  if (flags.doctrinal) return "doctrinal";
  if (flags.scriptureDense) return "scripture";
  return "general";
}

function normalizeScriptureInQuoteText(value) {
  let text = normalizeQuoteWhitespace(value);

  const bookPattern = "(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalm|Psalms|Proverbs|Ecclesiastes|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)";

  const numberWords = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
  };

  // Revelation 13, 7 -> Revelation 13:7
  // This must run BEFORE compact matching.
  text = text.replace(new RegExp(`\\b${bookPattern}\\s+(\\d{1,3})\\s*,\\s*(\\d{1,3})\\b`, "gi"), (match, book, chapter, verse) => {
    return `${book} ${chapter}:${verse}`;
  });

  // 1st Corinthians 15, 51 -> 1st Corinthians 15:51
  text = text.replace(/\b(1st|2nd|3rd)\s+(Corinthians|Thessalonians|Timothy|Peter|John)\s+(\d{1,3})\s*,\s*(\d{1,3})\b/gi, "$1 $2 $3:$4");

  // Romans 8 one -> Romans 8:1
  text = text.replace(new RegExp(`\\b${bookPattern}\\s+(\\d{1,3})\\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\\b`, "gi"), (match, book, chapter, word) => {
    return `${book} ${chapter}:${numberWords[word.toLowerCase()]}`;
  });

  // Revelation 310 -> Revelation 3:10
  // Only compact-normalize if the number is exactly 2-3 digits and not already
  // followed by punctuation or another verse marker. This prevents
  // "Revelation 13:7" from becoming "Revelation 1:3:7".
  text = text.replace(new RegExp(`\\b${bookPattern}\\s+(\\d{2,3})(?!\\s*[:.,])\\b`, "gi"), (match, book, digits) => {
    if (digits.length === 2) return `${book} ${digits[0]}:${digits[1]}`;
    if (digits.length === 3) return `${book} ${digits[0]}:${digits.slice(1)}`;
    return match;
  });

  return normalizeQuoteWhitespace(text);
}

function collapseRepeatedSpeechWords(value) {
  let text = normalizeQuoteWhitespace(value);
  let previous = "";

  // Repeat until stable. This catches:
  //   "the, the, the church" -> "the church"
  //   "is is" -> "is"
  //   "the the" -> "the"
  let guard = 0;
  while (text !== previous && guard < 6) {
    previous = text;
    text = text
      .replace(/\b(\w{1,14})(?:,\s*\1\b)+/gi, "$1")
      .replace(/\b(\w{2,14})\s+\1\b/gi, "$1");
    guard += 1;
  }

  return text;
}

function stripConversationalLeadIns(value) {
  let text = normalizeQuoteWhitespace(value);

  // Remove stacked lead-ins at the beginning.
  let previous = "";
  let guard = 0;
  while (text !== previous && guard < 6) {
    previous = text;
    text = text
      .replace(/^(?:all right|alright|right|amen|okay|anyway|listen|look|i mean|you know|y'all|yall|so|now)[,.?!:;]?\s+/i, "")
      .replace(/^(?:in other words|again|remember|therefore)[,.?!:;]?\s+/i, "");
    guard += 1;
  }

  // Remove awkward in-sentence filler when it is just a speech bridge.
  text = text
    .replace(/\b(?:all right|alright|you know what i'm saying|you know|i mean)\b[,.?!]?\s*/gi, "")
    .replace(/\b(?:listen|look)\b[,.]?\s+(?=(?:we|you|the|this|that|there|god|christ|jesus|church|scripture|revelation|romans|matthew|paul|john|he|they|it|i)\b)/gi, "")
    .replace(/\bRight\?\s*/g, "")
    .replace(/\bAmen\?\s*/g, "")
    .replace(/\bOkay\?\s*/g, "");

  return normalizeQuoteWhitespace(text);
}

function cleanupSpeechDisfluencies(value) {
  let text = normalizeQuoteWhitespace(value);

  text = stripConversationalLeadIns(text);
  text = collapseRepeatedSpeechWords(text);

  text = text
    .replace(/\bpre-rath\b/gi, "pre-wrath")
    .replace(/\bpost-tribute\b/gi, "post-tribulation")
    .replace(/\bspirit from\b/gi, "spared from")
    .replace(/\binjure in your own time\b/gi, "enjoy in your own time")
    .replace(/\bthe preacher of you\b/gi, "the pre-trib view")
    .replace(/\braptures\b/gi, "rapture")
    .replace(/\bRevelations\b/g, "Revelation");

  text = normalizeScriptureInQuoteText(text);
  text = stripConversationalLeadIns(text);
  text = collapseRepeatedSpeechWords(text);

  return trimLeadInFillers(trimTailFillers(normalizeQuoteWhitespace(text)
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^(?:[.\-–—,;:!?]\s*)+/g, "")
    .replace(/\s+/g, " ")
    .trim()));
}

function hardRejectQuoteReason(displayText, qualityFlags = {}) {
  const text = normalizeQuoteWhitespace(displayText);
  if (!text) return "empty";
  if (/^(?:all right|alright|right|amen|okay|anyway|listen|look|i mean|you know|y'all|yall)\b/i.test(text)) return "bad_leading_filler";
  if (/^(?:in other words,\s*listen|listen,|look,)/i.test(text)) return "bad_transition_filler";
  if (/\b(\w{1,14})(?:,\s*\1\b)+/i.test(text)) return "repeated_comma_word";
  if (/\b(\w{2,14})\s+\1\b/i.test(text)) return "repeated_word";
  if (/\binjure in your own time\b/i.test(text)) return "known_asr_error";
  if (/\bthe,\s*the\b/i.test(text)) return "unclean_repetition";
  if (/^[a-z]/.test(text)) return "lowercase_fragment_start";
  if (qualityFlags.prayer) return "prayer_segment";
  return null;
}

function polishQuoteDisplayText(rawText, thoughtText) {
  let displayText = cleanupSpeechDisfluencies(thoughtText);
  let reason = hardRejectQuoteReason(displayText, {});
  let speechCleanPasses = 1;

  // If the chosen thought is still rough, try all smaller thoughts from the raw
  // candidate and pick the strongest clean one.
  if (reason) {
    const alternatives = splitQuoteIntoThoughts(rawText)
      .map(thought => cleanupSpeechDisfluencies(thought))
      .filter(Boolean)
      .filter(thought => quoteWordCount(thought) >= 10 && quoteWordCount(thought) <= 38)
      .filter(thought => !hardRejectQuoteReason(thought, {}));

    if (alternatives.length) {
      alternatives.sort((a, b) => {
        const aScore = quoteStrongTermHits(a).length * 10 + (quoteSentenceCompleteness(a).startsCleanly ? 8 : 0) + (quoteSentenceCompleteness(a).endsCleanly ? 8 : 0);
        const bScore = quoteStrongTermHits(b).length * 10 + (quoteSentenceCompleteness(b).startsCleanly ? 8 : 0) + (quoteSentenceCompleteness(b).endsCleanly ? 8 : 0);
        return bScore - aScore;
      });
      displayText = alternatives[0];
      speechCleanPasses += 1;
      reason = hardRejectQuoteReason(displayText, {});
    }
  }

  return {
    displayText,
    speechCleanPasses,
    hardRejectReason: reason
  };
}

function isBrandSignatureText(value) {
  const text = normalizeQuoteWhitespace(value).toLowerCase();
  return [
    "never forget why you are the church",
    "love learn live lead",
    "cgbc"
  ].some(signature => text.includes(signature));
}

function metaTeachingScore(value) {
  const text = normalizeQuoteWhitespace(value).toLowerCase();
  const patterns = [
    /\bturn (?:in )?your bibles?\b/i,
    /\bgo home and (?:study|read)\b/i,
    /\bread it for yourself\b/i,
    /\byou can read\b/i,
    /\bwe can read\b/i,
    /\bwe're gonna read\b/i,
    /\bwe are going to read\b/i,
    /\bi(?:'m| am) going to read\b/i,
    /\bi(?:'m| am) gonna read\b/i,
    /\bi don't want to take the time\b/i,
    /\blater on\b/i,
    /\blet me get there\b/i,
    /\bif you're there\b/i,
    /\bsay amen\b/i,
    /\bsay read\b/i,
    /\bwrite that down\b/i,
    /\bchapter\s+\d+\b/i,
    /\bverse\s+\d+\b/i,
    /\bfirst point\b/i,
    /\bsecond point\b/i,
    /\bnext strength\b/i,
    /\bwe talked about\b/i,
    /\blast week\b/i,
    /\bwe're going to go over\b/i,
    /\bwe will get lost in the weeds\b/i,
    /\bthis chart\b/i,
    /\btable contents\b/i,
    /\busing a phone\b/i,
    /\bnsb 95\b/i
  ];
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function trimLeadInFillers(value) {
  let text = normalizeQuoteWhitespace(value);

  const patterns = [
    /^(?:i'm going to tell you right now[, ]*)/i,
    /^(?:i will say it like this[, ]*)/i,
    /^(?:i will say this[, ]*)/i,
    /^(?:let me tell you[, ]*)/i,
    /^(?:you see what i'm saying\??[, ]*)/i,
    /^(?:now[, ]*)/i,
    /^(?:all right[, ]*)/i,
    /^(?:okay[, ]*)/i,
    /^(?:listen[, ]*)/i
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, "");
  }

  return normalizeQuoteWhitespace(text);
}


function trimTailFillers(value) {
  return normalizeQuoteWhitespace(value)
    .replace(/\s*,?\s*(?:right|amen|okay)\?$/i, ".")
    .replace(/\s*,?\s*(?:right|amen|okay)\.$/i, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function hasContrastLanguage(value) {
  return /\b(?:cannot|can't|can and|not .* but|rather than|if .* then|although|however|but|instead|separate|together|weakness|strength)\b/i.test(value);
}

function hasPastoralCharge(value) {
  return /\b(?:are you ready|we still have to|we got to|we must|let's not forget|be careful|faith|soul winning|urgent|comfort one another|give your life to christ|absent from the body|present with the lord)\b/i.test(value);
}

function timelessnessScore(value) {
  const text = normalizeQuoteWhitespace(value);
  let score = 0;

  if (hasContrastLanguage(text)) score += 18;
  if (hasPastoralCharge(text)) score += 18;
  if (/\b(?:truth|faith|church|christ|scripture|word|grace|wrath|salvation|judgment|worship|holy spirit|lord)\b/i.test(text)) score += 12;
  if (/\b(?:tonight|tomorrow|last week|this week|right here|this chart|online|go home|turn your bibles|i'm reading|i'm going to read)\b/i.test(text)) score -= 30;
  if (isBrandSignatureText(text)) score -= 100;

  const words = quoteWordCount(text);
  if (words >= 12 && words <= 34) score += 10;
  if (words > 44) score -= 10;

  return score;
}

function scriptureModeForText(value) {
  const text = normalizeQuoteWhitespace(value);
  const lower = text.toLowerCase();

  const hasReference = /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|psalms|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d{1,3}[: ,]\s*\d{1,3}/i.test(text);
  const kjvLanguage = /\b(?:thou|thee|thy|ye|hath|saith|unto|goeth|shalt|shall|behold|verily|wherefore)\b/i.test(text);
  const readingMarker = /\b(?:turn your bibles|verse|chapter|let us read|i saw heaven open|it is written|the bible says|and he said unto me)\b/i.test(text);
  const applicationMarker = /\b(?:this means|therefore|so we|what i'm trying to say|the belief is|we believe|i believe|we see|notice|understand|let's think|be careful|are you ready)\b/i.test(text);

  if (readingMarker && kjvLanguage) return "direct_scripture";
  if (kjvLanguage && quoteWordCount(text) > 14 && !applicationMarker) return "direct_scripture";
  if (hasReference && kjvLanguage && !applicationMarker) return "direct_scripture";
  if (hasReference && applicationMarker) return "exposition";
  if (hasReference) return "reference_only";
  if (applicationMarker) return "application";
  if (lower.includes("scripture") || lower.includes("god's word")) return "application";
  return "none";
}

function quoteCategoryFinal(baseCategory, value, scriptureMode, metaScore, timelessScoreValue) {
  if (isBrandSignatureText(value)) return "brand_signature";
  if (metaScore > 0) return "meta_teaching";
  if (scriptureMode === "direct_scripture") return "direct_scripture";
  if (scriptureMode === "reference_only") return "scripture_reference";
  if (scriptureMode === "exposition") return "scripture_exposition";
  if (hasPastoralCharge(value)) return "pastoral_charge";
  if (timelessScoreValue >= 35) return "featured_candidate";
  return baseCategory;
}

function isSeriesRecapText(value) {
  return /\b(?:last several weeks|today we're|tonight we're|we've been talking about|we have looked at so far|so far|we continue our study|we've already gone through|it's all online|we've already talked about)\b/i.test(value);
}

function isInstructionalPrefixText(value) {
  return /^(?:first|second|third|next|another|remember|notice|look|listen|now)[,\s]+(?:you have|we see|what|that|there|this|the|in)\b/i.test(normalizeQuoteWhitespace(value))
    || /^(?:first,?\s+you have|next,?\s+you have|another interesting point|notice what we learn here|remember,?\s+that)\b/i.test(normalizeQuoteWhitespace(value));
}

function trimInstructionalPrefix(value) {
  let text = normalizeQuoteWhitespace(value);

  text = text
    .replace(/^(?:first|second|third|next),?\s+you have\s+/i, "")
    .replace(/^(?:another interesting point is found in\s+)/i, "")
    .replace(/^(?:remember,?\s+that\s+)/i, "")
    .replace(/^(?:notice what we learn here\.?\s*)/i, "")
    .replace(/^(?:look at|listen to)\s+/i, "")
    .replace(/^(?:well,?\s+think about\s+)/i, "")
    .replace(/^(?:the next strength is[^.?!]*[.?!]\s*)/i, "");

  return normalizeQuoteWhitespace(text);
}

function isWeakContextText(value) {
  const text = normalizeQuoteWhitespace(value);
  if (!text) return true;
  if (isSeriesRecapText(text)) return true;
  if (isInstructionalPrefixText(text)) return true;
  if (metaTeachingScore(text) > 0) return true;
  if (/\b(?:next strength|first point|second point|last week|we talked about|chapter|verse|turn your bibles|say amen|say read|let me get there)\b/i.test(text)) return true;
  if (isOutlineOrLessonStructure(text)) return true;
  if (isReflectionLeadIn(text)) return true;
  return false;
}

function isGoodForwardContext(value) {
  const text = normalizeQuoteWhitespace(value);
  if (!text) return false;
  if (quoteWordCount(text) < 4 || quoteWordCount(text) > 18) return false;
  if (isWeakContextText(text)) return false;
  if (isBrandSignatureText(text)) return false;
  if (scriptureModeForText(text) === "direct_scripture") return false;

  return hasPastoralCharge(text)
    || hasContrastLanguage(text)
    || /\b(?:faith|truth|word|church|christ|lord|grace|wrath|salvation|worship|ready)\b/i.test(text);
}

function refineScriptureReadingQuote(value, scriptureMode) {
  let text = normalizeQuoteWhitespace(value);

  // If a scripture quote plus teaching comment got merged, keep the strongest
  // short scripture sentence only, and leave approval UI context to expand it.
  if (scriptureMode === "direct_scripture" || scriptureMode === "exposition") {
    const pieces = splitQuoteIntoThoughts(text)
      .map(piece => trimInstructionalPrefix(cleanupSpeechDisfluencies(piece)))
      .filter(Boolean);

    const scriptureLike = pieces.find(piece =>
      /\b(?:thou|thee|thy|ye|hath|unto|wherefore|therefore|condemnation|christ jesus)\b/i.test(piece)
      && quoteWordCount(piece) <= 22
    );

    if (scriptureLike) return scriptureLike;
  }

  return text;
}



function dedupeQuoteSentences(value) {
  const pieces = splitQuoteIntoThoughts(value)
    .map(piece => normalizeQuoteWhitespace(piece))
    .filter(Boolean);

  const seen = new Set();
  const kept = [];

  for (const piece of pieces) {
    const key = piece
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!key) continue;
    if (seen.has(key)) continue;

    const alreadyContained = kept.some(existing => {
      const existingKey = existing.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
      return existingKey && key.includes(existingKey) && existingKey.length > 18;
    });

    if (alreadyContained) continue;

    seen.add(key);
    kept.push(piece);
  }

  return normalizeQuoteWhitespace(kept.join(" "));
}

function isOutlineOrLessonStructure(value) {
  return /\b(?:last weakness|next weakness|another weakness|the next strength|another strength|first strength|second strength|third strength|another reason|one reason|the last reason|the next reason|first point|second point|third point|we will go over|we'll go over|we have already mentioned|we've already mentioned)\b/i.test(value);
}

function isReflectionLeadIn(value) {
  return /\b(?:let's think about|think about this|think about it|notice what we learn|what do we learn|let me ask you)\b/i.test(value);
}

function shouldAddSecondForwardContext(currentText, nextText) {
  const next = normalizeQuoteWhitespace(nextText);

  if (!next) return false;
  if (quoteWordCount(next) > 10) return false;
  if (isWeakContextText(next)) return false;
  if (isOutlineOrLessonStructure(next)) return false;
  if (isReflectionLeadIn(next)) return false;
  if (scriptureModeForText(next) === "direct_scripture") return false;

  return hasPastoralCharge(next)
    || /\b(?:faith|ready|truth|word|church|christ|lord|grace|worship|salvation)\b/i.test(next);
}

function recoverQuoteContext(rawText, displayText) {
  const display = dedupeQuoteSentences(normalizeQuoteWhitespace(displayText));
  const thoughts = splitQuoteIntoThoughts(rawText)
    .map(thought => trimInstructionalPrefix(cleanupSpeechDisfluencies(thought)))
    .map(thought => dedupeQuoteSentences(thought))
    .filter(Boolean);

  const currentIndex = thoughts.findIndex(thought => {
    return thought === display || thought.includes(display) || display.includes(thought);
  });

  const before = currentIndex > 0 ? thoughts[currentIndex - 1] : "";
  const after = currentIndex >= 0 && currentIndex < thoughts.length - 1 ? thoughts[currentIndex + 1] : "";
  const secondAfter = currentIndex >= 0 && currentIndex < thoughts.length - 2 ? thoughts[currentIndex + 2] : "";

  function contextAllowed(text) {
    if (!text) return false;
    if (quoteWordCount(text) < 4 || quoteWordCount(text) > 28) return false;
    if (isBrandSignatureText(text)) return false;
    if (isWeakContextText(text)) return false;
    if (isOutlineOrLessonStructure(text)) return false;
    if (isReflectionLeadIn(text)) return false;
    if (scriptureModeForText(text) === "direct_scripture") return false;
    if (hardRejectQuoteReason(text, {})) return false;
    return true;
  }

  const useBefore = quoteWordCount(display) < 16 && contextAllowed(before);
  const useAfter = (quoteWordCount(display) < 12 && contextAllowed(after)) || isGoodForwardContext(after);

  let recoveredParts = [
    useBefore ? before : "",
    display,
    useAfter ? after : ""
  ].filter(Boolean);

  let recoveredText = dedupeQuoteSentences(normalizeQuoteWhitespace(recoveredParts.join(" ")));

  if (useAfter && shouldAddSecondForwardContext(recoveredText, secondAfter)) {
    recoveredText = dedupeQuoteSentences(`${recoveredText} ${secondAfter}`);
    recoveredParts.push(secondAfter);
  }

  return {
    contextBefore: before || null,
    contextAfter: after || null,
    contextSecondAfter: secondAfter || null,
    contextWindow: {
      before: before || null,
      quote: display,
      after: after || null,
      secondAfter: secondAfter || null
    },
    contextRecoveryUsed: recoveredText !== display,
    recoveredText
  };
}


function speechDisfluencyScore(rawText, displayText) {
  const raw = normalizeQuoteWhitespace(rawText);
  const display = normalizeQuoteWhitespace(displayText);
  let score = 0;

  const patterns = [
    /\ball right\b/gi,
    /\balright\b/gi,
    /\bright\?/gi,
    /\bamen\?/gi,
    /\bokay\?/gi,
    /\byou know\b/gi,
    /\bi mean\b/gi,
    /\blisten\b/gi,
    /\blook\b/gi,
    /\by'all\b/gi,
    /\bthe,\s*the\b/gi,
    /\b(\w{1,14})(?:,\s*\1\b){1,4}/gi,
    /\b(\w{2,14})\s+\1\b/gi
  ];

  for (const pattern of patterns) {
    const matches = raw.match(pattern);
    if (matches) score += matches.length;
  }

  if (display.length < raw.length * 0.75) score += 1;
  return score;
}

function speakerNaturalnessScore(displayText, flags, disfluencyScoreValue) {
  let score = 100;
  const words = quoteWordCount(displayText);

  if (words < 10) score -= 20;
  if (words > 38) score -= 15;
  if (flags.fillerHeavy) score -= 25;
  if (!flags.startsCleanly) score -= 20;
  if (!flags.endsCleanly) score -= 10;
  score -= Math.min(disfluencyScoreValue * 8, 32);

  if (flags.quoteReady) score += 8;
  if (flags.doctrinal) score += 5;

  return Math.max(0, Math.min(100, score));
}

function quoteQualityFlags(rawText, displayText, strongTerms, lowValuePenalty) {
  const text = normalizeQuoteWhitespace(rawText);
  const displayWordCount = quoteWordCount(displayText);
  const sentence = quoteSentenceCompleteness(displayText);

  const fillerHeavy = /\b(amen\?|okay|anyway|you know what i'm saying|right\?|does that make sense)\b/i.test(text);
  const scriptureDense = /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|psalms|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\b/i.test(text) || /\b\d+\s*:\s*\d+\b/.test(text);
  const prayer = /\b(father|lord|pray|amen|thank you for your word|in jesus name)\b/i.test(text);
  const humor = /\b(ain't|you know what i'm saying|okay\?|amen\?)\b/i.test(text);
  const doctrinal = strongTerms.length >= 2 || /\b(gospel|salvation|grace|faith|christ|church|wrath|tribulation|rapture|resurrection|truth)\b/i.test(text);

  return {
    fillerHeavy,
    scriptureDense,
    prayer,
    humor,
    doctrinal,
    startsCleanly: sentence.startsCleanly,
    endsCleanly: sentence.endsCleanly,
    hasOrphanLeadingPunctuation: sentence.hasOrphanLeadingPunctuation,
    beginsLowercase: sentence.beginsLowercase,
    preferredLength: displayWordCount >= 12 && displayWordCount <= 32,
    longThought: displayWordCount > 38,
    quoteReady: displayWordCount >= 12
      && displayWordCount <= 38
      && lowValuePenalty <= 1
      && sentence.startsCleanly
      && sentence.endsCleanly
      && !fillerHeavy
      && !prayer
  };
}

function qualityAdjustedQuoteScore(baseScore, flags) {
  let score = baseScore;
  if (flags.quoteReady) score += 16;
  if (flags.preferredLength) score += 10;
  if (flags.doctrinal) score += 8;
  if (flags.scriptureDense) score += 3;
  if (flags.prayer) score -= 22;
  if (flags.longThought) score -= 16;
  if (flags.fillerHeavy) score -= 18;
  if (flags.humor) score -= 5;
  if (!flags.startsCleanly) score -= 24;
  if (!flags.endsCleanly) score -= 8;
  if (flags.hasOrphanLeadingPunctuation) score -= 30;
  if (flags.beginsLowercase) score -= 18;
  return score;
}

function makeQuoteId(item, quoteIndex) {
  return `${item.stableId || "episode"}-quote-${String(quoteIndex + 1).padStart(4, "0")}`;
}

function buildQuoteMediaHooks(item, start, end) {
  const youtubeId = item?.video?.youtubeId || null;
  const audioUrl = item?.audio?.url || null;
  const videoUrl = item?.video?.url || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null);

  return {
    start,
    end,
    audioUrl,
    youtubeId,
    videoUrl,
    hasAudio: Boolean(audioUrl),
    hasVideo: Boolean(youtubeId || videoUrl)
  };
}

function buildQuoteEpisodePayload(item) {
  return {
    stableId: item.stableId,
    title: item.title?.display || item.title?.episodeName || "",
    episodeName: item.title?.episodeName || "",
    subtitle: item.title?.subtitle || "",
    series: item.series?.name || "",
    seriesKey: item.series?.key || "",
    study: item.study?.name || "",
    studyKey: item.study?.key || "",
    scripture: item.scripture?.display || "",
    date: item.date?.iso || null,
    speaker: item.speaker || null,
    shareUrl: item.links?.shareUrl || item.links?.episodeUrl || null,
    episodeUrl: item.links?.episodeUrl || null
  };
}

function buildQuoteCurationDefaults() {
  return {
    status: "candidate",
    approved: false,
    featured: false,
    rejected: false,
    approvedAt: null,
    rejectedAt: null,
    featuredAt: null,
    reviewedAt: null,
    reviewedBy: null,
    note: ""
  };
}

function quotePolishScoreForDisplay(quote) {
  let score = quote.score || 0;
  const text = normalizeQuoteWhitespace(quote.displayText || quote.text || "");

  if (quote.timelessnessScore) score += quote.timelessnessScore;
  if (quote.pastoralCharge) score += 16;
  if (quote.contextRecoveryUsed) score += 8;
  if (quote.speakerNaturalness >= 95) score += 10;
  if (quote.qualityFlags?.quoteReady) score += 8;

  // Study-specific technical terms are useful, but not always best for a public
  // random quote surface.
  if (/\b(?:pre-trib|post-trib|mid-trib|pre-wrath|post-tribulation|mid-tribulation|antichrist|bold judgments|chapter\s+\d+)\b/i.test(text)) {
    score -= 18;
  }

  // Lecture-navigation language should stay searchable, but should not dominate
  // public quote rails.
  if (/\b(?:this view|this text|following the|between chapters|we have looked|so far|weakness|strength|point)\b/i.test(text)) {
    score -= 14;
  }

  // Short, clear, devotional/application thoughts should rise.
  if (/\b(?:faith|truth|word|church|christ|lord|grace|salvation|ready|comfort|hope|worship)\b/i.test(text)) {
    score += 10;
  }

  const words = quoteWordCount(text);
  if (words >= 14 && words <= 34) score += 8;
  if (words > 46) score -= 12;
  if (words < 10) score -= 20;

  return Math.max(0, Math.round(score));
}

function displayTierForQuote(quote) {
  const text = normalizeQuoteWhitespace(quote.displayText || quote.text || "");
  const polish = quotePolishScoreForDisplay(quote);

  const technicalHeavy = /\b(?:pre-trib|post-trib|mid-trib|pre-wrath|post-tribulation|mid-tribulation|antichrist|bold judgments|chapter\s+\d+)\b/i.test(text);
  const lectureSummary = /\b(?:this view|this text|following the|between chapters|we have looked|so far|weakness|strength|point)\b/i.test(text);

  if (
    polish >= 155 &&
    !technicalHeavy &&
    !lectureSummary &&
    (quote.pastoralCharge || /\b(?:faith|truth|word|grace|salvation|comfort|hope|ready)\b/i.test(text))
  ) {
    return "featured";
  }

  if (polish >= 105 && !lectureSummary) {
    return technicalHeavy ? "study" : "strong";
  }

  if (polish >= 80) return "study";
  return "archive";
}

function searchBoostForQuote(quote) {
  const tier = quote.displayTier || displayTierForQuote(quote);
  if (quote.curation?.approved || quote.curation?.featured) return 100;
  if (tier === "featured") return 80;
  if (tier === "strong") return 60;
  if (tier === "study") return 35;
  return 10;
}


function hydrateQuoteDisplayFields(quote) {
  const quotePolishScore = quote.quotePolishScore ?? quotePolishScoreForDisplay(quote);
  const displayTier = quote.displayTier ?? displayTierForQuote({ ...quote, quotePolishScore });
  const searchBoost = quote.searchBoost ?? searchBoostForQuote({ ...quote, quotePolishScore, displayTier });

  return {
    ...quote,
    quotePolishScore,
    displayTier,
    searchBoost
  };
}

function hydrateQuoteDisplayFieldsList(quotes) {
  return (quotes || [])
    .map(hydrateQuoteDisplayFields)
    .sort((a, b) => {
      const tierOrder = { featured: 4, strong: 3, study: 2, archive: 1 };
      return (tierOrder[b.displayTier] || 0) - (tierOrder[a.displayTier] || 0)
        || (b.searchBoost || 0) - (a.searchBoost || 0)
        || (b.quotePolishScore || 0) - (a.quotePolishScore || 0)
        || (b.score || 0) - (a.score || 0);
    });
}


function isPublicSafeQuote(quote) {
  const text = normalizeQuoteWhitespace(quote.displayText || quote.text || "");
  const tier = quote.displayTier || displayTierForQuote(quote);

  if (quote.curation?.featured || quote.curation?.approved) return true;
  if (quote.curation?.rejected) return false;

  if (tier !== "featured" && tier !== "strong") return false;

  // Keep highly technical eschatology available for study/search, but avoid
  // surfacing it as a public random quote unless a human later approves it.
  if (/\b(?:pre-trib|post-trib|mid-trib|pre-wrath|post-tribulation|mid-tribulation|antichrist|bold judgments|chapter\s+\d+|between chapters|this view|this text)\b/i.test(text)) {
    return false;
  }

  // "church" alone is too broad in this sermon set. Prefer public surfacing
  // when it is paired with devotional or application language.
  const hasDevotionalSignal = /\b(?:faith|truth|word|grace|salvation|ready|comfort|hope|worship|christ|lord|gospel|pray|love)\b/i.test(text);
  const hasPastoralSignal = quote.pastoralCharge || /\b(?:we still have to|are you ready|do not forget|be careful|give your life|comfort one another)\b/i.test(text);

  return hasDevotionalSignal || hasPastoralSignal;
}

function publicSurfaceReasonForQuote(quote) {
  const text = normalizeQuoteWhitespace(quote.displayText || quote.text || "");
  const tier = quote.displayTier || displayTierForQuote(quote);

  if (quote.curation?.featured) return "human_featured";
  if (quote.curation?.approved) return "human_approved";
  if (quote.curation?.rejected) return "human_rejected";
  if (tier !== "featured" && tier !== "strong") return "not_public_tier";
  if (/\b(?:pre-trib|post-trib|mid-trib|pre-wrath|post-tribulation|mid-tribulation|antichrist|bold judgments|chapter\s+\d+|between chapters|this view|this text)\b/i.test(text)) return "study_specific";
  if (/\b(?:faith|truth|word|grace|salvation|ready|comfort|hope|worship|christ|lord|gospel|pray|love)\b/i.test(text)) return "devotional_signal";
  if (quote.pastoralCharge) return "pastoral_charge";
  return "needs_review";
}

function hydrateQuotePublicSurfaceFields(quote) {
  const hydrated = hydrateQuoteDisplayFields(quote);
  const publicSafe = hydrated.publicSafe ?? isPublicSafeQuote(hydrated);
  const publicSurfaceReason = hydrated.publicSurfaceReason ?? publicSurfaceReasonForQuote({ ...hydrated, publicSafe });
  return {
    ...hydrated,
    publicSafe,
    publicSurfaceReason
  };
}

function hydrateQuotePublicSurfaceFieldsList(quotes) {
  return (quotes || [])
    .map(hydrateQuotePublicSurfaceFields)
    .sort((a, b) => {
      const tierOrder = { featured: 4, strong: 3, study: 2, archive: 1 };
      return Number(b.publicSafe) - Number(a.publicSafe)
        || (tierOrder[b.displayTier] || 0) - (tierOrder[a.displayTier] || 0)
        || (b.searchBoost || 0) - (a.searchBoost || 0)
        || (b.quotePolishScore || 0) - (a.quotePolishScore || 0)
        || (b.score || 0) - (a.score || 0);
    });
}


function buildQuoteCandidatesForItem(item, language = QUOTE_DEFAULT_LANGUAGE) {
  const displayJsonFile = item?.transcript?.languages?.[language]?.displayJsonFile || item?.transcript?.displayJsonFile;
  if (!displayJsonFile || !existsSync(displayJsonFile)) return [];

  let transcriptDoc = null;
  try {
    transcriptDoc = readJson(displayJsonFile);
  } catch (err) {
    console.warn(`Could not read display transcript for quote bank: ${displayJsonFile}: ${err.message}`);
    return [];
  }

  const segments = Array.isArray(transcriptDoc?.segments) ? transcriptDoc.segments : [];
  const candidates = [];
  const windowSizes = [1, 2, 3, 4, 5, 6];

  for (let i = 0; i < segments.length; i += 1) {
    for (const size of windowSizes) {
      const group = segments.slice(i, i + size);
      if (group.length !== size) continue;

      const text = normalizeQuoteWhitespace(group.map(segment => segment.text).join(" "));
      const wordCount = quoteWordCount(text);
      const start = Number(group[0]?.start || 0);
      const end = Number(group[group.length - 1]?.end || start);
      const durationSeconds = Math.max(0, end - start);
      const strongTerms = quoteStrongTermHits(text);
      const lowValuePenalty = quoteLowValuePenalty(text);

      if (wordCount < 12 || wordCount > 55) continue;
      if (durationSeconds < 3 || durationSeconds > 45) continue;
      if (quoteLooksFragmentary(text)) continue;
      if (lowValuePenalty >= 3 && strongTerms.length === 0) continue;

      const rawText = text;
      const thoughtText = chooseBestQuoteThought(rawText);
      const polished = polishQuoteDisplayText(rawText, thoughtText);
      let displayText = trimInstructionalPrefix(trimTailFillers(polished.displayText));
      if (quoteWordCount(displayText) < 10) continue;

      let scriptureMode = scriptureModeForText(displayText);
      displayText = refineScriptureReadingQuote(displayText, scriptureMode);

      const contextRecovery = recoverQuoteContext(rawText, displayText);
      displayText = dedupeQuoteSentences(contextRecovery.recoveredText);
      displayText = trimInstructionalPrefix(displayText);
      displayText = dedupeQuoteSentences(displayText);

      scriptureMode = scriptureModeForText(displayText);
      const metaScore = metaTeachingScore(displayText);
      const brandSignature = isBrandSignatureText(displayText);
      const tailTrimmed = displayText !== polished.displayText;
      const displayStrongTerms = quoteStrongTermHits(displayText);
      const displayLowValuePenalty = quoteLowValuePenalty(displayText);
      const qualityFlags = quoteQualityFlags(rawText, displayText, displayStrongTerms, displayLowValuePenalty);
      const hardRejectReason = hardRejectQuoteReason(displayText, qualityFlags);
      const disfluencyScore = speechDisfluencyScore(rawText, displayText);
      const speakerNaturalness = speakerNaturalnessScore(displayText, qualityFlags, disfluencyScore);
      const timelessScoreValue = timelessnessScore(displayText);
      const contrastBoost = hasContrastLanguage(displayText) ? 12 : 0;
      const pastoralCharge = hasPastoralCharge(displayText);

      if (hardRejectReason) continue;
      if (brandSignature) continue;
      if (metaScore > 0) continue;
      if (isSeriesRecapText(displayText)) continue;
      if (isOutlineOrLessonStructure(displayText) && timelessScoreValue < 35) continue;
      if (isReflectionLeadIn(displayText) && timelessScoreValue < 35) continue;
      if (isWeakContextText(displayText) && !qualityFlags.doctrinal && !pastoralCharge) continue;
      if (scriptureMode === "direct_scripture") continue;

      // Keep non-quote-ready items only if they are still strong doctrinal/search
      // candidates. The random quote UI can prefer quoteReady later.
      if (!qualityFlags.startsCleanly && !qualityFlags.doctrinal) continue;
      if (qualityFlags.hasOrphanLeadingPunctuation) continue;
      if (speakerNaturalness < 55 && !qualityFlags.doctrinal) continue;

      const baseScore = quoteCandidateScore(displayText, quoteWordCount(displayText), durationSeconds, displayStrongTerms, displayLowValuePenalty);
      const scripturePenalty = scriptureMode === "reference_only" ? -18 : 0;
      const score = qualityAdjustedQuoteScore(baseScore, qualityFlags)
        + Math.round((speakerNaturalness - 70) / 5)
        + Math.round(timelessScoreValue / 4)
        + contrastBoost
        + (pastoralCharge ? 10 : 0)
        + scripturePenalty;
      if (score < 38) continue;

      candidates.push({
        id: makeQuoteId(item, candidates.length),
        language,
        status: "candidate",
        curation: buildQuoteCurationDefaults(),
        episode: buildQuoteEpisodePayload(item),
        media: buildQuoteMediaHooks(item, start, end),
        start,
        end,
        startTime: group[0]?.startTime || secondsToSrtTimestamp(start),
        endTime: group[group.length - 1]?.endTime || secondsToSrtTimestamp(end),
        segmentIndexes: group.map(segment => segment.index).filter(Boolean),
        wordCount,
        displayWordCount: quoteWordCount(displayText),
        durationSeconds,
        score,
        baseScore,
        disfluencyScore,
        speakerNaturalness,
        speechCleaned: displayText !== thoughtText,
        speechCleanPasses: polished.speechCleanPasses,
        hardRejectReason: null,
        scriptureMode,
        metaTeachingScore: metaScore,
        brandSignature,
        tailTrimmed,
        contrastBoost,
        pastoralCharge,
        timelessnessScore: timelessScoreValue,
        quotePolishScore: quotePolishScoreForDisplay({
          score,
          displayText,
          text: displayText,
          timelessnessScore: timelessScoreValue,
          pastoralCharge,
          contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
          speakerNaturalness,
          qualityFlags
        }),
        displayTier: displayTierForQuote({
          score,
          displayText,
          text: displayText,
          timelessnessScore: timelessScoreValue,
          pastoralCharge,
          contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
          speakerNaturalness,
          qualityFlags
        }),
        searchBoost: searchBoostForQuote({
          score,
          displayText,
          text: displayText,
          timelessnessScore: timelessScoreValue,
          pastoralCharge,
          contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
          speakerNaturalness,
          qualityFlags
        }),
        publicSafe: isPublicSafeQuote({
          score,
          displayText,
          text: displayText,
          timelessnessScore: timelessScoreValue,
          pastoralCharge,
          contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
          speakerNaturalness,
          qualityFlags,
          displayTier: displayTierForQuote({
            score,
            displayText,
            text: displayText,
            timelessnessScore: timelessScoreValue,
            pastoralCharge,
            contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
            speakerNaturalness,
            qualityFlags
          })
        }),
        publicSurfaceReason: publicSurfaceReasonForQuote({
          score,
          displayText,
          text: displayText,
          timelessnessScore: timelessScoreValue,
          pastoralCharge,
          contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
          speakerNaturalness,
          qualityFlags,
          displayTier: displayTierForQuote({
            score,
            displayText,
            text: displayText,
            timelessnessScore: timelessScoreValue,
            pastoralCharge,
            contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
            speakerNaturalness,
            qualityFlags
          })
        }),
        seriesRecap: isSeriesRecapText(displayText),
        outlineOrLessonStructure: isOutlineOrLessonStructure(displayText),
        reflectionLeadIn: isReflectionLeadIn(displayText),
        duplicateSentenceDedupe: dedupeQuoteSentences(displayText) !== displayText,
        instructionalPrefixTrimmed: displayText !== polished.displayText && isInstructionalPrefixText(polished.displayText),
        contextRecoveryUsed: contextRecovery.contextRecoveryUsed,
        contextBefore: contextRecovery.contextBefore,
        contextAfter: contextRecovery.contextAfter,
        contextSecondAfter: contextRecovery.contextSecondAfter,
        contextWindow: contextRecovery.contextWindow,
        approvedText: null,
        expandedText: contextRecovery.recoveredText,
        thoughtText,
        strongTerms: displayStrongTerms,
        lowValuePenalty: displayLowValuePenalty,
        quoteCategory: quoteCategoryFinal(quoteCategoryFromFlags(qualityFlags), displayText, scriptureMode, metaScore, timelessScoreValue),
        qualityFlags,
        source: {
          transcriptDisplayJson: displayJsonFile,
          transcriptCleanJson: item?.transcript?.jsonFile || null,
          transcriptDisplaySrt: item?.transcript?.displayFile || null,
          transcriptCleanSrt: item?.transcript?.cleanFile || null
        },
        rawText,
        displayText,
        text: displayText
      });
    }
  }

  const byKey = new Map();
  for (const candidate of candidates) {
    const key = (candidate.displayText || candidate.text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) byKey.set(key, candidate);
  }

  return Array.from(byKey.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.start - b.start;
    })
    .slice(0, 75)
    .map((candidate, index) => ({
      ...candidate,
      id: makeQuoteId(item, index),
      rank: index + 1
    }));
}

function buildQuoteBank(items) {
  const language = QUOTE_DEFAULT_LANGUAGE;
  const languageQuoteDir = `${QUOTE_DATA_DIR}/${language}`;
  ensureDirectory(languageQuoteDir);

  const allQuotes = [];
  const byEpisode = {};
  const bySeries = {};

  for (const item of items || []) {
    if (!item?.transcript?.hasTranscript) continue;

    const episodeQuotes = buildQuoteCandidatesForItem(item, language);
    if (!episodeQuotes.length) continue;

    const episodePayload = buildQuoteEpisodePayload(item);
    byEpisode[item.stableId] = {
      ...episodePayload,
      transcriptDisplayJson: item.transcript?.displayJsonFile || null,
      quoteCount: episodeQuotes.length,
      quotes: episodeQuotes
    };

    const seriesKey = episodePayload.seriesKey || "standalone";
    if (!bySeries[seriesKey]) {
      bySeries[seriesKey] = {
        seriesKey,
        series: episodePayload.series || "Standalone",
        quoteCount: 0,
        episodeStableIds: [],
        quoteIds: []
      };
    }
    bySeries[seriesKey].quoteCount += episodeQuotes.length;
    if (!bySeries[seriesKey].episodeStableIds.includes(item.stableId)) {
      bySeries[seriesKey].episodeStableIds.push(item.stableId);
    }
    bySeries[seriesKey].quoteIds.push(...episodeQuotes.map(q => q.id));

    allQuotes.push(...episodeQuotes);
  }

  allQuotes.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.episode?.date || "").localeCompare(String(a.episode?.date || ""));
  });

  const approvedQuotes = allQuotes.filter(q => q.curation?.approved);
  const featuredQuotes = allQuotes.filter(q => q.curation?.featured);

  const quoteBank = {
    generatedAt: new Date().toISOString(),
    version: 1,
    language,
    count: allQuotes.length,
    approvedCount: approvedQuotes.length,
    featuredCount: featuredQuotes.length,
    note: "Automatically generated quote candidates from display-clean transcripts. These are candidates, not pastor-approved final quotes.",
    curationModel: {
      statuses: ["candidate", "approved", "featured", "rejected"],
      futureConfigFile: "config/quote-curation.json",
      controls: ["Add Previous", "Add Next", "Edit Text", "Save / Approve", "Feature", "Dismiss / Reject", "Next Quote", "Jump to Audio", "Jump to Video"]
    },
    tuning: {
      minWords: 12,
      maxWords: 55,
      maxQuotesPerEpisode: 75,
      displayText: "Lightly cleaned presentation copy; rawText preserves the candidate source.",
      qualityPass: "nano precision clean rebuild: outline/lesson suppression, reflection lead-in suppression, second forward context recovery, duplicate sentence dedupe, tested from last working micro layer",
      source: "data/transcripts/en/*.display.json"
    },
    quotes: allQuotes,
    byEpisode,
    bySeries
  };

  writeJson(`${languageQuoteDir}/quote-bank.json`, quoteBank);

  writeJson(`${languageQuoteDir}/random-quotes.json`, {
    generatedAt: quoteBank.generatedAt,
    version: 1,
    language,
    count: allQuotes.length,
    quotes: allQuotes.map(quote => ({
      id: quote.id,
      status: quote.status,
      curation: quote.curation,
      episode: quote.episode,
      media: quote.media,
      start: quote.start,
      end: quote.end,
      score: quote.score,
      qualityFlags: quote.qualityFlags,
      quoteCategory: quote.quoteCategory,
      disfluencyScore: quote.disfluencyScore,
      speakerNaturalness: quote.speakerNaturalness,
      speechCleaned: quote.speechCleaned,
      speechCleanPasses: quote.speechCleanPasses,
      hardRejectReason: quote.hardRejectReason,
      scriptureMode: quote.scriptureMode,
      metaTeachingScore: quote.metaTeachingScore,
      brandSignature: quote.brandSignature,
      tailTrimmed: quote.tailTrimmed,
      contrastBoost: quote.contrastBoost,
      pastoralCharge: quote.pastoralCharge,
      timelessnessScore: quote.timelessnessScore,
      quotePolishScore: quote.quotePolishScore ?? quotePolishScoreForDisplay(quote),
      displayTier: quote.displayTier ?? displayTierForQuote({ ...quote, quotePolishScore: quote.quotePolishScore ?? quotePolishScoreForDisplay(quote) }),
      searchBoost: quote.searchBoost ?? searchBoostForQuote({ ...quote, quotePolishScore: quote.quotePolishScore ?? quotePolishScoreForDisplay(quote), displayTier: quote.displayTier ?? displayTierForQuote({ ...quote, quotePolishScore: quote.quotePolishScore ?? quotePolishScoreForDisplay(quote) }) }),
      seriesRecap: quote.seriesRecap,
      outlineOrLessonStructure: quote.outlineOrLessonStructure,
      reflectionLeadIn: quote.reflectionLeadIn,
      duplicateSentenceDedupe: quote.duplicateSentenceDedupe,
      instructionalPrefixTrimmed: quote.instructionalPrefixTrimmed,
      contextRecoveryUsed: quote.contextRecoveryUsed,
      contextBefore: quote.contextBefore,
      contextAfter: quote.contextAfter,
      contextSecondAfter: quote.contextSecondAfter,
      contextWindow: quote.contextWindow,
      approvedText: quote.approvedText,
      expandedText: quote.expandedText,
      rawText: quote.rawText,
      thoughtText: quote.thoughtText,
      displayText: quote.displayText,
      text: quote.displayText || quote.text
    }))
  });

  writeJson(`${languageQuoteDir}/approved-quotes.json`, {
    generatedAt: quoteBank.generatedAt,
    version: 1,
    language,
    count: approvedQuotes.length,
    quotes: approvedQuotes
  });

  writeJson(`${languageQuoteDir}/featured-quotes.json`, {
    generatedAt: quoteBank.generatedAt,
    version: 1,
    language,
    count: featuredQuotes.length,
    quotes: featuredQuotes
  });

  return allQuotes.length;
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

function resolveMemberships(series, study, scripture, bookTags, date, collections = []) {
  const bibleBooks = bookTags.length
    ? bookTags.map(t => t.key)
    : (scripture.bookKey ? [scripture.bookKey] : []);

  return {
    series: series.key ? [series.key] : [],
    studies: study.key ? [study.key] : [],
    bibleBooks,
    collections: collections.map(c => c.key).filter(Boolean),
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
    const references = resolveReferences(record, scripture);
    const bookTags = resolveBookTags(record);
    const collections = resolveCollections(record);
    const date = resolveDate(record);
    const transcriptResolved = resolveTranscript(stableId, title, date);
    const statsMatch = matchStats(record, statsIndexes);
    const audio = resolveAudio(record, statsMatch);
    const video = resolveVideo(record, youtube);
    const art = buildEpisodeArt(audio, video);
    const memberships = resolveMemberships(series, study, scripture, bookTags, date, collections);
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
      references,
      search: {
        scriptureTokens: references.searchTokens,
        transcriptText: transcriptResolved.searchText
      },
      collections,
      bookTags,
      speaker: clean(record.notesFields?.["by"]) || null,
      date,
      transcript: transcriptResolved.transcript,
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
  const transcriptSearchCount = buildTranscriptSearchIndex(items);
  const quoteCandidateCount = buildQuoteBank(items);

  const output = {
    generatedAt: new Date().toISOString(),
    version: 1,
    sourceSummary: {
      rssItems: rss.length,
      archiveItems: items.length,
      videoMatchedItems: items.filter(i => i.video.hasVideo).length,
      transcriptMatchedItems: transcriptSearchCount,
      quoteCandidateCount
    },
    totals: {
      audioPlaysTotal: Number(statsDoc?.podcast_totals?.plays_total || 0),
      audioEpisodesTotal: Number(statsDoc?.podcast_totals?.episodes_total || items.length)
    },
    current: detectCurrentSeries(items),
    collections: buildCollectionsSummary(items),
    items
  };

  writeJson("data/library-resolved.json", output);
  console.log(`Resolved archive items: ${items.length}`);
}

main();
