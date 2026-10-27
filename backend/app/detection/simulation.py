"""Controlled synthetic slick exercise on a copy of a real Sentinel-1 scene.

This deliberately darkens a small SAR patch so the existing review screen has
something known to find. It is a pipeline demonstration, not a physical oil
signature model or a validation of real spill detection.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import cos, radians, sin
from pathlib import Path
import tempfile
from typing import Any

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from rasterio.warp import transform

from app.detection.sar import DetectionInputError, detect_sar_dark_features


def make_offline_practice_scene(seed: int = 42) -> tuple[bytes, list[float]]:
    """Build a deterministic, explicitly synthetic SAR-like raster for offline practice."""
    west, south, east, north = 57.2, -20.8, 58.2, -20.0
    # Use a finer synthetic grid so a close-up map view stays legible instead
    # of enlarging visibly blocky radar pixels during the demo.
    width = height = 1024
    rng = np.random.default_rng(seed)
    rows, columns = np.indices((height, width), dtype=np.float32)
    speckle = rng.normal(0.0, 0.45, size=(height, width)).astype(np.float32)
    texture = (0.25 * np.sin(rows * 0.12) + 0.18 * np.sin((columns + rows) * 0.06)).astype(np.float32)
    backscatter = (-16.0 + speckle + texture).astype(np.float32)

    profile = {
        "driver": "GTiff", "height": height, "width": width, "count": 1,
        "dtype": "float32", "crs": "EPSG:4326",
        "transform": from_bounds(west, south, east, north, width, height),
    }
    with MemoryFile() as memory_file:
        with memory_file.open(**profile) as raster:
            raster.write(backscatter, 1)
        return memory_file.read(), [west, south, east, north]


def _move_by_metres(lon: float, lat: float, east_m: float, north_m: float) -> tuple[float, float]:
    moved_lon = lon + east_m / (111_320.0 * max(0.1, cos(radians(lat))))
    moved_lat = lat + north_m / 110_574.0
    return moved_lon, moved_lat


def _particle_zone(lon: float, lat: float, seed: int, count: int = 20) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    points = [_move_by_metres(lon, lat, float(east), float(north))
              for east, north in rng.normal(0.0, 350.0, size=(count, 2))]
    unique = sorted(set(points))

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[float, float]] = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    ring = [[x, y] for x, y in lower[:-1] + upper[:-1]]
    if len(ring) < 3:
        radius_lon = 0.005 / max(0.1, cos(radians(lat)))
        radius_lat = 0.005
        ring = [[lon - radius_lon, lat - radius_lat], [lon + radius_lon, lat - radius_lat],
                [lon + radius_lon, lat + radius_lat], [lon - radius_lon, lat + radius_lat]]
    ring.append(ring[0][:])
    return {"type": "Polygon", "coordinates": [ring]}


def _geometry_center(geometry: dict[str, Any]) -> tuple[float, float] | None:
    """Approximate the center of a small detected GeoJSON component."""
    positions: list[tuple[float, float]] = []

    def collect(value: Any) -> None:
        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and all(isinstance(part, (int, float)) for part in value[:2]):
                positions.append((float(value[0]), float(value[1])))
            else:
                for child in value:
                    collect(child)

    collect(geometry.get("coordinates"))
    if not positions:
        return None
    return sum(point[0] for point in positions) / len(positions), sum(point[1] for point in positions) / len(positions)


def _distance_metres(first: tuple[float, float], second: tuple[float, float]) -> float:
    """Approximate local distance between GeoJSON [longitude, latitude] points."""
    mean_latitude = radians((first[1] + second[1]) / 2)
    east = (first[0] - second[0]) * 111_320.0 * cos(mean_latitude)
    north = (first[1] - second[1]) * 110_574.0
    return float(np.hypot(east, north))


def _patch_particle_offsets(
    geometry: dict[str, Any],
    center: tuple[float, float],
    *,
    count: int = 24,
    seed: int = 42,
) -> list[tuple[float, float]]:
    """Place synthetic particles around the detected slick rim and across its interior."""
    coordinates: list[tuple[float, float]] = []

    def collect(value: Any) -> None:
        if (isinstance(value, (list, tuple)) and len(value) >= 2
                and all(isinstance(part, (int, float)) for part in value[:2])):
            coordinates.append((float(value[0]), float(value[1])))
        elif isinstance(value, (list, tuple)):
            for child in value:
                collect(child)

    collect(geometry.get("coordinates"))
    if not coordinates:
        return [(0.0, 0.0)] * count
    latitude_factor = cos(radians(center[1]))
    radius_x = max(abs(lon - center[0]) * 111_320.0 * latitude_factor
                   for lon, _ in coordinates)
    radius_y = max(abs(lat - center[1]) * 110_574.0 for _, lat in coordinates)
    radius_x = max(radius_x, 1.0)
    radius_y = max(radius_y, 1.0)
    edge_count = min(count, max(12, round(count * 2 / 3)))
    interior_count = count - edge_count
    pixel_offsets: list[tuple[float, float]] = []
    for index in range(edge_count):
        angle = 2 * np.pi * index / edge_count
        wobble = 1 + 0.12 * np.sin(3 * angle + seed) + 0.06 * np.sin(5 * angle - seed)
        pixel_offsets.append((radius_x * 0.94 * wobble * np.cos(angle),
                              radius_y * 0.94 * wobble * np.sin(angle)))
    golden_angle = np.pi * (3 - np.sqrt(5))
    for index in range(interior_count):
        angle = index * golden_angle + seed * 0.1
        radius = 0.82 * np.sqrt((index + 0.5) / interior_count)
        pixel_offsets.append((radius_x * radius * np.cos(angle),
                              radius_y * radius * np.sin(angle)))

    return pixel_offsets


def _inject_dark_patch(geotiff: bytes, lon: float, lat: float, seed: int) -> tuple[bytes, dict[str, Any]]:
    """Return a modified in-memory GeoTIFF and the patch's raster pixel settings."""
    try:
        with MemoryFile(geotiff) as source_mem:
            with source_mem.open() as source:
                data = source.read()
                if source.crs is None or source.count != 1:
                    raise ValueError("The selected scene must be a single-band georeferenced SAR image.")
                xs, ys = transform("EPSG:4326", source.crs, [lon], [lat])
                row, col = source.index(xs[0], ys[0])
                width, height = source.width, source.height
                rx = max(6, min(25, int(width * 0.02)))
                ry = max(5, min(14, int(height * 0.011)))
                if row - ry < 2 or row + ry >= height - 2 or col - rx < 2 or col + rx >= width - 2:
                    raise ValueError("Choose a point farther inside the displayed scene, not on its edge.")

                band = data[0].astype(np.float32, copy=True)
                valid = (source.read_masks(1) > 0) & np.isfinite(band)
                if not valid.any():
                    valid = np.isfinite(band)
                yy, xx = np.ogrid[row - ry:row + ry + 1, col - rx:col + rx + 1]
                angle = np.arctan2(yy - row, xx - col)
                radius = (xx - col) ** 2 / (rx * rx) + (yy - row) ** 2 / (ry * ry)
                wobble = 1.0 + 0.12 * np.sin(3 * angle + seed) + 0.06 * np.sin(5 * angle - seed)
                patch = radius <= wobble
                local_valid = valid[row - ry:row + ry + 1, col - rx:col + rx + 1]
                patch &= local_valid
                if int(patch.sum()) < 25:
                    raise ValueError("The chosen point has too little usable radar data. Click another ocean point.")

                scene_median = float(np.median(band[valid]))
                target_db = scene_median - 9.0
                local = band[row - ry:row + ry + 1, col - rx:col + rx + 1]
                local[patch] = target_db
                data[0] = band

                profile = source.profile.copy()
                with MemoryFile() as output_mem:
                    with output_mem.open(**profile) as output:
                        output.write(data)
                        output.write_mask(valid.astype(np.uint8) * 255)
                    result = output_mem.read()
    except (rasterio.errors.RasterioError, OSError) as exc:
        raise ValueError("Could not prepare a simulated radar patch: " + str(exc)) from exc

    return result, {"center_pixel": [int(col), int(row)], "patch_width_pixels": int(rx * 2 + 1),
                    "patch_height_pixels": int(ry * 2 + 1), "injected_backscatter_db": round(target_db, 2),
                    "seed": seed}


