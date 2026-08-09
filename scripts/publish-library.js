import { readJson, writeJson } from "./utils.js";

function main() {
  const doc = readJson("data/library-resolved.json");
  if (!doc.generatedAt) throw new Error("Missing generatedAt");
  if (!Array.isArray(doc.items)) throw new Error("items must be an array");

     const seen = new Set();
    doc.items = doc.items.filter(item => {
        if (!item.stableId) throw new Error("Missing stableId");
        if (seen.has(item.stableId)) {
            console.warn(`Skipping duplicate item: ${item.stableId}`);
            return false;
        }
        seen.add(item.stableId);
        return true;
    });


  writeJson("public/library-resolved.json", doc);
  console.log(`Published items: ${doc.items.length}`);
}

main();
