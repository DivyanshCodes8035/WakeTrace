from __future__ import annotations

import json
import math
import asyncio
import csv
import io
import re
import tempfile
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any

import rasterio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.detection.copernicus import make_scene_preview, process_sentinel1_scene, search_sentinel1
from app.detection.sar import DetectionInputError, detect_sar_dark_features
from app.detection.simulation import make_offline_practice_scene, run_simulated_spill
from app.drift.copernicus_forcing import fetch_readers
from app.drift.simulation import DriftInputError, estimate_origin
from app.vessels.matching import VesselMatchingInputError, match_vessel_candidates

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEMO_CASE_PATH = PROJECT_ROOT / "data" / "sample" / "demo_case.json"
if not DEMO_CASE_PATH.exists():
    DEMO_CASE_PATH = PROJECT_ROOT / "frontend" / "demo-case.json"
SAVED_CASES_DIR = PROJECT_ROOT / "data" / "cases"
load_dotenv(PROJECT_ROOT / ".env")

app = FastAPI(
    title="WakeTrace API",
    version="0.1.0",
    description="Prototype API for reviewing synthetic maritime pollution investigation cases.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def load_demo_case() -> dict[str, Any]:
    with DEMO_CASE_PATH.open("r", encoding="utf-8") as case_file:
        return json.load(case_file)


class SaveCaseRequest(BaseModel):
    case_data: dict[str, Any]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "waketrace-api"}


