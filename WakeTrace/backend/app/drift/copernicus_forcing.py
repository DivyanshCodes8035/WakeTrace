"""Fetch replayable wind/current subsets from Copernicus Marine for OpenDrift."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


CURRENT_DATASET = "cmems_obs-mob_glo_phy-cur_my_0.25deg_PT1H-i"
WIND_DATASET = "cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H"


def _utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def fetch_readers(
    *,
    geometry: dict[str, Any],
    observed_at: datetime,
    backtrack_hours: int,
    output_directory: Path,
) -> tuple[list[Any], list[dict[str, Any]]]:
    """Download small hourly surface forcing subsets and return OpenDrift readers.

    Credentials are read by the official Copernicus Marine Toolbox from its
    normal login profile or environment variables. No invented fallback data is
    supplied when remote data or credentials are missing.
    """
    try:
        import copernicusmarine
        from opendrift.readers import reader_netCDF_CF_generic
    except ImportError as exc:
        raise RuntimeError(
            "Real drift needs the Copernicus Marine Toolbox. Install backend requirements first."
        ) from exc

    has_environment_credentials = bool(
        os.getenv("COPERNICUSMARINE_SERVICE_USERNAME") and os.getenv("COPERNICUSMARINE_SERVICE_PASSWORD")
    )
    credentials_directory = Path(
        os.getenv("COPERNICUSMARINE_CREDENTIALS_DIRECTORY", str(Path.home() / ".copernicusmarine"))
    )
    credential_files = [
        credentials_directory / ".copernicusmarine-credentials",
        Path.home() / ".netrc",
        Path.home() / "_netrc",
        Path.home() / "motuclient" / "motuclient-python.ini",
    ]
    if not has_environment_credentials and not any(path.is_file() for path in credential_files):
        raise RuntimeError(
            "Copernicus Marine is not logged in for this computer. From the backend folder, "
            "run `copernicusmarine login` once, finish the login in that terminal, then restart WakeTrace."
        )

    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") == "Polygon":
        points = [position for ring in coordinates for position in ring]
    elif geometry.get("type") == "MultiPolygon":
        points = [position for polygon in coordinates for ring in polygon for position in ring]
    else:
        raise ValueError("Choose a polygon dark feature before running drift.")
    longitudes = [float(point[0]) for point in points]
    latitudes = [float(point[1]) for point in points]
    # Leave room around the slick for the particles to move during backtracking.
    west = max(-180.0, min(longitudes) - 1.5)
    east = min(180.0, max(longitudes) + 1.5)
    south = max(-80.0, min(latitudes) - 1.5)
    north = min(90.0, max(latitudes) + 1.5)
    start = observed_at - timedelta(hours=backtrack_hours + 2)
    end = observed_at + timedelta(hours=1)
    start_text, end_text = _utc(start), _utc(end)
    common = {
        "minimum_longitude": west,
        "maximum_longitude": east,
        "minimum_latitude": south,
        "maximum_latitude": north,
        "start_datetime": start_text,
        "end_datetime": end_text,
        "output_directory": str(output_directory),
        "disable_progress_bar": True,
    }

    current_path = output_directory / "surface_currents.nc"
    wind_path = output_directory / "surface_wind.nc"
    try:
        copernicusmarine.subset(
            dataset_id=CURRENT_DATASET,
            variables=["uo", "vo"],
            minimum_depth=0,
            maximum_depth=1,
            output_filename=current_path.name,
            **common,
        )
        copernicusmarine.subset(
            dataset_id=WIND_DATASET,
            variables=["eastward_wind", "northward_wind"],
            output_filename=wind_path.name,
            **common,
        )
    except Exception as exc:
        detail = str(exc)
        if any(word in detail.lower() for word in ("credential", "login", "unauthorized", "401", "authentication", "token")):
            raise RuntimeError(
                "Sign in to the free Copernicus Marine Toolbox once, then retry. "
                "From the backend folder run: copernicusmarine login"
            ) from exc
        raise RuntimeError("Copernicus Marine could not provide wind/current data: " + detail[:500]) from exc

    if not current_path.exists() or not wind_path.exists():
        raise RuntimeError("Copernicus Marine returned no forcing file for this time and area.")

    current_reader = reader_netCDF_CF_generic.Reader(str(current_path), name="Copernicus Marine hourly currents")
    wind_reader = reader_netCDF_CF_generic.Reader(str(wind_path), name="Copernicus Marine hourly winds")
    sources = [
        {
            "provider": "Copernicus Marine Service",
            "product": "MULTIOBS_GLO_PHY_MYNRT_015_003",
            "dataset": CURRENT_DATASET,
            "url": "https://data.marine.copernicus.eu/product/MULTIOBS_GLO_PHY_MYNRT_015_003/description",
            "variables": ["uo", "vo"],
            "time_range": {"start": start_text, "end": end_text},
            "area": [west, south, east, north],
            "resolution_note": "Hourly, 0.25 degree surface current analysis; combines geostrophic, Ekman and tidal components.",
        },
        {
            "provider": "Copernicus Marine Service",
            "product": "WIND_GLO_PHY_L4_MY_012_006",
            "dataset": WIND_DATASET,
            "url": "https://data.marine.copernicus.eu/product/WIND_GLO_PHY_L4_MY_012_006/description",
            "variables": ["eastward_wind", "northward_wind"],
            "time_range": {"start": start_text, "end": end_text},
            "area": [west, south, east, north],
            "resolution_note": "Hourly, 0.125 degree 10 m winds, reanalysis corrected with scatterometer observations.",
        },
    ]
    return [current_reader, wind_reader], sources
