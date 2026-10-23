"""Load public historical wind and current fields for an OpenDrift replay.

This provider avoids Copernicus Marine account setup. It uses Open-Meteo's
historical ERA5 archive for winds and ERA5-Ocean for currents. These are coarse
reanalysis fields intended for a prototype, not local operational forecasts.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import xarray as xr


MARINE_API = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_API = "https://archive-api.open-meteo.com/v1/archive"


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)


def _locations(payload: Any, expected: int, provider: str) -> list[dict[str, Any]]:
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != expected:
        raise RuntimeError(f"{provider} returned {len(items)} locations; expected {expected}.")
    for item in items:
        if not isinstance(item, dict) or item.get("error"):
            reason = item.get("reason", "invalid response") if isinstance(item, dict) else "invalid response"
            raise RuntimeError(f"{provider} could not provide forcing data: {reason}")
        if not isinstance(item.get("hourly"), dict):
            raise RuntimeError(f"{provider} returned no hourly data for this time and area.")
    return items


def _geometry_points(geometry: dict[str, Any]) -> list[list[float]]:
    if geometry.get("type") == "Polygon":
        return [p for ring in geometry.get("coordinates", []) for p in ring]
    if geometry.get("type") == "MultiPolygon":
        return [p for poly in geometry.get("coordinates", []) for ring in poly for p in ring]
    raise ValueError("Choose a polygon dark feature before running drift.")


def _write_reader_file(path: Path, times: list[datetime], latitudes: np.ndarray,
                       longitudes: np.ndarray, eastward: np.ndarray,
                       northward: np.ndarray, standard_names: tuple[str, str],
                       variable_names: tuple[str, str]) -> None:
    coords = {
        "time": np.asarray(times, dtype="datetime64[ns]"),
        "latitude": latitudes,
        "longitude": longitudes,
    }
    ds = xr.Dataset(
        {
            variable_names[0]: (("time", "latitude", "longitude"), eastward),
            variable_names[1]: (("time", "latitude", "longitude"), northward),
        },
        coords=coords,
        attrs={"Conventions": "CF-1.8", "source": "Open-Meteo public historical API"},
    )
    for name, standard_name in zip(variable_names, standard_names):
        ds[name].attrs.update({"standard_name": standard_name, "units": "m s-1"})
    ds.to_netcdf(path, engine="scipy")


def fetch_readers(
    *, geometry: dict[str, Any], observed_at: datetime, backtrack_hours: int,
    output_directory: Path,
) -> tuple[list[Any], list[dict[str, Any]]]:
    """Fetch wind/current grid data and return OpenDrift-compatible readers."""
    try:
        from opendrift.readers import reader_netCDF_CF_generic
    except ImportError as exc:
        raise RuntimeError("OpenDrift readers are unavailable. Install backend requirements first.") from exc

    points = _geometry_points(geometry)
    west = max(-180.0, min(float(p[0]) for p in points) - 1.5)
    east = min(180.0, max(float(p[0]) for p in points) + 1.5)
    south = max(-80.0, min(float(p[1]) for p in points) - 1.5)
    north = min(90.0, max(float(p[1]) for p in points) + 1.5)
    # A 7 x 7 sample grid keeps requests small while spanning the backtrack area.
    longitudes = np.linspace(west, east, 7)
    latitudes = np.linspace(south, north, 7)
    grid = [(lat, lon) for lat in latitudes for lon in longitudes]
    start = (observed_at - timedelta(hours=backtrack_hours + 2)).replace(minute=0, second=0, microsecond=0)
    end = (observed_at + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    params = {
        "latitude": ",".join(f"{lat:.5f}" for lat, _ in grid),
        "longitude": ",".join(f"{lon:.5f}" for _, lon in grid),
        "start_date": start.date().isoformat(),
        "end_date": end.date().isoformat(),
        "timezone": "GMT",
    }

    try:
        with httpx.Client(timeout=httpx.Timeout(50.0, connect=15.0)) as client:
            marine = client.get(MARINE_API, params={
                **params,
                "hourly": "ocean_current_velocity,ocean_current_direction",
                "models": "era5_ocean",
                "length_unit": "metric",
                "cell_selection": "sea",
            })
            marine.raise_for_status()
            wind = client.get(WEATHER_API, params={
                **params,
                "hourly": "wind_speed_10m,wind_direction_10m",
                "models": "era5",
                "wind_speed_unit": "ms",
            })
            wind.raise_for_status()
        current_rows = _locations(marine.json(), len(grid), "Open-Meteo ERA5-Ocean")
        wind_rows = _locations(wind.json(), len(grid), "Open-Meteo ERA5")
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(f"Could not download public historical wind/current data: {str(exc)[:300]}") from exc

    time_labels = current_rows[0]["hourly"].get("time", [])
    times = [_parse_time(t) for t in time_labels]
    if len(times) < 2:
        raise RuntimeError("Open-Meteo returned too few hourly current records for the requested period.")
    expected_times = time_labels
    nt, ny, nx = len(times), len(latitudes), len(longitudes)
    uo = np.full((nt, ny, nx), np.nan, dtype=float)
    vo = np.full_like(uo, np.nan)
    uw = np.full_like(uo, np.nan)
    vw = np.full_like(uo, np.nan)
    for index, (current, wind_row) in enumerate(zip(current_rows, wind_rows)):
        ch, wh = current["hourly"], wind_row["hourly"]
        if ch.get("time") != expected_times or wh.get("time") != expected_times:
            raise RuntimeError("Open-Meteo wind and current timestamps do not align.")
        cv = np.asarray(ch.get("ocean_current_velocity", []), dtype=float) / 3.6
        cd = np.deg2rad(np.asarray(ch.get("ocean_current_direction", []), dtype=float))
        ws = np.asarray(wh.get("wind_speed_10m", []), dtype=float)
        wd = np.deg2rad(np.asarray(wh.get("wind_direction_10m", []), dtype=float))
        if any(len(values) != nt for values in (cv, cd, ws, wd)):
            raise RuntimeError("Open-Meteo returned incomplete wind/current arrays.")
        iy, ix = divmod(index, nx)
        # Current direction points toward; meteorological wind direction points from.
        uo[:, iy, ix], vo[:, iy, ix] = cv * np.sin(cd), cv * np.cos(cd)
        uw[:, iy, ix], vw[:, iy, ix] = -ws * np.sin(wd), -ws * np.cos(wd)

    output_directory.mkdir(parents=True, exist_ok=True)
    current_path, wind_path = output_directory / "open_meteo_currents.nc", output_directory / "open_meteo_winds.nc"
    _write_reader_file(current_path, times, latitudes, longitudes, uo, vo,
                       ("x_sea_water_velocity", "y_sea_water_velocity"), ("uo", "vo"))
    _write_reader_file(wind_path, times, latitudes, longitudes, uw, vw,
                       ("x_wind", "y_wind"), ("eastward_wind", "northward_wind"))
    readers = [
        reader_netCDF_CF_generic.Reader(str(current_path), name="Open-Meteo ERA5-Ocean currents"),
        reader_netCDF_CF_generic.Reader(str(wind_path), name="Open-Meteo ERA5 winds"),
    ]
    time_range = {"start": times[0].isoformat().replace("+00:00", "Z"),
                  "end": times[-1].isoformat().replace("+00:00", "Z")}
    area = [west, south, east, north]
    sources = [
        {
            "provider": "Open-Meteo",
            "product": "ERA5-Ocean reanalysis",
            "dataset": "era5_ocean",
            "url": MARINE_API,
            "variables": ["ocean_current_velocity", "ocean_current_direction"],
            "time_range": time_range,
            "area": area,
            "resolution_note": "Hourly, approximately 0.5 degree global ERA5-Ocean reanalysis; currents converted to east/north m/s.",
        },
        {
            "provider": "Open-Meteo",
            "product": "ERA5 reanalysis",
            "dataset": "era5",
            "url": WEATHER_API,
            "variables": ["wind_speed_10m", "wind_direction_10m"],
            "time_range": time_range,
            "area": area,
            "resolution_note": "Hourly, approximately 0.25 degree global 10 m ERA5 winds converted to east/north m/s.",
        },
    ]
    return readers, sources
