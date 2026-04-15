#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const STATS_PATH = path.resolve(process.cwd(), "stats", "stats.json");
const MAX_PAGES = Number(process.env.PODBEAN_MAX_PAGES || 20);
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 600);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readExistingStats(statsPath) {
  if (!fs.existsSync(statsPath)) {
    return {
      generated_at: null,
      source: {},
      podcast_totals: {},
      episodes: {},
      summary: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch (err) {
    console.warn(`Could not parse existing stats.json: ${err.message}`);
    return {
      generated_at: null,
      source: {},
      podcast_totals: {},
      episodes: {},
      summary: {},
    };
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCVisibleTextSync/3.0",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }
  return html;
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToVisibleText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/section>/gi, "\n")
      .replace(/<\/article>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "/");
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\|/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompactNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;

  const n = Number(match[1]);
  const suffix = match[2] || "";
  const scale = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
  return Math.round(n * scale);
}

function extractPodcastTotals(visibleText) {
  const lines = visibleText.split("\n").map((s) => s.trim()).filter(Boolean);

  let plays = null;
  let episodes = null;

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!Number.isFinite(plays) && /^(\d+(?:\.\d+)?[KMB]?)$/i.test(lines[i]) && /^Downloads$/i.test(lines[i + 1])) {
      plays = parseCompactNumber(lines[i]);
    }
    if (!Number.isFinite(episodes) && /^\d+$/.test(lines[i]) && /^Episodes$/i.test(lines[i + 1])) {
      episodes = Number(lines[i]);
    }
    if (Number.isFinite(plays) && Number.isFinite(episodes)) break;
  }

  return {
    plays: Number.isFinite(plays) ? plays : null,
    episodes: Number.isFinite(episodes) ? episodes : null,
  };
}

function pageCandidates(baseUrl) {
  const root = normalizeUrl(baseUrl);
  const out = [root];
  for (let i = 2; i <= MAX_PAGES; i += 1) {
    out.push(`${root}page/${i}/`);
  }
  return out;
}

function isNoiseLine(line) {
  return !line ||
    /^Likes$/i.test(line) ||
    /^Share$/i.test(line) ||
    /^Read more$/i.test(line) ||
    /^RSS$/i.test(line) ||
    /^Episodes$/i.test(line) ||
    /^Home$/i.test(line) ||
    /^Cancel$/i.test(line) ||
    /^Subscribe$/i.test(line) ||
    /^Profile$/i.test(line) ||
    /^\d+(?:\.\d+)?[KMB]?$/i.test(line) ||
    /^Downloads$/i.test(line);
}

function extractEpisodePairsFromVisibleText(visibleText) {
  const lines = visibleText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^Download\s+(\d+)$/i);
    if (!match) continue;

    const downloads = Number(match[1]);
    let title = null;

    for (let j = i - 1; j >= Math.max(0, i - 18); j -= 1) {
      const candidate = lines[j];
      if (isNoiseLine(candidate)) continue;
      if (/^Title:/i.test(candidate)) continue;
      if (/^Series:/i.test(candidate)) continue;
      if (/^Scripture:/i.test(candidate)) continue;
      if (/^by:/i.test(candidate)) continue;
      if (/^Date:/i.test(candidate)) continue;
      if (/^Video:/i.test(candidate)) continue;
      if (/^\d+\s+days?\s+ago$/i.test(candidate)) continue;
      if (/^[A-Za-z]{3,9}\s+[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}$/i.test(candidate)) continue;
      if (/^[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}$/i.test(candidate)) continue;
      if (/^CGBC\b/i.test(candidate)) continue;
      if (/^Established in/i.test(candidate)) continue;
      if (/^https?:\/\//i.test(candidate)) continue;

      title = candidate;
      break;
    }

    if (title) {
      out.push({
        title,
        title_key: normalizeTitle(title),
        downloads,
      });
    }
  }

  return out;
}

function buildExistingTitleIndex(episodes) {
  const index = new Map();

  for (const [key, episode] of Object.entries(episodes || {})) {
    const current = safeObject(episode);
    const title = current.title || current.display_title || "";
    const titleKey = normalizeTitle(title);
    if (!titleKey) continue;

    if (!index.has(titleKey)) index.set(titleKey, []);
    index.get(titleKey).push({ key, episode: current });
  }

  return index;
}

async function scrapeAllPages(showUrl) {
  const pages = pageCandidates(showUrl);
  const episodePairs = [];
  let pagesFetched = 0;
  let page1VisibleText = "";

  for (const url of pages) {
    try {
      const html = await fetchHtml(url);
      pagesFetched += 1;
      const visibleText = htmlToVisibleText(html);

      if (!page1VisibleText) page1VisibleText = visibleText;

      const pairs = extractEpisodePairsFromVisibleText(visibleText);
      if (!pairs.length && url !== normalizeUrl(showUrl)) {
        break;
      }

      episodePairs.push(...pairs);
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      if (url === normalizeUrl(showUrl)) throw err;
      break;
    }
  }

  return {
    pagesFetched,
    episodePairs,
    page1VisibleText,
  };
}

async function main() {
  const existing = readExistingStats(STATS_PATH);
  const scrape = await scrapeAllPages(PODBEAN_SHOW_URL);
  const totals = extractPodcastTotals(scrape.page1VisibleText);

  const now = new Date().toISOString();
  const episodes = safeObject(existing.episodes);
  const titleIndex = buildExistingTitleIndex(episodes);

  let matches = 0;

  for (const pair of scrape.episodePairs) {
    const candidates = titleIndex.get(pair.title_key) || [];
    if (!candidates.length) continue;

    for (const candidate of candidates) {
      const current = safeObject(candidate.episode);
      const newValue = Math.max(Number(current.plays_total || current.downloads_total || 0), Number(pair.downloads || 0));

      episodes[candidate.key] = {
        ...current,
        title: current.title || pair.title,
        plays_total: newValue,
        downloads_total: newValue,
        public_listing_downloads: Number(pair.downloads || 0),
        public_listing_title: pair.title,
        public_listing_title_key: pair.title_key,
        last_public_listing_sync_at: now,
        downloads_by_date: safeObject(current.downloads_by_date),
      };

      matches += 1;
    }
  }

  const output = {
    generated_at: now,
    source: {
      ...(safeObject(existing.source)),
      provider: "podbean_public_site",
      metric: "plays",
      strategy: "visible_text_block_parser",
      show_url: PODBEAN_SHOW_URL,
    },
    podcast_totals: {
      ...(safeObject(existing.podcast_totals)),
      plays_total: Number.isFinite(totals.plays)
        ? totals.plays
        : Number(existing?.podcast_totals?.plays_total || 0),
      episodes_total: Number.isFinite(totals.episodes)
        ? totals.episodes
        : Number(existing?.podcast_totals?.episodes_total || 0),
      last_updated: now,
      source_url: PODBEAN_SHOW_URL,
    },
    episodes,
    summary: {
      ...(safeObject(existing.summary)),
      sync_type: "podcast_totals_plus_visible_text_episode_blocks",
      pages_fetched: scrape.pagesFetched,
      visible_text_pairs_found: scrape.episodePairs.length,
      episode_listing_matches: matches,
    },
  };

  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${STATS_PATH}`);
  console.log(
    `Totals -> plays=${output.podcast_totals.plays_total}, episodes=${output.podcast_totals.episodes_total}, visiblePairs=${scrape.episodePairs.length}, matches=${matches}, pagesFetched=${scrape.pagesFetched}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
