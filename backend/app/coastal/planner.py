"""A transparent, forecast-driven coastal exposure scenario for WakeTrace.

This is a prototype sensitivity envelope, not an operational oil-spill model.
It uses Open-Meteo forecast fields and community-mapped OpenStreetMap features.
"""
from __future__ import annotations

import asyncio
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.drift.open_meteo_forcing import fetch_forecast_readers
from app.drift.simulation import simulate_forward_scenario


MARINE_API = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_API = "https://api.open-meteo.com/v1/forecast"
OVERPASS_API = "https://overpass-api.de/api/interpreter"
WDPA_QUERY_API = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/WDPA_Marine_and_Coastal/FeatureServer/1/query"
OPENSTREETMAP_ATTRIBUTION = "© OpenStreetMap contributors"


def _points(geometry: dict[str, Any]) -> list[tuple[float, float]]:
    found: list[tuple[float, float]] = []

    def visit(value: Any) -> None:
        if not isinstance(value, list):
            return
        if len(value) >= 2 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in value[:2]):
            lon, lat = float(value[0]), float(value[1])
            if -180 <= lon <= 180 and -90 <= lat <= 90:
                found.append((lon, lat))
            return
        for child in value:
            visit(child)

    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"}:
        raise ValueError("Choose a mapped radar feature before planning coastal exposure.")
    visit(geometry.get("coordinates"))
    if not found or len(found) > 5000:
        raise ValueError("The selected feature has no usable boundary coordinates or is too complex.")
    return found


def _meters_per_degree(latitude: float) -> tuple[float, float]:
    return 111_195.0 * max(0.15, math.cos(math.radians(latitude))), 111_195.0


def _advance(lon: float, lat: float, east_mps: float, north_mps: float, hours: float) -> tuple[float, float]:
    m_lon, m_lat = _meters_per_degree(lat)
    return lon + east_mps * 3600 * hours / m_lon, lat + north_mps * 3600 * hours / m_lat


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _point_segment_distance_km(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    ref_lat = math.radians(point[1])
    scale_x = 6371.0088 * math.cos(ref_lat) * math.pi / 180
    scale_y = 6371.0088 * math.pi / 180
    px, py = point[0] * scale_x, point[1] * scale_y
    ax, ay = start[0] * scale_x, start[1] * scale_y
    bx, by = end[0] * scale_x, end[1] * scale_y
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    fraction = 0.0 if denominator == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denominator))
    return math.hypot(px - (ax + fraction * dx), py - (ay + fraction * dy))


def _inside_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    previous = ring[-1] if ring else point
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def _category(tags: dict[str, Any]) -> tuple[str, int]:
    natural = str(tags.get("natural", "")).lower()
    wetland = str(tags.get("wetland", "")).lower()
    if "mangrove" in wetland or natural == "mangrove":
        return "Mangrove / wetland", 1
    if natural == "reef":
        return "Reef", 1
    if tags.get("boundary") == "protected_area" or tags.get("leisure") == "nature_reserve":
        return "Protected area", 1
    if natural == "wetland":
        return "Wetland", 2
    if natural == "beach" or tags.get("leisure") == "beach":
        return "Beach", 3
    return "Coastal feature", 4


def _element_feature(element: dict[str, Any]) -> tuple[dict[str, Any], list[tuple[float, float]]] | None:
    tags = element.get("tags") or {}
    coords: list[tuple[float, float]] = []
    if element.get("type") == "node":
        coords = [(float(element["lon"]), float(element["lat"]))]
        geometry: dict[str, Any] = {"type": "Point", "coordinates": list(coords[0])}
    else:
        coords = [(float(p["lon"]), float(p["lat"])) for p in element.get("geometry", []) if "lon" in p and "lat" in p]
        if not coords:
            center = element.get("center") or {}
            if "lon" not in center or "lat" not in center:
                return None
            coords = [(float(center["lon"]), float(center["lat"]))]
            geometry = {"type": "Point", "coordinates": list(coords[0])}
        elif len(coords) >= 4 and coords[0] == coords[-1]:
            geometry = {"type": "Polygon", "coordinates": [[list(p) for p in coords]]}
        elif len(coords) >= 2:
            geometry = {"type": "LineString", "coordinates": [list(p) for p in coords]}
        else:
            geometry = {"type": "Point", "coordinates": list(coords[0])}
    category, order = _category(tags)
    feature = {
        "type": "Feature",
        "id": f"{element.get('type', 'feature')}/{element.get('id', '')}",
        "geometry": geometry,
        "properties": {
            "name": tags.get("name") or category,
            "category": category,
            "priority_order": order,
            "source": "OpenStreetMap",
            "osm_type": element.get("type"),
            "osm_id": element.get("id"),
        },
    }
    return feature, coords


