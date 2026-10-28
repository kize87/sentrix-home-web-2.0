"""Lightweight process, PyTorch MPS and MLX memory snapshots."""

from __future__ import annotations

from typing import Any


class ResourceTracker:
    def __init__(self, requested_device: str) -> None:
        import psutil

        self._process = psutil.Process()
        self._torch = None
        self._mlx = None
        self.requested_device = requested_device
        self.mps_active = False
        self.mlx_active = requested_device.startswith("mlx")
        if self.mlx_active:
            import mlx.core as mx

            self._mlx = mx
            mx.reset_peak_memory()
        elif requested_device.startswith("mps"):
            import torch

            self._torch = torch
            self.mps_active = torch.backends.mps.is_available()
        self._stage_peaks: dict[str, dict[str, float]] = {}

    def sample(self, stage: str) -> None:
        rss_mb = self._process.memory_info().rss / (1024 * 1024)
        allocated_mb = 0.0
        driver_mb = 0.0
        mlx_active_mb = 0.0
        mlx_cache_mb = 0.0
        mlx_peak_mb = 0.0
        if self.mps_active and self._torch is not None:
            allocated_mb = self._torch.mps.current_allocated_memory() / (1024 * 1024)
            driver_mb = self._torch.mps.driver_allocated_memory() / (1024 * 1024)
        if self.mlx_active and self._mlx is not None:
            mlx_active_mb = self._mlx.get_active_memory() / (1024 * 1024)
            mlx_cache_mb = self._mlx.get_cache_memory() / (1024 * 1024)
            mlx_peak_mb = self._mlx.get_peak_memory() / (1024 * 1024)
        peak = self._stage_peaks.setdefault(
            stage,
            {
                "rss_mb": 0.0,
                "mps_allocated_mb": 0.0,
                "mps_driver_mb": 0.0,
                "mlx_active_mb": 0.0,
                "mlx_cache_mb": 0.0,
                "mlx_peak_mb": 0.0,
            },
        )
        peak["rss_mb"] = max(peak["rss_mb"], rss_mb)
        peak["mps_allocated_mb"] = max(peak["mps_allocated_mb"], allocated_mb)
        peak["mps_driver_mb"] = max(peak["mps_driver_mb"], driver_mb)
        peak["mlx_active_mb"] = max(peak["mlx_active_mb"], mlx_active_mb)
        peak["mlx_cache_mb"] = max(peak["mlx_cache_mb"], mlx_cache_mb)
        peak["mlx_peak_mb"] = max(peak["mlx_peak_mb"], mlx_peak_mb)

    def summary(self) -> dict[str, Any]:
        all_stages = list(self._stage_peaks.values())
        return {
            "requested_device": self.requested_device,
            "accelerator": (
                "apple_mlx"
                if self.mlx_active
                else "apple_mps"
                if self.mps_active
                else "none_cpu_only"
            ),
            "mps_active": self.mps_active,
            "mlx_active": self.mlx_active,
            "peak_observed_rss_mb": max((row["rss_mb"] for row in all_stages), default=0.0),
            "peak_observed_mps_allocated_mb": max(
                (row["mps_allocated_mb"] for row in all_stages), default=0.0
            ),
            "peak_observed_mps_driver_mb": max((row["mps_driver_mb"] for row in all_stages), default=0.0),
            "peak_observed_mlx_active_mb": max(
                (row["mlx_active_mb"] for row in all_stages), default=0.0
            ),
            "peak_observed_mlx_cache_mb": max(
                (row["mlx_cache_mb"] for row in all_stages), default=0.0
            ),
            "peak_observed_mlx_peak_mb": max(
                (row["mlx_peak_mb"] for row in all_stages), default=0.0
            ),
            "stage_snapshots": self._stage_peaks,
        }
