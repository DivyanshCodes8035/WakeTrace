"""Estimate a possible slick origin by backtracking an OpenOil ensemble.

OpenDrift is imported lazily so API and non-drift code can run without the
optional scientific stack installed. Callers provide configured forcing
readers and provenance for those readers; this module never downloads or
fabricates environmental data.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from importlib.metadata import version as package_version
from statistics import median
from typing import Any, Mapping, Sequence


class DriftInputError(ValueError):
    """Raised when slick, time, forcing, or simulation inputs are invalid."""


def _utc_datetime(value: str | datetime) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise DriftInputError("observed_at must be an ISO 8601 timestamp") from exc
    if value.tzinfo is None or value.utcoffset() is None:
        raise DriftInputError("observed_at must include a UTC offset")
    if value.utcoffset() != timedelta(0):
        raise DriftInputError("observed_at must be in UTC")
    return value.astimezone(timezone.utc)


def _validate_geometry(geometry: Mapping[str, Any]) -> None:
    kind = geometry.get("type")
    if kind not in {"Polygon", "MultiPolygon"}:
        raise DriftInputError("slick geometry must be a GeoJSON Polygon or MultiPolygon")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        raise DriftInputError("slick geometry must contain coordinates")

    def check_position(position: Any) -> None:
        if (not isinstance(position, (list, tuple)) or len(position) < 2
                or not all(isinstance(v, (int, float)) for v in position[:2])):
            raise DriftInputError("GeoJSON positions must be [longitude, latitude]")
        lon, lat = position[:2]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise DriftInputError("slick coordinates are outside longitude/latitude bounds")

    def check_rings(rings: Any) -> None:
        if not isinstance(rings, list) or not rings:
            raise DriftInputError("each polygon must contain at least one linear ring")
        for ring in rings:
            if not isinstance(ring, list) or len(ring) < 4:
                raise DriftInputError("GeoJSON polygon rings need at least four positions")
            for position in ring:
                check_position(position)

    if kind == "Polygon":
        check_rings(coordinates)
    else:
        for polygon in coordinates:
            check_rings(polygon)


def _convex_hull(points: Sequence[tuple[float, float]]) -> list[list[float]]:
    """Return a closed GeoJSON-order convex hull without a geometry dependency."""
    unique = sorted(set(points))
    if len(unique) <= 1:
        return [[unique[0][0], unique[0][1]]] if unique else []

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
    hull = lower[:-1] + upper[:-1]
    if len(hull) == 2:
        return [[hull[0][0], hull[0][1]], [hull[1][0], hull[1][1]]]
    ring = [[lon, lat] for lon, lat in hull]
    ring.append(ring[0][:])
    return ring


def _trajectory_animation(result: Any, *, max_particles: int = 96, max_frames: int = 72) -> dict[str, Any]:
    """Return a compact, time-ordered sample of the modelled particle paths."""
    lons = result["lon"].transpose("time", "trajectory").values
    lats = result["lat"].transpose("time", "trajectory").values
    raw_times = result["time"].values
    if lons.ndim != 2 or lats.shape != lons.shape or len(raw_times) != lons.shape[0]:
        return {"direction": "forward replay of backward hindcast", "frames": [], "particle_count": 0}

    time_count, trajectory_count = lons.shape
    frame_count = min(time_count, max_frames)
    frame_indices = sorted({round(index * (time_count - 1) / max(frame_count - 1, 1))
                            for index in range(frame_count)}, reverse=True)
    particle_count = min(trajectory_count, max_particles)
    particle_indices = [round(index * (trajectory_count - 1) / max(particle_count - 1, 1))
                        for index in range(particle_count)]
    frames = []
    for frame_index in frame_indices:
        raw_time = raw_times[frame_index]
        try:
            timestamp = datetime.fromtimestamp(
                int(raw_time.astype("datetime64[s]").astype(int)), timezone.utc
            ).isoformat(timespec="seconds").replace("+00:00", "Z")
        except (AttributeError, TypeError, ValueError, OverflowError):
            timestamp = str(raw_time).replace(" ", "T")
            if not timestamp.endswith("Z"):
                timestamp += "Z"
        positions = []
        for particle_index in particle_indices:
            lon, lat = float(lons[frame_index, particle_index]), float(lats[frame_index, particle_index])
            positions.append([lon, lat] if lon == lon and lat == lat and abs(lon) <= 180 and abs(lat) <= 90 else None)
        frames.append({"time": timestamp, "positions": positions})
    return {
        "direction": "forward replay of backward hindcast",
        "frames": frames,
        "particle_count": particle_count,
    }


def estimate_origin(
    slick_geometry: Mapping[str, Any],
    observed_at: str | datetime,
    *,
    readers: Sequence[Any],
    input_sources: Sequence[Mapping[str, Any]],
    backtrack_hours: int = 24,
    ensemble_size: int = 1000,
    time_step_seconds: int = 900,
    oil_type: str = "GENERIC BUNKER C",
    random_seed: int = 42,
    loglevel: int = 50,
) -> dict[str, Any]:
    """Backtrack oil particles seeded in a slick and return a case ``drift``.

    ``input_sources`` should identify each forcing dataset (for example, its
    provider, dataset/version, and file or service URL). ``readers`` must be
    OpenDrift-compatible readers covering the complete requested time range.
    The release window is the configured search horizon, not an independently
    inferred spill duration.
    """
    _validate_geometry(slick_geometry)
    observed = _utc_datetime(observed_at)
    if not readers:
        raise DriftInputError("at least one wind/current forcing reader is required")
    if not input_sources:
        raise DriftInputError("input_sources must identify the forcing data used")
    if backtrack_hours <= 0 or ensemble_size <= 0 or time_step_seconds <= 0:
        raise DriftInputError("backtrack hours, ensemble size, and time step must be positive")
    if time_step_seconds * 2 > backtrack_hours * 3600:
        raise DriftInputError("time step must allow at least two backward steps")

    try:
        from opendrift.models.openoil import OpenOil
    except ImportError as exc:
        raise RuntimeError(
            "OpenDrift is not installed. Install backend/requirements.txt before running drift."
        ) from exc

    model = OpenOil(loglevel=loglevel, seed=random_seed)
    model.add_reader(list(readers))
    feature = {
        "type": "Feature",
        "geometry": dict(slick_geometry),
        "properties": {
            "time": observed.isoformat().replace("+00:00", "Z"),
            "number": ensemble_size,
            "oil_type": oil_type,
        },
    }
    model.seed_from_geojson(json.dumps(feature))
    model.run(
        duration=timedelta(hours=backtrack_hours),
        time_step=-time_step_seconds,
        time_step_output=time_step_seconds,
    )

    # OpenDrift results use ``lon``/``lat`` dimensions by time and trajectory.
    # Select the oldest output, i.e. the end of the backward integration.
    result = model.result
    lons = result["lon"].isel(time=-1).values.ravel()
    lats = result["lat"].isel(time=-1).values.ravel()
    origins = [
        (float(lon), float(lat))
        for lon, lat in zip(lons, lats)
        if lon == lon and lat == lat and abs(lon) <= 180 and abs(lat) <= 90
    ]
    if not origins:
        raise RuntimeError("OpenDrift returned no valid particle positions at the search horizon")
    animation = _trajectory_animation(result)

    hull = _convex_hull(origins)
    if len(hull) == 1:
        origin_zone = {"type": "Point", "coordinates": hull[0]}
    elif len(hull) == 2:
        origin_zone = {"type": "LineString", "coordinates": hull}
    else:
        origin_zone = {"type": "Polygon", "coordinates": [hull]}

    start = observed - timedelta(hours=backtrack_hours)
    settings = {
        "direction": "backward",
        "observed_at": observed.isoformat().replace("+00:00", "Z"),
        "backtrack_hours": backtrack_hours,
        "time_step_seconds": time_step_seconds,
        "ensemble_size_requested": ensemble_size,
        "ensemble_size_returned": len(origins),
        "oil_type_assumption": oil_type,
        "random_seed": random_seed,
        "initialization": "particles seeded within detected slick GeoJSON",
        "slick_geometry": dict(slick_geometry),
    }
    return {
        "model": f"OpenDrift OpenOil {package_version('opendrift')}",
        "release_window": {
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": observed.isoformat().replace("+00:00", "Z"),
        },
        "origin_zone": origin_zone,
        "animation": animation,
        "ensemble_size": len(origins),
        "uncertainty_note": (
            "Possible origin area from backward particle endpoints under the supplied forcing. "
            "The release window is the configured search horizon, not a measured release time; "
            "wind/current error, slick delineation, oil type, and unmodeled processes can widen "
            "the true uncertainty. This is an investigation lead and does not identify a source vessel."
        ),
        "provenance": {
            "input_sources": [dict(source) for source in input_sources],
            "settings": settings,
        },
    }


def simulate_forward_scenario(
    slick_geometry: Mapping[str, Any],
    start_at: str | datetime,
    *,
    readers: Sequence[Any],
    forecast_hours: int = 36,
    ensemble_size: int = 100,
    wind_drift_factor: float = 0.02,
    current_uncertainty: float = 0.1,
    random_seed: int = 42,
    loglevel: int = 50,
) -> dict[str, Any]:
    """Run an OpenOil forward ensemble with explicit forecast-forcing readers."""
    _validate_geometry(slick_geometry)
    start = _utc_datetime(start_at)
    if not readers or not 6 <= forecast_hours <= 72 or ensemble_size < 10:
        raise DriftInputError("Forward planning needs readers, a 6–72 hour horizon, and at least 10 particles.")
    if not 0.005 <= wind_drift_factor <= 0.05 or not 0 <= current_uncertainty <= 1:
        raise DriftInputError("Windage or current uncertainty is outside the supported scenario range.")
    try:
        from opendrift.models.openoil import OpenOil
    except ImportError as exc:
        raise RuntimeError("OpenDrift is not installed. Install backend/requirements.txt before planning coastal exposure.") from exc

    model = OpenOil(loglevel=loglevel, seed=random_seed)
    model.add_reader(list(readers))
    model.set_config("seed:wind_drift_factor", wind_drift_factor)
    model.set_config("drift:current_uncertainty", current_uncertainty)
    # The forecast readers currently provide wind and current, not Stokes drift.
    model.set_config("drift:stokes_drift", False)
    model.set_config("general:coastline_action", "stranding")
    feature = {
        "type": "Feature",
        "geometry": dict(slick_geometry),
        "properties": {
            "time": start.isoformat().replace("+00:00", "Z"),
            "number": ensemble_size,
            "oil_type": "GENERIC BUNKER C",
            "wind_drift_factor": wind_drift_factor,
        },
    }
    model.seed_from_geojson(json.dumps(feature))
    model.run(
        duration=timedelta(hours=forecast_hours),
        time_step=900,
        time_step_output=3600,
    )

    result = model.result
    lons = result["lon"].transpose("time", "trajectory").values
    lats = result["lat"].transpose("time", "trajectory").values
    raw_times = result["time"].values
    if lons.ndim != 2 or lats.shape != lons.shape or len(raw_times) != lons.shape[0]:
        raise RuntimeError("OpenDrift returned an invalid forward ensemble shape.")

    times: list[str] = []
    for raw_time in raw_times:
        try:
            timestamp = datetime.fromtimestamp(
                int(raw_time.astype("datetime64[s]").astype(int)), timezone.utc
            ).isoformat(timespec="seconds").replace("+00:00", "Z")
        except (AttributeError, TypeError, ValueError, OverflowError):
            timestamp = str(raw_time).replace(" ", "T")
            if not timestamp.endswith("Z"):
                timestamp += "Z"
        times.append(timestamp)

    particle_tracks = []
    for particle_index in range(lons.shape[1]):
        track = []
        for frame_index, timestamp in enumerate(times):
            lon, lat = float(lons[frame_index, particle_index]), float(lats[frame_index, particle_index])
            if math.isfinite(lon) and math.isfinite(lat) and abs(lon) <= 180 and abs(lat) <= 90:
                track.append({"time": timestamp, "coordinates": [lon, lat]})
        if len(track) >= 2:
            particle_tracks.append(track)
    if not particle_tracks:
        raise RuntimeError("OpenDrift returned no usable particle tracks for this forecast scenario.")

    center_track = []
    for frame_index, timestamp in enumerate(times):
        valid = [
            (float(lons[frame_index, particle]), float(lats[frame_index, particle]))
            for particle in range(lons.shape[1])
            if math.isfinite(float(lons[frame_index, particle])) and math.isfinite(float(lats[frame_index, particle]))
            and abs(float(lons[frame_index, particle])) <= 180 and abs(float(lats[frame_index, particle])) <= 90
        ]
        if valid:
            center_track.append({
                "time": timestamp,
                "coordinates": [median(p[0] for p in valid), median(p[1] for p in valid)],
            })

    return {
        "track": center_track,
        "particle_tracks": particle_tracks,
        "particle_count_requested": ensemble_size,
        "particle_count_returned": len(particle_tracks),
        "settings": {
            "model": f"OpenDrift OpenOil {package_version('opendrift')}",
            "start_at": start.isoformat().replace("+00:00", "Z"),
            "forecast_hours": forecast_hours,
            "time_step_seconds": 900,
            "time_step_output_seconds": 3600,
            "wind_drift_factor": wind_drift_factor,
            "current_uncertainty_mps": current_uncertainty,
            "stokes_drift": False,
            "coastline_action": "stranding",
            "oil_type_assumption": "GENERIC BUNKER C",
            "random_seed": random_seed,
            "initialization": "particles seeded within selected possible slick GeoJSON",
        },
    }
