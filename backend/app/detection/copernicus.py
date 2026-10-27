"""Small server-side client for Copernicus Sentinel-1 discovery and previews."""
from __future__ import annotations

import base64
import io
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform_bounds

STAC_SEARCH_URL = "https://stac.opensearch.dataspace.copernicus.eu/v1/search"
STAC_ITEM_URL = "https://stac.opensearch.dataspace.copernicus.eu/v1/collections/sentinel-1-grd/items/{}"
TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/process/v1"

_cached_token: str | None = None
_token_expires_at = 0.0


def _scene_summary(feature: dict[str, Any]) -> dict[str, Any]:
    properties = feature.get("properties") or {}
    assets = feature.get("assets") or {}
    return {
        "id": feature.get("id"),
        "datetime": properties.get("datetime") or properties.get("start_datetime"),
        "start_datetime": properties.get("start_datetime"),
        "end_datetime": properties.get("end_datetime"),
        "platform": properties.get("platform"),
        "orbit": properties.get("sat:orbit_state"),
        "mode": properties.get("sar:instrument_mode"),
        "polarizations": properties.get("sar:polarizations") or [],
        "bbox": feature.get("bbox"),
        "geometry": feature.get("geometry"),
        "item_url": (assets.get("thumbnail") or {}).get("href"),
    }


