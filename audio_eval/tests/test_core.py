from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace

from evalkit.asr_runner import AsrOutput
from evalkit.faster_whisper_runner import _segments as faster_whisper_segments
from evalkit.gate import AudioQualityGate, QualityStatus, Segment
from evalkit.mlx_whisper_runner import _segments as whisper_segments
from evalkit.storage import TranscriptStore
from evalkit.summary import summarize
from evalkit.text_metrics import cer_counts, clean_asr_text, normalize_for_cer
from evaluate import _evaluate_one


class TextMetricTests(unittest.TestCase):
    def test_normalization_removes_control_tags_spaces_and_punctuation(self) -> None:
        self.assertEqual(clean_asr_text(" <|zh|> 今天， 去公园。 "), "今天, 去公园。")
        self.assertEqual(normalize_for_cer(" <|zh|> 今天， 去公园。 "), "今天去公园")

    def test_character_error_rate(self) -> None:
        counts = cer_counts("今天去公园", "今天去花园")
        self.assertEqual(counts.edits, 1)
        self.assertEqual(counts.reference_characters, 5)
        self.assertAlmostEqual(counts.rate or 0.0, 0.2)


class GateTests(unittest.TestCase):
    def test_low_confidence_is_not_searchable(self) -> None:
        result = AudioQualityGate().evaluate((Segment(0, 1800, "今天去公园", confidence_raw=0.1),))
        self.assertFalse(result.searchable)
        self.assertEqual(result.decisions[0].status, QualityStatus.UNCERTAIN)
        self.assertIn("low_confidence", result.decisions[0].reasons)

    def test_missing_score_is_visible(self) -> None:
        result = AudioQualityGate().evaluate((Segment(0, 1800, "今天去公园"),))
        self.assertTrue(result.searchable)
        self.assertEqual(result.decisions[0].reasons, ("no_acoustic_score",))


class MlxWhisperAdapterTests(unittest.TestCase):
    def test_maps_whisper_scores_to_gate_segment(self) -> None:
        segments = whisper_segments(
            {
                "text": " 今天去公园。",
                "segments": [
                    {
                        "start": 0.2,
                        "end": 1.7,
                        "text": " 今天去公园。",
                        "avg_logprob": -0.2,
                        "no_speech_prob": 0.1,
                    }
                ],
            },
            duration_seconds=2.0,
        )

        self.assertEqual(len(segments), 1)
        self.assertEqual((segments[0].start_ms, segments[0].end_ms), (200, 1700))
        self.assertAlmostEqual(segments[0].confidence_raw or 0.0, 0.81873075)
        self.assertAlmostEqual(segments[0].speech_probability or 0.0, 0.9)

    def test_uses_full_duration_when_whisper_has_text_without_segments(self) -> None:
        segments = whisper_segments({"text": "测试文本", "segments": []}, 1.25)
        self.assertEqual(segments, (Segment(0, 1250, "测试文本"),))

    def test_applies_injected_traditional_to_simplified_normalizer(self) -> None:
        segments = whisper_segments(
            {"text": "幫我們宣傳", "segments": []},
            1.0,
            simplify=lambda text: text.replace("幫", "帮").replace("們", "们").replace("傳", "传"),
        )
        self.assertEqual(segments[0].text, "帮我们宣传")


class FasterWhisperAdapterTests(unittest.TestCase):
    def test_maps_faster_whisper_scores_to_gate_segment(self) -> None:
        segments = faster_whisper_segments(
            [
                SimpleNamespace(
                    start=0.2,
                    end=1.7,
                    text=" 今天去公园。",
                    avg_logprob=-0.2,
                    no_speech_prob=0.1,
                )
            ]
        )

        self.assertEqual(len(segments), 1)
        self.assertEqual((segments[0].start_ms, segments[0].end_ms), (200, 1700))
        self.assertAlmostEqual(segments[0].confidence_raw or 0.0, 0.81873075)
        self.assertAlmostEqual(segments[0].speech_probability or 0.0, 0.9)

    def test_applies_injected_traditional_to_simplified_normalizer(self) -> None:
        segments = faster_whisper_segments(
            [
                SimpleNamespace(
                    start=0.0,
                    end=1.0,
                    text="幫我們宣傳",
                    avg_logprob=-0.1,
                    no_speech_prob=0.0,
                )
            ],
            simplify=lambda text: text.replace("幫", "帮").replace("們", "们").replace("傳", "传"),
        )
        self.assertEqual(segments[0].text, "帮我们宣传")


