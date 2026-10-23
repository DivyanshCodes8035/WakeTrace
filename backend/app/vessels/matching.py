"""Explainable AIS screening against a WakeTrace drift origin and release window.

This is a coarse candidate-ranking aid. It is not a probability of responsibility
and does not compare AIS tracks to time-varying particle trajectories.
"""
from __future__ import annotations

from bisect import bisect_left
from copy import deepcopy
from datetime import datetime, timezone
from math import asin, cos, isfinite, radians, sin, sqrt
from typing import Any, Iterable

EARTH_RADIUS_KM = 6371.0088
SPATIAL_WEIGHT = 0.75
TEMPORAL_WEIGHT = 0.25
MAX_INTERPOLATION_GAP_SECONDS = 30 * 60
MAX_TRACK_GAP_SECONDS = 2 * 60 * 60
MAX_PLAUSIBLE_SPEED_KNOTS = 60.0
INTERPOLATION_STEPS = 20


class VesselMatchingInputError(ValueError):
    """Raised when a case or AIS observation cannot be used for matching."""


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise VesselMatchingInputError(label + " must be an ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise VesselMatchingInputError(label + " is not a valid ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise VesselMatchingInputError(label + " must include a UTC offset or Z")
    return parsed.astimezone(timezone.utc)


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _position(observation: dict[str, Any]) -> tuple[float, float]:
    try:
        lon = float(observation["longitude"])
        lat = float(observation["latitude"])
    except (KeyError, TypeError, ValueError) as exc:
        raise VesselMatchingInputError("AIS observations need numeric longitude and latitude") from exc
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise VesselMatchingInputError("AIS coordinates are out of range; use [longitude, latitude]")
    return lon, lat


def _position_accuracy(value: Any) -> float | None:
    if value is None:
        return None
    try:
        accuracy = float(value)
    except (TypeError, ValueError) as exc:
        raise VesselMatchingInputError("position_accuracy_m must be a non-negative number") from exc
    if not isfinite(accuracy) or accuracy < 0:
        raise VesselMatchingInputError("position_accuracy_m must be a non-negative number")
    return accuracy


def _geometry_parts(
    geometry: dict[str, Any],
) -> tuple[list[tuple[float, float]], list[list[list[tuple[float, float]]]]]:
    """Return coordinates and polygon groups from common GeoJSON geometries."""
    if not isinstance(geometry, dict):
        raise VesselMatchingInputError("drift.origin_zone must be a GeoJSON geometry")
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")

    if kind == "Feature":
        return _geometry_parts(geometry.get("geometry"))
    if kind == "FeatureCollection":
        points: list[tuple[float, float]] = []
        polygons: list[list[list[tuple[float, float]]]] = []
        for feature in geometry.get("features", []):
            feature_points, feature_polygons = _geometry_parts(feature)
            points.extend(feature_points)
            polygons.extend(feature_polygons)
        return points, polygons
    if kind == "GeometryCollection":
        points = []
        polygons = []
        for item in geometry.get("geometries", []):
            item_points, item_polygons = _geometry_parts(item)
            points.extend(item_points)
            polygons.extend(item_polygons)
        return points, polygons

    def coord(value: Any) -> tuple[float, float]:
        if not isinstance(value, (list, tuple)) or len(value) < 2:
            raise VesselMatchingInputError("origin_zone coordinates must use [longitude, latitude]")
        try:
            lon, lat = float(value[0]), float(value[1])
        except (TypeError, ValueError) as exc:
            raise VesselMatchingInputError("origin_zone coordinates must be numeric") from exc
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise VesselMatchingInputError("origin_zone coordinates are out of range")
        return lon, lat

    points: list[tuple[float, float]] = []
    polygons: list[list[list[tuple[float, float]]]] = []
    if kind == "Point":
        points.append(coord(coordinates))
    elif kind == "MultiPoint":
        points.extend(coord(item) for item in coordinates)
    elif kind == "LineString":
        points.extend(coord(item) for item in coordinates)
    elif kind == "MultiLineString":
        for line in coordinates:
            points.extend(coord(item) for item in line)
    elif kind == "Polygon":
        polygon: list[list[tuple[float, float]]] = []
        for ring in coordinates:
            parsed_ring = [coord(item) for item in ring]
            points.extend(parsed_ring)
            polygon.append(parsed_ring)
        polygons.append(polygon)
    elif kind == "MultiPolygon":
        for polygon in coordinates:
            parsed_polygon: list[list[tuple[float, float]]] = []
            for ring in polygon:
                parsed_ring = [coord(item) for item in ring]
                points.extend(parsed_ring)
                parsed_polygon.append(parsed_ring)
            polygons.append(parsed_polygon)
    else:
        raise VesselMatchingInputError("unsupported origin_zone GeoJSON type: " + str(kind))
    if not points:
        raise VesselMatchingInputError("drift.origin_zone contains no coordinates")
    return points, polygons


def _inside_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    lon, lat = point
    inside = False
    if len(ring) < 3:
        return False
    previous = ring[-1]
    for current in ring:
        lon_a, lat_a = previous
        lon_b, lat_b = current
        crosses = (lat_a > lat) != (lat_b > lat)
        if crosses:
            crossing_lon = (lon_b - lon_a) * (lat - lat_a) / (lat_b - lat_a) + lon_a
            if lon < crossing_lon:
                inside = not inside
        previous = current
    return inside


def _inside_polygons(
    point: tuple[float, float], polygons: list[list[list[tuple[float, float]]]]
) -> bool:
    for rings in polygons:
        if rings and _inside_ring(point, rings[0]) and not any(
            _inside_ring(point, hole) for hole in rings[1:]
        ):
            return True
    return False


def _haversine_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lon1, lat1 = map(radians, first)
    lon2, lat2 = map(radians, second)
    delta_lon = lon2 - lon1
    delta_lat = lat2 - lat1
    value = sin(delta_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(delta_lon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * asin(min(1.0, sqrt(value)))


def _segment_distance_km(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    """Approximate point-to-segment distance in a local equirectangular plane."""
    lon, lat = point
    scale_x = cos(radians(lat)) * 111.195
    start_x = ((start[0] - lon + 180) % 360 - 180) * scale_x
    end_x = ((end[0] - lon + 180) % 360 - 180) * scale_x
    start_y = (start[1] - lat) * 111.195
    end_y = (end[1] - lat) * 111.195
    dx, dy = end_x - start_x, end_y - start_y
    denominator = dx * dx + dy * dy
    fraction = 0 if denominator == 0 else max(0, min(1, -(start_x * dx + start_y * dy) / denominator))
    nearest = (start_x + fraction * dx, start_y + fraction * dy)
    return sqrt(nearest[0] ** 2 + nearest[1] ** 2)


def _distance_to_origin_km(
    point: tuple[float, float],
    geometry_points: list[tuple[float, float]],
    polygons: list[list[list[tuple[float, float]]]],
    geometry: dict[str, Any],
) -> float:
    if polygons and _inside_polygons(point, polygons):
        return 0.0

    distances = [_haversine_km(point, item) for item in geometry_points]
    lines: list[list[tuple[float, float]]] = []

    def collect_lines(item: dict[str, Any]) -> None:
        kind = item.get("type")
        if kind == "Feature":
            collect_lines(item.get("geometry") or {})
        elif kind == "FeatureCollection":
            for feature in item.get("features", []):
                collect_lines(feature)
        elif kind == "GeometryCollection":
            for child in item.get("geometries", []):
                collect_lines(child)
        elif kind == "LineString":
            lines.append([tuple(coord[:2]) for coord in item.get("coordinates", [])])
        elif kind == "MultiLineString":
            lines.extend([[tuple(coord[:2]) for coord in line] for line in item.get("coordinates", [])])
        elif kind == "Polygon":
            lines.extend([[tuple(coord[:2]) for coord in ring] for ring in item.get("coordinates", [])])
        elif kind == "MultiPolygon":
            for polygon in item.get("coordinates", []):
                lines.extend([[tuple(coord[:2]) for coord in ring] for ring in polygon])

    collect_lines(geometry)
    for line in lines:
        distances.extend(_segment_distance_km(point, a, b) for a, b in zip(line, line[1:]))
    return min(distances)


def _coverage_score(times: list[datetime], start: datetime, end: datetime) -> float:
    if len(times) < 2 or end <= start:
        return 0.0
    overlap_start = max(min(times), start)
    overlap_end = min(max(times), end)
    if overlap_end <= overlap_start:
        return 0.0
    return min(100.0, (overlap_end - overlap_start).total_seconds() / (end - start).total_seconds() * 100)


def _interpolate_position(
    first: tuple[datetime, float, float, Any],
    second: tuple[datetime, float, float, Any],
    fraction: float,
) -> tuple[datetime, float, float, float | None]:
    first_time, first_lon, first_lat, first_accuracy = first
    second_time, second_lon, second_lat, second_accuracy = second
    delta_lon = (second_lon - first_lon + 180) % 360 - 180
    longitude = (first_lon + delta_lon * fraction + 180) % 360 - 180
    latitude = first_lat + (second_lat - first_lat) * fraction
    timestamp = first_time + (second_time - first_time) * fraction
    accuracy = None
    if first_accuracy is not None and second_accuracy is not None:
        accuracy = first_accuracy + (second_accuracy - first_accuracy) * fraction
    return timestamp, longitude, latitude, accuracy


def _track_geometry(positions: list[tuple[datetime, float, float, Any]]) -> dict[str, Any]:
    """Draw only plausible segments across short gaps; preserve isolated fixes as points."""
    lines: list[list[list[float]]] = []
    isolated: list[list[float]] = []
    current: list[list[float]] = []
    previous = None
    for position in positions:
        point = [position[1], position[2]]
        if previous is None:
            current = [point]
            previous = position
            continue
        gap = (position[0] - previous[0]).total_seconds()
        speed_knots = _haversine_km((previous[1], previous[2]), (position[1], position[2])) / max(gap / 3600, 1e-9) / 1.852
        if 0 < gap <= MAX_TRACK_GAP_SECONDS and speed_knots <= MAX_PLAUSIBLE_SPEED_KNOTS:
            current.append(point)
        else:
            if len(current) >= 2:
                lines.append(current)
            else:
                isolated.extend(current)
            current = [point]
        previous = position
    if len(current) >= 2:
        lines.append(current)
    else:
        isolated.extend(current)
    geometries = []
    if lines:
        geometries.append({"type": "MultiLineString", "coordinates": lines})
    if isolated:
        geometries.append({"type": "MultiPoint", "coordinates": isolated})
    if len(geometries) == 1:
        return geometries[0]
    return {"type": "GeometryCollection", "geometries": geometries}


def match_vessel_candidates(
    case: dict[str, Any],
    observations: Iterable[dict[str, Any]],
    *,
    ais_source: dict[str, Any] | None,
    search_radius_km: float = 25.0,
    max_candidates: int = 20,
) -> dict[str, Any]:
    """Return a copied case with candidates screened from supplied AIS observations.

    Each observation needs vessel_id, timestamp, longitude, and latitude. A
    supplied particle animation is used as a time-varying corridor. Older cases
    without particle positions retain the static origin-zone comparison.
    """
    if search_radius_km <= 0 or max_candidates <= 0:
        raise VesselMatchingInputError("search_radius_km and max_candidates must be positive")

    drift = case.get("drift") or {}
    release_window = drift.get("release_window") or {}
    if not release_window.get("start") or not release_window.get("end"):
        raise VesselMatchingInputError("case needs drift.release_window.start and end")
    start = _parse_time(release_window["start"], "release_window.start")
    end = _parse_time(release_window["end"], "release_window.end")
    if end <= start:
        raise VesselMatchingInputError("release_window.end must be after start")
    origin_zone = drift.get("origin_zone")
    if origin_zone is None:
        raise VesselMatchingInputError("case needs drift.origin_zone before AIS matching")
    origin_points, polygons = _geometry_parts(origin_zone)
    model_frames = []
    animation = drift.get("animation")
    animation_frames = animation.get("frames", []) if isinstance(animation, dict) else []
    for frame in (animation_frames if isinstance(animation_frames, list) else []):
        if not isinstance(frame, dict):
            continue
        try:
            frame_time = _parse_time(frame.get("time"), "drift animation time")
            particles = [tuple(map(float, point[:2])) for point in frame.get("positions", [])
                         if isinstance(point, (list, tuple)) and len(point) >= 2
                         and all(isfinite(float(value)) for value in point[:2])
                         and abs(float(point[0])) <= 180 and abs(float(point[1])) <= 90]
            if particles:
                model_frames.append((frame_time, particles))
        except (TypeError, ValueError, VesselMatchingInputError):
            continue
    model_frames.sort(key=lambda item: item[0])
    model_frame_times = [item[0] for item in model_frames]

    grouped: dict[str, list[tuple[datetime, float, float, Any]]] = {}
    observation_list = list(observations)
    if observation_list and (not isinstance(ais_source, dict) or not ais_source):
        raise VesselMatchingInputError("ais_source metadata is required when AIS observations are supplied")
    total_observations = 0
    for observation in observation_list:
        total_observations += 1
        if not isinstance(observation, dict):
            raise VesselMatchingInputError("each AIS observation must be an object")
        vessel_id = str(observation.get("vessel_id", "")).strip()
        if not vessel_id:
            raise VesselMatchingInputError("each AIS observation needs a vessel_id")
        timestamp = _parse_time(observation.get("timestamp"), "AIS timestamp")
        longitude, latitude = _position(observation)
        accuracy = _position_accuracy(observation.get("position_accuracy_m"))
        if start <= timestamp <= end:
            grouped.setdefault(vessel_id, []).append(
                (timestamp, longitude, latitude, accuracy)
            )

    candidates: list[dict[str, Any]] = []
    in_window_count = sum(len(items) for items in grouped.values())
    for vessel_id, positions in grouped.items():
        positions.sort(key=lambda item: item[0])
        distances = [
            _distance_to_origin_km((lon, lat), origin_points, polygons, origin_zone)
            for _, lon, lat, _ in positions
        ]
        closest_index = min(range(len(distances)), key=distances.__getitem__)
        closest_km = distances[closest_index]
        closest_time = positions[closest_index][0]
        closest_accuracy = positions[closest_index][3]
        closest_method = "recorded AIS position"
        interpolated_segments = 0
        for first, second in zip(positions, positions[1:]):
            gap_seconds = (second[0] - first[0]).total_seconds()
            if not 0 < gap_seconds <= MAX_INTERPOLATION_GAP_SECONDS:
                continue
            speed_knots = _haversine_km((first[1], first[2]), (second[1], second[2])) / (gap_seconds / 3600) / 1.852
            if speed_knots > MAX_PLAUSIBLE_SPEED_KNOTS:
                continue
            interpolated_segments += 1
            for step in range(1, INTERPOLATION_STEPS):
                sample = _interpolate_position(first, second, step / INTERPOLATION_STEPS)
                distance = _distance_to_origin_km((sample[1], sample[2]), origin_points, polygons, origin_zone)
                if distance < closest_km:
                    closest_km = distance
                    closest_time = sample[0]
                    closest_accuracy = sample[3]
                    closest_method = "short-gap interpolated position"
        corridor_closest_km: float | None = None
        corridor_closest_time: datetime | None = None
        if model_frames:
            for timestamp, longitude, latitude, _ in positions:
                insert_at = bisect_left(model_frame_times, timestamp)
                nearby_indices = [index for index in (insert_at - 1, insert_at) if 0 <= index < len(model_frames)]
                if not nearby_indices:
                    continue
                nearest_index = min(nearby_indices, key=lambda index: abs((model_frame_times[index] - timestamp).total_seconds()))
                frame_time, particles = model_frames[nearest_index]
                if abs((frame_time - timestamp).total_seconds()) > 3600:
                    continue
                distance = min(_haversine_km((longitude, latitude), particle) for particle in particles)
                if corridor_closest_km is None or distance < corridor_closest_km:
                    corridor_closest_km = distance
                    corridor_closest_time = timestamp
        if closest_km > search_radius_km and (corridor_closest_km is None or corridor_closest_km > search_radius_km):
            continue

        proximity_score = max(0.0, 100.0 * (1.0 - closest_km / search_radius_km))
        time_coverage_score = _coverage_score([item[0] for item in positions], start, end)
        corridor_score = (max(0.0, 100.0 * (1.0 - corridor_closest_km / search_radius_km))
                          if corridor_closest_km is not None else None)
        priority_score = (
            0.55 * proximity_score + 0.25 * time_coverage_score + 0.20 * corridor_score
            if corridor_score is not None
            else SPATIAL_WEIGHT * proximity_score + TEMPORAL_WEIGHT * time_coverage_score
        )
        track = _track_geometry(positions)
        track_positions = [
            {"time": _utc_text(timestamp), "coordinates": [longitude, latitude]}
            for timestamp, longitude, latitude, _ in positions
        ]

        accuracy_count = sum(item[3] is not None for item in positions)
        quality_note = (
            str(len(positions)) + " in-window AIS position(s); "
            + str(accuracy_count) + " report position accuracy. "
            + "AIS gaps are not evidence that a vessel was absent."
        )
        if len(positions) == 1:
            quality_note += " A single position cannot establish route continuity."
        quality_note += (
            " Short gaps were interpolated only up to 30 minutes; the map breaks route lines after "
            "2-hour gaps or implausible jumps."
        )
        explanation = (
            "AIS observations fall inside the drift release window. The closest recorded or short-gap interpolated position "
            + "was "
            + format(closest_km, ".1f")
            + " km from the modeled origin zone at " + _utc_text(closest_time)
            + " (" + closest_method + "). Short gaps are interpolated only when they are at most 30 minutes "
            + "and the implied speed is at most 60 knots."
            + (" The closest time-matched model-path distance was " + format(corridor_closest_km, ".1f") + " km."
               if corridor_closest_km is not None else " No time-matched particle path was available.")
            + " The score is a screening priority, not a probability of responsibility."
        )
        candidates.append(
            {
                "vessel_id": vessel_id,
                "track": track,
                "track_positions": track_positions,
                "track_timestamps": [_utc_text(item[0]) for item in positions],
                "position_accuracy_m": [item[3] for item in positions],
                "closest_approach": {
                    "distance_km": round(closest_km, 2),
                    "timestamp": _utc_text(closest_time),
                    "method": closest_method,
                    "position_accuracy_m": round(closest_accuracy, 1) if closest_accuracy is not None else None,
                },
                "priority_score": round(priority_score, 1),
                "score_breakdown": {
                    "origin_proximity": {
                        "score": round(proximity_score, 1),
                        "weight": 0.55 if corridor_score is not None else SPATIAL_WEIGHT,
                        "closest_approach_km": round(closest_km, 2),
                    },
                    "release_window_coverage": {
                        "score": round(time_coverage_score, 1),
                        "weight": 0.25 if corridor_score is not None else TEMPORAL_WEIGHT,
                        "meaning": "span between first and last reported positions; not continuous AIS coverage",
                    },
                    "particle_corridor_proximity": {
                        "score": round(corridor_score, 1) if corridor_score is not None else None,
                        "weight": 0.20 if corridor_score is not None else 0.0,
                        "closest_approach_km": round(corridor_closest_km, 2) if corridor_closest_km is not None else None,
                        "timestamp": _utc_text(corridor_closest_time) if corridor_closest_time is not None else None,
                    },
                },
                "data_quality_note": quality_note,
                "interpolated_segments_checked": interpolated_segments,
                "explanation": explanation,
            }
        )

    candidates.sort(key=lambda item: (-item["priority_score"], item["vessel_id"]))
    candidates = candidates[:max_candidates]
    for rank, candidate in enumerate(candidates, start=1):
        candidate["rank"] = rank

    result = deepcopy(case)
    result["vessel_candidates"] = candidates
    provenance = result.setdefault("provenance", {})
    provenance["ais_data"] = [deepcopy(ais_source)] if ais_source else []
    provenance["ais_matching"] = {
        "method": "origin-zone proximity, time-matched particle corridor proximity, and AIS report-span score",
        "release_window": {"start": _utc_text(start), "end": _utc_text(end)},
        "search_radius_km": search_radius_km,
        "score_weights": {
            "origin_proximity": 0.55 if model_frames else SPATIAL_WEIGHT,
            "release_window_coverage": 0.25 if model_frames else TEMPORAL_WEIGHT,
            "particle_corridor_proximity": 0.20 if model_frames else 0.0,
        },
        "ais_observations_received": total_observations,
        "ais_observations_in_release_window": in_window_count,
        "max_candidates": max_candidates,
        "interpolation": {
            "max_gap_seconds": MAX_INTERPOLATION_GAP_SECONDS,
            "max_plausible_speed_knots": MAX_PLAUSIBLE_SPEED_KNOTS,
            "intermediate_samples_per_gap": INTERPOLATION_STEPS - 1,
            "long_track_gaps_seconds": MAX_TRACK_GAP_SECONDS,
        },
        "limitation": (
            "Particle positions are a sampled model corridor and depend on the supplied forcing and model assumptions. "
            "Short AIS gaps are approximated linearly; longer gaps are not interpolated. Scores are screening priorities, not responsibility probabilities or source attribution."
        ),
    }
    return result

