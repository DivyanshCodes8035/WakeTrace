"""Conservative dark-feature screening for calibrated Sentinel-1 SAR GeoTIFFs.

This is a review aid, not an oil classifier. Low radar backscatter can also come
from low wind, wave fronts, rain, ship wakes, or other look-alike features.
"""
from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite, log2
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.warp import transform_geom
from scipy import ndimage


class DetectionInputError(ValueError):
    """Raised when the SAR scene or its metadata is not usable."""


def _utc_text(value: str) -> str:
    if not isinstance(value, str):
        raise DetectionInputError("acquired_at must be an ISO 8601 timestamp with UTC offset")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DetectionInputError("acquired_at is not a valid ISO 8601 timestamp") from exc
    if timestamp.tzinfo is None:
        raise DetectionInputError("acquired_at must include UTC offset or Z")
    return timestamp.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def detect_sar_dark_features(
    scene_path: str | Path,
    *,
    acquired_at: str,
    source: dict[str, Any],
    band: int = 1,
    polarization: str = "VV",
    water_mask_path: str | Path | None = None,
    dark_percentile: float = 15.0,
    minimum_contrast_db: float = 3.0,
    minimum_component_pixels: int = 25,
    maximum_candidates: int = 10,
) -> dict[str, Any]:
    """Screen one calibrated SAR backscatter band for connected dark regions.

    The GeoTIFF band must contain calibrated sigma0 backscatter in dB. If a
    same-grid water mask is supplied, non-water pixels are excluded. Returns
    a case-contract detection object with the leading geometry and ranked
    candidate geometries in WGS84 GeoJSON coordinate order.
    """
    if not isinstance(source, dict) or not source:
        raise DetectionInputError("source metadata is required to record imagery provenance")
    if not source.get("provider") or not source.get("dataset"):
        raise DetectionInputError("source metadata needs the actual provider and dataset/product identifier")
    if band < 1 or minimum_component_pixels < 1 or maximum_candidates < 1:
        raise DetectionInputError("band, minimum_component_pixels, and maximum_candidates must be positive")
    if not 0 < dark_percentile < 50:
        raise DetectionInputError("dark_percentile must be between 0 and 50")
    if not isfinite(minimum_contrast_db) or minimum_contrast_db <= 0:
        raise DetectionInputError("minimum_contrast_db must be positive")

    observed_at = _utc_text(acquired_at)
    scene_path = Path(scene_path)
    try:
        scene = rasterio.open(scene_path)
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise DetectionInputError("could not open SAR GeoTIFF: " + str(exc)) from exc

    with scene:
        if scene.crs is None:
            raise DetectionInputError("SAR GeoTIFF needs a coordinate reference system")
        if band > scene.count:
            raise DetectionInputError("requested band is not present in SAR GeoTIFF")
        if scene.width * scene.height > 50_000_000:
            raise DetectionInputError("scene exceeds the 50-million-pixel screening limit; crop it first")
        backscatter = scene.read(band).astype(np.float32)
        finite = np.isfinite(backscatter)
        valid = (scene.read_masks(band) > 0) & finite
        # Copernicus FLOAT32 GeoTIFFs can contain finite pixels while the
        # generated GDAL mask is empty; the evalscript writes NaN outside data.
        if not valid.any():
            valid = finite
        if not valid.any():
            raise DetectionInputError("SAR band has no valid pixels")

        water_mask_used = False
        if water_mask_path is not None:
            try:
                with rasterio.open(water_mask_path) as water_source:
                    if (water_source.shape != scene.shape or water_source.transform != scene.transform
                            or water_source.crs != scene.crs):
                        raise DetectionInputError("water mask must match SAR scene dimensions, grid, and CRS")
                    valid &= water_source.read(1) > 0
                    water_mask_used = True
            except (OSError, rasterio.errors.RasterioError) as exc:
                raise DetectionInputError("could not open water mask: " + str(exc)) from exc
        if not valid.any():
            raise DetectionInputError("no valid water pixels remain after masking")

        scene_values = backscatter[valid]
        scene_median_db = float(np.median(scene_values))
        percentile_db = float(np.percentile(scene_values, dark_percentile))
        threshold_db = min(percentile_db, scene_median_db - minimum_contrast_db)
        dark_mask = valid & (backscatter <= threshold_db)
        labels, component_count = ndimage.label(dark_mask, structure=np.ones((3, 3), dtype=np.uint8))
        component_sizes = np.bincount(labels.ravel())
        component_slices = ndimage.find_objects(labels)

        candidates: list[dict[str, Any]] = []
        for geometry, raw_label in shapes(labels.astype(np.int32), mask=labels > 0, transform=scene.transform, connectivity=8):
            label = int(raw_label)
            pixel_count = int(component_sizes[label])
            if pixel_count < minimum_component_pixels:
                continue
            region_slice = component_slices[label - 1]
            local_labels = labels[region_slice]
            region_values = backscatter[region_slice][local_labels == label]
            region_median_db = float(np.median(region_values))
            contrast_db = max(0.0, scene_median_db - region_median_db)
            contrast_score = min(70.0, contrast_db / 6.0 * 70.0)
            area_score = min(30.0, 10.0 * log2(pixel_count / minimum_component_pixels + 1.0))
            screening_score = round(contrast_score + area_score, 1)
            wgs84_geometry = transform_geom(scene.crs, "EPSG:4326", geometry, precision=6)
            candidates.append({
                "geometry": wgs84_geometry,
                "screening_score": screening_score,
                "pixel_count": pixel_count,
                "median_backscatter_db": round(region_median_db, 2),
                "contrast_from_scene_median_db": round(contrast_db, 2),
                "explanation": (
                    "Connected dark SAR region with " + str(pixel_count) + " pixels and "
                    + format(contrast_db, ".1f") + " dB contrast from the valid-scene median. "
                    "This is a look-alike screening score, not a probability that the feature is oil."
                ),
            })

    candidates.sort(key=lambda item: (-item["screening_score"], -item["pixel_count"]))
    candidates = candidates[:maximum_candidates]
    note = (
        "Automated SAR dark-feature screening only. Low wind, wave fronts, rain, ship wakes, "
        "and other look-alikes can appear dark; a trained analyst and independent evidence "
        "must review each candidate. Screening scores are not calibrated probabilities."
    )
    if not water_mask_used:
        note += " No water mask was supplied, so land and coastal dark features may also be flagged."

    return {
        "source": "Sentinel-1 SAR dark-feature screen",
        "acquired_at": observed_at,
        "confidence": None,
        "geometry": candidates[0]["geometry"] if candidates else None,
        "candidates": candidates,
        "note": note,
        "provenance": {
            "input_sources": [source],
            "settings": {
                "algorithm": "scene-relative dark backscatter threshold plus connected-component screening",
                "backscatter_units_expected": "calibrated sigma0 dB",
                "polarization": polarization,
                "band": band,
                "dark_percentile": dark_percentile,
                "minimum_contrast_db": minimum_contrast_db,
                "minimum_component_pixels": minimum_component_pixels,
                "maximum_candidates": maximum_candidates,
                "water_mask_used": water_mask_used,
                "valid_pixel_count": int(valid.sum()),
                "dark_threshold_db": round(threshold_db, 2),
                "scene_median_db": round(scene_median_db, 2),
                "connected_components_before_filtering": int(component_count),
                "candidates_returned": len(candidates),
            },
        },
    }
