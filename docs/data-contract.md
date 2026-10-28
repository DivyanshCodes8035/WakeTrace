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

Drift results may include `drift.animation.frames`, a compact playback sample with UTC `time`
and per-particle `[longitude, latitude]` positions. The live OpenDrift response includes at
most 72 frames and 96 particles; positions can be null when a particle is inactive. This is a
visual sample of modeled trajectories, not additional observation data. Drift results also
include `drift.provenance.input_sources`, an array identifying the wind and current forcing
datasets used, and `drift.provenance.settings`, which records simulation
direction, horizon, time step, requested/returned ensemble size, oil type assumption, and
random seed. Input source entries should include enough detail to identify/retrieve the data,
such as provider, dataset/version, and URL or file path. The OpenOil backtrack does not apply
forward oil weathering processes; outputs are possible origins under the supplied forcing, not
proof of release location or vessel responsibility.

For a synthetic end-to-end run only, execute `python -m app.drift.demo` from the
`backend/` directory. The example labels its invented geometry and constant
forcing as synthetic and must not be added to a case record as incident data.

## Candidate shape (when candidates are added)

Each `vessel_candidates` item should include a synthetic or authorized vessel identifier, a track as GeoJSON, timestamped `track_positions` for playback when available, a score breakdown with named factors, a data-quality note, and a plain-language explanation. A priority score is an investigation aid, not a probability of responsibility.
## AIS candidate screening

The vessel matcher accepts AIS observations only when supplied by an authorized source. It does
not download AIS data or create candidate vessels. Each input observation has `vessel_id`,
`timestamp` (ISO 8601 with a UTC offset or `Z`), `longitude`, and `latitude`; coordinates
are validated as GeoJSON order `[longitude, latitude]`. Optional `position_accuracy_m` is retained
as a data-quality signal. A source record supplied by the caller is copied to `provenance.ais_data`.

The function screens in-window AIS positions against `drift.origin_zone` and, when sampled
`drift.animation.frames` are available, compares AIS positions with the nearest particle frame
within one hour. Candidates outside the configured search radius of both are omitted. To avoid missing a pass between
reports, it samples 19 estimated positions only when two adjacent AIS reports are at most 30 minutes
apart and imply a speed no greater than 60 knots. Longer gaps are never filled for scoring. The
priority score (0–100) is `0.55 × origin_proximity + 0.25 × release_window_span + 0.20 × particle_corridor_proximity` when a time-matched particle frame is available; otherwise it uses `0.75 × origin_proximity + 0.25 × release_window_span`. The span factor
measures the time between the first and last report, not continuous AIS coverage. Factor scores
and weights are returned for review; the score is not a probability. Route lines break after gaps
over two hours or implausible jumps. Each candidate includes its track, aligned `track_timestamps`
and `position_accuracy_m` arrays, rank, closest-approach time and method, data-quality note, and
plain-language explanation. Replay settings and counts are recorded under
`provenance.ais_matching`.

The particle corridor is a sampled model trajectory and depends on its forcing and assumptions.
Short AIS-gap interpolation is a straight-line estimate between two AIS reports, not an observed
position. A trajectory match or high score does not establish that a vessel released oil or caused a spill.
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



## Historical forcing used by OpenDrift

For a selected Sentinel-1 candidate, `POST /api/satellite/scenes/{scene_id}/drift` retrieves public historical forcing and runs the OpenDrift OpenOil backtrack. To avoid a separate account setup, it uses Open-Meteo's ERA5-Ocean hourly current velocity/direction and ERA5 hourly 10 m wind speed/direction. Current directions are converted to east/north components; wind directions are converted from meteorological “from” direction to east/north components. No forcing values are invented.

