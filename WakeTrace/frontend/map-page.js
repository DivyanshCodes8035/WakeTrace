const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const colors = {
  slick: { color: "#ffd17d", weight: 3, fillColor: "#f3a642", fillOpacity: 0.16, className: "slick-candidate-outline", smoothFactor: 2.5, lineJoin: "round", lineCap: "round" },
  origin: { color: "#0f7c86", weight: 3, fillColor: "#55b8ad", fillOpacity: 0.3, dashArray: "7 5" },
  track: { color: "#66d5ca", weight: 3, opacity: 0.95, dashArray: "1 8", lineCap: "round", lineJoin: "round" },
  secondary: { color: "#b5dcce", weight: 2, fillColor: "#83cbb9", fillOpacity: 0.14, dashArray: "3 5" },
  aiSlick: { color: "#c7a3ff", weight: 3, fillColor: "#9d6bff", fillOpacity: 0.12, dashArray: "6 4", className: "ai-slick-outline" },
};
function candidateRouteStyle(index = 0) {
  return { ...colors.track, color: index === 0 ? "#ff827f" : "#f5bd58" };
}
const shipSvg = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><radialGradient id="hullGrad" cx="40%" cy="30%" r="70%"><stop offset="0%" stop-color="#d0f0ec"/><stop offset="100%" stop-color="#9de8e0"/></radialGradient></defs><path d="M16 3 L22 9 L22 24 L16 29 L10 24 L10 9 Z" fill="url(#hullGrad)"/><rect x="12" y="10" width="8" height="5" rx="1" class="ship-bridge"/><line x1="11" y1="18" x2="21" y2="18" class="ship-deck"/><line x1="12" y1="21" x2="20" y2="21" class="ship-deck"/><line x1="13.5" y1="24" x2="18.5" y2="24" class="ship-deck"/><path d="M6 17 C4.5 20 5 23 7 25 M26 17 C27.5 20 27 23 25 25" class="ship-wake"/></svg>';
const historicalIncident = { latitude: -20.4382, longitude: 57.7447 };

const hasMapLibrary = Boolean(window.L);
let map = null;
let layers = null;
let animationLayer = null;
let sceneOverlay = null;
let incidentMarker = null;
let simulationMarker = null;
let simulationSlickMarker = null;
let userChoseMapArea = false;
let selectedScene = null;
let selectedSceneBounds = null;
let trajectoryPlayback = null;

function vesselIcon(variant = "report") {
  const report = variant === "report";
  return L.divIcon({
    className: "vessel-icon-container",
    html: '<span class="vessel-icon vessel-icon-' + variant + '">' + shipSvg + '</span>',
    iconSize: report ? [30, 30] : [40, 40],
    iconAnchor: report ? [15, 15] : [20, 20],
    popupAnchor: [0, -14],
  });
}

