const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const colors = {
  slick: { color: "#c97a0a", weight: 3, fillColor: "#e9a933", fillOpacity: 0.42 },
  origin: { color: "#0f7c86", weight: 3, fillColor: "#55b8ad", fillOpacity: 0.3, dashArray: "7 5" },
  track: { color: "#35507a", weight: 3, opacity: 0.9, dashArray: "6 6" },
  secondary: { color: "#b5dcce", weight: 2, fillColor: "#83cbb9", fillOpacity: 0.14, dashArray: "3 5" },
};
const historicalIncident = { latitude: -20.4382, longitude: 57.7447 };

const hasMapLibrary = Boolean(window.L);
let map = null;
let layers = null;
let sceneOverlay = null;
let incidentMarker = null;
let simulationMarker = null;
let simulationSlickMarker = null;
let userChoseMapArea = false;
let selectedScene = null;
let selectedSceneBounds = null;

function addGeometry(geometry, style, label) {
  if (!geometry || !map || !layers) return false;
  try {
    const geojson = ["Feature", "FeatureCollection"].includes(geometry.type)
      ? geometry : { type: "Feature", properties: {}, geometry };
    L.geoJSON(geojson, { style }).eachLayer((layer) => layer.bindPopup(label)).addTo(layers);
    return true;
  } catch (error) {
    console.warn("Skipped invalid case geometry", error);
    return false;
  }
}

function fitToCase() {
  if (layers?.getLayers().length) map.fitBounds(layers.getBounds(), { padding: [36, 36], maxZoom: 11 });
}

function apiRoot() {
  return "http://" + (window.location.hostname || "localhost") + ":8002";
}

function bboxFromForm(form) {
  return ["west", "south", "east", "north"].map((name) => Number(form.elements[name].value));
}

function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

if (!hasMapLibrary) {
  $("map-message").textContent = "Map library unavailable. Check your internet connection and reload.";
} else {
  map = L.map("map", { scrollWheelZoom: false, zoomControl: true, zoomAnimation: !reduceMotion });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.setView([0, 0], 2);
  map.on("dragend click", () => { userChoseMapArea = true; });
  layers = L.featureGroup().addTo(map);
  $("fit-button").addEventListener("click", fitToCase);
  map.on("click", (event) => {
    userChoseMapArea = true;
    if (!selectedScene || !$("simulation-panel").open) return;
    if (simulationMarker) map.removeLayer(simulationMarker);
    const point = { latitude: event.latlng.lat, longitude: event.latlng.lng };
    simulationMarker = L.circleMarker([point.latitude, point.longitude], {
      radius: 8, color: "#ffffff", weight: 3, fillColor: "#d44d69", fillOpacity: 1,
    }).bindPopup("Fictional spill release point selected for the exercise.").addTo(map);
    $("run-simulation").disabled = false;
    $("run-simulation").textContent = "Run simulated spill exercise";
    $("simulation-status").textContent = "Release point selected. This point and the vessel tracks will be fictional.";
    window.simulationSourcePoint = point;
  });
  window.addEventListener("resize", () => map.invalidateSize());
}

