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
  "therefore", "also", "or", "if", "when"
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
    .replace(/^(amen\??\s*)+/i, "")
    .replace(/^(okay[,.]?\s*)+/i, "")
    .replace(/^(anyway[,.]?\s*)+/i, "")
    .replace(/^(so[,.]?\s*)+/i, "")
    .replace(/\b(okay|anyway)\b[,.]?\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteQualityFlags(rawText, displayText, strongTerms, lowValuePenalty) {
  const text = normalizeQuoteWhitespace(rawText);
  const lower = text.toLowerCase();
  const displayWordCount = quoteWordCount(displayText);

  return {
    fillerHeavy: /\b(amen\?|okay|anyway|you know what i'm saying|right\?)\b/i.test(text),
    scriptureDense: /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|psalms|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\b/i.test(text) || /\b\d+\s*:\s*\d+\b/.test(text),
    prayer: /\b(father|lord|pray|amen|thank you for your word|in jesus name)\b/i.test(text),
    humor: /\b(ain't|you know what i'm saying|okay\?|amen\?)\b/i.test(text),
    doctrinal: strongTerms.length >= 2 || /\b(gospel|salvation|grace|faith|christ|church|wrath|tribulation|rapture|resurrection|truth)\b/i.test(text),
    quoteReady: displayWordCount >= 12 && displayWordCount <= 45 && lowValuePenalty <= 1 && !/^(amen|okay|anyway|so|and|but)\b/i.test(displayText)
  };
}

function qualityAdjustedQuoteScore(baseScore, flags) {
  let score = baseScore;
  if (flags.quoteReady) score += 10;
  if (flags.doctrinal) score += 8;
  if (flags.scriptureDense) score += 3;
  if (flags.prayer) score -= 4;
  if (flags.fillerHeavy) score -= 10;
  if (flags.humor) score -= 3;
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
      const displayText = buildQuoteDisplayText(rawText);
      if (quoteWordCount(displayText) < 10) continue;

      const baseScore = quoteCandidateScore(rawText, wordCount, durationSeconds, strongTerms, lowValuePenalty);
      const qualityFlags = quoteQualityFlags(rawText, displayText, strongTerms, lowValuePenalty);
      const score = qualityAdjustedQuoteScore(baseScore, qualityFlags);
      if (score < 18) continue;

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
        strongTerms,
        lowValuePenalty,
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
      controls: ["Save / Approve", "Dismiss / Reject", "Next Quote", "Jump to Audio", "Jump to Video"]
    },
    tuning: {
      minWords: 12,
      maxWords: 55,
      maxQuotesPerEpisode: 75,
      displayText: "Lightly cleaned presentation copy; rawText preserves the candidate source.",
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
      rawText: quote.rawText,
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