function addGeometry(geometry, style, label) {
  if (!geometry || !map || !layers) return false;
  try {
    const geojson = ["Feature", "FeatureCollection"].includes(geometry.type)
      ? geometry : { type: "Feature", properties: {}, geometry };
    const isVesselTrack = /vessel|ais candidate route/i.test(label);
    const pointToLayer = isVesselTrack
      ? (_feature, latlng) => L.marker(latlng, { icon: vesselIcon("report") })
      : undefined;
    L.geoJSON(geojson, { style, pointToLayer }).eachLayer((layer) => layer.bindPopup(label)).addTo(layers);
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
  const configuredPort = new URLSearchParams(window.location.search).get("apiPort");
  const port = configuredPort && /^\d{1,5}$/.test(configuredPort) && Number(configuredPort) <= 65535
    ? configuredPort : "8002";
  return "http://" + (window.location.hostname || "localhost") + ":" + port;
}

function candidatePositionAt(positions, timestamp) {
  if (!Array.isArray(positions) || !positions.length) return null;
  const target = timestamp.getTime();
  const fixes = positions.map((item) => ({
    time: new Date(item.time).getTime(),
    lon: Number(item.coordinates?.[0]),
    lat: Number(item.coordinates?.[1]),
  })).filter((item) => Number.isFinite(item.time) && Number.isFinite(item.lon) && Number.isFinite(item.lat))
    .sort((a, b) => a.time - b.time);
  if (!fixes.length || target < fixes[0].time || target > fixes[fixes.length - 1].time) return null;
  for (let index = 0; index < fixes.length; index += 1) {
    const first = fixes[index];
    if (target === first.time) return [first.lat, first.lon];
    const second = fixes[index + 1];
    if (!second || target > second.time) continue;
    const gap = second.time - first.time;
    if (gap <= 0 || gap > 2 * 60 * 60 * 1000) return null;
    const meanLat = (first.lat + second.lat) / 2 * Math.PI / 180;
    const dx = ((second.lon - first.lon + 540) % 360 - 180) * Math.cos(meanLat) * 111.195;
    const dy = (second.lat - first.lat) * 111.195;
    const speedKnots = Math.hypot(dx, dy) / (gap / 3600000) / 1.852;
    if (speedKnots > 60) return null;
    const fraction = (target - first.time) / gap;
    const lon = ((first.lon + (((second.lon - first.lon + 540) % 360) - 180) * fraction + 540) % 360) - 180;
    return [first.lat + (second.lat - first.lat) * fraction, lon];
  }
  return null;
}

function updateTrajectoryFrame(index) {
  if (!trajectoryPlayback) return;
  const state = trajectoryPlayback;
  state.index = Math.max(0, Math.min(index, state.frames.length - 1));
  const frame = state.frames[state.index];
  const frameTime = new Date(frame.time);
  const positions = frame.positions || [];
  state.particleMarkers.forEach((marker, particleIndex) => {
    const trail = [];
    for (let frameIndex = 0; frameIndex <= state.index; frameIndex += 1) {
      const point = state.frames[frameIndex].positions?.[particleIndex];
      if (Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite)) trail.push([point[1], point[0]]);
    }
    state.particleTrails[particleIndex].setLatLngs(trail);
    const point = positions[particleIndex];
    if (Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite)) {
      marker.setLatLng([point[1], point[0]]).setStyle({ opacity: 1, fillOpacity: .9 });
    } else {
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
    }
  });
  state.vessels.forEach(({ marker, candidate }) => {
    const point = candidatePositionAt(candidate.track_positions, frameTime);
    if (point) marker.setLatLng(point).setOpacity(1);
    else marker.setOpacity(0);
  });
  $("trajectory-range").value = String(state.index);
  $("trajectory-time").textContent = frameTime.toLocaleString(undefined, {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }) + " UTC";
  $("trajectory-play").textContent = state.timer
    ? "Pause"
    : state.index >= state.frames.length - 1 ? "Replay drift" : state.index > 0 ? "Resume drift" : "Play drift";
}

function startTrajectoryPlayback() {
  if (!trajectoryPlayback || trajectoryPlayback.timer) return;
  if (trajectoryPlayback.index >= trajectoryPlayback.frames.length - 1) updateTrajectoryFrame(0);
  trajectoryPlayback.timer = window.setInterval(() => {
    const next = trajectoryPlayback.index + 1;
    if (next >= trajectoryPlayback.frames.length) {
      window.clearInterval(trajectoryPlayback.timer);
      trajectoryPlayback.timer = null;
      updateTrajectoryFrame(trajectoryPlayback.index);
    } else {
      updateTrajectoryFrame(next);
    }
  }, 650);
  updateTrajectoryFrame(trajectoryPlayback.index);
}

function configureTrajectoryPlayback(drift, candidates = [], note = "") {
  if (trajectoryPlayback?.timer) window.clearInterval(trajectoryPlayback.timer);
  if (animationLayer) animationLayer.clearLayers();
  const frames = (drift?.animation?.frames || []).filter((frame) => frame?.time && Array.isArray(frame.positions));
  const controls = $("trajectory-controls");
  if (frames.length < 2 || !animationLayer) {
    controls.hidden = true;
    $("legend-particles").hidden = true;
    trajectoryPlayback = null;
    return;
  }
  const particleCount = Math.min(...frames.map((frame) => frame.positions.length));
  if (particleCount < 1) {
    controls.hidden = true;
    $("legend-particles").hidden = true;
    trajectoryPlayback = null;
    return;
  }
  const particleMarkers = [];
  const particleTrails = [];
  for (let index = 0; index < particleCount; index += 1) {
    const trail = L.polyline([], { color: "#63d5c6", weight: 1.5, opacity: .32, smoothFactor: 1 }).addTo(animationLayer);
    const marker = L.circleMarker([0, 0], { radius: 3.5, className: "trajectory-particle", fillColor: "#68d5c5", color: "#e4fffb" }).addTo(animationLayer);
    particleTrails.push(trail);
    particleMarkers.push(marker);
  }
  const vesselMarkers = candidates.filter((candidate) => Array.isArray(candidate.track_positions) && candidate.track_positions.length)
    .map((candidate, index) => {
      const marker = L.marker([0, 0], {
        icon: vesselIcon(index === 0 ? "lead" : "candidate"),
        opacity: 0,
        keyboard: true,
      }).bindPopup("AIS candidate " + (candidate.rank ? "#" + candidate.rank + " · " : "") + candidate.vessel_id + " · screening lead only").addTo(animationLayer);
      return { marker, candidate };
    });
  trajectoryPlayback = { frames, particleMarkers, particleTrails, vessels: vesselMarkers, index: 0, timer: null };
  $("trajectory-range").max = String(frames.length - 1);
  $("trajectory-range").value = "0";
  $("trajectory-note").textContent = note || (drift.animation.direction === "forward synthetic particle demonstration"
    ? "Synthetic current demonstration and fictional AIS routes. This animation is practice data, not an observed spill."
    : "Particle paths replay the backward model in time order. Moving vessels appear only where timestamped AIS positions are available.");
  controls.hidden = false;
  $("legend-particles").hidden = false;
  updateTrajectoryFrame(0);
  startTrajectoryPlayback();
}