WakeTraceCase.load()
  .then((caseData) => {
    WakeTraceCase.markSynthetic(caseData);
    const detection = caseData.detection || {};
    document.title = "WakeTrace | Map | " + (caseData.case_id || "Case");
    $("case-title").textContent = caseData.title || caseData.case_id || "Untitled case";
    $("case-subtitle").textContent = "Observation · " + WakeTraceCase.formatUtc(detection.acquired_at);
    const inputSource = detection.provenance?.input_sources?.[0] || {};
    $("scene-source").textContent = [inputSource.provider, inputSource.dataset].filter(Boolean).join(" · ") || detection.source || "Source not recorded";
    $("scene-acquired").textContent = "Acquired · " + WakeTraceCase.formatUtc(detection.acquired_at);
    if (detection.preview_url) {
      $("scene-preview").src = detection.preview_url;
      $("scene-preview").hidden = false;
      $("scene-preview-status").hidden = true;
    }
    if (!hasMapLibrary) return;
    const sarCandidates = detection.candidates || [];
    addGeometry(detection.geometry, colors.slick,
      sarCandidates.length ? "Leading SAR dark-feature candidate · analyst review required" : "Slick boundary recorded in case");
    sarCandidates.slice(1).forEach((candidate, index) =>
      addGeometry(candidate.geometry, colors.secondary, "Other SAR dark feature " + (index + 2) + " · analyst review required"));
    $("legend-dark-features").hidden = sarCandidates.length < 2;
    addGeometry(caseData.drift?.origin_zone, colors.origin, "Possible origin area from drift simulation");
    let tracks = 0;
    (caseData.vessel_candidates || []).forEach((candidate) => {
      if (addGeometry(candidate.track, colors.track, "Possible vessel track · not evidence of responsibility")) tracks += 1;
    });
    $("legend-track").hidden = tracks === 0;
    if (layers.getLayers().length) {
      map.invalidateSize();
      fitToCase();
      $("map-message").hidden = true;
    } else {
      $("map-message").textContent = "Search for a real satellite scene to show its image on the map.";
    }
  })
  .catch((error) => {
    $("case-title").textContent = "Case data unavailable";
    $("case-subtitle").textContent = error.message;
    $("case-badge").textContent = "NO CASE";
    $("map-message").textContent = error.message;
  });

const searchForm = $("scene-search-form");
$("use-map-bounds").addEventListener("click", () => {
  if (!map) {
    $("upload-status").textContent = "The map is not available yet.";
    return;
  }
  const bounds = map.getBounds();
  const values = {
    west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(),
  };
  Object.entries(values).forEach(([name, value]) => {
    searchForm.elements[name].value = value.toFixed(4);
  });
  $("upload-status").textContent = "Search area copied from the current map view. Set real dates, then search.";
});

$("auto-find-scene").addEventListener("click", () => {
  if (!map) {
    $("upload-status").textContent = "The map is not available yet.";
    return;
  }
  if (!userChoseMapArea) {
    $("upload-status").textContent = "Click or drag the map to the real incident area first. The map may be showing the synthetic example location.";
    return;
  }
  const bounds = map.getBounds();
  if (bounds.getEast() - bounds.getWest() > 5 || bounds.getNorth() - bounds.getSouth() > 5) {
    $("upload-status").textContent = "Zoom in on the real ocean area first. Then click Find newest scene automatically again.";
    return;
  }
  const values = {
    west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(),
  };
  Object.entries(values).forEach(([name, value]) => {
    searchForm.elements[name].value = value.toFixed(4);
  });
  const end = new Date();
  const start = new Date(end.getTime() - 31 * 24 * 60 * 60 * 1000);
  searchForm.elements.end_date.value = end.toISOString().slice(0, 10);
  searchForm.elements.start_date.value = start.toISOString().slice(0, 10);
  searchForm.elements.polarization.value = "VV";
  searchForm.dataset.autoSelectNewest = "true";
  $("upload-status").textContent = "Searching the visible map area for the newest VV radar image from the last 32 days…";
  searchForm.requestSubmit();
});

function startOfflinePractice() {
  selectedScene = { id: "OFFLINE-SYNTHETIC-PRACTICE", synthetic: true };
  selectedSceneBounds = [57.2, -20.8, 58.2, -20.0];
  window.simulationSourcePoint = { longitude: 57.7, latitude: -20.4 };
  $("simulation-panel").hidden = false;
  $("simulation-panel").open = true;
  $("simulation-status").textContent = "Starting a fully generated practice scene. No satellite or incident data is used.";
  $("run-simulation").disabled = false;
  $("run-simulation").textContent = "Run offline practice";
  $("run-simulation").click();
}