Each `drift.provenance.input_sources` entry records provider, product, dataset, URL, variables, requested UTC range, area and resolution note. `drift.provenance.settings` records model parameters and selected scene. ERA5-Ocean currents are approximately 0.5 degree (~50 km) and ERA5 winds approximately 0.25 degree (~25 km), so the modeled origin is a broad estimate; local coastal circulation, waves, shoreline processes, oil properties and forcing uncertainty are not fully represented. Open-Meteo data should be attributed to Open-Meteo and its upstream sources. Live results remain temporary until an analyst reviews and saves them to a case.

## Coastal impact what-if planner

`POST /api/coastal/impact-plan` accepts an analyst-selected GeoJSON feature and a forecast horizon (6–72 hours). It samples hourly Open-Meteo marine currents and 10 m winds on a 9 × 9 grid, writes OpenDrift-compatible readers, and runs three 120-particle forward OpenOil ensembles. Wind-drift factors are 1%/2%/3%; current-uncertainty settings are 0.05/0.1/0.2 m/s. The model uses a generic bunker-C oil assumption and disables Stokes drift because the current reader does not supply wave-drift vectors. These sensitivity runs are not probabilities or confidence bounds, and start at the forecast time rather than at a potentially historical satellite acquisition time.

The planner queries OpenStreetMap community-mapped reefs, beaches, and wetlands/mangroves through Overpass, and queries marine/coastal protected polygons from the UNEP-WCMC/IUCN Protected Planet WDPCA feature service, for a bounded area around all particle paths. It records providers, query bounds, feature counts, available snapshot/version timestamps, query time, and forecast source URLs. Distances and sampled times inside 10 km are review aids, not landfall predictions. Data may be incomplete or outdated; no returned feature is evidence that no sensitive place exists. NOAA ESI coverage must be confirmed per selected area before use; it is not presented for Mauritius by this feature. The live plan is included in `coastal_impact_plan` when the analyst saves the reviewed real-data case.

After a real drift estimate, the map automatically calls `POST /api/vessels/search-presence` to query Global Fishing Watch's `public-global-presence:latest` AIS-presence report for the modeled origin polygon and release dates. Configure a Global Fishing Watch API token as `GFW_API_TOKEN` in the ignored project-root `.env`; get a token from [Global Fishing Watch API access](https://globalfishingwatch.org/our-apis/). The token stays on the backend. The endpoint requests 0.01-degree cells, daily time aggregation, individual vessel grouping, and no spatial aggregation. `ais_presence.provenance` records the provider, dataset, query geometry and dates, settings, upstream result counts, and the number of coordinate rows parsed.

This automatic source returns daily AIS presence summarized in grid cells. When GFW supplies a vessel identity, the row can include it; otherwise it remains an anonymous presence cell. A cell center is an approximate location, not an exact ship position. The report is not a raw, continuous AIS track and cannot support exact closest-approach timing. WakeTrace displays these results as approximate presence markers, never route lines. GFW documents AIS vessel presence as a gridded dataset and warns that it is not a vessel track ([4Wings API](https://globalfishingwatch.org/our-apis/documentation/docs/v3/4wings), [report endpoint](https://globalfishingwatch.org/our-apis/documentation/docs/v3/4wings/report)). Data availability and report limits depend on GFW. An empty result means the query returned no rows; it does not prove that vessels were absent.

The detailed CSV matcher remains available when an analyst has authorized, time-stamped AIS observations. Simulated practice tracks must never be reused as incident evidence.

The live UI can submit a CSV to `POST /api/vessels/match` after a drift estimate. Required columns are `vessel_id`, `timestamp`, `longitude`, and `latitude`; optional `position_accuracy_m` is retained by the matcher. The analyst must enter the actual AIS provider and dataset name. See `docs/data/ais-template.csv` for the header. This detailed-track endpoint does not download raw AIS data and must not be supplied with synthetic practice tracks.

`POST /api/cases` saves the reviewed, real-data case JSON under `data/cases/`; `GET /api/cases/{case_id}` loads either the synthetic fixture or a saved case. The SAR quicklook image is excluded from saved JSON to keep case files small. Saved case files are ignored by Git by default.
