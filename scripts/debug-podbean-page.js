#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PODBEAN_SHOW_URL =
  process.env.PODBEAN_SHOW_URL || "https://brojacobcedargrovebaptist.podbean.com/";
const MAX_PAGES = Number(process.env.PODBEAN_MAX_PAGES || 5);
const REQUEST_DELAY_MS = Number(process.env.PODBEAN_REQUEST_DELAY_MS || 500);
const OUT_DIR = path.resolve(process.cwd(), "stats", "debug");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "/");
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

function stripTags(str) {
  return decodeEntities(
    String(str || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CGBCPodbeanDebug/1.0",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }
  return html;
}

function pageCandidates(baseUrl) {
  const root = normalizeUrl(baseUrl);
  const out = [root];
  for (let i = 2; i <= MAX_PAGES; i += 1) {
    out.push(`${root}page/${i}/`);
  }
  return out;
}

function summarizeArticle(article, index) {
  const hrefMatches = [...article.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const hrefs = hrefMatches.slice(0, 12).map((m) => ({
    href: normalizeUrl(m[1]),
    text: stripTags(m[2]).slice(0, 140),
  }));

  const visible = htmlToVisibleText(article);
  const downloadMatches = [...visible.matchAll(/\bDownload\s+\d+\b/gi)].map((m) => m[0]);
  const titleish = hrefs.find((h) => h.text && h.text.length > 10);

  return {
    index,
    visible_preview: visible.slice(0, 600),
    href_count: hrefMatches.length,
    hrefs,
    download_tokens: downloadMatches,
    titleish_text: titleish ? titleish.text : null,
  };
}

function inspectHtml(html, pageUrl) {
  const visible = htmlToVisibleText(html);
  const downloadTokenCount = [...visible.matchAll(/\bDownload\s+\d+\b/gi)].length;
  const articleRegex = /<article[\s\S]*?<\/article>/gi;
  const articleMatches = html.match(articleRegex) || [];

  const articleSummaries = articleMatches.slice(0, 20).map((article, idx) =>
    summarizeArticle(article, idx + 1)
  );

  const globalHrefMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const suspiciousLinks = globalHrefMatches
    .map((m) => ({
      href: normalizeUrl(m[1]),
      text: stripTags(m[2]).slice(0, 160),
    }))
    .filter((x) => /podbean\.com\/e\//i.test(x.href) || /\/\d{6,}\/?$/i.test(x.href))
    .slice(0, 50);

  const visibleLinesWithDownload = visible
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /Download\s+\d+/i.test(s))
    .slice(0, 80);

  return {
    page_url: pageUrl,
    html_length: html.length,
    visible_text_preview: visible.slice(0, 2000),
    article_count: articleMatches.length,
    download_token_count: downloadTokenCount,
    visible_lines_with_download: visibleLinesWithDownload,
    suspicious_links: suspiciousLinks,
    article_summaries: articleSummaries,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pages = pageCandidates(PODBEAN_SHOW_URL);
  const manifest = [];

  for (let i = 0; i < pages.length; i += 1) {
    const url = pages[i];
    try {
      const html = await fetchHtml(url);
      const inspection = inspectHtml(html, url);

      const jsonPath = path.join(OUT_DIR, `page-${i + 1}-inspection.json`);
      const htmlPath = path.join(OUT_DIR, `page-${i + 1}.html`);
      const txtPath = path.join(OUT_DIR, `page-${i + 1}-visible.txt`);

      fs.writeFileSync(jsonPath, JSON.stringify(inspection, null, 2), "utf8");
      fs.writeFileSync(htmlPath, html, "utf8");
      fs.writeFileSync(txtPath, htmlToVisibleText(html), "utf8");

      manifest.push({
        page: i + 1,
        url,
        inspection_file: path.relative(process.cwd(), jsonPath),
        html_file: path.relative(process.cwd(), htmlPath),
        visible_file: path.relative(process.cwd(), txtPath),
        article_count: inspection.article_count,
        download_token_count: inspection.download_token_count,
      });

      console.log(`Inspected page ${i + 1}: ${url}`);
      console.log(`  article_count=${inspection.article_count}`);
      console.log(`  download_token_count=${inspection.download_token_count}`);

      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.error(`Failed page ${i + 1}: ${url}`);
      console.error(err.message);
      break;
    }
  }

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ generated_at: new Date().toISOString(), pages: manifest }, null, 2), "utf8");
  console.log(`Wrote ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
