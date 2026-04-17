import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "fs";
import {
  clean, ensureDir, writeJson, stripHtmlToText, trimTrailingChurchBoilerplate,
  detectBibleBook, parseFlexibleDate, formatISODate
} from "./utils.js";

const config = JSON.parse(readFileSync(new URL("../config/resolver-config.json", import.meta.url), "utf-8"));
const RSS_URL = config.rssUrl;

const NOTE_FIELD_MAP = {
  "title": "Title",
  "subtitle": "Subtitle",
  "series": "Series",
  "study": "Study",
  "series type": "Series Type",
  "scripture": "Scripture",
  "book tags": "Book Tags",
  "by": "by",
  "date": "Date",
  "video": "Video"
};

function buildEmptyNotesFields() {
  return {
    "Title": "",
    "Subtitle": "",
    "Series": "",
    "Study": "",
    "Series Type": "",
    "Scripture": "",
    "Book Tags": "",
    "by": "",
    "Date": "",
    "Video": ""
  };
}

function parseNotesFields(notesRaw = "") {
  const result = buildEmptyNotesFields();
  const lines = String(notesRaw).replace(/\r\n/g, "\n").split("\n").map(line => line.trim());
  let currentField = null;

  for (const line of lines) {
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const rawLabel = match[1].trim().toLowerCase();
      const canonicalField = NOTE_FIELD_MAP[rawLabel];
      if (canonicalField) {
        currentField = canonicalField;
        result[canonicalField] = clean(match[2] ?? "");
        continue;
      }
    }
    if (currentField) {
      result[currentField] = clean(`${result[currentField]} ${line}`);
    }
  }

  return result;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function applyLegacyFallbacks(fields, notesRaw, item) {
  const next = { ...fields };
  const text = String(notesRaw || "");
  if (!clean(text)) return next;

  if (!next["Date"]) {
    const lines = text.split("\n").map(clean).filter(Boolean);
    const dateLine = lines.find(line => parseFlexibleDate(line));
    if (dateLine) {
      const parsed = parseFlexibleDate(dateLine);
      next["Date"] = formatISODate(parsed) || clean(dateLine);
    }
  }

  if (!next["Scripture"]) {
    const scriptureMatch = text.match(/\b((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)*\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?)\b/);
    if (scriptureMatch) {
      next["Scripture"] = clean(scriptureMatch[1]);
    }
  }

  if (!next["Book Tags"]) {
    const detected = new Set();
    const directBook = detectBibleBook(next["Scripture"]);
    if (directBook) detected.add(directBook);
    const scanTargets = [
      clean(first(item.title)),
      clean(first(item.description)),
      clean(text)
    ];
    for (const target of scanTargets) {
      const book = detectBibleBook(target);
      if (book) detected.add(book);
    }
    if (detected.size) {
      next["Book Tags"] = Array.from(detected).join(", ");
    }
  }

  if (!next["Video"]) {
    const videoMatch = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+|youtube\.com\/shorts\/[A-Za-z0-9_-]+)/i);
    if (videoMatch) {
      next["Video"] = clean(videoMatch[0]);
    }
  }

  return next;
}

function getGuid(item) {
  const guid = first(item.guid);
  if (!guid) return "";
  if (typeof guid === "string") return clean(guid);
  if (typeof guid === "object") {
    if (typeof guid["#text"] === "string") return clean(guid["#text"]);
    if (typeof guid.text === "string") return clean(guid.text);
    if (typeof guid.__text === "string") return clean(guid.__text);
    if (typeof guid["cdata"] === "string") return clean(guid["cdata"]);
  }
  return "";
}

function getEpisodeImage(item) {
  const itunesImage = item["itunes:image"];
  if (itunesImage && typeof itunesImage === "object" && itunesImage.href) return clean(itunesImage.href);
  if (typeof itunesImage === "string") return clean(itunesImage);
  return "";
}

function getNotes(item) {
  const content = first(item["content:encoded"]) || first(item.description) || "";
  const plainText = stripHtmlToText(content);
  return trimTrailingChurchBoilerplate(plainText);
}

async function main() {
  const xml = await fetch(RSS_URL).then(r => {
    if (!r.ok) throw new Error(`RSS fetch failed: ${r.status}`);
    return r.text();
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    trimValues: false
  });

  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  const items = Array.isArray(channel?.item) ? channel.item : (channel?.item ? [channel.item] : []);

  const records = items.map(item => {
    const enclosure = first(item.enclosure);
    const notesRaw = getNotes(item);
    const parsedFields = parseNotesFields(notesRaw);
    const notesFields = applyLegacyFallbacks(parsedFields, notesRaw, item);

    return {
      rssGuid: getGuid(item),
      mediaUrl: clean(enclosure?.url || ""),
      episodeUrl: clean(first(item.link)),
      rssTitle: clean(first(item.title)),
      pubDate: clean(first(item.pubDate)),
      itunesDuration: clean(first(item["itunes:duration"])),
      episodeImage: getEpisodeImage(item),
      notesRaw,
      notesFields
    };
  });

  ensureDir("data");
  writeJson("data/raw-rss.json", records);

  const withVideo = records.filter(r => clean(r.notesFields["Video"])).length;
  const withSubtitle = records.filter(r => clean(r.notesFields["Subtitle"])).length;
  const withBookTags = records.filter(r => clean(r.notesFields["Book Tags"])).length;
  const withScripture = records.filter(r => clean(r.notesFields["Scripture"])).length;
  const withDate = records.filter(r => clean(r.notesFields["Date"])).length;

  console.log(`RSS items fetched: ${records.length}`);
  console.log(`Items with Video field: ${withVideo}`);
  console.log(`Items with Subtitle field: ${withSubtitle}`);
  console.log(`Items with Book Tags field: ${withBookTags}`);
  console.log(`Items with Scripture field: ${withScripture}`);
  console.log(`Items with Date field: ${withDate}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
