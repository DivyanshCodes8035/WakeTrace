# WakeTrace

A team prototype for reviewing possible maritime oil-slick cases. Results are investigation leads and include uncertainty; they do not establish responsibility.

## Team modules

- `backend/app/detection/` — satellite image and possible slick detection
- `backend/app/drift/` — wind/current-driven oil drift simulations
- `backend/app/vessels/` — AIS matching and explainable candidate ranking
- `backend/app/api/` — API that connects backend results to the frontend
- `frontend/` — map, timeline, and evidence panels
- `data/sample/` — small sample files for the demo; see `data/README.md`

## Satellite scene screening

The detection module screens an analyst-supplied, calibrated Sentinel-1 sigma0 GeoTIFF in dB for
possible dark features. It does not download imagery, classify oil with a trained model, or treat
dark regions as confirmed spills. Install backend dependencies from `backend/`, then run the CLI
from that directory:

```powershell
python -m pip install -r requirements.txt
python -m app.detection.cli --help
```

Use the help output to provide the actual scene file, acquisition time, image provider and product
identifier. An aligned water mask is optional and reduces land/coastal detections. Review candidate
geometries and source metadata before adding the JSON result to a case. The detector score is a
heuristic review priority, not a probability. No real satellite scene is bundled in this project.

## Frontend preview

From `frontend/`, run `python -m http.server 8080` and open `http://localhost:8080`.
The interface has three focused pages: **Overview**, **Map**, and **Evidence**. The
pages load a clearly labeled synthetic UI fixture by default and keep `?case=<case_id>`
when navigating between pages. With the frontend served from the same origin as the
API, that query requests `/api/cases/<case_id>`. Leaflet and OpenStreetMap tiles need
an internet connection.

For a one-click local launch on Windows, double-click [`Start WakeTrace.bat`](Start%20WakeTrace.bat)
in the project folder. It opens the API and website in separate command windows and
opens the Overview page in your browser. Close those command windows when you are done.
To present the synthetic workflow, click **Run one-click demo** on Overview. It generates
a radar-style practice scene, inserts and screens a fictional dark patch, estimates a
possible origin, and ranks invented vessel tracks without asking for coordinates. This is
not real satellite imagery or evidence about a real spill or vessel.

## Search and show live satellite scenes

The Map page searches the official Copernicus Sentinel-1 GRD catalog for an area and
date range. Choose a result to request its calibrated VV or VH image, display the
scene in the map, and screen it for possible dark features. Scene search uses the
public Copernicus STAC catalog. Image processing needs a free Copernicus Data Space
account and an OAuth client; the secret stays in the Python backend.

1. Create a Copernicus Data Space account and register a Sentinel Hub OAuth client
   in its dashboard.
2. From the project root, run `Copy-Item .env.example .env`, then fill `CDSE_CLIENT_ID`
   and `CDSE_CLIENT_SECRET` in `.env`. Keep `.env` private; it is excluded from Git.
3. Start the API in one terminal from `backend/`:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.api.main:app --reload --port 8002
```

4. In a second terminal, serve `frontend/` with `python -m http.server 8080`.
5. Open `http://localhost:8080/map.html`, enter a small real ocean bounding box and
   dates, search Copernicus, and choose a scene to view and screen it.

The live scene and detection output are temporary until saved into a reviewed case.
Dark features are possible leads, not confirmed oil. The optional synthetic exercise
is separate from real-scene screening.

## Estimate a possible origin from a real scene

After a real scene is displayed, choose one of the screened dark features and click
**Estimate possible origin**. WakeTrace retrieves hourly surface wind and current
subsets from Copernicus Marine, then backtracks an OpenDrift OpenOil ensemble. The
products are global reanalysis and can lag the newest dates; the request will report
when the selected time or area is unavailable. A free Copernicus Marine account is
required. Sign in once from `backend/` with `copernicusmarine login`; the toolbox
keeps its credentials in its own local profile. Never put that password in the web
page or commit it to this project.

The result records product, dataset, variables, time range, area and model settings.
The 24-hour window is a configured search horizon, not a measured release time.
The feature remains only a dark radar candidate, and the origin polygon is uncertain.
No vessel matching runs without real, authorized, time-stamped AIS observations.
The app does not infer a responsible vessel.

When an analyst has an authorized AIS export, the result card accepts a CSV using
the column names in [`docs/data/ais-template.csv`](docs/data/ais-template.csv).
Enter the actual provider and dataset name with the upload. WakeTrace checks the
tracks against the possible-origin area and configured window; it cannot retrieve
global commercial AIS data without a provider integration and account.

Use **Save this reviewed case** to store the current review under `data/cases/` and
reopen it later from Overview, Map, or Evidence. Saved case files are kept out of
version control by default; share them only through your approved project process.

The forcing datasets are Copernicus Marine's [global hourly surface-current
analysis](https://data.marine.copernicus.eu/product/MULTIOBS_GLO_PHY_MYNRT_015_003/description)
and [global hourly reprocessed sea-surface winds](https://data.marine.copernicus.eu/product/WIND_GLO_PHY_L4_MY_012_006/description).
The toolbox supports time/area subsets through its Python API. Current and wind
grids have different resolution and method, so this is a review aid, not an
operational spill forecast.

## Simulated spill exercise

After loading a real Sentinel-1 scene on the Map page, use the **synthetic practice mode**:
click an offshore point in the displayed scene, then run the exercise. WakeTrace edits
only a temporary copy of the radar pixels to add a simplified dark patch, screens that
copy with the existing SAR dark-feature detector, reverses a fixed invented current and calm-wind assumption for
a simple possible-origin area, and ranks two invented AIS tracks. The map and result card
keep the exercise labeled as synthetic. This demonstrates how the pieces connect; it is
not a physical oil-signature model, real OpenDrift run, real AIS lookup, or evidence about
any real spill or vessel. The current detector identifies dark radar regions only.

If the satellite image service or OAuth setup is unavailable, click **Start offline
practice** on the Map page. This generates a radar-style practice image locally and runs
the same screening and fictional-route exercise without an account. The generated image
is not satellite data and must not be presented as a real observation.