$("trajectory-range").addEventListener("input", (event) => {
  if (!trajectoryPlayback) return;
  if (trajectoryPlayback.timer) {
    window.clearInterval(trajectoryPlayback.timer);
    trajectoryPlayback.timer = null;
  }
  updateTrajectoryFrame(Number(event.currentTarget.value));
});

$("trajectory-play").addEventListener("click", () => {
  if (!trajectoryPlayback) return;
  if (trajectoryPlayback.timer) {
    window.clearInterval(trajectoryPlayback.timer);
    trajectoryPlayback.timer = null;
    updateTrajectoryFrame(trajectoryPlayback.index);
    return;
  }
  startTrajectoryPlayback();
});

function revealVesselResults(result) {
  addGeometry(result.drift.origin_zone, colors.origin, "Possible origin area from synthetic drift exercise");
  (result.vessel_candidates || []).forEach((candidate, index) => addGeometry(candidate.track, candidateRouteStyle(index),
    candidate.vessel_id + " · fictional vessel track"));
  configureTrajectoryPlayback(result.drift, result.vessel_candidates || [],
    "Synthetic current demonstration and fictional AIS routes. This animation is practice data, not an observed spill.");
  const source = result.simulation.source_point.coordinates;
  simulationMarker = L.circleMarker([source[1], source[0]], {
    radius: 8, color: "#ffffff", weight: 3, fillColor: "#d44d69", fillOpacity: 1,
  }).bindPopup("Fictional release location planted for this exercise.").addTo(map);
  $("legend-origin").hidden = !result.drift.origin_zone;
  $("legend-track").hidden = (result.vessel_candidates || []).length === 0;
  $("legend-sim-source").hidden = false;
  $("map-overlay-chip").innerHTML = '<span class="overlay-icon" aria-hidden="true">↶</span> POSSIBLE ORIGIN + FICTIONAL ROUTES';
  $("simulation-step").hidden = true;
  $("simulation-results").hidden = false;
  if (layers?.getLayers().length) {
    map.fitBounds(layers.getBounds(), { padding: [52, 52], maxZoom: 13, animate: !reduceMotion });
  }

  const ranked = result.vessel_candidates || [];
  const truthRank = ranked.findIndex((candidate) => candidate.vessel_id === result.simulation.truth_vessel_id) + 1;
  $("simulation-summary").textContent = (result.detection.candidates || []).length
    ? "The screen marked " + result.detection.candidates.length + " possible dark radar feature(s). The outline marks a synthetic patch; darkness alone cannot confirm oil."
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
  $("simulation-results").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
}

function savePracticeResultForEvidence(result) {
  const sceneTime = result.scene?.datetime || result.detection?.acquired_at || new Date().toISOString();
  const detection = { ...result.detection };
  delete detection.preview_url;
  const caseData = {
    practice_result: true,
    synthetic: true,
    case_id: "practice-session",
    title: "One-click simulated spill exercise",
    synthetic_notice: result.simulation?.note || "Synthetic practice only. Results are generated for demonstration and are not real incident evidence.",
    detection: {
      ...detection,
      acquired_at: sceneTime,
      provenance: {
        ...(detection.provenance || {}),
        input_sources: [{
          provider: result.scene?.source || "Synthetic practice generator",
          dataset: result.scene?.id || "Generated radar-style scene",
          description: result.simulation?.background_label === "Synthetic radar-style"
            ? "Generated practice background; not satellite imagery."
            : result.simulation?.background_label || "Generated practice background; not satellite imagery.",
        }],
      },
    },
    drift: result.drift,
    vessel_candidates: result.vessel_candidates || [],
    simulation: result.simulation,
  };
  try {
    sessionStorage.setItem("waketrace.practice-result.v1", JSON.stringify(caseData));
  } catch (error) {
    console.warn("Could not save the practice result for Evidence", error);
  }
}

function bboxFromForm(form) {
  return ["west", "south", "east", "north"].map((name) => Number(form.elements[name].value));
}

