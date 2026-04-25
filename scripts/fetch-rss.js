import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "fs";
import {
  clean, ensureDir, writeJson, stripHtmlToText
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
  "references": "References",
  "reference": "References",
  "book tags": "Book Tags",
  "collections": "Collections",
  "collection": "Collections",
  "by": "by",
  "date": "Date",
  "video": "Video"
};

const EMPTY_NOTES_FIELDS = {
  "Title": "",
  "Subtitle": "",
  "Series": "",
  "Study": "",
  "Series Type": "",
  "Scripture": "",
  "References": "",
  "Book Tags": "",
  "Collections": "",
  "by": "",
  "Date": "",
  "Video": ""
};

function parseNotesFields(notesRaw = "") {
  const result = { ...EMPTY_NOTES_FIELDS };

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

      // Beginner note:
      // If a line looks like "Some Unknown Label:", do not append it to the
      // previous known field. This keeps future metadata experiments from
      // accidentally polluting Scripture, Book Tags, Date, etc.
      currentField = null;
      continue;
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
  return stripHtmlToText(content);
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
    const notesFields = parseNotesFields(notesRaw);

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
  const withReferences = records.filter(r => clean(r.notesFields["References"])).length;
  const withCollections = records.filter(r => clean(r.notesFields["Collections"])).length;

  console.log(`RSS items fetched: ${records.length}`);
  console.log(`Items with Video field: ${withVideo}`);
  console.log(`Items with Subtitle field: ${withSubtitle}`);
  console.log(`Items with Book Tags field: ${withBookTags}`);
  console.log(`Items with References field: ${withReferences}`);
  console.log(`Items with Collections field: ${withCollections}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
