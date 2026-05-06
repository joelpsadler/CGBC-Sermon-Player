CGBC Transcript Search Index Patch

Upload locations:
- scripts/resolve-library.js
- .github/workflows/build-sermon-library.yml
- index.html from site/index.html, if you want the frontend to use the new public/search-index.json

What changed:
- Generates data/transcripts/search-index.json and public/search-index.json.
- Removes repeated transcript search noise phrases from the search index only.
- Keeps full transcript files for transcript display, but no longer embeds full transcriptText in library-resolved.json.
- Frontend loads search-index.json when available and folds it into the existing search matcher.

Noise phrases excluded from transcript search index:
- Never forget why you are the church
- If you have/love the Lord say amen
- With heads bowed and eyes closed all over this place
- You are released/relase bye-bye variants
- fur-filled / fur-fild transcription variants