$("start-offline-practice").addEventListener("click", startOfflinePractice);

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("upload-status");
  const button = form.querySelector("button[type=submit]");
  const results = $("scene-results");
  status.textContent = "Searching the Copernicus Sentinel-1 catalog…";
  results.replaceChildren();
  button.disabled = true;
  try {
    const params = new URLSearchParams(new FormData(form));
    const response = await fetch(apiRoot() + "/api/satellite/search?" + params.toString());
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Satellite search failed.");
    if (!result.scenes.length) {
      status.textContent = "No matching Sentinel-1 scenes found. Try a wider date range or nearby ocean area.";
      return;
    }
    status.textContent = result.scenes.length + " real Copernicus scene(s) found. Choose one to display and screen it.";
    result.scenes.forEach((scene) => {
      const card = document.createElement("article");
      card.className = "scene-result-card";
      const details = document.createElement("div");
      details.append(
        textNode("strong", (scene.platform || "Sentinel-1").toUpperCase() + " radar image", "scene-title"),
        textNode("span", [scene.datetime ? WakeTraceCase.formatUtc(scene.datetime) : "Time unavailable", scene.platform, scene.mode, scene.orbit, (scene.polarizations || []).join("/")].filter(Boolean).join(" · ")),
        textNode("span", "Product ID · " + (scene.id || "Unavailable"), "scene-product-id"),
      );
      const select = textNode("button", "Show image + screen", "scene-select-button");
      select.type = "button";
      select.addEventListener("click", () => showScene(scene, form, status, select));
      card.append(details, select);
      results.append(card);
    });
    if (form.dataset.autoSelectNewest === "true") {
      form.dataset.autoSelectNewest = "false";
      results.querySelector(".scene-select-button")?.click();
    }
  } catch (error) {
    status.textContent = error.message + " Check that the WakeTrace API is running.";
  } finally {
    button.disabled = false;
  }
});

