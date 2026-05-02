#!/usr/bin/env python3
"""
Translate CGBC transcript SRT files with Azure Translator while preserving subtitle timing.

Beginner notes:
- This script reads English .srt files and display-clean JSON transcript files.
- It sends ONLY the cue text to Azure, not the timestamps.
- It writes translated .srt files into matching language folders.
- Example:
    transcripts_display/en/example.srt
  becomes:
    transcripts_display/es/example.srt
    transcripts_display/fr/example.srt
    transcripts_display/de/example.srt
    transcripts_display/nl/example.srt
    transcripts_display/pt/example.srt

Required GitHub Secrets:
- AZURE_TRANSLATOR_KEY
- AZURE_TRANSLATOR_ENDPOINT
- AZURE_TRANSLATOR_REGION
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

import requests


# -----------------------------
# Main configuration
# -----------------------------

DEFAULT_SOURCE_DIRS = [
    Path("transcripts_display/en"),
    Path("transcripts_clean/en"),
]

# This helps avoid accidental runaway use.
# Azure F0 is generous, but guardrails are still wise.
DEFAULT_MAX_RUN_CHARACTERS = 550_000

# Azure accepts many texts in one call, but batching keeps requests stable.
MAX_TEXTS_PER_REQUEST = 75
MAX_CHARS_PER_REQUEST = 35_000


@dataclass
class Cue:
    index: int
    start_time: str
    end_time: str
    text: str


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def normalize_endpoint(endpoint: str) -> str:
    endpoint = endpoint.strip()
    if not endpoint:
        die("AZURE_TRANSLATOR_ENDPOINT is empty.")
    return endpoint.rstrip("/")


def get_required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        die(f"Missing required environment variable: {name}")
    return value


def parse_srt(content: str) -> List[Cue]:
    """
    Parse a normal SRT file into cues.

    This parser is intentionally forgiving because real subtitle files often
    have harmless spacing differences.
    """
    content = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not content:
        return []

    blocks = re.split(r"\n\s*\n", content)
    cues: List[Cue] = []

    for block in blocks:
        lines = [line.rstrip() for line in block.split("\n") if line.strip() != ""]
        if len(lines) < 2:
            continue

        idx_line = lines[0].strip()
        time_line_index = 1

        if not idx_line.isdigit():
            # Some SRT-like files omit the numeric index.
            time_line_index = 0
            cue_index = len(cues) + 1
        else:
            cue_index = int(idx_line)

        if time_line_index >= len(lines):
            continue

        time_line = lines[time_line_index]
        match = re.match(
            r"(?P<start>\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(?P<end>\d{2}:\d{2}:\d{2},\d{3})",
            time_line,
        )
        if not match:
            continue

        text = "\n".join(lines[time_line_index + 1 :]).strip()
        cues.append(
            Cue(
                index=len(cues) + 1,
                start_time=match.group("start"),
                end_time=match.group("end"),
                text=text,
            )
        )

    return cues


def cues_from_display_json(content: str) -> List[Cue]:
    """
    Convert one of our display transcript JSON files into SRT cues.

    Expected shape:
    {
      "segments": [
        {
          "index": 1,
          "startTime": "00:00:00,000",
          "endTime": "00:00:04,849",
          "text": "Never forget why you are the church."
        }
      ]
    }
    """
    data = json.loads(content)
    segments = data.get("segments", [])
    cues: List[Cue] = []

    for i, seg in enumerate(segments, start=1):
        start_time = seg.get("startTime")
        end_time = seg.get("endTime")
        text = (seg.get("text") or "").strip()

        if not start_time or not end_time or not text:
            continue

        cues.append(
            Cue(
                index=i,
                start_time=start_time,
                end_time=end_time,
                text=text,
            )
        )

    return cues


def read_cues(path: Path) -> List[Cue]:
    content = path.read_text(encoding="utf-8-sig")

    if path.suffix.lower() == ".json":
        return cues_from_display_json(content)

    return parse_srt(content)


def write_srt(path: Path, cues: List[Cue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    chunks = []
    for i, cue in enumerate(cues, start=1):
        text = cue.text.strip()
        chunks.append(f"{i}\n{cue.start_time} --> {cue.end_time}\n{text}\n")

    path.write_text("\n".join(chunks).strip() + "\n", encoding="utf-8")


def output_path_for(source_path: Path, target_lang: str) -> Path:
    """
    Preserve your repo structure by replacing /en/ with /target_lang/.

    Also converts .json input into .srt output, because the website can consume
    the translated subtitles as normal SRT files.
    """
    parts = list(source_path.parts)
    try:
        en_index = parts.index("en")
        parts[en_index] = target_lang
    except ValueError:
        # Fallback if someone passes a file outside transcripts_display/en.
        parts.insert(-1, target_lang)

    out = Path(*parts)
    return out.with_suffix(".srt")


def estimate_billable_characters(cues: List[Cue], target_count: int) -> int:
    return sum(len(cue.text) for cue in cues) * target_count


def chunk_texts(texts: List[str]) -> Iterable[List[str]]:
    batch: List[str] = []
    batch_chars = 0

    for text in texts:
        text_chars = len(text)

        if batch and (
            len(batch) >= MAX_TEXTS_PER_REQUEST
            or batch_chars + text_chars > MAX_CHARS_PER_REQUEST
        ):
            yield batch
            batch = []
            batch_chars = 0

        batch.append(text)
        batch_chars += text_chars

    if batch:
        yield batch


def translate_batch(
    texts: List[str],
    target_lang: str,
    source_lang: str,
    key: str,
    endpoint: str,
    region: str,
) -> List[str]:
    url = f"{endpoint}/translate"
    params = {
        "api-version": "3.0",
        "from": source_lang,
        "to": target_lang,
        "textType": "plain",
    }
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Ocp-Apim-Subscription-Region": region,
        "Content-Type": "application/json; charset=UTF-8",
        "X-ClientTraceId": str(uuid.uuid4()),
    }
    body = [{"text": text} for text in texts]

    # Simple retry for temporary service hiccups.
    for attempt in range(1, 5):
        response = requests.post(url, params=params, headers=headers, json=body, timeout=60)

        if response.status_code == 429 or 500 <= response.status_code < 600:
            wait_seconds = min(2 * attempt, 10)
            print(f"Azure returned {response.status_code}; retrying in {wait_seconds}s...")
            time.sleep(wait_seconds)
            continue

        if not response.ok:
            print("Azure response body:")
            print(response.text)
            response.raise_for_status()

        payload = response.json()
        translated = []
        for item in payload:
            translated_text = item["translations"][0]["text"]
            translated.append(html.unescape(translated_text))
        return translated

    die(f"Azure translation failed repeatedly for target language {target_lang}.")
    return []


def translate_texts(
    texts: List[str],
    target_lang: str,
    source_lang: str,
    key: str,
    endpoint: str,
    region: str,
) -> List[str]:
    translated_all: List[str] = []

    for batch in chunk_texts(texts):
        translated_all.extend(
            translate_batch(
                texts=batch,
                target_lang=target_lang,
                source_lang=source_lang,
                key=key,
                endpoint=endpoint,
                region=region,
            )
        )

    if len(translated_all) != len(texts):
        die(
            f"Translation count mismatch for {target_lang}: "
            f"expected {len(texts)}, got {len(translated_all)}"
        )

    return translated_all


def find_source_files(source_path: str) -> List[Path]:
    if source_path.strip():
        path = Path(source_path.strip())
        if not path.exists():
            die(f"SOURCE_PATH does not exist: {path}")
        return [path]

    files: List[Path] = []
    for source_dir in DEFAULT_SOURCE_DIRS:
        if source_dir.exists():
            files.extend(sorted(source_dir.glob("*.srt")))
            files.extend(sorted(source_dir.glob("*.json")))

    # Avoid double-processing matching .json/.srt pairs with the same stem in the same folder.
    # Prefer .srt if both exist, otherwise use .json.
    best = {}
    for path in files:
        key = (path.parent, path.stem)
        existing = best.get(key)
        if existing is None:
            best[key] = path
        elif existing.suffix.lower() == ".json" and path.suffix.lower() == ".srt":
            best[key] = path

    return sorted(best.values())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", nargs="+", default=["es", "fr", "de", "nl", "pt"])
    parser.add_argument("--source-lang", default="en")
    parser.add_argument("--max-run-characters", type=int, default=DEFAULT_MAX_RUN_CHARACTERS)
    args = parser.parse_args()

    key = get_required_env("AZURE_TRANSLATOR_KEY")
    endpoint = normalize_endpoint(get_required_env("AZURE_TRANSLATOR_ENDPOINT"))
    region = get_required_env("AZURE_TRANSLATOR_REGION")

    force = os.environ.get("FORCE_TRANSLATE", "false").strip().lower() == "true"
    source_path = os.environ.get("SOURCE_PATH", "").strip()

    source_files = find_source_files(source_path)
    if not source_files:
        print("No English SRT/JSON transcript files found. Nothing to translate.")
        return

    print(f"Found {len(source_files)} source transcript file(s).")
    print(f"Targets: {', '.join(args.targets)}")
    print(f"Force translate: {force}")

    planned_work = []
    estimated_total = 0

    for source_file in source_files:
        cues = read_cues(source_file)
        if not cues:
            print(f"Skipping empty/unreadable transcript: {source_file}")
            continue

        needed_targets = []
        for target in args.targets:
            out_path = output_path_for(source_file, target)
            if force or not out_path.exists():
                needed_targets.append(target)

        if not needed_targets:
            print(f"Already translated, skipping: {source_file}")
            continue

        estimate = estimate_billable_characters(cues, len(needed_targets))
        estimated_total += estimate
        planned_work.append((source_file, cues, needed_targets, estimate))

    if not planned_work:
        print("No translation work needed.")
        return

    print(f"Estimated billable characters for this run: {estimated_total:,}")

    if estimated_total > args.max_run_characters:
        die(
            f"Safety stop: estimated {estimated_total:,} characters exceeds "
            f"--max-run-characters={args.max_run_characters:,}. "
            f"Raise the limit intentionally if needed."
        )

    for source_file, cues, needed_targets, estimate in planned_work:
        print(f"\nTranslating {source_file} ({len(cues)} cues, est. {estimate:,} chars)")

        original_texts = [cue.text for cue in cues]

        for target in needed_targets:
            out_path = output_path_for(source_file, target)
            print(f"  -> {target}: {out_path}")

            translated_texts = translate_texts(
                texts=original_texts,
                target_lang=target,
                source_lang=args.source_lang,
                key=key,
                endpoint=endpoint,
                region=region,
            )

            translated_cues = [
                Cue(
                    index=cue.index,
                    start_time=cue.start_time,
                    end_time=cue.end_time,
                    text=translated_text,
                )
                for cue, translated_text in zip(cues, translated_texts)
            ]

            write_srt(out_path, translated_cues)

    print("\nDone. Translated SRT files are ready to commit.")


if __name__ == "__main__":
    main()