class SummaryTests(unittest.TestCase):
    def test_false_accept_metrics(self) -> None:
        records = [
            {
                "cer": 0.1,
                "searchable": True,
                "edits": 1,
                "reference_characters": 10,
                "accepted_edits": 1,
                "accepted_reference_characters": 10,
                "duration_seconds": 2.0,
                "latency_seconds": 1.0,
                "rtf": 0.5,
                "segments": [],
                "error": "",
            },
            {
                "cer": 0.5,
                "searchable": True,
                "edits": 5,
                "reference_characters": 10,
                "accepted_edits": 5,
                "accepted_reference_characters": 10,
                "duration_seconds": 2.0,
                "latency_seconds": 1.0,
                "rtf": 0.5,
                "segments": [],
                "error": "",
            },
        ]
        result = summarize(records, bad_cer_threshold=0.2, model_load_seconds=3.0)
        self.assertEqual(result["quality"]["corpus_cer"], 0.3)
        self.assertEqual(result["quality"]["searchable_projection_cer"], 0.3)
        self.assertEqual(result["quality"]["false_accept_rate_among_bad"], 1.0)
        self.assertEqual(result["quality"]["pollution_rate_among_searchable"], 0.5)


class EvaluationPipelineTests(unittest.TestCase):
    def test_wav_to_asr_gate_and_metrics(self) -> None:
        class FakeRunner:
            def transcribe(self, audio_path: Path) -> AsrOutput:
                self.audio_path = audio_path
                return AsrOutput(
                    raw_text="今天去花园。",
                    cleaned_text="今天去花园。",
                    segments=(Segment(0, 1000, "今天去花园。", confidence_raw=0.9),),
                    latency_seconds=0.25,
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio_path = root / "sample.wav"
            with wave.open(str(audio_path), "wb") as target:
                target.setnchannels(1)
                target.setsampwidth(2)
                target.setframerate(16000)
                target.writeframes(b"\x00\x00" * 16000)

            runner = FakeRunner()
            result = _evaluate_one(
                {"id": "sample-1", "audio": "sample.wav", "text": "今天去公园"},
                manifest_path=root / "manifest.jsonl",
                runner=runner,  # type: ignore[arg-type]
                gate=AudioQualityGate(),
            )

        self.assertEqual(runner.audio_path, audio_path.resolve())
        self.assertEqual(result["cer"], 0.2)
        self.assertEqual(result["accepted_projection_cer"], 0.2)
        self.assertEqual(result["accepted_edits"], 1)
        self.assertTrue(result["searchable"])
        self.assertEqual(result["gate_status"], "accepted")
        self.assertEqual(result["rtf"], 0.25)


class StorageTests(unittest.TestCase):
    def test_transcript_segments_and_search_text_are_persisted(self) -> None:
        record = {
            "id": "sample-1",
            "audio": "/tmp/sample.wav",
            "reference": "今天去公园",
            "hypothesis": "今天去花园",
            "accepted_text": "今天去花园",
            "gate_status": "accepted",
            "searchable": True,
            "cer": 0.2,
            "duration_seconds": 1.0,
            "latency_seconds": 0.25,
            "segments": [
                {
                    "start_ms": 0,
                    "end_ms": 1000,
                    "text": "今天去花园",
                    "quality_status": "accepted",
                    "quality_reasons": [],
                    "searchable": True,
                }
            ],
            "error": "",
            "storage_error": "",
        }
        with tempfile.TemporaryDirectory() as directory:
            store = TranscriptStore(Path(directory) / "audio.sqlite3")
            self.assertGreaterEqual(store.write(record), 0.0)
            result = store.verify([record])
            database_bytes = store.close()

        self.assertEqual(result["integrity_match_rate"], 1.0)
        self.assertEqual(result["transcription_rows"], 1)
        self.assertEqual(result["segment_rows"], 1)
        self.assertEqual(result["fts_rows"], 1)
        self.assertGreater(database_bytes, 0)


if __name__ == "__main__":
    unittest.main()