async def _fetch_json(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = await client.get(url, params=params)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError("A public forecast provider returned an invalid response.")
    return payload


async def _get_coastal_features(client: httpx.AsyncClient, bounds: tuple[float, float, float, float]) -> tuple[list[dict[str, Any]], str | None]:
    west, south, east, north = bounds
    bbox = f"{south:.5f},{west:.5f},{north:.5f},{east:.5f}"
    query = (
        f"[out:json][timeout:25];("
        f'nwr["natural"="reef"]({bbox});'
        f'nwr["natural"="beach"]({bbox});'
        f'nwr["leisure"="beach"]({bbox});'
        f'nwr["natural"="wetland"]["wetland"~"mangrove|tidalflat|saltmarsh"]({bbox});'
        f'nwr["boundary"="protected_area"]({bbox});'
        f'nwr["leisure"="nature_reserve"]({bbox});'
        f");out center geom 80;"
    )
    response = await client.post(OVERPASS_API, data={"data": query})
    response.raise_for_status()
    payload = response.json()
    features = []
    for element in payload.get("elements", []):
        item = _element_feature(element)
        if item:
            features.append(item[0])
    timestamp = (payload.get("osm3s") or {}).get("timestamp_osm_base")
    return features, timestamp


async def _get_protected_areas(client: httpx.AsyncClient, bounds: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    west, south, east, north = bounds
    response = await client.get(WDPA_QUERY_API, params={
        "geometry": f"{west},{south},{east},{north}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "site_id,site_pid,name_eng,name,desig_eng,desig,iucn_cat,realm,status,iso3",
        "returnGeometry": "true",
        "geometryPrecision": 5,
        "resultRecordCount": 80,
        "f": "geojson",
    })
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError("The UNEP-WCMC/IUCN protected-area service returned an invalid response.")
    features = []
    for item in payload.get("features", []):
        properties = item.get("properties") or {}
        geometry = item.get("geometry")
        if not isinstance(geometry, dict):
            continue
        kind, order = _category({"boundary": "protected_area"})
        features.append({
            "type": "Feature",
            "id": "wdpa/" + str(properties.get("site_pid") or properties.get("site_id") or len(features)),
            "geometry": geometry,
            "properties": {
                "name": properties.get("name_eng") or properties.get("name") or "Protected area",
                "category": "Marine / coastal protected area",
                "priority_order": order,
                "source": "UNEP-WCMC / IUCN Protected Planet",
                "site_id": properties.get("site_id"),
                "site_pid": properties.get("site_pid"),
                "designation": properties.get("desig_eng") or properties.get("desig"),
                "iucn_category": properties.get("iucn_cat"),
                "realm": properties.get("realm"),
                "status": properties.get("status"),
                "iso3": properties.get("iso3"),
            },
        })
    return features


def _geometry_paths(geometry: dict[str, Any]) -> list[list[tuple[float, float]]]:
    kind = geometry.get("type")
    coords = geometry.get("coordinates", [])
    if kind == "Polygon":
        return [[(float(p[0]), float(p[1])) for p in ring] for ring in coords]
    if kind == "MultiPolygon":
        return [[(float(p[0]), float(p[1])) for p in ring] for polygon in coords for ring in polygon]
    if kind == "LineString":
        return [[(float(p[0]), float(p[1])) for p in coords]]
    if kind == "MultiLineString":
        return [[(float(p[0]), float(p[1])) for p in line] for line in coords]
    if kind == "Point":
        return [[(float(coords[0]), float(coords[1]))]]
    if kind == "MultiPoint":
        return [[(float(p[0]), float(p[1]))] for p in coords]
    return []


def _distance_to_feature(track: list[dict[str, Any]], geometry: dict[str, Any]) -> tuple[float, list[str]]:
    best = math.inf
    near_times = []
    paths = _geometry_paths(geometry)
    outer_ring = paths[0] if geometry.get("type") in {"Polygon", "MultiPolygon"} and paths else []
    for frame in track:
        point = tuple(frame["coordinates"])
        distance = min((
            min(_haversine_km(point, vertex) for vertex in path)
            if len(path) == 1 else
            min(_point_segment_distance_km(point, path[index - 1], path[index]) for index in range(1, len(path)))
            for path in paths if path
        ), default=math.inf)
        if outer_ring and _inside_ring(point, outer_ring):
            distance = 0.0
        best = min(best, distance)
        if distance <= 10:
            near_times.append(frame["time"])
    return best, near_times


async def create_impact_plan(geometry: dict[str, Any], forecast_hours: int = 36) -> dict[str, Any]:
    """Run real-forecast OpenDrift ensembles and query nearby mapped coastal sites."""
    feature_points = _points(geometry)
    origin = (
        sum(point[0] for point in feature_points) / len(feature_points),
        sum(point[1] for point in feature_points) / len(feature_points),
    )
    if not 6 <= forecast_hours <= 72:
        raise ValueError("Choose a forecast window from 6 to 72 hours.")

    scenario_settings = [
        {"name": "Lower windage", "wind_drift_factor": 0.01, "current_uncertainty": 0.05},
        {"name": "Central scenario", "wind_drift_factor": 0.02, "current_uncertainty": 0.1},
        {"name": "Higher windage / wider spread", "wind_drift_factor": 0.03, "current_uncertainty": 0.2},
    ]

    def run_ensembles() -> tuple[list[dict[str, Any]], list[dict[str, Any]], datetime, dict[str, Any]]:
        import numpy as np

        with tempfile.TemporaryDirectory(prefix="waketrace-coastal-forcing-") as directory:
            readers, input_sources, start_at, metadata = fetch_forecast_readers(
                geometry=geometry, forecast_hours=forecast_hours, output_directory=Path(directory),
            )
            scenarios = []
            try:
                for index, setting in enumerate(scenario_settings):
                    output = simulate_forward_scenario(
                        geometry, start_at, readers=readers, forecast_hours=forecast_hours,
                        ensemble_size=120,
                        wind_drift_factor=setting["wind_drift_factor"],
                        current_uncertainty=setting["current_uncertainty"],
                        random_seed=42 + index,
                    )
                    scenarios.append({**setting, **output})
            finally:
                for reader in readers:
                    dataset = getattr(reader, "Dataset", None)
                    close = getattr(dataset, "close", None)
                    if callable(close):
                        close()

            all_tracks = [track for scenario in scenarios for track in scenario["particle_tracks"]]
            all_points = [tuple(item["coordinates"]) for track in all_tracks for item in track]
            if not all_points:
                raise RuntimeError("OpenDrift returned no usable forecast positions.")
            pad = 0.12
            bounds = (
                max(-180, min(point[0] for point in all_points) - pad),
                max(-90, min(point[1] for point in all_points) - pad),
                min(180, max(point[0] for point in all_points) + pad),
                min(90, max(point[1] for point in all_points) + pad),
            )
            if bounds[2] - bounds[0] > 2.5 or bounds[3] - bounds[1] > 2.5:
                raise RuntimeError("The modeled area is too wide to query coastal features safely.")
            return scenarios, input_sources, start_at, {**metadata, "bounds": list(bounds)}

    scenarios, input_sources, start_at, forcing_metadata = await asyncio.to_thread(run_ensembles)
    bounds = tuple(forcing_metadata["bounds"])
    timeout = httpx.Timeout(45.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "WakeTrace coastal-impact-planner/0.2"}) as client:
        osm_result, protected_areas = await asyncio.gather(
            _get_coastal_features(client, bounds),
            _get_protected_areas(client, bounds),
        )
    osm_features, osm_data_timestamp = osm_result
    coastal_features = osm_features + protected_areas

    for feature in coastal_features:
        scenario_distances = []
        arrivals = []
        for scenario in scenarios:
            for track in scenario["particle_tracks"]:
                distance, near_times = _distance_to_feature(track, feature["geometry"])
                scenario_distances.append(distance)
                arrivals.extend(near_times)
        minimum = min(scenario_distances)
        feature["properties"].update({
            "distance_km": round(minimum, 1),
            "within_10km": minimum <= 10,
            "arrival_window": [min(arrivals), max(arrivals)] if arrivals else None,
        })
    coastal_features.sort(key=lambda item: (
        not item["properties"]["within_10km"],
        item["properties"]["priority_order"],
        item["properties"]["distance_km"],
    ))
    for rank, feature in enumerate(coastal_features, start=1):
        feature["properties"]["priority_rank"] = rank

    return {
        "origin": {"type": "Point", "coordinates": list(origin)},
        "scenarios": [{
            "name": item["name"], "track": item["track"],
            "particle_tracks": item["particle_tracks"],
            "particle_count_returned": item["particle_count_returned"],
            "settings": item["settings"],
        } for item in scenarios],
        "coastal_features": {"type": "FeatureCollection", "features": coastal_features},
        "forecast": {
            "provider": "Open-Meteo",
            "marine_product": input_sources[0]["product"],
            "weather_product": input_sources[1]["product"],
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "start": start_at.isoformat().replace("+00:00", "Z"),
            "end": scenarios[-1]["track"][-1]["time"],
            "hours_requested": forecast_hours,
            "hours_returned": min(len(item["track"]) for item in scenarios) - 1,
            "sources": input_sources,
            "forcing_grid": forcing_metadata,
            "model": "OpenDrift OpenOil",
        },
        "coastal_source": {
            "providers": ["OpenStreetMap contributors", "UNEP-WCMC / IUCN Protected Planet"],
            "datasets": [
                {"provider": "OpenStreetMap contributors", "dataset": "Mapped reefs, beaches, wetlands/mangroves, and nature reserves", "url": "https://www.openstreetmap.org/copyright", "query_url": OVERPASS_API, "feature_count": len(osm_features), "data_timestamp": osm_data_timestamp},
                {"provider": "UNEP-WCMC / IUCN", "dataset": "World Database on Protected and Conserved Areas (WDPCA) marine/coastal polygons", "url": "https://www.protectedplanet.net/", "query_url": WDPA_QUERY_API, "feature_count": len(protected_areas), "release_note": "Protected Planet updates the database monthly."},
            ],
            "queried_bounds": list(bounds),
            "feature_count": len(coastal_features),
            "queried_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "coverage_note": "Community-mapped features can be incomplete or out of date. No mapped result does not mean no sensitive place exists.",
            "noaa_esi": "NOAA ESI coverage is not confirmed for this location; this map does not present an ESI layer.",
        },
        "model": {
            "label": "OpenDrift OpenOil forecast ensemble",
            "assumptions": [
                "Three 120-particle runs vary windage (1%, 2%, 3%) and current-uncertainty settings.",
                "The model uses OpenDrift OpenOil with forecast forcing sampled on a 9 × 9 grid; coastal-scale gaps and model-grid resolution remain important.",
                "Stokes drift is disabled because the current forecast-reader implementation does not supply wave-drift fields.",
                "Oil type is assumed as GENERIC BUNKER C; the actual substance and weathering may differ.",
                "A 10 km proximity screen is a review aid, not a confirmed landfall or impact prediction.",
            ],
            "uncertainty_note": "These are model scenarios, not probabilities or confidence bounds. Forecast error, oil properties, nearshore circulation, and mapped-data gaps may change the result. Human review is required.",
            "attribution": [OPENSTREETMAP_ATTRIBUTION, "UNEP-WCMC and IUCN (2026), Protected Planet / WDPCA", "Open-Meteo and its forecast providers"],
        },
    }
