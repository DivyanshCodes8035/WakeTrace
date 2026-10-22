# Shared case data contract (v0.1)

All module outputs use this common case shape. Coordinates use GeoJSON order `[longitude, latitude]`; timestamps use ISO 8601 in UTC (`Z`). The bundled `data/sample/demo_case.json` is synthetic and must not be treated as a real incident.

## Module handoffs

- **Detection** fills `detection.source`, `acquired_at`, `confidence`, and `geometry`.
- **Drift** fills `drift.model`, `release_window`, `origin_zone`, `ensemble_size`, and `uncertainty_note`.
- **Vessel matching** fills `vessel_candidates` and records source data in `provenance.ais_data`.
- **API/frontend** read the same JSON format and must preserve the provenance and uncertainty fields.

## Drift result details

`drift.release_window.start` and `drift.release_window.end` are ISO 8601 UTC timestamps.
For the current OpenOil backtracking implementation, this is the configured search horizon:
the start is the oldest simulated time and the end is the slick observation time. It must not
be presented as a measured or independently inferred spill duration. `drift.origin_zone` is a
GeoJSON geometry containing the oldest backward ensemble positions (usually a Polygon hull;
it can be a LineString or Point for a degenerate ensemble). Coordinates remain
`[longitude, latitude]`.

Drift results also include `drift.provenance.input_sources`, an array identifying the wind and
current forcing datasets used, and `drift.provenance.settings`, which records simulation
direction, horizon, time step, requested/returned ensemble size, oil type assumption, and
random seed. Input source entries should include enough detail to identify/retrieve the data,
such as provider, dataset/version, and URL or file path. The OpenOil backtrack does not apply
forward oil weathering processes; outputs are possible origins under the supplied forcing, not
proof of release location or vessel responsibility.

For a synthetic end-to-end run only, execute `python -m app.drift.demo` from the
`backend/` directory. The example labels its invented geometry and constant
forcing as synthetic and must not be added to a case record as incident data.

## Candidate shape (when candidates are added)

Each `vessel_candidates` item should include a synthetic or authorized vessel identifier, a track as GeoJSON, a score breakdown with named factors, a data-quality note, and a plain-language explanation. A priority score is an investigation aid, not a probability of responsibility.
## AIS candidate screening

The vessel matcher accepts AIS observations only when supplied by an authorized source. It does
not download AIS data or create candidate vessels. Each input observation has `vessel_id`,
`timestamp` (ISO 8601 with a UTC offset or `Z`), `longitude`, and `latitude`; coordinates
are validated as GeoJSON order `[longitude, latitude]`. Optional `position_accuracy_m` is retained
as a data-quality signal. A source record supplied by the caller is copied to `provenance.ais_data`.

The function screens in-window AIS positions against the case's static `drift.origin_zone`.
Candidates outside the configured search radius are omitted. The priority score (0–100) is
`0.75 × origin_proximity + 0.25 × release_window_coverage`; both factor scores and weights are
returned for review. This score is not a probability. The track geometry, aligned
`track_timestamps` and `position_accuracy_m` arrays, rank, closest approach, data-quality note, and
plain-language explanation are returned for each candidate.
Replay settings and counts are recorded under `provenance.ais_matching`.

The current drift contract contains one origin-zone geometry and a release-time interval, not a
time-varying drift corridor. Therefore the matcher is only a coarse spatial-temporal screen: it
does not establish that a vessel crossed a modeled trajectory, released oil, or caused a spill.
Sparse or missing AIS observations are not evidence that a vessel was absent. Real matching
requires authorized, time-stamped AIS data and the corresponding provider/dataset details; the
bundled synthetic case has no AIS observations, so its candidate list remains empty.

Example input shape (illustrative schema only; values below are not case or AIS data):

```json
[
  {
    "vessel_id": "authorized-source-vessel-id",
    "timestamp": "2026-10-09T12:00:00Z",
    "longitude": 70.04,
    "latitude": 18.03,
    "position_accuracy_m": 20
  }
]
```

## Satellite detection result details