function copernicusBrowserUrl(scene, polarization = "VV") {
  const [west, south, east, north] = scene.bbox || [];
  const lat = Number.isFinite((south + north) / 2) ? (south + north) / 2 : 0;
  const lng = Number.isFinite((west + east) / 2) ? (west + east) / 2 : 0;
  const mode = String(scene.mode || "IW").toUpperCase();
  const available = (scene.polarizations || []).map((value) => String(value).toUpperCase());
  const selectedPol = String(polarization || "VV").toUpperCase();
  const verticalPair = available.includes("VV") && available.includes("VH");
  const horizontalPair = available.includes("HH") && available.includes("HV");
  const paired = verticalPair || horizontalPair;
  const modeCode = ["IW", "EW", "SM"].includes(mode) ? mode : "IW";
  const pairCode = verticalPair ? "VVVH" : "HHHV";
  const datasetId = "S1_CDAS_" + modeCode + (paired ? "_" + pairCode : "_" + (available[0] || selectedPol));
  const polarizationMode = verticalPair || available.includes("VV") ? "DV" : (horizontalPair ? "DH" : "SH");
  const layerPrefix = modeCode + "-" + polarizationMode + "-";
  const layerPolarization = selectedPol === "VH" && paired ? "VH" : (available.includes(selectedPol) ? selectedPol : available[0] || "VV");
  const layerId = layerPrefix + layerPolarization + "-DECIBEL-GAMMA0-ORTHORECTIFIED";
  const acquired = new Date(scene.datetime || scene.start_datetime || Date.now());
  const dayEnd = new Date(Date.UTC(acquired.getUTCFullYear(), acquired.getUTCMonth(), acquired.getUTCDate(), 23, 59, 59, 999)).toISOString();
  const url = new URL("https://browser.dataspace.copernicus.eu/");
  url.search = new URLSearchParams({
    zoom: "8", lat: String(lat), lng: String(lng), themeId: "DEFAULT-THEME",
    datasetId, layerId, toTime: dayEnd, dateMode: "SINGLE",
  }).toString();
  return url.toString();
}

function addCopernicusBrowserLink(container, scene, polarization, label = "Open this date in Copernicus Browser") {
  const link = document.createElement("a");
  link.className = "scene-select-button scene-browser-link";
  link.href = copernicusBrowserUrl(scene, polarization);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  container.append(link);
  return link;
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
  animationLayer = L.layerGroup().addTo(map);
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
    document.title = "WakeTrace | Map | " + (caseData.title || caseData.case_id || "Case");
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
      if (addGeometry(candidate.track, candidateRouteStyle(index), "Possible vessel track · not evidence of responsibility")) tracks += 1;
    });
    $("legend-track").hidden = tracks === 0;
    configureTrajectoryPlayback(caseData.drift, caseData.vessel_candidates || []);
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
const savedCoordinatesKey = "waketrace.map-search-coordinates.v1";
const coordinateFields = ["west", "south", "east", "north"];
const coordinateSaveStatus = $("coordinate-save-status");

try {
  const savedCoordinates = JSON.parse(localStorage.getItem(savedCoordinatesKey) || "{}");
  coordinateFields.forEach((name) => {
    const value = savedCoordinates[name];
    if (typeof value === "string" && value.trim() !== "") searchForm.elements[name].value = value;
  });
  if (coordinateFields.some((name) => searchForm.elements[name].value)) {
    coordinateSaveStatus.textContent = "Saved coordinates restored from this device.";
  }
} catch (error) {
  coordinateSaveStatus.textContent = "Automatic coordinate saving is unavailable in this browser.";
}

function saveSearchCoordinates() {
  try {
    const values = Object.fromEntries(coordinateFields.map((name) => [name, searchForm.elements[name].value]));
    if (coordinateFields.every((name) => values[name] === "")) {
      localStorage.removeItem(savedCoordinatesKey);
      coordinateSaveStatus.textContent = "Enter coordinates and WakeTrace will save them on this device.";
      return;
    }
    localStorage.setItem(savedCoordinatesKey, JSON.stringify(values));
    coordinateSaveStatus.textContent = "Coordinates saved automatically on this device.";
  } catch (error) {
    coordinateSaveStatus.textContent = "Could not save coordinates in this browser.";
  }
}

