"""Isolated SQLite persistence for transcript benchmark results."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any


class TranscriptStore:
    """Mirror the product's transcript/segment/search-text storage shape."""

    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path)
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._connection.execute("PRAGMA synchronous = NORMAL")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS audio_transcriptions (
                sample_id TEXT PRIMARY KEY,
                audio_path TEXT NOT NULL,
                reference_text TEXT NOT NULL,
                raw_transcript TEXT NOT NULL,
                accepted_text TEXT NOT NULL,
                gate_status TEXT NOT NULL,
                searchable INTEGER NOT NULL,
                cer REAL,
                audio_duration_seconds REAL NOT NULL,
                asr_latency_seconds REAL NOT NULL,
                stored_at_unix REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audio_transcript_segments (
                sample_id TEXT NOT NULL,
                segment_order INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                quality_status TEXT NOT NULL,
                quality_reasons TEXT NOT NULL,
                searchable INTEGER NOT NULL,
                PRIMARY KEY (sample_id, segment_order),
                FOREIGN KEY (sample_id) REFERENCES audio_transcriptions(sample_id)
                    ON DELETE CASCADE
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS audio_transcript_fts USING fts5(
                sample_id UNINDEXED,
                accepted_text
            );
            """
        )

    def write(self, record: dict[str, Any]) -> float:
        started = time.perf_counter()
        sample_id = str(record["id"])
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO audio_transcriptions (
                    sample_id, audio_path, reference_text, raw_transcript,
                    accepted_text, gate_status, searchable, cer,
                    audio_duration_seconds, asr_latency_seconds, stored_at_unix
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sample_id) DO UPDATE SET
                    audio_path = excluded.audio_path,
                    reference_text = excluded.reference_text,
                    raw_transcript = excluded.raw_transcript,
                    accepted_text = excluded.accepted_text,
                    gate_status = excluded.gate_status,
                    searchable = excluded.searchable,
                    cer = excluded.cer,
                    audio_duration_seconds = excluded.audio_duration_seconds,
                    asr_latency_seconds = excluded.asr_latency_seconds,
                    stored_at_unix = excluded.stored_at_unix
                """,
                (
                    sample_id,
                    str(record["audio"]),
                    str(record["reference"]),
                    str(record["hypothesis"]),
                    str(record["accepted_text"]),
                    str(record["gate_status"]),
                    int(bool(record["searchable"])),
                    record.get("cer"),
                    float(record["duration_seconds"]),
                    float(record["latency_seconds"]),
                    time.time(),
                ),
            )
            self._connection.execute(
                "DELETE FROM audio_transcript_segments WHERE sample_id = ?", (sample_id,)
            )
            for order, segment in enumerate(record.get("segments", [])):
                self._connection.execute(
                    """
                    INSERT INTO audio_transcript_segments (
                        sample_id, segment_order, start_ms, end_ms, text,
                        quality_status, quality_reasons, searchable
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        sample_id,
                        order,
                        int(segment["start_ms"]),
                        int(segment["end_ms"]),
                        str(segment["text"]),
                        str(segment["quality_status"]),
                        ",".join(str(value) for value in segment["quality_reasons"]),
                        int(bool(segment["searchable"])),
                    ),
                )
            self._connection.execute("DELETE FROM audio_transcript_fts WHERE sample_id = ?", (sample_id,))
            if record["searchable"] and record["accepted_text"]:
                self._connection.execute(
                    "INSERT INTO audio_transcript_fts (sample_id, accepted_text) VALUES (?, ?)",
                    (sample_id, str(record["accepted_text"])),
                )
        return time.perf_counter() - started

    def verify(self, records: list[dict[str, Any]]) -> dict[str, Any]:
        expected = [row for row in records if not row.get("error") and not row.get("storage_error")]
        matches = 0
        for row in expected:
            stored = self._connection.execute(
                """
                SELECT raw_transcript, accepted_text, searchable
                FROM audio_transcriptions WHERE sample_id = ?
                """,
                (str(row["id"]),),
            ).fetchone()
            if stored == (
                str(row["hypothesis"]),
                str(row["accepted_text"]),
                int(bool(row["searchable"])),
            ):
                matches += 1
        transcript_count = int(
            self._connection.execute("SELECT COUNT(*) FROM audio_transcriptions").fetchone()[0]
        )
        segment_count = int(
            self._connection.execute("SELECT COUNT(*) FROM audio_transcript_segments").fetchone()[0]
        )
        fts_count = int(self._connection.execute("SELECT COUNT(*) FROM audio_transcript_fts").fetchone()[0])
        expected_searchable = sum(bool(row["searchable"]) for row in expected)
        return {
            "database": str(self.path),
            "attempted": sum(not row.get("error") for row in records),
            "succeeded": len(expected),
            "failed": sum(bool(row.get("storage_error")) for row in records),
            "integrity_matches": matches,
            "integrity_match_rate": matches / len(expected) if expected else None,
            "transcription_rows": transcript_count,
            "segment_rows": segment_count,
            "fts_rows": fts_count,
            "expected_fts_rows": expected_searchable,
        }

    def close(self) -> int:
        self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self._connection.close()
        return self.path.stat().st_size if self.path.exists() else 0
