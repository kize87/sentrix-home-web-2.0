"""Native Transformers runner for Qwen3-ASR and Fun-ASR-Nano checkpoints."""

from __future__ import annotations

import importlib.metadata
import time
from pathlib import Path
from typing import Any

from .asr_runner import AsrOutput, audio_duration_seconds
from .gate import Segment
from .text_metrics import clean_asr_text


class TransformersAsrRunner:
    """Load a local generation-based ASR checkpoint and transcribe sequentially."""

    def __init__(
        self,
        *,
        model_name: str,
        language: str,
        device: str,
        compute_type: str,
    ) -> None:
        try:
            import torch
            from opencc import OpenCC
            from transformers import (
                AutoConfig,
                AutoModelForMultimodalLM,
                AutoModelForSpeechSeq2Seq,
                AutoProcessor,
            )
        except ImportError as error:
            raise RuntimeError(
                "Transformers ASR 依赖未安装，请安装 audio_eval/requirements.txt"
            ) from error

        self.model_name = model_name
        self.language = language
        self.device = device
        self.compute_type = compute_type
        self.transformers_version = _package_version("transformers")
        self.torch_version = _package_version("torch")
        self._torch = torch
        self._simplify = OpenCC("t2s").convert
        self._dtype = _torch_dtype(torch, compute_type, device)

        started = time.perf_counter()
        config = AutoConfig.from_pretrained(model_name, trust_remote_code=False)
        self.model_type = str(config.model_type)
        if (
            self.model_type == "fun_asr_nano"
            and device.startswith("mps")
            and self._dtype == torch.float16
        ):
            raise ValueError(
                "Fun-ASR-Nano 在本机 MPS FP16 实测会退化为重复标点，请改用 --compute-type float32"
            )
        self._processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=False)
        if self.model_type == "qwen3_asr":
            model_class = AutoModelForMultimodalLM
        elif self.model_type == "fun_asr_nano":
            model_class = AutoModelForSpeechSeq2Seq
        else:
            raise ValueError(f"不支持的 Transformers ASR model_type: {self.model_type}")
        self._model = model_class.from_pretrained(
            model_name,
            trust_remote_code=False,
            dtype=self._dtype,
        ).to(device).eval()
        self.load_seconds = time.perf_counter() - started

    def configuration(self) -> dict[str, object]:
        return {
            "backend": "transformers_asr",
            "model_name": self.model_name,
            "model_type": self.model_type,
            "vad_model": "none",
            "punc_model": "native",
            "timestamps": "full_clip_only",
            "device": self.device,
            "compute_type": self.compute_type,
            "language": self.language,
            "max_new_tokens": 256,
            "text_normalization": "opencc_t2s",
            "transformers_version": self.transformers_version,
            "torch_version": self.torch_version,
        }

    def transcribe(self, audio_path: Path) -> AsrOutput:
        started = time.perf_counter()
        processor_kwargs: dict[str, Any] = {}
        if self.model_type == "fun_asr_nano":
            processor_kwargs = {
                "processor_kwargs": {
                    "return_tensors": "pt",
                    "audio_kwargs": {"sampling_rate": 16000},
                }
            }
        inputs = self._processor.apply_transcription_request(
            audio=str(audio_path),
            language=self.language or None,
            **processor_kwargs,
        ).to(self.device, self._dtype)
        with self._torch.inference_mode():
            output_ids = self._model.generate(
                **inputs,
                max_new_tokens=256,
                do_sample=False,
            )
        generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
        if self.model_type == "qwen3_asr":
            raw_text = self._processor.decode(
                generated_ids,
                return_format="transcription_only",
            )[0]
        else:
            raw_text = self._processor.batch_decode(
                generated_ids,
                skip_special_tokens=True,
            )[0]
        latency = time.perf_counter() - started
        normalized = self._simplify(str(raw_text or "").strip())
        cleaned_text = clean_asr_text(normalized)
        duration = audio_duration_seconds(audio_path)
        segments = ()
        if cleaned_text:
            segments = (
                Segment(
                    start_ms=0,
                    end_ms=max(1, round(duration * 1000)),
                    text=normalized,
                ),
            )
        return AsrOutput(
            raw_text=str(raw_text or ""),
            cleaned_text=cleaned_text,
            segments=segments,
            latency_seconds=latency,
        )


def _torch_dtype(torch: Any, compute_type: str, device: str) -> Any:
    normalized = compute_type.lower().replace("torch.", "")
    if normalized in {"float16", "fp16", "half"}:
        return torch.float16
    if normalized in {"bfloat16", "bf16"}:
        return torch.bfloat16
    if normalized in {"float32", "fp32", "int8"}:
        # Native Transformers checkpoints are not quantized by this runner.
        return torch.float32
    if normalized == "auto":
        return torch.float16 if device.startswith("mps") else torch.float32
    raise ValueError(f"不支持的 Transformers compute type: {compute_type}")


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"