coordinateFields.forEach((name) => searchForm.elements[name].addEventListener("input", saveSearchCoordinates));
$("clear-saved-coordinates").addEventListener("click", () => {
  coordinateFields.forEach((name) => { searchForm.elements[name].value = ""; });
  try {
    localStorage.removeItem(savedCoordinatesKey);
    coordinateSaveStatus.textContent = "Saved coordinates cleared from this device.";
  } catch (error) {
    coordinateSaveStatus.textContent = "Could not clear saved coordinates in this browser.";
  }
});

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
  saveSearchCoordinates();
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
  saveSearchCoordinates();
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
      const actions = document.createElement("div");
      actions.className = "scene-result-actions";
      actions.append(select);
      addCopernicusBrowserLink(actions, scene, form.elements.polarization.value, "View in Copernicus Browser");
      card.append(details, actions);
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
    const aiScreen = result.detection.ai_screen || { status: "unavailable", message: "AI model results were not returned." };
    const aiCandidates = aiScreen.status === "complete" ? (aiScreen.candidates || []) : [];
    aiCandidates.forEach((candidate, index) => {
      addGeometry(candidate.geometry, colors.aiSlick,
        "AI slick-like texture " + (index + 1) + " · experimental model score, not an oil probability");
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
        ai_screen: result.detection.ai_screen,
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
    $("legend-ai").hidden = aiCandidates.length === 0;
    $("legend-dark-features").hidden = candidates.length < 2;
    $("legend-origin").hidden = true;
    $("legend-track").hidden = true;
    $("legend-scene").hidden = false;
    $("legend-scene").lastChild.textContent = "Copernicus Sentinel-1 scene";
    $("legend-sim-source").hidden = true;
    $("legend-sim-slick").hidden = true;
    $("map-overlay-chip").textContent = "RADAR + AI SCREEN";
    $("map-footnote").textContent = result.detection.note + (incidentInScene
      ? " The red marker shows the approximate reported Wakashio incident position from NOAA; it is reference context, not a detected oil boundary."
      : "") + " The scene and outlines are temporary and are not saved to the case.";
    $("map-description").textContent = "Radar + AI candidate areas · analyst review required";
    map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 12 });
    $("real-detection-results").hidden = candidates.length === 0 && aiCandidates.length === 0 && aiScreen.status === "complete";
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
    $("ai-screen-results").hidden = false;
    $("ai-candidate-list").replaceChildren();
    if (aiScreen.status === "complete") {
      $("ai-screen-summary").textContent = aiCandidates.length
        ? aiCandidates.length + " AI-highlighted area(s) · trained on Sentinel-1 examples from the Gulf of Mexico. Purple outlines show where the model found similar radar textures."
        : "The AI model found no areas above its screening threshold in this image.";
      aiCandidates.forEach((candidate, index) => {
        const card = document.createElement("article");
        card.className = "candidate-card ai-candidate-card";
        const title = textNode("strong", "AI area " + (index + 1), "scene-title");
        const score = Number(candidate.model_score);
        const detail = textNode("p", candidate.pixel_count + " pixels · model score " + (Number.isFinite(score) ? score.toFixed(2) : "—") + " (not a probability). " + candidate.explanation);
        const action = textNode("button", "Estimate possible origin", "scene-select-button");
        action.type = "button";
        action.addEventListener("click", () => estimateRealDrift(candidate, action));
        card.append(title, detail, action);
        $("ai-candidate-list").append(card);
      });
      $("ai-screen-limitations").textContent = "Experimental model · trained with 173 labeled Sentinel-1 tiles from Cantarell, Gulf of Mexico (2020); held-out test IoU 0.618. It has not been validated for Mauritius. Dark wind areas, rain, waves, and ship wakes can resemble oil. Human review is required.";
    } else {
      $("ai-screen-summary").textContent = "AI screening is unavailable: " + (aiScreen.message || "install the optional model runtime and checkpoint");
      $("ai-screen-limitations").textContent = "The regular radar dark-feature screen above still works.";
    }
    $("simulation-panel").hidden = false;
    $("simulation-panel").open = false;
    $("simulation-status").textContent = "Expand Practice mode only if you want to try a clearly fictional exercise.";
    if (candidates.length || aiCandidates.length) {
      status.textContent = candidates.length + " radar-screen area(s) and " + aiCandidates.length + " AI-highlighted area(s). Choose any area below to estimate its possible origin; none is confirmed oil.";
      $("map-message").hidden = true;
    } else {
      status.textContent = aiScreen.status === "complete"
        ? "The image loaded, but neither screen highlighted an area above its settings. This does not prove there is no oil."
        : "The radar screen found no candidate, and AI screening is unavailable. This does not prove there is no oil.";
      $("map-message").textContent = aiScreen.status === "complete"
        ? "Neither screen highlighted a possible area."
        : "No radar candidate found; AI screening unavailable.";
      $("map-message").hidden = false;
    }
  } catch (error) {
    try {
      await showCatalogQuicklook(scene, form, status, error.message);
    } catch (fallbackError) {
      status.textContent = error.message;
      const message = $("map-message");
      message.replaceChildren(document.createTextNode("WakeTrace cannot load the image service right now. " + fallbackError.message + " Open the same real Sentinel-1 date and location in Copernicus Browser instead: "));
      addCopernicusBrowserLink(message, scene, form.elements.polarization.value, "Open real Sentinel-1 scene");
      $("map-message").hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

async function showCatalogQuicklook(scene, form, status, processingError) {
  if (!map || !scene.item_url || !Array.isArray(scene.bbox) || scene.bbox.length < 4) {
    throw new Error("This scene has no usable quicklook link or map bounds.");
  }
  const image = new Image();
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("The Copernicus quicklook took too long to load.")), 8000);
    image.onload = () => { window.clearTimeout(timeout); resolve(); };
    image.onerror = () => { window.clearTimeout(timeout); reject(new Error("The Copernicus quicklook link is unavailable from this browser.")); };
    image.src = scene.item_url;
  });

  const [west, south, east, north] = scene.bbox;
  const bounds = [[south, west], [north, east]];
  selectedScene = scene;
  selectedSceneBounds = bboxFromForm(form);
  layers.clearLayers();
  if (sceneOverlay) map.removeLayer(sceneOverlay);
  sceneOverlay = L.imageOverlay(scene.item_url, bounds, { opacity: 0.96 }).addTo(map);
  map.fitBounds(bounds, { padding: [28, 28], maxZoom: 10 });

  const acquired = scene.datetime || scene.start_datetime;
  $("scene-source").textContent = "Copernicus Data Space · " + scene.id;
  $("scene-kind").textContent = "SENTINEL-1 QUICKLOOK";
  $("scene-acquired").textContent = "Acquired · " + WakeTraceCase.formatUtc(acquired);
  $("scene-preview").src = scene.item_url;
  $("scene-preview").alt = "Copernicus Sentinel-1 radar quicklook for " + scene.id;
  $("scene-preview").hidden = false;
  $("scene-preview-status").hidden = true;
  $("case-badge").textContent = "LIVE COPERNICUS SCENE";
  $("case-badge").classList.add("real-case-badge");
  $("case-title").textContent = "Sentinel-1 scene review";
  $("case-subtitle").textContent = "Real radar observation · " + WakeTraceCase.formatUtc(acquired);
  $("case-notice").textContent = "Real Copernicus radar quicklook shown. Automatic slick screening and pixel-level analysis did not run because the image-processing service is unavailable. This preview alone does not confirm oil.";
  $("case-notice").hidden = false;
  $("real-detection-results").hidden = true;
  $("real-drift-output").hidden = true;
  $("save-real-case").hidden = true;
  $("simulation-panel").hidden = true;
  $("legend-slick").hidden = true;
  $("legend-ai").hidden = true;
  $("legend-dark-features").hidden = true;
  $("legend-origin").hidden = true;
  $("legend-track").hidden = true;
  $("legend-scene").hidden = false;
  $("legend-scene").lastChild.textContent = "Copernicus Sentinel-1 quicklook";
  $("map-description").textContent = "Real Sentinel-1 quicklook · automatic image screening unavailable";
  $("map-footnote").textContent = "Showing the real Copernicus scene thumbnail over its geographic extent. The image-processing service failed: " + processingError;
  $("map-message").textContent = "Real satellite quicklook loaded. Automatic slick detection did not run.";
  addCopernicusBrowserLink($("map-message"), scene, form.elements.polarization.value);
  $("map-message").hidden = false;
  status.textContent = "Showing the real Copernicus quicklook. Automatic slick screening is unavailable until image processing can connect.";
}

