"""Optional trained SAR slick-like segmentation model.

Architecture adapted from Garcia et al., Oil Spill Segmentation Dataset,
licensed CC BY 4.0. The model is experimental and trained on Gulf of Mexico
tiles; outputs are model scores, not calibrated oil probabilities.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.warp import transform_geom
from scipy import ndimage

MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "oil_slick_tinyunet_v1.pt"
MODEL_VERSION = "waketrace-slick-screen-v1"


def detect_ai_slick_candidates(scene_path: str | Path, *, band: int = 1,
                               threshold: float = 0.5, maximum_candidates: int = 8) -> dict[str, Any]:
    """Run trained slick-like pixel segmentation on calibrated sigma0 dB data."""
    try:
        import torch
        import torch.nn.functional as F
        from ._tiny_unet import TinyUNet
    except ImportError as exc:
        raise RuntimeError("Install backend/ml-requirements.txt to enable the experimental SAR model.") from exc
    if not MODEL_PATH.is_file():
        raise RuntimeError("The trained SAR model checkpoint is missing.")

    torch.set_num_threads(min(4, torch.get_num_threads()))
    with rasterio.open(scene_path) as scene:
        if scene.crs is None or band < 1 or band > scene.count:
            raise ValueError("AI screening needs a georeferenced scene and an available SAR band.")
        values = scene.read(band).astype(np.float32)
        valid = np.isfinite(values) & (scene.read_masks(band) > 0)
        if not valid.any():
            valid = np.isfinite(values)
        if not valid.any():
            raise ValueError("SAR scene has no valid pixels for model screening.")
        lower, upper = np.percentile(values[valid], [2, 98])
        if upper <= lower:
            upper = lower + 1.0
        gray = np.clip((values - lower) / (upper - lower), 0.0, 1.0)
        gray[~valid] = 0.0
        height, width = gray.shape
        # The model is trained on 800x600 tiles at 400x300. Inference uses the
        # same scene-relative stretch and aspect-preserving normalized grid.
        target_w, target_h = 400, 300
        model_input = torch.from_numpy(gray).float()[None, None]
        model_input = F.interpolate(model_input, size=(target_h, target_w), mode="bilinear", align_corners=False)
        model_input = model_input.repeat(1, 3, 1, 1)

        model = TinyUNet(in_channels=3, num_classes=2, base_ch=8)
        checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
        model.load_state_dict(checkpoint["model_state"])
        model.eval()
        with torch.inference_mode():
            logits = model(model_input)
            score = torch.softmax(logits, dim=1)[0, 1].numpy()
        score = F.interpolate(torch.from_numpy(score)[None, None], size=(height, width), mode="bilinear", align_corners=False)[0, 0].numpy()
        mask = valid & (score >= threshold)
        # Suppress isolated speckle while retaining contiguous slick-like regions.
        mask = ndimage.binary_opening(mask, structure=np.ones((3, 3), dtype=bool))
        labels, _ = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
        sizes = np.bincount(labels.ravel())
        candidates = []
        for geometry, raw_label in shapes(labels.astype(np.int32), mask=labels > 0, transform=scene.transform, connectivity=8):
            label = int(raw_label)
            count = int(sizes[label])
            if count < max(25, int(height * width * 0.00002)):
                continue
            component = labels == label
            mean_score = float(np.mean(score[component]))
            candidates.append({
                "geometry": transform_geom(scene.crs, "EPSG:4326", geometry, precision=6),
                "pixel_count": count,
                "model_score": round(mean_score, 3),
                "explanation": "Experimental model score for a slick-like SAR texture; not a calibrated probability or confirmation of oil.",
            })
        candidates.sort(key=lambda item: (-item["model_score"], -item["pixel_count"]))
        return {
            "model": MODEL_VERSION,
            "training_domain": "173 Sentinel-1 tiles from Cantarell, Gulf of Mexico (Jan–Sep 2020)",
            "training_data": {
                "dataset": "Garcia et al. (2026), INPE Oil Spill Segmentation Dataset",
                "license": "CC BY 4.0",
                "url": "https://github.com/Garcia-INPE/oilspill-detection-dataset",
                "split_counts": {"train": 108, "validation": 43, "test": 22},
            },
            "held_out_test_metrics": {
                "slick_iou": 0.6179,
                "precision": 0.9300,
                "recall": 0.6480,
            },
            "threshold": threshold,
            "valid_pixels": int(valid.sum()),
            "positive_pixel_fraction": round(float(mask.sum() / max(valid.sum(), 1)), 5),
            "candidates": candidates[:maximum_candidates],
            "limitations": "Experimental Gulf of Mexico model. It has not been independently validated on Mauritius or all Sentinel-1 acquisition conditions. Scores are not calibrated probabilities; analyst review and independent AIS/ocean evidence are required.",
        }
