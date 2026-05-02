#!/usr/bin/env python3
"""
Reconcile CGBC transcript files using the current transcript manifest.

This is the long-term cleanup approach for routine metadata improvements.

Source of truth:
- data/transcripts/search-index.json

This script keeps current transcript files listed in the manifest and removes
stale managed transcript files left behind after RSS/title metadata changes.

It intentionally does NOT touch:
- transcripts_incoming/
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Set


DATE_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})_.+\.(?P<ext>srt|json)$", re.IGNORECASE)

MANIFEST_PATH = Path("data/transcripts/search-index.json")

MANAGED_ENGLISH_DIRS = [
    Path("transcripts_clean/en"),
    Path("transcripts_display/en"),
    Path("data/transcripts/en"),
]

TRANSLATED_DISPLAY_LANGS = ["es", "fr", "de", "nl", "pt"]


def norm_path(value: str | Path | None) -> str:
    if not value:
        return ""
    return str(value).replace("\\", "/").strip().lstrip("./")


def date_from_path(path: Path) -> str | None:
    match = DATE_RE.match(path.name)
    if not match:
        return None
    return match.group("date")


def load_manifest(path: Path) -> Dict:
    if not path.exists():
        raise SystemExit(
            f"ERROR: Transcript manifest not found: {path}\n"
            "Run the library/transcript build first so data/transcripts/search-index.json exists."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def add_path(paths: Set[str], value: str | None) -> None:
    normalized = norm_path(value)
    if normalized:
        paths.add(normalized)


def translated_display_path_from_english(english_display_srt: str, lang: str) -> str:
    parts = norm_path(english_display_srt).split("/")
    try:
        en_index = parts.index("en")
    except ValueError:
        return ""
    parts[en_index] = lang
    return "/".join(parts)


def collect_current_paths(manifest: Dict, include_translated: bool) -> tuple[Set[str], Set[str]]:
    entries = manifest.get("entries", [])
    keep_paths: Set[str] = set()
    managed_dates: Set[str] = set()

    for entry in entries:
        date = entry.get("date")
        if date:
            managed_dates.add(str(date))

        add_path(keep_paths, entry.get("transcriptCleanSrt"))
        add_path(keep_paths, entry.get("transcriptDisplaySrt"))
        add_path(keep_paths, entry.get("transcriptJson"))
        add_path(keep_paths, entry.get("transcriptDisplayJson"))

        languages = entry.get("languages") or {}
        for payload in languages.values():
            if isinstance(payload, dict):
                add_path(keep_paths, payload.get("cleanFile"))
                add_path(keep_paths, payload.get("displayFile"))
                add_path(keep_paths, payload.get("jsonFile"))
                add_path(keep_paths, payload.get("displayJsonFile"))

        if include_translated:
            english_display = norm_path(entry.get("transcriptDisplaySrt"))
            if english_display:
                for lang in TRANSLATED_DISPLAY_LANGS:
                    add_path(keep_paths, translated_display_path_from_english(english_display, lang))

    return keep_paths, managed_dates


def managed_dirs(include_translated: bool) -> List[Path]:
    dirs = list(MANAGED_ENGLISH_DIRS)
    if include_translated:
        for lang in TRANSLATED_DISPLAY_LANGS:
            dirs.append(Path(f"transcripts_display/{lang}"))
    return dirs


def iter_managed_files(folder: Path) -> Iterable[Path]:
    if not folder.exists():
        return []
    files = []
    files.extend(folder.glob("*.srt"))
    files.extend(folder.glob("*.json"))
    return sorted(files)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(MANIFEST_PATH))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--translated", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    keep_paths, managed_dates = collect_current_paths(manifest, include_translated=args.translated)

    print("CGBC transcript manifest reconciliation")
    print(f"Manifest: {manifest_path}")
    print(f"Mode: {'APPLY / delete stale files' if args.apply else 'DRY RUN / no files deleted'}")
    print(f"Manifest entries: {len(manifest.get('entries', []))}")
    print(f"Current paths to keep: {len(keep_paths)}")
    print(f"Managed dates: {', '.join(sorted(managed_dates)) if managed_dates else '(none)'}")
    print(f"Translated folders included: {args.translated}")
    print("")

    stale_files: List[Path] = []

    for folder in managed_dirs(include_translated=args.translated):
        print(f"Folder: {folder}")

        files = list(iter_managed_files(folder))
        if not files:
            print("  No managed files found.")
            print("")
            continue

        folder_stale_count = 0

        for path in files:
            normalized = norm_path(path)
            file_date = date_from_path(path)

            if not file_date or file_date not in managed_dates:
                continue

            if normalized in keep_paths:
                continue

            print(f"  STALE: {path}")
            stale_files.append(path)
            folder_stale_count += 1

        if folder_stale_count == 0:
            print("  No stale files found.")
        print("")

    print("Summary:")
    print(f"  Stale files identified: {len(stale_files)}")

    if args.apply:
        for path in stale_files:
            path.unlink(missing_ok=True)
        print(f"  Files deleted: {len(stale_files)}")
    else:
        print("  Files deleted: 0 because this was a dry run.")
        print("  Re-run with --apply to delete them.")


if __name__ == "__main__":
    main()