async function estimateRealDrift(candidate, button) {
  if (!selectedScene || !selectedSceneBounds) return;
  const status = $("real-drift-status");
  button.disabled = true;
  document.querySelectorAll("#real-detection-results .scene-select-button").forEach((item) => { item.disabled = true; });
  status.textContent = "Getting public historical wind and current data, then backtracking an OpenDrift ensemble… This may take a few minutes.";
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
    $("real-drift-text").textContent = "OpenDrift backtracked this selected radar feature to an uncertain possible origin area. Search window: " + start + " to " + end + ". " + result.drift.uncertainty_note;
    $("real-drift-sources").textContent = "Real data used: " + result.drift.provenance.input_sources.map((source) => source.product + " (" + source.dataset + ")").join(" and ") + ". The release window is the model search period, not a measured spill time.";
    $("real-drift-output").hidden = false;
    window.currentRealDrift = result.drift;
    configureTrajectoryPlayback(result.drift, [], "Modeled particle paths replay the backward drift estimate from the possible origin area toward the observed dark feature. This is a model, not a measured spill route.");
    window.realCaseData.drift = result.drift;
    $("real-ais-auto").hidden = false;
    $("manual-ais-review").hidden = false;
    $("real-ais-status").hidden = false;
    $("real-ais-candidates").replaceChildren();
    status.textContent = result.note;
    map.fitBounds(window.realOriginLayer.getBounds(), { padding: [40, 40], maxZoom: 11 });
    await searchAutomaticAISPresence(result.drift);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    document.querySelectorAll("#real-detection-results .scene-select-button").forEach((item) => { item.disabled = false; });
  }
}