`detection.geometry` is the leading candidate boundary in GeoJSON WGS84 coordinate order, or
`null` when no component meets the screen settings. `detection.candidates` contains screened
regions with geometry, pixel count, scene-relative contrast, and a heuristic screening score.
`detection.confidence` remains `null`: that score is not a calibrated probability that a dark SAR
feature is oil. `detection.provenance.input_sources` records the actual image provider, product
identifier, and file; `detection.provenance.settings` records the band, polarization, threshold,
and component filter used. An optional `detection.preview_url` may point to a quicklook of that
same authorized scene; a basemap is not a satellite observation and must not be used as one.

The detector screens calibrated Sentinel-1 sigma0 backscatter GeoTIFFs in dB for connected dark
features. Low wind, wave fronts, rain, ship wakes, land, and other look-alikes can also appear dark.
A water mask reduces land/coast false positives but does not distinguish oil from oceanic
look-alikes. Every feature needs analyst review and independent evidence. No real scene is bundled;
the frontend case remains synthetic until an authorized product is supplied.

From `backend/`, run `python -m app.detection.cli --help` for the image-screening command. Use a
calibrated scene and accurate provider, product, and acquisition metadata. The command outputs a
detection object as JSON; review it before merging it into a case record.

The Map page searches the public Copernicus STAC catalog through `GET /api/satellite/search`
and displays a selected Sentinel-1 scene through `POST /api/satellite/scenes/{scene_id}/preview`.
The latter uses Sentinel Hub Process API to retrieve a calibrated sigma0 dB GeoTIFF, screens
that scene with the SAR dark-feature detector, and returns a quicklook plus detection result.
It needs a Copernicus Data Space Sentinel Hub OAuth client configured as `CDSE_CLIENT_ID` and
`CDSE_CLIENT_SECRET` in the ignored project-root `.env` file; credentials remain on the backend.
The searched scene metadata and detection sources/settings follow the existing `detection`
shape. The current browser-session result is not saved into a case, and drift or AIS analysis
does not run automatically. Start the API with `python -m uvicorn app.api.main:app --reload
--port 8000` from `backend/`, and serve `frontend/` on port 8080.



## Live Copernicus Marine drift input

For a selected Sentinel-1 candidate, `POST /api/satellite/scenes/{scene_id}/drift` retrieves small time/area subsets and runs the OpenDrift OpenOil backtrack. The current source is `cmems_obs-mob_glo_phy-cur_my_0.25deg_PT1H-i` (variables `uo`, `vo`; hourly total surface current analysis including geostrophic, Ekman and tidal components). The wind source is `cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H` (variables `eastward_wind`, `northward_wind`; hourly 10 m wind reanalysis corrected using scatterometer observations).

Each `drift.provenance.input_sources` entry records provider, product, dataset, URL, variables, requested UTC range, area and resolution note. `drift.provenance.settings` records model parameters and selected scene. A Copernicus Marine Toolbox login is required; the API does not fall back to synthetic forcing. Data coverage may lag the latest Sentinel-1 scenes. Wind and current grids differ, and missing waves, local circulation, coastline resolution, oil properties and forcing uncertainty must be considered. Live results remain temporary until an analyst reviews and saves them to a case.

Vessel matching does not run automatically from this endpoint. It requires genuine, authorized, time-stamped AIS observations covering the release window. Simulated practice tracks must never be reused as incident evidence.

The live UI can submit a CSV to `POST /api/vessels/match` after a drift estimate. Required columns are `vessel_id`, `timestamp`, `longitude`, and `latitude`; optional `position_accuracy_m` is retained by the matcher. The analyst must enter the actual AIS provider and dataset name. See `docs/data/ais-template.csv` for the header. This endpoint does not download AIS data and must not be supplied with synthetic practice tracks.

`POST /api/cases` saves the reviewed, real-data case JSON under `data/cases/`; `GET /api/cases/{case_id}` loads either the synthetic fixture or a saved case. The SAR quicklook image is excluded from saved JSON to keep case files small. Saved case files are ignored by Git by default.
