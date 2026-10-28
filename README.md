# WakeTrace

WakeTrace is a prototype workspace for reviewing possible maritime oil-slick cases. It brings together Sentinel-1 radar screening, wind/current drift backtracking, AIS evidence review, map playback, and case notes. Its outputs are possible leads with uncertainty; they do not confirm oil, identify a responsible vessel, or establish liability.

## What is in the current version

- **Overview** introduces the case and launches the guided practice demonstration.
- **Map** shows the scene and case geometry, supports Copernicus Sentinel-1 search, screens imagery with a dark-feature detector and experimental AI model, runs drift analysis, reviews vessel data, and includes a coastal impact what-if planner.
- **Evidence** presents observation time, the configured release search window, sources, model settings, uncertainty, and vessel-screening results.
- **Guided synthetic demonstration** walks through six visual steps with a generated radar-style scene, animated current/oil, a possible-origin area, fictional vessel tracks, and ranked practice leads.
- **Backend API** serves the frontend, processes requested real scene imagery, runs both radar screens and the real drift model, and accepts AIS exports supplied by the analyst.

The bundled case and guided demonstration are synthetic. Real-data searches and analyses require internet access, and selected services need credentials.

## Quick start on Windows

1. Install Python 3.10 or newer and ensure python is available in PowerShell.
2. Double-click [Start WakeTrace.bat](Start%20WakeTrace.bat) in this project folder.
3. Keep both command windows open. The launcher starts the API on port **8002**, serves the website on port **8080**, and opens the Overview page.
4. Select **Run one-click demo** to open the guided six-step practice workflow.