async function searchAutomaticAISPresence(drift) {
  const button = $("search-ais-presence");
  const status = $("real-ais-status");
  if (window.gfwPresenceLayer && layers) layers.removeLayer(window.gfwPresenceLayer);
  window.gfwPresenceLayer = L.layerGroup();
  if (layers) window.gfwPresenceLayer.addTo(layers);
  button.disabled = true;
  status.hidden = false;
  status.textContent = "Searching Global Fishing Watch for vessel presence near the possible origin…";
  $("real-ais-candidates").replaceChildren();
  try {
    const response = await fetch(apiRoot() + "/api/vessels/search-presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drift }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Automatic AIS presence search failed.");
    result.presence_cells.forEach((presence, index) => {
      const vesselLabel = presence.ship_name || presence.vessel_id || presence.mmsi || "Vessel presence cell " + (index + 1);
      const card = document.createElement("article");
      card.className = "candidate-card";
      const title = textNode("strong", vesselLabel, "scene-title");
      const details = [presence.date || "date not supplied"];
      if (presence.vessel_type) details.push(presence.vessel_type);
      if (presence.flag) details.push("flag " + presence.flag);
      if (presence.mmsi) details.push("MMSI " + presence.mmsi);
      details.push(presence.vessel_count + " vessel ID(s) in grid cell");
      details.push(Number(presence.hours).toFixed(1) + " presence-hours");
      const description = textNode("p", details.join(" · "));
      const quality = textNode("p", "Approximate cell center: " + presence.longitude.toFixed(3) + ", " + presence.latitude.toFixed(3) + ". Daily aggregated AIS presence, not a precise ship position or route.", "muted");
      card.append(title, description, quality);
      $("real-ais-candidates").append(card);
      if (map && layers) {
        L.circleMarker([presence.latitude, presence.longitude], {
          radius: 7, color: "#ffffff", weight: 2, fillColor: "#f2a84a", fillOpacity: 0.92,
        }).bindPopup("GFW AIS presence · " + vesselLabel + " · " + (presence.date || "date unavailable") + " · approximate daily grid cell, not a track").addTo(window.gfwPresenceLayer);
      }
    });
    window.realCaseData.ais_presence = result;
    if (result.presence_cells.length) {
      status.textContent = result.presence_cells.length + " AIS presence cell(s) returned by Global Fishing Watch. " + result.note;
    } else if (result.provenance?.upstream_entries_received > 0 && result.provenance?.upstream_coordinate_rows_received === 0) {
      status.textContent = "Global Fishing Watch returned report entries, but WakeTrace could not read their map coordinates. Refresh the backend before retrying. " + result.note;
    } else {
      status.textContent = "Global Fishing Watch returned no AIS presence rows for this area and date range. That does not prove vessels were absent. " + result.note;
    }
  } catch (error) {
    status.replaceChildren(document.createTextNode(error.message + " "));
    if (error.message.includes("Global Fishing Watch API token")) {
      const link = document.createElement("a");
      link.href = "https://globalfishingwatch.org/our-apis/";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Get a free API token";
      status.append(link, document.createTextNode(". Add it as GFW_API_TOKEN in the project-root .env file and restart the backend."));
    }
  } finally {
    button.disabled = false;
  }
}

