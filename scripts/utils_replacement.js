import fs from "fs";
import path from "path";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function slugify(value) {
  const s = clean(value).toLowerCase();
  if (!s) return null;
  return s
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function simpleHash(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function splitPipeTitle(title) {
  const raw = clean(title);
  if (!raw.includes("|")) return { left: raw, right: "" };
  const [left, ...rest] = raw.split("|");
  return { left: clean(left), right: clean(rest.join("|")) };
}

export function extractYoutubeId(url) {
  const raw = clean(url);
  if (!raw) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{6,})/,
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /embed\/([A-Za-z0-9_-]{6,})/,
    /shorts\/([A-Za-z0-9_-]{6,})/
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function parseDurationToSeconds(value) {
  const raw = clean(value);
  if (!raw) return 0;
  const parts = raw.split(":").map(n => Number(n));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

export function parseFlexibleDate(raw) {
  const text = clean(raw);
  if (!text) return null;

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;

  const normalized = text.replace(/^[A-Za-z]+,\s*/, "");
  const m = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  }
  return null;
}

export function formatISODate(dateObj) {
  if (!dateObj) return null;
  return dateObj.toISOString().slice(0, 10);
}

export function stripHtmlToText(html) {
  const raw = String(html || "");
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function trimTrailingChurchBoilerplate(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const cgIndex = raw.search(/\bCGBC\b/i);
  if (cgIndex >= 0) {
    const tailRatio = cgIndex / Math.max(raw.length, 1);
    if (tailRatio > 0.45) {
      return clean(raw.slice(0, cgIndex));
    }
  }

  const fallbackPatterns = [
    /\bCedar Grove Baptist Church\b.*$/i,
    /\bLebanon,\s*TN\b.*$/i,
    /\bLove\.\s*Learn\.\s*Live\.\s*Lead\..*$/i
  ];

  for (const pattern of fallbackPatterns) {
    const match = raw.match(pattern);
    if (match && typeof match.index === "number") {
      const tailRatio = match.index / Math.max(raw.length, 1);
      if (tailRatio > 0.45) {
        return clean(raw.slice(0, match.index));
      }
    }
  }

  return clean(raw);
}

export const BIBLE_BOOKS = [
  "Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth",
  "1 Samuel","2 Samuel","1 Kings","2 Kings","1 Chronicles","2 Chronicles","Ezra",
  "Nehemiah","Esther","Job","Psalms","Proverbs","Ecclesiastes","Song of Solomon",
  "Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel","Hosea","Joel","Amos",
  "Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi",
  "Matthew","Mark","Luke","John","Acts","Romans","1 Corinthians","2 Corinthians","Galatians",
  "Ephesians","Philippians","Colossians","1 Thessalonians","2 Thessalonians","1 Timothy",
  "2 Timothy","Titus","Philemon","Hebrews","James","1 Peter","2 Peter","1 John","2 John",
  "3 John","Jude","Revelation"
];

export function detectBibleBook(text) {
  const raw = clean(text);
  if (!raw) return null;
  for (const book of BIBLE_BOOKS) {
    const pattern = new RegExp(`(^|\\b)${book.replace(/ /g, "\\s+")}(\\b|\\s+\\d)`, "i");
    if (pattern.test(raw)) return book;
  }
  return null;
}

export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
