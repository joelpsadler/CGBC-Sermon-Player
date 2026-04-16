import { readJson, writeJson } from "./utils.js";

function main() {
  const doc = readJson("data/library-resolved.json");
  if (!doc.generatedAt) throw new Error("Missing generatedAt");
  if (!Array.isArray(doc.items)) throw new Error("items must be an array");

  const seen = new Set();
  for (const item of doc.items) {
    if (!item.stableId) throw new Error("Missing stableId");
    if (seen.has(item.stableId)) throw new Error(`Duplicate stableId: ${item.stableId}`);
    seen.add(item.stableId);
  }

  writeJson("public/library-resolved.json", doc);
  console.log(`Published items: ${doc.items.length}`);
}

main();