async function showScene(scene, form, status, button) {
  button.disabled = true;
  selectedScene = null;
  selectedSceneBounds = null;
  $("simulation-panel").hidden = true;
  window.currentRealDrift = null;
  $("real-detection-results").hidden = true;
  $("real-drift-output").hidden = true;
    $("save-real-case").hidden = true;
    $("save-case-status").hidden = true;
    $("real-ais-form").hidden = true;
    $("real-ais-status").hidden = true;
    $("real-ais-candidates").replaceChildren();
  $("simulation-results").hidden = true;
  $("run-simulation").disabled = true;
  if (simulationMarker) map.removeLayer(simulationMarker);
  simulationMarker = null;
  if (simulationSlickMarker) map.removeLayer(simulationSlickMarker);
  simulationSlickMarker = null;
  window.simulationSourcePoint = null;
  status.textContent = "Fetching and screening the real satellite image…";
  $("map-message").textContent = "Loading the Sentinel-1 radar image from Copernicus…";
  $("map-message").hidden = false;
  $("map").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  try {
    const response = await fetch(apiRoot() + "/api/satellite/scenes/" + encodeURIComponent(scene.id) + "/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox: bboxFromForm(form), polarization: form.elements.polarization.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Could not display the selected scene.");
    if (!map) throw new Error("Map library unavailable.");
    selectedScene = scene;
    selectedSceneBounds = bboxFromForm(form);

    layers.clearLayers();
    if (sceneOverlay) map.removeLayer(sceneOverlay);
    sceneOverlay = L.imageOverlay(result.preview.preview_url, result.preview.preview_bounds, { opacity: 0.9 }).addTo(map);
    const candidates = result.detection.candidates || [];
    candidates.forEach((candidate, index) => {
      addGeometry(candidate.geometry, index === 0 ? colors.slick : colors.secondary,
        "Dark SAR feature " + (index + 1) + " · review required; not confirmed oil");
    });
    const [west, south, east, north] = bboxFromForm(form);
    const incidentInScene = historicalIncident.longitude >= west && historicalIncident.longitude <= east
      && historicalIncident.latitude >= south && historicalIncident.latitude <= north;
    if (incidentMarker) map.removeLayer(incidentMarker);
    incidentMarker = null;
    $("historical-reference").hidden = !incidentInScene;
    $("legend-reference").hidden = !incidentInScene;
    if (incidentInScene) {
      incidentMarker = L.circleMarker([historicalIncident.latitude, historicalIncident.longitude], {
        radius: 9, color: "#ffffff", weight: 3, fillColor: "#c13c50", fillOpacity: 1,
      }).bindPopup("Approximate reported position for the documented MV Wakashio incident. Reference only; this is not a detected slick boundary or an algorithmic vessel match.").addTo(map);
    }
    $("scene-source").textContent = result.scene.source + " · " + result.scene.id;
    $("scene-kind").textContent = "SATELLITE SCENE";
    $("scene-acquired").textContent = "Acquired · " + WakeTraceCase.formatUtc(result.scene.datetime);
    $("scene-preview").src = result.preview.preview_url;
    $("scene-preview").hidden = false;
    $("scene-preview-status").hidden = true;
    $("case-badge").textContent = "LIVE COPERNICUS SCENE";
    $("case-badge").classList.add("real-case-badge");
    $("case-title").textContent = "Sentinel-1 scene review";
    $("case-subtitle").textContent = "Real radar observation · " + WakeTraceCase.formatUtc(result.scene.datetime);
    $("case-notice").textContent = result.note;
    $("case-notice").hidden = false;
    window.realCaseData = {
      case_id: "review-" + Date.now(),
      title: "Sentinel-1 review · " + WakeTraceCase.formatUtc(result.scene.datetime),
      synthetic: false,
      detection: {
        source: result.detection.source,
        acquired_at: result.detection.acquired_at,
        confidence: null,
        geometry: result.detection.geometry,
        candidates: result.detection.candidates,
        note: result.detection.note,
        provenance: result.detection.provenance,
      },
      drift: {},
      vessel_candidates: [],
      provenance: { ais_data: [] },
    };
    $("save-real-case").hidden = false;
    $("save-case-status").hidden = true;
    $("legend-slick").hidden = candidates.length === 0;
    $("legend-dark-features").hidden = candidates.length < 2;
    $("legend-origin").hidden = true;
    $("legend-track").hidden = true;
    $("legend-scene").hidden = false;
    $("legend-scene").lastChild.textContent = "Copernicus Sentinel-1 scene";
    $("legend-sim-source").hidden = true;
    $("legend-sim-slick").hidden = true;
    $("map-overlay-chip").textContent = "DRIFT ORIGIN ESTIMATE";
    $("map-footnote").textContent = result.detection.note + (incidentInScene
      ? " The red marker shows the approximate reported Wakashio incident position from NOAA; it is reference context, not a detected oil boundary."
      : "") + " The scene and outlines are temporary and are not saved to the case.";
    $("map-description").textContent = "Observed dark radar features · analyst review required";
    map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 12 });
    $("real-detection-results").hidden = candidates.length === 0;
    $("real-candidate-list").replaceChildren();
    candidates.forEach((candidate, index) => {
      const card = document.createElement("article");
      card.className = "candidate-card";
      const title = textNode("strong", "Dark feature " + (index + 1), "scene-title");
      const detail = textNode("p", candidate.pixel_count + " pixels · " + candidate.contrast_from_scene_median_db + " dB darker than the scene median · review priority " + candidate.screening_score + " / 100. This score is not an oil probability.");
      const action = textNode("button", "Estimate possible origin", "scene-select-button");
      action.type = "button";
      action.addEventListener("click", () => estimateRealDrift(candidate, action));
      card.append(title, detail, action);
      $("real-candidate-list").append(card);
    });
    $("simulation-panel").hidden = false;
    $("simulation-panel").open = false;
    $("simulation-status").textContent = "Expand Practice mode only if you want to try a clearly fictional exercise.";
    if (candidates.length) {
      status.textContent = candidates.length + " possible dark radar feature(s) found. Select a feature below to estimate its possible origin; the features are not confirmed oil.";
      $("map-message").hidden = true;
    } else {
      status.textContent = "The image loaded, but no dark-feature candidates met the screening settings. This does not prove there is no oil.";
      $("map-message").textContent = "No dark-feature candidates met the screen settings.";
      $("map-message").hidden = false;
    }
  } catch (error) {
    status.textContent = error.message;
    $("map-message").textContent = "Image could not be loaded: " + error.message;
    $("map-message").hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function estimateRealDrift(candidate, button) {
  if (!selectedScene || !selectedSceneBounds) return;
  const status = $("real-drift-status");
  button.disabled = true;
  document.querySelectorAll("#real-candidate-list button").forEach((item) => { item.disabled = true; });
  status.textContent = "Getting real Copernicus wind and current data, then backtracking an OpenDrift ensemble… This may take a few minutes.";
  $("real-drift-output").hidden = true;
  try {
    const response = await fetch(apiRoot() + "/api/satellite/scenes/" + encodeURIComponent(selectedScene.id) + "/drift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bbox: selectedSceneBounds,
        polarization: selectedScene.polarization || searchForm.elements.polarization.value,
        geometry: candidate.geometry,
        acquired_at: selectedScene.datetime,
        backtrack_hours: 24,
        ensemble_size: 300,
        seed: 42,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "The real-data drift estimate could not be completed.");
    if (window.realOriginLayer) layers.removeLayer(window.realOriginLayer);
    window.realOriginLayer = L.geoJSON(result.drift.origin_zone, { style: colors.origin }).bindPopup("Possible origin area · uncertain model result").addTo(layers);
    $("legend-origin").hidden = false;
    const start = WakeTraceCase.formatUtc(result.drift.release_window.start);
    const end = WakeTraceCase.formatUtc(result.drift.release_window.end);
    $("real-drift-title").textContent = "Possible origin area · " + result.drift.ensemble_size + " particles";
    $("real-drift-text").textContent = "OpenDrift backtracked this selected dark feature to an uncertain possible origin area. Search window: " + start + " to " + end + ". " + result.drift.uncertainty_note;
    $("real-drift-sources").textContent = "Real data used: " + result.drift.provenance.input_sources.map((source) => source.product + " (" + source.dataset + ")").join(" and ") + ". The release window is the model search period, not a measured spill time.";
    $("real-drift-output").hidden = false;
    window.currentRealDrift = result.drift;
    window.realCaseData.drift = result.drift;
    $("real-ais-form").hidden = false;
    $("real-ais-status").hidden = true;
    $("real-ais-candidates").replaceChildren();
    status.textContent = result.note;
    map.fitBounds(window.realOriginLayer.getBounds(), { padding: [40, 40], maxZoom: 11 });
  } catch (error) {
    status.textContent = error.message;
  } finally {
    document.querySelectorAll("#real-candidate-list button").forEach((item) => { item.disabled = false; });
  }
}

$("real-ais-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.currentRealDrift) return;
  const form = event.currentTarget;
  const button = $("match-ais-button");
  const status = $("real-ais-status");
  const file = form.elements.ais_file.files[0];
  if (!file) {
    status.hidden = false;
    status.textContent = "Choose a CSV export from your AIS data provider first.";
    return;
  }
  button.disabled = true;
  status.hidden = false;
  status.textContent = "Checking real AIS positions against the possible origin area and release window…";
  $("real-ais-candidates").replaceChildren();
  try {
    const response = await fetch(apiRoot() + "/api/vessels/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drift: window.currentRealDrift,
        provider: form.elements.provider.value,
        dataset: form.elements.dataset.value,
        filename: file.name,
        csv_text: await file.text(),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "AIS review failed.");
    result.vessel_candidates.forEach((candidate) => {
      const card = document.createElement("article");
      card.className = "candidate-card";
      const heading = document.createElement("div");
      heading.className = "candidate-card-heading";
      heading.append(textNode("strong", "#" + candidate.rank + " · " + candidate.vessel_id));
      heading.append(textNode("span", candidate.priority_score + " / 100", "score-pill"));
      card.append(heading, textNode("p", candidate.explanation), textNode("p", candidate.data_quality_note, "muted"));
      $("real-ais-candidates").append(card);
      addGeometry(candidate.track, colors.track, "AIS candidate route · possible lead only");
    });
    window.realCaseData.vessel_candidates = result.vessel_candidates;
    window.realCaseData.provenance = result.provenance;
    status.textContent = result.vessel_candidates.length
      ? result.vessel_candidates.length + " possible AIS match(es). " + result.note
      : "No AIS positions from this file fell within the configured search radius and release window. Missing AIS coverage is not evidence that a vessel was absent.";
    $("legend-track").hidden = result.vessel_candidates.length === 0;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("save-real-case").addEventListener("click", async () => {
  if (!window.realCaseData) return;
  const button = $("save-real-case");
  const status = $("save-case-status");
  button.disabled = true;
  status.hidden = false;
  status.textContent = "Saving this review in the WakeTrace project…";
  try {
    const response = await fetch(apiRoot() + "/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case_data: window.realCaseData }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Could not save this case.");
    status.textContent = "Saved. Use Overview or Evidence to reopen this case.";
    const url = new URL(window.location.href);
    url.searchParams.set("case", result.case_id);
    window.history.replaceState({}, "", url);
    document.querySelectorAll("[data-case-link]").forEach((link) => {
      const target = new URL(link.href, window.location.href);
      target.searchParams.set("case", result.case_id);
      link.href = target.pathname.split("/").pop() + target.search;
    });
    button.textContent = "Case saved";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});

$("run-simulation").addEventListener("click", async () => {
  if (!selectedScene || (!selectedScene.synthetic && !selectedSceneBounds) || !window.simulationSourcePoint) {
    $("simulation-status").textContent = "Select a satellite scene, then click inside it to choose a fictional release point.";
    return;
  }
  const button = $("run-simulation");
  button.disabled = true;
  $("simulation-status").textContent = "Creating the artificial radar patch and screening it… This can take a little while.";
  try {
    const isOfflinePractice = selectedScene.synthetic === true;
    const endpoint = isOfflinePractice
      ? apiRoot() + "/api/simulation/practice"
      : apiRoot() + "/api/satellite/scenes/" + encodeURIComponent(selectedScene.id) + "/simulate";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_longitude: window.simulationSourcePoint.longitude,
        source_latitude: window.simulationSourcePoint.latitude,
        seed: 42,
        ...(isOfflinePractice ? {} : { bbox: selectedSceneBounds, polarization: searchForm.elements.polarization.value }),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "The simulated exercise could not run.");

    if (sceneOverlay) map.removeLayer(sceneOverlay);
    sceneOverlay = L.imageOverlay(result.preview.preview_url, result.preview.preview_bounds, { opacity: 0.94 }).addTo(map);
    layers.clearLayers();
    const candidates = result.detection.candidates || [];
    candidates.forEach((candidate, index) => addGeometry(candidate.geometry,
      index === 0 ? colors.slick : colors.secondary,
      "Simulated dark radar feature " + (index + 1) + " · screening candidate, not real oil"));
    addGeometry(result.drift.origin_zone, colors.origin, "Possible origin area from synthetic drift exercise");
    (result.vessel_candidates || []).forEach((candidate) => addGeometry(candidate.track, colors.track,
      candidate.vessel_id + " · fictional vessel track"));
    if (simulationMarker) map.removeLayer(simulationMarker);
    const source = result.simulation.source_point.coordinates;
    simulationMarker = L.circleMarker([source[1], source[0]], {
      radius: 8, color: "#ffffff", weight: 3, fillColor: "#d44d69", fillOpacity: 1,
    }).bindPopup("Chosen fictional release location.").addTo(map);
    const slick = result.simulation.slick_point.coordinates;
    simulationSlickMarker = L.circleMarker([slick[1], slick[0]], {
      radius: 6, color: "#ffffff", weight: 2, fillColor: "#168e9b", fillOpacity: 1,
    }).bindPopup("Center of the simplified dark patch planted in the copied radar image.").addTo(map);

    $("case-badge").textContent = isOfflinePractice ? "OFFLINE PRACTICE" : "SIMULATED SPILL";
    $("case-badge").classList.remove("real-case-badge");
    $("case-title").textContent = "Simulated spill exercise";
    $("case-subtitle").textContent = result.simulation.background_label + " background · fictional slick, currents, and vessel tracks";
    $("case-notice").textContent = result.simulation.note;
    $("case-notice").hidden = false;
    $("historical-reference").hidden = true;
    $("legend-reference").hidden = true;
    $("legend-sim-source").hidden = true;
    $("legend-slick").hidden = candidates.length === 0;
    $("legend-dark-features").hidden = candidates.length < 2;
    $("legend-origin").hidden = !result.drift.origin_zone;
    $("legend-track").hidden = (result.vessel_candidates || []).length === 0;
    $("legend-scene").hidden = false;
    $("legend-scene").lastChild.textContent = isOfflinePractice ? "Synthetic radar-style background" : "Copernicus Sentinel-1 scene";
    $("scene-source").textContent = result.scene.source + " · " + result.scene.id;
    $("scene-kind").textContent = isOfflinePractice ? "SYNTHETIC PRACTICE BACKGROUND" : "SATELLITE SCENE";
    $("scene-acquired").textContent = (isOfflinePractice ? "Generated · " : "Acquired · ") + WakeTraceCase.formatUtc(result.scene.datetime);
    $("scene-preview").src = result.preview.preview_url;
    $("scene-preview").alt = isOfflinePractice ? "Generated synthetic radar-style practice image; not satellite data" : "Satellite scene preview attached to this case";
    $("scene-preview").hidden = false;
    $("scene-preview-status").hidden = true;
    $("map-footnote").textContent = result.detection.note;
    $("map-description").textContent = "Artificial dark patch · synthetic origin area · fictional vessel routes";
    $("map-overlay-chip").textContent = "SIMULATED DRIFT ORIGIN";
    $("legend-sim-source").hidden = false;
    $("legend-sim-slick").hidden = false;
    if (incidentMarker) map.removeLayer(incidentMarker);
    incidentMarker = null;
    map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 12 });
    $("map-message").hidden = true;

    const ranked = result.vessel_candidates || [];
    const truthRank = ranked.findIndex((candidate) => candidate.vessel_id === result.simulation.truth_vessel_id) + 1;
    $("simulation-summary").textContent = candidates.length
      ? "The radar screen marked " + candidates.length + " possible dark feature(s). Compare the outlines with the planted patch; the screen ranks darkness and size, not oil identity."
      : "No dark feature met the current screening settings. This exercise did not produce a candidate.";
    $("simulation-truth").textContent = truthRank
      ? result.simulation.truth_vessel_id + " was the generated source and ranked #" + truthRank + " in the fictional AIS exercise."
      : result.simulation.truth_vessel_id + " was the generated source; it was not returned as an AIS candidate in this run.";
    const vesselList = $("simulation-vessel-list");
    vesselList.replaceChildren();
    ranked.forEach((candidate) => {
      const card = document.createElement("article");
      card.className = "candidate-card";
      const heading = document.createElement("div");
      heading.className = "candidate-card-heading";
      heading.append(textNode("strong", "#" + candidate.rank + " · " + candidate.vessel_id));
      heading.append(textNode("span", candidate.priority_score + " / 100", "score-pill"));
      card.append(heading, textNode("p", "Fictional AIS route · " + candidate.explanation));
      vesselList.append(card);
    });
    $("simulation-results").hidden = false;
    $("simulation-panel").hidden = true;
    $("simulation-results").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    $("simulation-status").textContent = isOfflinePractice
      ? "Offline practice complete. The background, patch, forcing, and routes are all generated."
      : "Simulation complete. The satellite image is real; the patch, forcing, and routes are fictional.";
  } catch (error) {
    $("simulation-status").textContent = error.message + " You can click another offshore point and try again.";
  } finally {
    button.disabled = false;
  }
});

if (new URLSearchParams(window.location.search).get("demo") === "1") {
  startOfflinePractice();
}
