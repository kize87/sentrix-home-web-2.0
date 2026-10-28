from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
import soundfile as sf

from prepare_alimeeting import _speaker_overlap_seconds, extract_mono_clip, parse_textgrid


class TextGridTests(unittest.TestCase):
    def test_parse_multiple_tiers_and_praat_quotes(self) -> None:
        content = '''File type = "ooTextFile"
Object class = "TextGrid"
item []:
    item [1]:
        class = "IntervalTier"
        name = "N_SPK1"
        intervals [1]:
            xmin = 1.25
            xmax = 2.5
            text = "今天""很好""。"
    item [2]:
        class = "IntervalTier"
        name = "N_SPK2"
        intervals [1]:
            xmin = 3
            xmax = 4
            text = ""
        intervals [2]:
            xmin = 4
            xmax = 5
            text = "第二句"
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.TextGrid"
            path.write_text(content, encoding="utf-8")
            rows = parse_textgrid(path)

        self.assertEqual(
            rows,
            [
                ("N_SPK1", 1, 1.25, 2.5, '今天"很好"。'),
                ("N_SPK2", 3, 4.0, 5.0, "第二句"),
            ],
        )

    def test_other_speaker_overlap_uses_union_without_double_counting(self) -> None:
        intervals = [
            ("A", 1, 1.0, 5.0, "目标"),
            ("B", 2, 2.0, 3.5, "重叠一"),
            ("C", 3, 3.0, 4.0, "重叠二"),
            ("A", 4, 3.0, 4.5, "同一说话人不算"),
        ]
        self.assertAlmostEqual(_speaker_overlap_seconds("A", 1.0, 5.0, intervals), 2.0)


class AudioExtractionTests(unittest.TestCase):
    def test_extract_selected_channel_as_mono(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "stereo.wav"
            target = root / "mono.wav"
            with wave.open(str(source), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(4)
                frames = b"".join(
                    left.to_bytes(2, "little", signed=True)
                    + right.to_bytes(2, "little", signed=True)
                    for left, right in [(1, 11), (2, 12), (3, 13), (4, 14)]
                )
                output.writeframes(frames)

            metadata = extract_mono_clip(
                source, target, start_seconds=0.25, end_seconds=0.75, channel=1
            )
            with wave.open(str(target), "rb") as audio:
                values = [
                    int.from_bytes(audio.readframes(1), "little", signed=True)
                    for _ in range(audio.getnframes())
                ]

        self.assertEqual(values, [12, 13])
        self.assertEqual(metadata["source_channels"], 2)
        self.assertEqual(metadata["selected_channel"], 1)

    def test_extract_channel_from_wavex_used_by_far_field_audio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "array.wav"
            target = root / "mono.wav"
            samples = np.array(
                [[1, 11, 21], [2, 12, 22], [3, 13, 23], [4, 14, 24]], dtype=np.int16
            )
            sf.write(source, samples, 4, format="WAVEX", subtype="PCM_16")

            metadata = extract_mono_clip(
                source, target, start_seconds=0.25, end_seconds=0.75, channel=2
            )
            values, sample_rate = sf.read(target, dtype="int16")

        self.assertEqual(values.tolist(), [22, 23])
        self.assertEqual(sample_rate, 4)
        self.assertEqual(metadata["source_channels"], 3)
        self.assertEqual(metadata["selected_channel"], 2)


if __name__ == "__main__":
    unittest.main()