def run_simulated_spill(
    geotiff: bytes,
    *,
    source_lon: float,
    source_lat: float,
    acquired_at: str,
    scene_source: dict[str, Any],
    polarization: str,
    seed: int = 42,
) -> dict[str, Any]:
    """Make a synthetic slick, screen it, and rank generated AIS tracks."""
    if not (-180 <= source_lon <= 180 and -90 <= source_lat <= 90):
        raise ValueError("Choose a valid map position for the simulated release point.")
    try:
        observed = datetime.fromisoformat(acquired_at.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise ValueError("The selected scene has no usable UTC acquisition time.") from exc
    if observed.tzinfo is None:
        raise ValueError("The selected scene time must include UTC information.")
    observed = observed.astimezone(timezone.utc)

    duration_hours = 6
    offline_practice = scene_source.get("provider") == "WakeTrace synthetic practice generator"
    eastward_current_m_s = 0.36 if offline_practice else 0.12
    northward_current_m_s = 0.12 if offline_practice else 0.03
    elapsed = duration_hours * 3600
    slick_lon, slick_lat = _move_by_metres(
        source_lon, source_lat,
        eastward_current_m_s * elapsed,
        northward_current_m_s * elapsed,
    )
    modified_geotiff, injection_settings = _inject_dark_patch(geotiff, slick_lon, slick_lat, seed)
    start = observed - timedelta(hours=duration_hours)
    animation_frames = []
    for frame_index in range(duration_hours * 2 + 1):
        fraction = frame_index / (duration_hours * 2)
        frame_time = start + timedelta(seconds=elapsed * fraction)
        animation_frames.append({
            "time": frame_time.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "positions": [],
        })

    with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as temporary:
        temporary.write(modified_geotiff)
        temporary_path = Path(temporary.name)
    try:
        detection = detect_sar_dark_features(
            temporary_path,
            acquired_at=observed.isoformat().replace("+00:00", "Z"),
            source=scene_source,
            polarization=polarization,
        )
    except DetectionInputError as exc:
        raise ValueError(str(exc)) from exc
    finally:
        temporary_path.unlink(missing_ok=True)

    nearby_features = []
    for index, candidate in enumerate(detection["candidates"]):
        center = _geometry_center(candidate["geometry"])
        if center:
            nearby_features.append((_distance_metres(center, (slick_lon, slick_lat)), index, center))
    nearest_feature = min(nearby_features, default=None, key=lambda item: item[0])
    # Real scenes can contain much larger dark land/coast features than the planted patch.
    # Use the screened candidate near the known synthetic patch, not the globally largest one.
    detected_center = nearest_feature[2] if nearest_feature and nearest_feature[0] <= 8_000 else None
    detected_geometry = (detection["candidates"][nearest_feature[1]]["geometry"]
                         if detected_center and nearest_feature else None)
    particle_offsets = _patch_particle_offsets(
        detected_geometry or {}, detected_center or (slick_lon, slick_lat), count=24, seed=seed,
    )
    motion_origin = (_move_by_metres(
        detected_center[0], detected_center[1],
        -eastward_current_m_s * elapsed, -northward_current_m_s * elapsed,
    ) if detected_center else (source_lon, source_lat))
    for frame_index, frame in enumerate(animation_frames):
        fraction = frame_index / (duration_hours * 2)
        frame_center = _move_by_metres(
            motion_origin[0], motion_origin[1],
            eastward_current_m_s * elapsed * fraction,
            northward_current_m_s * elapsed * fraction,
        )
        frame["positions"] = [
            [lon, lat]
            for east_offset, north_offset in particle_offsets
            for lon, lat in [_move_by_metres(
                frame_center[0], frame_center[1],
                east_offset * fraction, north_offset * fraction,
            )]
        ]
    estimated_source = (_move_by_metres(detected_center[0], detected_center[1],
                                        -eastward_current_m_s * elapsed,
                                        -northward_current_m_s * elapsed)
                       if detected_center else None)
    drift = {
        "model": "WakeTrace synthetic constant-current particle demonstration",
        "release_window": {"start": start.isoformat().replace("+00:00", "Z"),
                           "end": observed.isoformat().replace("+00:00", "Z")},
        "origin_zone": _particle_zone(estimated_source[0], estimated_source[1], seed) if estimated_source else None,
        "animation": {
            "direction": "forward synthetic particle demonstration",
            "frames": animation_frames if estimated_source else [],
            "particle_count": len(particle_offsets) if estimated_source else 0,
        },
        "ensemble_size": 20 if estimated_source else 0,
        "uncertainty_note": (
            "Synthetic exercise only. Twenty illustrative points surround the estimated origin. "
            "The slick was moved with a fixed artificial current and calm-wind assumption for six hours; these are not observed "
            "winds or currents and this result is not a real spill estimate."
            if estimated_source else
            "Synthetic exercise only. No origin estimate was made because the screen returned no candidate. "
            "The fixed artificial current is not observed environmental data."
        ),
        "provenance": {
            "input_sources": [{"provider": "synthetic simulation", "dataset": "fixed artificial wind and current",
                               "description": "calm wind (0 m/s); current east "
                               + format(eastward_current_m_s, ".2f") + " m/s and north "
                               + format(northward_current_m_s, ".2f") + " m/s; all invented for this exercise."}],
            "settings": {"direction": "forward injection plus synthetic reverse estimate",
                         "duration_hours": duration_hours, "ensemble_size": 20 if estimated_source else 0,
                         "wind_east_m_s": 0.0, "wind_north_m_s": 0.0,
                         "current_east_m_s": eastward_current_m_s, "current_north_m_s": northward_current_m_s,
                         "random_seed": seed, "method": "simple constant-velocity geometry; not OpenDrift"},
        },
    }

    candidates = []
    if estimated_source:
        vessel_tracks = []
        routes = (
            ("SIM-VESSEL-01", [(-9_000, 8_000), (18_000, -16_000)]),
            ("SIM-VESSEL-02", [(-9_000, 12_000), (18_000, 21_000)]),
        )
        for vessel_id, (start_offset, end_offset) in routes:
            for hour in range(duration_hours + 1):
                fraction = hour / duration_hours
                east_offset = start_offset[0] + (end_offset[0] - start_offset[0]) * fraction
                north_offset = start_offset[1] + (end_offset[1] - start_offset[1]) * fraction
                longitude, latitude = _move_by_metres(source_lon, source_lat, east_offset, north_offset)
                timestamp = start + timedelta(hours=hour)
                vessel_tracks.append({
                    "vessel_id": vessel_id,
                    "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
                    "longitude": longitude,
                    "latitude": latitude,
                })
        from app.vessels.matching import match_vessel_candidates
        matched = match_vessel_candidates(
            {"drift": drift}, vessel_tracks,
            ais_source={"provider": "synthetic generator", "dataset": "invented AIS tracks",
                        "description": "Both vessel identities and all positions are fictional."},
            search_radius_km=25.0,
        )
        candidates = matched["vessel_candidates"]
        for candidate in candidates:
            candidate["data_quality_note"] = "Synthetic track generated for demonstration; not real AIS data."

    real_background = scene_source.get("provider") == "Copernicus Data Space"
    detection["note"] = (
        "SIMULATED SPILL: an artificial dark patch was added to a temporary copy of the real Sentinel-1 image. "
        "The screen found dark radar features; it cannot verify oil."
        if real_background else
        "OFFLINE PRACTICE ONLY: this radar-like background and dark patch were generated for the exercise; neither is satellite data. "
        "The screen demonstrates dark-feature screening and cannot verify oil."
    )
    return {
        "modified_geotiff": modified_geotiff,
        "detection": detection,
        "drift": drift,
        "vessel_candidates": candidates,
        "simulation": {
            "label": "SIMULATED SPILL · REAL SATELLITE BACKGROUND" if real_background else "OFFLINE PRACTICE · SYNTHETIC RADAR",
            "background_label": "Real Sentinel-1" if real_background else "Synthetic radar-style",
            "source_point": {"type": "Point", "coordinates": [source_lon, source_lat]},
            "slick_point": {"type": "Point", "coordinates": [slick_lon, slick_lat]},
            "truth_vessel_id": "SIM-VESSEL-01",
            "screened_patch_candidate_index": nearest_feature[1] if detected_center and nearest_feature else None,
            "screened_patch_distance_m": round(nearest_feature[0], 1) if detected_center and nearest_feature else None,
            "injection": injection_settings,
            "note": (
                "Synthetic slick and vessel tracks on real Sentinel-1 imagery. The patch is a simplified pixel edit, not a physical oil signature."
                if real_background else
                "Synthetic practice only: the radar-like background, slick, currents, and vessel tracks are generated. No satellite or incident data is used."
            ),
        },
    }
