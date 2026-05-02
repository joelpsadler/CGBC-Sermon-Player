#!/usr/bin/env python3
"""
Translate CGBC display subtitle files with Azure Translator while preserving timing.

Rate-safe version:
- Scans only transcripts_display/en/
- Prefers .srt files and ignores display .json files when SRTs exist
- Uses smaller Azure batches
- Pauses between requests
- Handles Azure 429 rate limits with longer backoff and Retry-After support

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


DEFAULT_SOURCE_DIRS = [
    Path("transcripts_display/en"),
]

DEFAULT_MAX_RUN_CHARACTERS = 750_000

# Azure F0 can rate-limit if we move too fast.
# Smaller batches are slower, but much more reliable for GitHub Actions.
MAX_TEXTS_PER_REQUEST = 20
MAX_CHARS_PER_REQUEST = 8_000
REQUEST_PAUSE_SECONDS = 2.5

# 429 backoff. We would rather wait a few minutes than fail a whole workflow.
MAX_RETRY_ATTEMPTS = 10
DEFAULT_429_BACKOFF_SECONDS = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240]


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
        time_line_index = 1 if idx_line.isdigit() else 0

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
        chunks.append(f"{i}\n{cue.start_time} --> {cue.end_time}\n{cue.text.strip()}\n")

    path.write_text("\n".join(chunks).strip() + "\n", encoding="utf-8")


def output_path_for(source_path: Path, target_lang: str) -> Path:
    parts = list(source_path.parts)
    try:
        en_index = parts.index("en")
        parts[en_index] = target_lang
    except ValueError:
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


def retry_after_seconds(response: requests.Response, attempt: int) -> int:
    header_value = response.headers.get("Retry-After", "").strip()
    if header_value.isdigit():
        return max(5, int(header_value))

    index = min(attempt - 1, len(DEFAULT_429_BACKOFF_SECONDS) - 1)
    return DEFAULT_429_BACKOFF_SECONDS[index]


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

    for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
        response = requests.post(url, params=params, headers=headers, json=body, timeout=90)

        if response.status_code == 429:
            wait_seconds = retry_after_seconds(response, attempt)
            print(
                f"Azure returned 429 for target {target_lang}; "
                f"attempt {attempt}/{MAX_RETRY_ATTEMPTS}. Waiting {wait_seconds}s..."
            )
            time.sleep(wait_seconds)
            continue

        if 500 <= response.status_code < 600:
            wait_seconds = min(15 * attempt, 120)
            print(
                f"Azure returned {response.status_code} for target {target_lang}; "
                f"attempt {attempt}/{MAX_RETRY_ATTEMPTS}. Waiting {wait_seconds}s..."
            )
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

        # Gentle pacing after successful requests too.
        time.sleep(REQUEST_PAUSE_SECONDS)
        return translated

    die(
        f"Azure translation failed repeatedly for target language {target_lang}. "
        "This is usually a temporary F0 rate limit. Re-running the workflow later should continue "
        "because already-created translated SRT files are skipped when FORCE_TRANSLATE=false."
    )
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
    batches = list(chunk_texts(texts))

    print(f"    Azure batches for {target_lang}: {len(batches)}")

    for batch_index, batch in enumerate(batches, start=1):
        print(f"    Batch {batch_index}/{len(batches)} for {target_lang} ({sum(len(t) for t in batch):,} chars)")
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

    srt_files: List[Path] = []
    json_files: List[Path] = []

    for source_dir in DEFAULT_SOURCE_DIRS:
        if source_dir.exists():
            srt_files.extend(sorted(source_dir.glob("*.srt")))
            json_files.extend(sorted(source_dir.glob("*.json")))

    if srt_files:
        print("SRT files found; ignoring display JSON files to avoid duplicate translation.")
        return sorted(srt_files)

    print("No display SRT files found; falling back to display JSON files.")
    return sorted(json_files)


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
        print("No English display SRT/JSON transcript files found. Nothing to translate.")
        return

    print(f"Found {len(source_files)} source display transcript file(s).")
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

    print("\nDone. Translated display SRT files are ready to commit.")


if __name__ == "__main__":
    main()
