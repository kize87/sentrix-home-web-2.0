"""Construct optional ASR backends without importing unused runtimes."""

from __future__ import annotations

from .asr_runner import AsrRunner


def create_runner(
    *,
    backend: str,
    model_name: str,
    vad_model: str,
    punc_model: str,
    device: str,
    batch_size_s: int,
    language: str,
    compute_type: str,
) -> AsrRunner:
    if backend == "funasr":
        from .funasr_runner import FunAsrRunner

        return FunAsrRunner(
            model_name=model_name,
            vad_model=vad_model,
            punc_model=punc_model,
            device=device,
            batch_size_s=batch_size_s,
        )
    if backend == "mlx-whisper":
        from .mlx_whisper_runner import MlxWhisperRunner

        return MlxWhisperRunner(model_name=model_name, language=language)
    if backend == "faster-whisper":
        from .faster_whisper_runner import FasterWhisperRunner

        return FasterWhisperRunner(
            model_name=model_name,
            language=language,
            device=device,
            compute_type=compute_type,
        )
    if backend == "transformers-asr":
        from .transformers_asr_runner import TransformersAsrRunner

        return TransformersAsrRunner(
            model_name=model_name,
            language=language,
            device=device,
            compute_type=compute_type,
        )
    raise ValueError(f"不支持的 ASR backend: {backend}")