@app.get("/api/cases/{case_id}")
def get_case(case_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", case_id):
        raise HTTPException(status_code=404, detail="Case not found")
    case = load_demo_case()
    if case_id == case["case_id"]:
        return case
    path = SAVED_CASES_DIR / (case_id + ".json")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Case not found")
    with path.open("r", encoding="utf-8") as saved_file:
        return json.load(saved_file)


@app.post("/api/cases")
def save_case(request: SaveCaseRequest) -> dict[str, str]:
    """Persist a reviewed real-data lead separately from the synthetic fixture."""
    case = request.case_data
    case_id = str(case.get("case_id", ""))
    if not re.fullmatch(r"[a-zA-Z0-9_-]{3,64}", case_id) or case.get("synthetic") is True:
        raise HTTPException(status_code=422, detail="Choose a valid real-review case ID.")
    if not isinstance(case.get("detection"), dict):
        raise HTTPException(status_code=422, detail="A reviewed detection result is required.")
    SAVED_CASES_DIR.mkdir(parents=True, exist_ok=True)
    destination = SAVED_CASES_DIR / (case_id + ".json")
    if destination.exists():
        raise HTTPException(status_code=409, detail="This case has already been saved.")
    temporary = destination.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(case, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(destination)
    except (OSError, TypeError, ValueError) as exc:
        temporary.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save the case to the project data folder.") from exc
    return {"case_id": case_id, "path": "data/cases/" + case_id + ".json"}


class SceneSelection(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4, description="WGS84 [west, south, east, north]")
    polarization: str = "VV"


class SimulatedSpillSelection(SceneSelection):
    source_longitude: float = Field(ge=-180, le=180)
    source_latitude: float = Field(ge=-90, le=90)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class OfflinePracticeRequest(BaseModel):
    source_longitude: float = Field(default=57.7, ge=57.2, le=58.2)
    source_latitude: float = Field(default=-20.4, ge=-20.8, le=-20.0)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class DriftSelection(SceneSelection):
    geometry: dict[str, Any]
    acquired_at: str
    backtrack_hours: int = Field(default=24, ge=6, le=120)
    ensemble_size: int = Field(default=300, ge=50, le=2000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class AISMatchRequest(BaseModel):
    drift: dict[str, Any]
    provider: str = Field(min_length=2, max_length=120)
    dataset: str = Field(min_length=2, max_length=160)
    filename: str = Field(min_length=1, max_length=255)
    csv_text: str = Field(min_length=1, max_length=25_000_000)


def _validated_bbox(values: list[float], max_span: float = 5.0) -> list[float]:
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        raise HTTPException(status_code=422, detail="Area must contain four finite WGS84 coordinates.")
    west, south, east, north = values
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(status_code=422, detail="Use west, south, east, north in GeoJSON coordinate order.")
    if east - west > max_span or north - south > max_span:
        raise HTTPException(status_code=422, detail="Choose a smaller ocean area so image processing stays manageable.")
    return values


@app.get("/api/satellite/search")
async def satellite_search(
    west: float,
    south: float,
    east: float,
    north: float,
    start_date: date,
    end_date: date,
    polarization: str = Query("VV", pattern="^(VV|VH|HH|HV)$"),
) -> dict[str, Any]:
    """Search official Copernicus Sentinel-1 GRD scenes for a user-selected area and dates."""
    bbox = _validated_bbox([west, south, east, north])
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must be on or before end date.")
    if (end_date - start_date).days > 31:
        raise HTTPException(status_code=422, detail="Search at most 32 days at a time.")
    start = datetime.combine(start_date, time.min, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    end = datetime.combine(end_date, time.max, tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        scenes = await search_sentinel1(bbox=bbox, start=start, end=end, polarization=polarization)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"provider": "Copernicus Data Space", "collection": "sentinel-1-grd", "bbox": bbox,
            "start_date": start, "end_date": end, "polarization": polarization, "scenes": scenes}


@app.post("/api/satellite/scenes/{scene_id}/preview")
async def satellite_scene_preview(scene_id: str, selection: SceneSelection) -> dict[str, Any]:
    """Fetch one real Sentinel-1 scene, show its quicklook, and screen for dark features."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    polarization = selection.polarization.upper()
    if polarization not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    temporary_path: Path | None = None
    try:
        metadata, geotiff = await process_sentinel1_scene(
            scene_id=scene_id, bbox=bbox, polarization=polarization, width=1200,
        )
        preview = make_scene_preview(geotiff)
        with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as temporary:
            temporary.write(geotiff)
            temporary_path = Path(temporary.name)
        detection = detect_sar_dark_features(
            temporary_path,
            acquired_at=metadata["datetime"],
            source={"provider": "Copernicus Data Space", "dataset": metadata["dataset"], "product_id": scene_id},
            polarization=polarization,
        )
        detection["preview_url"] = preview["preview_url"]
        detection["preview_bounds"] = preview["preview_bounds"]
        detection["provenance"]["input_sources"][0].update({
            "platform": metadata["platform"],
            "product_id": metadata["id"],
            "catalog_url": metadata["catalog_url"],
        })
        detection["provenance"]["settings"]["copernicus_processing"] = metadata["processing_settings"]
        detection["provenance"]["settings"]["copernicus_time_range"] = metadata["processing_time_range"]
    except (RuntimeError, ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        message = str(exc)
        status = 503 if "CDSE_CLIENT_ID" in message or "OAuth client" in message else 502
        raise HTTPException(status_code=status, detail=message) from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    preview.pop("geotiff", None)
    return {"scene": metadata, "preview": preview, "detection": detection,
            "note": "Real Sentinel-1 image from Copernicus Data Space. Dark regions are candidates for analyst review, not confirmed oil."}


@app.post("/api/satellite/scenes/{scene_id}/simulate")
async def satellite_scene_simulation(scene_id: str, selection: SimulatedSpillSelection) -> dict[str, Any]:
    """Inject and screen a labeled synthetic slick on a copy of a real SAR scene."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    polarization = selection.polarization.upper()
    if polarization not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    west, south, east, north = bbox
    if not (west <= selection.source_longitude <= east and south <= selection.source_latitude <= north):
        raise HTTPException(status_code=422, detail="Click a source point inside the displayed satellite scene.")
    try:
        metadata, geotiff = await process_sentinel1_scene(
            scene_id=scene_id, bbox=bbox, polarization=polarization, width=1200,
        )
        result = run_simulated_spill(
            geotiff,
            source_lon=selection.source_longitude,
            source_lat=selection.source_latitude,
            acquired_at=metadata["datetime"],
            scene_source={"provider": "Copernicus Data Space", "dataset": metadata["dataset"],
                          "product_id": scene_id, "platform": metadata["platform"],
                          "catalog_url": metadata["catalog_url"]},
            polarization=polarization,
            seed=selection.seed,
        )
        preview = make_scene_preview(result.pop("modified_geotiff"))
        preview.pop("geotiff", None)
    except (RuntimeError, ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        message = str(exc)
        status = 503 if "CDSE_CLIENT_ID" in message or "OAuth client" in message else 502
        raise HTTPException(status_code=status, detail=message) from exc
    result["preview"] = preview
    result["scene"] = metadata
    result["detection"]["provenance"]["settings"]["copernicus_processing"] = metadata["processing_settings"]
    result["detection"]["provenance"]["settings"]["copernicus_time_range"] = metadata["processing_time_range"]
    return result


@app.post("/api/simulation/practice")
def offline_synthetic_practice(selection: OfflinePracticeRequest) -> dict[str, Any]:
    """Run the practice pipeline against locally generated, non-satellite radar-like pixels."""
    acquired_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    geotiff, bbox = make_offline_practice_scene(selection.seed)
    scene = {
        "id": "OFFLINE-SYNTHETIC-PRACTICE",
        "source": "Locally generated synthetic radar-style practice scene",
        "datetime": acquired_at,
        "dataset": "WakeTrace synthetic practice raster",
        "bbox": bbox,
        "platform": "simulation",
        "polarization": "VV (synthetic)",
    }
    try:
        result = run_simulated_spill(
            geotiff,
            source_lon=selection.source_longitude,
            source_lat=selection.source_latitude,
            acquired_at=acquired_at,
            scene_source={"provider": "WakeTrace synthetic practice generator", "dataset": scene["dataset"],
                          "product_id": scene["id"]},
            polarization="VV",
            seed=selection.seed,
        )
        preview = make_scene_preview(result.pop("modified_geotiff"))
        preview.pop("geotiff", None)
    except (ValueError, DetectionInputError, rasterio.errors.RasterioError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result["preview"] = preview
    result["scene"] = scene
    return result


def _run_real_drift(selection: DriftSelection) -> dict[str, Any]:
    observed = datetime.fromisoformat(selection.acquired_at.replace("Z", "+00:00"))
    if observed.tzinfo is None or observed.utcoffset() != timezone.utc.utcoffset(observed):
        raise DriftInputError("Observation time must include UTC (Z).")
    with tempfile.TemporaryDirectory(prefix="waketrace-forcing-") as directory:
        readers, sources = fetch_readers(
            geometry=selection.geometry,
            observed_at=observed,
            backtrack_hours=selection.backtrack_hours,
            output_directory=Path(directory),
        )
        return estimate_origin(
            selection.geometry,
            observed,
            readers=readers,
            input_sources=sources,
            backtrack_hours=selection.backtrack_hours,
            ensemble_size=selection.ensemble_size,
            random_seed=selection.seed,
        )


@app.post("/api/satellite/scenes/{scene_id}/drift")
async def satellite_scene_drift(scene_id: str, selection: DriftSelection) -> dict[str, Any]:
    """Backtrack one analyst-selected real SAR feature with downloaded real forcing."""
    bbox = _validated_bbox(selection.bbox, max_span=2.5)
    if not scene_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for char in scene_id):
        raise HTTPException(status_code=422, detail="Invalid Copernicus scene identifier.")
    if selection.polarization.upper() not in {"VV", "VH", "HH", "HV"}:
        raise HTTPException(status_code=422, detail="Unsupported polarization.")
    try:
        drift = await asyncio.to_thread(_run_real_drift, selection)
    except (DriftInputError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    drift["provenance"]["settings"]["scene_id"] = scene_id
    drift["provenance"]["settings"]["scene_bbox"] = bbox
    drift["uncertainty_note"] += (
        " The wind and current products have different grid spacing and analysis methods; "
        "nearshore resolution, sub-grid circulation, wave drift, and oil properties add uncertainty."
    )
    return {
        "drift": drift,
        "note": "OpenDrift backtracked the selected SAR feature using Copernicus Marine wind and current reanalysis. The feature is not confirmed oil, and this result does not identify a vessel.",
    }


@app.post("/api/vessels/match")
async def match_uploaded_ais(request: AISMatchRequest) -> dict[str, Any]:
    """Screen an analyst-supplied AIS CSV from an authorized provider."""
    try:
        drift = request.drift
        if not isinstance(drift, dict) or not drift.get("release_window") or not drift.get("origin_zone"):
            raise ValueError("A completed drift estimate is required before AIS matching.")
        reader = csv.DictReader(io.StringIO(request.csv_text.lstrip("\ufeff")))
        required = {"vessel_id", "timestamp", "longitude", "latitude"}
        headers = set(reader.fieldnames or [])
        if not required.issubset(headers):
            raise ValueError("CSV needs vessel_id, timestamp, longitude, and latitude columns.")
        observations = list(reader)
        if len(observations) > 100_000:
            raise ValueError("Choose a smaller AIS export with at most 100,000 position rows.")
        source = {
            "provider": request.provider.strip(),
            "dataset": request.dataset.strip(),
            "filename": Path(request.filename).name,
        }
        result = match_vessel_candidates({"drift": drift}, observations, ais_source=source)
    except (ValueError, VesselMatchingInputError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "vessel_candidates": result["vessel_candidates"],
        "provenance": result["provenance"],
        "note": "These are AIS proximity leads only. AIS gaps are not evidence of absence, and the score is not a probability of responsibility.",
    }
