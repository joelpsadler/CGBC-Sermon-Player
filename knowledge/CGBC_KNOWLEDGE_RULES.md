# CGBC Knowledge Rules

Purpose:
This folder stores the durable, UI-independent sermon knowledge records that can later power CGBC Discover, Deep Dive, search improvements, Quote Engine 2.0, and a possible private Pastor Jacob Lannom author corpus.

Core rules:
1. One sermon = one canonical JSON file under `knowledge/sermons/<year>/`.
2. The sermon JSON is the durable source. Generated search indexes, Discover feeds, quote feeds, and other build outputs should be recreated from it.
3. Preserve provenance. Clearly distinguish:
   - PASTOR — SPOKEN EXACT
   - PASTOR — PREPARED
   - PASTOR — VISUAL
   - SCRIPTURE
   - PASTOR RESOURCE / EXTERNAL SUPPORT
   - ANALYSIS — SYNTHESIS
   - ANALYSIS — CLASSIFICATION
   - ANALYSIS — GENERATED QUESTION
   - EDITORIAL FLAG
4. Quote-worthy material belongs in the sermon knowledge record even if it is never approved for the public Quote Wall.
5. Quote curation is a lightweight editorial decision layer. Approved and Featured decisions are durable. Routine rejected recommendations do not need permanent storage.
6. Future Quote Engine 2.0 should use the processed transcript baseline plus sermon Info Map context, structure, doctrine, Scripture, and prior Approved/Featured decisions to generate a small recommendation set.
7. Discover, Deep Dive, and a future author-facing system should read from the same sermon record rather than maintain duplicate theological content.
8. Do not let AI-generated organization or synthesis masquerade as Pastor Jacob Lannom's own words.
9. Stable episode IDs, transcript timestamps, source paths, Scripture references, and provenance should be retained whenever available.
10. UI decisions may change without requiring the sermon knowledge record to be rewritten.

Naming:
`YYYY-MM-DD_sermon-title-slug.json`

Example:
`2026-09-27_good-gifts-from-a-good-god.json`