Check the API at [http://localhost:8002/api/health](http://localhost:8002/api/health). Interactive API documentation is at [http://localhost:8002/docs](http://localhost:8002/docs).

If the browser reports a connection error, confirm that both launcher windows are still running and that ports 8002 and 8080 are available. Opening frontend/index.html directly as a file:// URL does not start the API; use the launcher or the manual steps below. Leaflet and OpenStreetMap map tiles need internet access and may be unavailable if a network or tile service blocks requests.

### Manual start

Open two PowerShell terminals from the project folder. In the first:

    Set-Location backend
    python -m pip install -r requirements.txt
    python -m uvicorn app.api.main:app --reload --port 8002

In the second:

    Set-Location frontend
    python -m http.server 8080

Then open [http://localhost:8080](http://localhost:8080). The API and website are separate local services; leave both terminals running while you use the app.

## Guided demo: six visual steps

Choose **Run one-click demo** on Overview. The demo creates a local radar-style practice scene, plants a fictional dark patch, runs the practice pipeline, and opens the guided Map experience. Press the step buttons in order, or use **Play all steps**. Each step adds a visual layer:

1. **Find probable slick** — screen the generated radar-like image and outline a possible dark feature. Dark pixels are only a screening clue.
2. **Wind (what-if)** — adjust a simplified browser-side wind illustration to see how wind could change an oil path. This is an educational what-if, not the forcing used for the origin estimate.
3. **Water flow (current)** — view the practice current and its effect on the simulated flow.
4. **Trace back to a possible origin** — show the modeled/fictional backtrack, an uncertain origin area, and the oil-particle animation.
5. **Vessels near the origin** — show fictional timestamped routes moving against the same exercise clock.
6. **Rank the vessel leads** — compare fictional vessels by proximity and time coverage. A rank is practice output, not a probability of responsibility.

The background, slick, source point, current, and vessel tracks are generated or fictional. They are not Sentinel-1 imagery, observed wind/current, real AIS data, or evidence about an incident. The wind slider is a simplified browser-side illustration; it does not rerun the backend drift estimate. Use the **Classic view** link in the guided panel to return to the non-guided practice layout.

The Map also offers **Run simulated case** for an offline practice scene. When a real Sentinel-1 scene has been loaded, the separate practice mode can plant an artificial patch on a temporary copy of that scene. Neither practice mode changes the original image or creates real incident evidence.

## Real-data workflow

Use this workflow when reviewing an actual scene. The six visual demo steps above are illustrative; they do not replace the real-data review below.

1. **Choose an area and date range.** On Map, move and zoom the map to the ocean area, then use **Use current map area** or enter west, south, east, and north coordinates. Choose Sentinel-1 polarization (VV or VH) and dates. **Find newest scene automatically** searches the current map area over the latest 32 days. Manual searches are limited to 32 days; scene processing accepts a maximum 2.5° by 2.5° area.
2. **Find and load a Sentinel-1 scene.** Search the Copernicus Data Space catalog and select a Sentinel-1 GRD result. Catalog search is public; downloading and processing the image uses a Sentinel Hub OAuth client. WakeTrace displays the image and runs the rule-based dark-feature screen plus the experimental AI screen.
3. **Review possible slick-like areas.** Compare the amber rule-based outlines and purple AI outlines with the radar image, acquisition time, and provenance. The AI was trained on Gulf of Mexico examples and has not been validated for Mauritius. Wind, rain, waves, wakes, land, or other effects can resemble oil. Neither screen confirms oil; the AI score and dark-feature review score are not probabilities. Select an area before proceeding.
4. **Estimate a possible origin.** Ask WakeTrace to backtrack an OpenDrift OpenOil ensemble using hourly Open-Meteo ERA5 10 m winds and ERA5-Ocean currents. The default search horizon is 24 hours; the API accepts 6–120 hours and ensemble sizes of 50–2,000 (default 300). Review the origin area, release search window, model assumptions, and input sources. The configured horizon is the search interval; it is not a measured spill duration or release time.
5. **Review vessel information.** WakeTrace can query optional Global Fishing Watch AIS presence for the modeled area and dates. These are daily grid-cell presence leads, not exact positions or continuous routes. For a detailed comparison, provide an authorized AIS CSV with columns vessel_id, timestamp, longitude, and latitude; position_accuracy_m is optional. Enter the actual provider and dataset. The matcher compares reported tracks against the origin area, release window, and sampled particle corridor where timestamps align. It does not fetch commercial AIS data.
6. **Assess, save, and revisit the case.** Review the Map, case provenance, coverage gaps, ranking factors, and uncertainty. Save a reviewed real-data case from Map; the API stores it under data/cases/. Reopen a case through its case link/query. A high rank is a screening priority only. Missing AIS reports do not show that a vessel was absent, and no result assigns responsibility.

7. **Explore coastal exposure scenarios.** After choosing a possible radar feature and completing its drift review, select **Plan possible coastal exposure**. WakeTrace starts a separate OpenDrift OpenOil forward ensemble from the feature location at the forecast start time. Three runs vary windage and current uncertainty, showing individual particles and ensemble medians. Hourly Open-Meteo marine-current and 10 m wind forecast fields drive the model. Nearby UNEP-WCMC/IUCN Protected Planet marine/coastal polygons and OpenStreetMap-mapped reefs, wetlands/mangroves, and beaches are listed with distance and sampled times within a 10 km review screen. This is not a continuation of the historical backtrack, a probability envelope, or a confirmed impact forecast. NOAA ESI coverage is not confirmed for Mauritius; the planner does not draw NOAA layers. Coastal map coverage can be incomplete. See every source and limitation in the planner and saved case.


### Experimental AI runtime

The AI runs on processed real Sentinel-1 scenes alongside the regular dark-feature screen. Install its optional CPU runtime from the project root if it is not already available:

    python -m pip install -r backend/ml-requirements.txt

The model weights are included. Scores indicate similarity to training labels, not the probability that a feature is oil. The model has not been validated for Mauritius or all Sentinel-1 conditions. See the model card for dataset attribution, test metrics, and reproduction instructions. The licensed training dataset is not included in the repository.

### Copernicus credentials for real imagery

Create a Copernicus Data Space account and register a Sentinel Hub OAuth client. Copy .env.example to .env in the project folder and set:

    CDSE_CLIENT_ID=your-sentinel-hub-client-id
    CDSE_CLIENT_SECRET=your-sentinel-hub-client-secret

Restart the backend after changing .env. Keep credentials private; the file is excluded from Git. Public scene catalog search does not use these credentials, but fetching calibrated imagery does. Wind/current retrieval uses Open-Meteo's public historical API and does not require a separate Copernicus Marine login.

### Optional Global Fishing Watch presence

For the automatic daily presence query, configure GFW_API_TOKEN in the project-root .env using a token from [Global Fishing Watch API access](https://globalfishingwatch.org/our-apis/). Restart the API after adding it. This source is optional; use an authorized AIS export for detailed, timestamped route review.

## Data, assumptions, and limitations

- **Radar screening:** The rule-based detector screens calibrated Sentinel-1 sigma0 backscatter GeoTIFFs in dB for connected dark regions. The separate experimental AI model, **WakeTrace experimental Sentinel-1 slick-like TinyUNet v1**, was trained on 173 labeled Sentinel-1 tiles from Cantarell in the Gulf of Mexico (108 train, 43 validation, 22 held-out test). Its held-out test slick IoU was 0.618; this in-domain result does not establish performance in Mauritius. Model scores are not oil probabilities. Neither screen confirms oil. No real satellite scene is bundled with the project. See the [model card](backend/models/MODEL_CARD.md) and [training report](backend/models/oil_slick_training_report.json).
- **Drift:** OpenDrift backtracks a particle ensemble using Open-Meteo ERA5 and ERA5-Ocean reanalysis. Approximate grid spacing is about 25 km for wind and 50 km for current. Coastal circulation, waves, shoreline effects, oil properties, and forcing uncertainty limit precision; this is not an operational spill forecast.
- **Vessel presence:** Global Fishing Watch results are aggregated daily cells and can have incomplete coverage. A cell center is approximate and must not be drawn as a precise vessel route.
- **Coastal what-if:** OpenDrift OpenOil is run on a 9 × 9 forecast forcing grid built from Open-Meteo hourly currents and 10 m winds. Three 120-particle runs vary windage and current uncertainty. Stokes drift is disabled because the current forcing reader does not supply wave-drift vectors. The model uses a generic bunker-C oil assumption; real oil properties and nearshore circulation may differ. Coastal sensitivity layers combine UNEP-WCMC/IUCN protected-area polygons with community-mapped OpenStreetMap reefs, wetlands/mangroves, and beaches. Map coverage and update dates vary; absence from either source is not evidence of absence. The 10 km proximity screen is only a review aid.
- **Detailed AIS matching:** Scores and candidate order are review aids, not probabilities. Short gaps may be interpolated only under matcher limits; long gaps and implausible jumps break route segments. A match does not prove a vessel caused a release.
- **Coordinates and time:** GeoJSON positions use WGS84 longitude, latitude order. Timestamps use ISO 8601 UTC, normally ending in Z.
- **Provenance:** Review the source provider, dataset/product, time range, area, model settings, and uncertainty recorded with each result. Saved cases are local project files and are ignored by Git by default; handle or share them according to your team's data rules.

See [docs/data-contract.md](docs/data-contract.md) for the case schema, result details, matcher behavior, and provenance fields. A CSV header template is in [docs/data/ais-template.csv](docs/data/ais-template.csv).

## Project layout

    backend/app/api/          FastAPI routes and case storage
    backend/app/detection/    Sentinel-1 screens, Copernicus access, and practice scene generation
    backend/models/           Trained model weights, model card, and training report
    backend/scripts/          Model training script
    backend/app/drift/        OpenDrift model and Open-Meteo wind/current retrieval
    backend/app/vessels/      AIS matching and optional Global Fishing Watch presence
    frontend/                 Overview, Map, styles, and guided demo
    data/sample/              Bundled synthetic example
    docs/                     Data contract and AIS CSV template
    Start WakeTrace.bat       Windows local launcher

## API reference

The API runs on port 8002. Full schemas are shown at http://localhost:8002/docs.

| Method and path | Purpose |
| --- | --- |
| GET /api/health | Check that the API is running. |
| GET /api/cases/{case_id} | Load the bundled example or a saved case. |
| POST /api/cases | Save a reviewed real-data case under data/cases/. |
| GET /api/satellite/search | Search Sentinel-1 scenes by bounding box, dates, and polarization. |
| POST /api/satellite/scenes/{scene_id}/preview | Fetch a scene preview and run the rule-based and AI screens. |
| POST /api/satellite/scenes/{scene_id}/simulate | Plant and screen a fictional patch on a copy of a real scene. |
| POST /api/simulation/practice | Generate and run an offline synthetic practice scene. |
| POST /api/satellite/scenes/{scene_id}/drift | Backtrack a selected real feature using reanalysis forcing. |
| POST /api/vessels/search-presence | Query optional Global Fishing Watch daily presence. |
| POST /api/coastal/impact-plan | Build forecast sensitivity paths and query nearby OpenStreetMap coastal places. |
| POST /api/vessels/match | Compare an analyst-supplied AIS CSV with a completed drift estimate. |

The satellite search takes west, south, east, north, start_date, end_date, and optional polarization query parameters. API request/response models and validation messages are documented in the interactive API reference.

## Standalone SAR screening CLI

The detector can also screen an analyst-supplied calibrated Sentinel-1 sigma0 GeoTIFF. From backend/:

    python -m pip install -r requirements.txt
    python -m app.detection.cli --help

Use the CLI help for required scene path, acquisition time, provider, and product metadata. An aligned water mask is optional and can reduce land/coast detections. Review the JSON output and provenance before attaching it to a case. The detector score is a heuristic review priority, not a probability.