$("search-ais-presence").addEventListener("click", () => {
  if (window.currentRealDrift) searchAutomaticAISPresence(window.currentRealDrift);
});

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
      addGeometry(candidate.track, candidateRouteStyle(index), "AIS candidate route · possible lead only");
    });
    configureTrajectoryPlayback(window.currentRealDrift, result.vessel_candidates,
      "Modeled particle paths and timestamped AIS tracks share one playback clock. Candidate scores include proximity to the model corridor.");
    window.realCaseData.vessel_candidates = result.vessel_candidates;
    window.realCaseData.provenance = result.provenance;
    status.textContent = result.vessel_candidates.length
      ? result.vessel_candidates.length + " possible AIS match(es). Highest screening priority: "
        + result.vessel_candidates[0].vessel_id + " (" + result.vessel_candidates[0].priority_score
        + "/100). This is a lead for review, not vessel attribution. " + result.note
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
  $("simulation-step").hidden = true;
  $("simulation-results").hidden = true;
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
    savePracticeResultForEvidence(result);

    if (sceneOverlay) map.removeLayer(sceneOverlay);
    sceneOverlay = L.imageOverlay(result.preview.preview_url, result.preview.preview_bounds, { opacity: 0.94 }).addTo(map);
    layers.clearLayers();
    const candidates = result.detection.candidates || [];
    candidates.forEach((candidate, index) => addGeometry(candidate.geometry,
      index === 0 ? colors.slick : colors.secondary,
      "Simulated dark radar feature " + (index + 1) + " · screening candidate, not real oil"));
    if (simulationMarker) map.removeLayer(simulationMarker);
    simulationMarker = null;
    const slick = result.simulation.slick_point.coordinates;
    if (simulationSlickMarker) map.removeLayer(simulationSlickMarker);
    simulationSlickMarker = L.featureGroup([
      L.circleMarker([slick[1], slick[0]], {
        radius: 17, color: "#ffc66f", weight: 3, fillColor: "#ffb547", fillOpacity: 0.22,
        className: "slick-pulse-ring",
      }),
      L.circleMarker([slick[1], slick[0]], {
        radius: 7, color: "#ffffff", weight: 3, fillColor: "#e66a2c", fillOpacity: 1,
      }).bindPopup("Center of the synthetic dark patch planted for this practice exercise."),
    ]).addTo(map);

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
    $("legend-ai").hidden = true;
    $("legend-dark-features").hidden = candidates.length < 2;
    $("legend-origin").hidden = true;
    $("legend-track").hidden = true;
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
    $("map-description").textContent = "Step 1 · full-scene synthetic radar overview";
    $("map-overlay-chip").innerHTML = '<span class="overlay-icon" aria-hidden="true">◉</span> SYNTHETIC RADAR OVERVIEW';
    $("legend-sim-source").hidden = true;
    $("legend-sim-slick").hidden = false;
    if (incidentMarker) map.removeLayer(incidentMarker);
    incidentMarker = null;
    $("map-message").hidden = true;
    $("map-message").textContent = candidates.length
      ? "Full radar scene · zooming to the synthetic patch in 2 seconds."
      : "No dark feature was detected in this synthetic practice run.";
    $("map-message").hidden = false;
    $("simulation-step").hidden = false;
    $("map-description").textContent = "Step 1 · full-scene view, then a close-up of the synthetic patch";
    $("simulation-step-title").textContent = "Full-scene radar overview";
    $("simulation-step-copy").textContent = "A generated Sentinel-1-style radar view is shown first. In two seconds, WakeTrace zooms to the planted practice patch. This is not actual satellite imagery.";
    $("simulation-step-count").textContent = "";
    $("show-vessel-matches").disabled = true;
    $("show-vessel-matches").textContent = "Zooming to patch…";
    $("simulation-panel").hidden = true;
    $("map-panel").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 11 });
    window.pendingSimulationResult = result;
    window.setTimeout(() => {
      if (window.pendingSimulationResult !== result) return;
      map.flyTo([slick[1], slick[0]], 14, { animate: !reduceMotion, duration: 1.2 });
      $("map-description").textContent = "Step 1 of 2 · inspect the highlighted possible dark feature";
      $("map-overlay-chip").innerHTML = '<span class="overlay-icon slick-chip-icon" aria-hidden="true">●</span> POSSIBLE SLICK · SYNTHETIC';
      $("map-message").textContent = candidates.length
        ? "Possible dark patch highlighted · synthetic exercise only; not confirmed oil."
        : "No dark feature was detected in this synthetic practice run.";
      $("simulation-step-title").textContent = "Inspect the highlighted possible slick";
      $("simulation-step-copy").textContent = "The map has zoomed to the dark feature found in the generated radar scene. It is a synthetic practice patch, not confirmed oil.";
      $("simulation-step-count").textContent = candidates.length + " possible dark feature" + (candidates.length === 1 ? "" : "s");
      $("show-vessel-matches").disabled = false;
      $("show-vessel-matches").textContent = "Show possible origin & vessel routes";
    }, 2000);
    $("simulation-status").textContent = isOfflinePractice
      ? "Offline practice complete. The background, patch, forcing, and routes are all generated."
      : "Simulation complete. The satellite image is real; the patch, forcing, and routes are fictional.";
  } catch (error) {
    $("simulation-status").textContent = error.message + " You can click another offshore point and try again.";
  } finally {
    button.disabled = false;
  }
});

$("show-vessel-matches").addEventListener("click", () => {
  if (window.pendingSimulationResult) revealVesselResults(window.pendingSimulationResult);
});

if (new URLSearchParams(window.location.search).get("demo") === "1") {
  startOfflinePractice();
}
