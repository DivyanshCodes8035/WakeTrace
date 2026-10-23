"""Fetch coarse, aggregated AIS vessel-presence leads from Global Fishing Watch."""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

GFW_REPORT_URL = "https://gateway.api.globalfishingwatch.org/v3/4wings/report"
GFW_DATASET = "public-global-presence:latest"


class AISPresenceError(ValueError):
    """A user-facing error from the optional GFW AIS-presence lookup."""


def _utc_date(value: Any, label: str) -> date:
    if not isinstance(value, str):
        raise AISPresenceError(f"Drift {label} must be a UTC timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AISPresenceError(f"Drift {label} is not a valid timestamp.") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise AISPresenceError(f"Drift {label} must include UTC (Z).")
    return parsed.date()


def _validate_origin(origin: Any) -> dict[str, Any]:
    if not isinstance(origin, dict) or origin.get("type") not in {"Polygon", "MultiPolygon"}:
        raise AISPresenceError("The drift result needs a Polygon or MultiPolygon origin area.")
    coordinates = origin.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        raise AISPresenceError("The drift origin area has no coordinates.")
    return origin


async def search_gfw_presence(drift: dict[str, Any]) -> dict[str, Any]:
    """Return daily, gridded vessel presence within the drift origin area."""
    token = os.getenv("GFW_API_TOKEN", "").strip()
    if not token:
        raise AISPresenceError(
            "Automatic AIS search needs a free Global Fishing Watch API token. "
            "Create one at https://globalfishingwatch.org/our-apis/ and add "
            "GFW_API_TOKEN=your-token to the project-root .env, then restart the backend."
        )

    release = drift.get("release_window")
    if not isinstance(release, dict):
        raise AISPresenceError("Complete the drift estimate before searching AIS presence.")
    start_day = _utc_date(release.get("start"), "release start")
    end_day = _utc_date(release.get("end"), "release end")
    if end_day < start_day or (end_day - start_day).days > 6:
        raise AISPresenceError("The release window must be valid and no longer than seven calendar days.")
    origin = _validate_origin(drift.get("origin_zone"))

    params = {
        "spatial-resolution": "HIGH",
        "temporal-resolution": "DAILY",
        "spatial-aggregation": "true",
        "group-by": "VESSEL_ID",
        "datasets[0]": GFW_DATASET,
        "date-range": f"{start_day.isoformat()},{(end_day + timedelta(days=1)).isoformat()}",
        "format": "JSON",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0)) as client:
            response = await client.post(
                GFW_REPORT_URL,
                params=params,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"geojson": origin},
            )
    except httpx.TimeoutException as exc:
        raise AISPresenceError("Global Fishing Watch took too long to return AIS presence. Try again shortly.") from exc
    except httpx.RequestError as exc:
        raise AISPresenceError("WakeTrace could not connect to Global Fishing Watch. Check internet access and try again.") from exc

    if response.status_code == 401:
        raise AISPresenceError("Global Fishing Watch rejected the API token. Check GFW_API_TOKEN in the project-root .env.")
    if response.status_code == 403:
        raise AISPresenceError("This Global Fishing Watch token does not have access to the AIS presence report.")
    if response.status_code == 429:
        raise AISPresenceError("Global Fishing Watch is already processing a report for this token. Wait briefly and retry.")
    if response.status_code >= 400:
        raise AISPresenceError(f"Global Fishing Watch returned HTTP {response.status_code}. Check the area, dates, and API token.")
    try:
        payload = response.json()
    except ValueError as exc:
        raise AISPresenceError("Global Fishing Watch returned an unreadable report.") from exc

    entries: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        raw_entries = payload.get("entries", [])
        if isinstance(raw_entries, list):
            for group in raw_entries:
                if not isinstance(group, dict):
                    continue
                rows = group.get(GFW_DATASET, [])
                if isinstance(rows, list):
                    entries.extend(row for row in rows if isinstance(row, dict))

    presences = []
    for row in entries:
        try:
            longitude, latitude = float(row["lon"]), float(row["lat"])
            hours = float(row.get("hours", 0))
            vessel_count = int(row.get("vesselIDs", 1))
        except (KeyError, TypeError, ValueError):
            continue
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90 and hours >= 0):
            continue
        presences.append({
            "date": row.get("date"),
            "longitude": longitude,
            "latitude": latitude,
            "hours": hours,
            "vessel_count": max(1, vessel_count),
            "vessel_id": row.get("vesselId") or row.get("vessel_id"),
            "mmsi": row.get("mmsi"),
            "ship_name": row.get("shipName") or row.get("ship_name"),
            "vessel_type": row.get("vesselType") or row.get("vessel_type"),
            "flag": row.get("flag"),
        })

    return {
        "provider": "Global Fishing Watch",
        "dataset": GFW_DATASET,
        "release_window": {"start": release["start"], "end": release["end"]},
        "spatial_resolution_degrees": 0.01,
        "temporal_resolution": "daily",
        "presence_cells": presences[:500],
        "reported_cell_count": len(presences),
        "provenance": {
            "provider": "Global Fishing Watch",
            "dataset": GFW_DATASET,
            "api": GFW_REPORT_URL,
            "query_geometry": origin,
            "query_start_date": start_day.isoformat(),
            "query_end_date_exclusive": (end_day + timedelta(days=1)).isoformat(),
            "spatial_resolution_degrees": 0.01,
            "temporal_resolution": "DAILY",
        },
        "note": (
            "AIS presence leads from Global Fishing Watch, aggregated into approximately 0.01° grid cells by day. "
            "These are not exact vessel tracks or precise positions. They show vessels reported in the modeled "
            "origin area during the release window and cannot establish that any vessel caused a spill."
        ),
    }