async def search_sentinel1(
    *, bbox: list[float], start: str, end: str, polarization: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search the public Copernicus STAC catalog and return scenes with the requested polarization."""
    query = {
        "collections": ["sentinel-1-grd"],
        "bbox": bbox,
        "datetime": start + "/" + end,
        "limit": min(max(limit, 1), 20),
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    try:
        async with httpx.AsyncClient(timeout=35, transport=httpx.AsyncHTTPTransport(retries=2)) as client:
            response = await client.post(STAC_SEARCH_URL, json=query)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError("Could not reach the Copernicus scene catalog: " + str(exc)) from exc

    features = response.json().get("features", [])
    results = [_scene_summary(item) for item in features]
    return [item for item in results if polarization.upper() in item["polarizations"]]


async def _access_token() -> str:
    global _cached_token, _token_expires_at
    if _cached_token and time.monotonic() < _token_expires_at:
        return _cached_token
    client_id = os.getenv("CDSE_CLIENT_ID")
    client_secret = os.getenv("CDSE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("Add CDSE_CLIENT_ID and CDSE_CLIENT_SECRET to the project .env file to view satellite imagery.")
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=8.0),
            transport=httpx.AsyncHTTPTransport(retries=2),
        ) as client:
            response = await client.post(
                TOKEN_URL,
                data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {400, 401}:
            raise RuntimeError(
                "Copernicus rejected the OAuth client credentials (HTTP "
                + str(exc.response.status_code)
                + "). Check CDSE_CLIENT_ID and CDSE_CLIENT_SECRET in the project .env."
            ) from exc
        raise RuntimeError("Copernicus OAuth returned HTTP " + str(exc.response.status_code) + ". Try again shortly.") from exc
    except httpx.RequestError as exc:
        raise RuntimeError(
            "Could not connect to the Copernicus OAuth service (" + type(exc).__name__ + "). Try again shortly."
        ) from exc
    token_data = response.json()
    _cached_token = token_data["access_token"]
    _token_expires_at = time.monotonic() + max(60, int(token_data.get("expires_in", 3600)) - 90)
    return _cached_token


async def process_sentinel1_scene(
    *, scene_id: str, bbox: list[float], polarization: str, width: int = 1200
) -> tuple[dict[str, Any], bytes]:
    """Request one selected Sentinel-1 acquisition as calibrated sigma0 dB GeoTIFF."""
    if not scene_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for char in scene_id):
        raise ValueError("Invalid Copernicus scene identifier.")
    try:
        async with httpx.AsyncClient(timeout=30, transport=httpx.AsyncHTTPTransport(retries=2)) as client:
            item_response = await client.get(STAC_ITEM_URL.format(scene_id))
            item_response.raise_for_status()
        item = item_response.json()
    except httpx.HTTPError as exc:
        raise RuntimeError("Could not load the selected scene details from Copernicus.") from exc

    properties = item.get("properties") or {}
    available = [value.upper() for value in (properties.get("sar:polarizations") or [])]
    polarization = polarization.upper()
    if polarization not in available:
        raise ValueError("This scene does not contain " + polarization + " polarization.")
    acquired_at = properties.get("datetime") or properties.get("start_datetime")
    if not acquired_at:
        raise ValueError("The selected scene has no acquisition time in the catalog.")
    start_at = properties.get("start_datetime")
    end_at = properties.get("end_datetime")
    if not start_at or not end_at:
        instant = datetime.fromisoformat(acquired_at.replace("Z", "+00:00"))
        start_at = instant.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        end_at = start_at
    # Allow for small timestamp differences between the public STAC item and
    # Sentinel Hub's acquisition index. The requested interval is recorded below.
    start_at = (
        datetime.fromisoformat(start_at.replace("Z", "+00:00")) - timedelta(minutes=2)
    ).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    end_at = (
        datetime.fromisoformat(end_at.replace("Z", "+00:00")) + timedelta(minutes=2)
    ).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    evalscript = f"""//VERSION=3
function setup() {{
  return {{ input: [{{ bands: ["{polarization}", "dataMask"], units: ["LINEAR_POWER", "DN"] }}],
    output: {{ bands: 1, sampleType: "FLOAT32" }} }};
}}
function evaluatePixel(s) {{
  return [s.dataMask ? 10 * Math.log10(Math.max(s.{polarization}, 1e-8)) : NaN];
}}
"""
    request = {
        "input": {
            "bounds": {"bbox": bbox, "properties": {"crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84"}},
            "data": [{
                "type": "sentinel-1-grd",
                "dataFilter": {"timeRange": {"from": start_at, "to": end_at}, "mosaickingOrder": "mostRecent"},
                "processing": {"backCoeff": "SIGMA0_ELLIPSOID", "orthorectify": True, "demInstance": "COPERNICUS_30"},
            }],
        },
        "output": {
            "width": min(max(int(width), 128), 1800),
            "height": min(max(int(width), 128), 1800),
            "responses": [{"identifier": "default", "format": {"type": "image/tiff"}}],
        },
        "evalscript": evalscript,
    }
    token = await _access_token()
    try:
        # Keep the interactive map responsive if Sentinel Hub is unreachable;
        # the frontend can then offer its Copernicus Browser fallback promptly.
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(25.0, connect=8.0),
            transport=httpx.AsyncHTTPTransport(retries=2),
        ) as client:
            response = await client.post(PROCESS_URL, json=request, headers={"Authorization": "Bearer " + token})
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        details = exc.response.text[:500]
        raise RuntimeError("Copernicus could not process this scene: " + details) from exc
    except httpx.HTTPError as exc:
        raise RuntimeError("Could not get the Sentinel-1 image from Copernicus: " + str(exc)) from exc

    metadata = {
        "id": scene_id,
        "datetime": acquired_at,
        "platform": properties.get("platform"),
        "orbit": properties.get("sat:orbit_state"),
        "mode": properties.get("sar:instrument_mode"),
        "polarization": polarization,
        "source": "Copernicus Data Space Sentinel-1 GRD via Sentinel Hub Process API",
        "dataset": "sentinel-1-grd / " + scene_id,
        "catalog_url": STAC_ITEM_URL.format(scene_id),
        "bbox": bbox,
        "processing_time_range": {"start": start_at, "end": end_at},
        "processing_settings": {
            "backscatter_coefficient": "SIGMA0_ELLIPSOID",
            "orthorectify": True,
            "dem": "COPERNICUS_30",
            "output_width_pixels": min(max(int(width), 128), 1800),
            "output_height_pixels": min(max(int(width), 128), 1800),
        },
    }
    return metadata, response.content


def make_scene_preview(geotiff: bytes) -> dict[str, Any]:
    """Make a display quicklook and WGS84 extent from a processed GeoTIFF."""
    try:
        with rasterio.MemoryFile(geotiff) as memory_file:
            with memory_file.open() as raster:
                if raster.crs is None:
                    raise ValueError("Copernicus response did not include a map coordinate system.")
                shape = (min(raster.height, 1200), min(raster.width, 1200))
                values = raster.read(1, out_shape=shape, resampling=rasterio.enums.Resampling.average).astype(np.float32)
                finite = np.isfinite(values)
                valid = (raster.read_masks(1, out_shape=shape) > 0) & finite
                # Some FLOAT32 TIFF responses carry usable samples while GDAL's
                # generated mask is empty. The evalscript writes NaN for no-data,
                # so finite samples remain a safe fallback in that case.
                if not valid.any():
                    valid = finite
                if not valid.any():
                    raise ValueError("No valid satellite pixels were returned for this area.")
                low, high = np.percentile(values[valid], [2, 98])
                if high <= low:
                    high = low + 1
                gray = np.clip((values - low) / (high - low) * 255, 0, 255).astype(np.uint8)
                gray[~valid] = 0
                buffer = io.BytesIO()
                Image.fromarray(gray).convert("RGB").save(buffer, format="JPEG", quality=84)
                west, south, east, north = transform_bounds(raster.crs, "EPSG:4326", *raster.bounds, densify_pts=21)
    except (rasterio.errors.RasterioError, OSError) as exc:
        raise ValueError("Copernicus returned an unreadable image: " + str(exc)) from exc
    return {
        "preview_url": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
        "preview_bounds": [[south, west], [north, east]],
        "geotiff": geotiff,
    }
