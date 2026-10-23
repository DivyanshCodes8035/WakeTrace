const $ = (id) => document.getElementById(id);

function addTextElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderTimeline(caseData) {
  const start = new Date(caseData.drift?.release_window?.start);
  const end = new Date(caseData.drift?.release_window?.end);
  const observed = new Date(caseData.detection?.acquired_at);
  if ([start, end, observed].some((value) => Number.isNaN(value.getTime())) || end <= start) {
    $("timeline-duration").textContent = "Unavailable";
    $("timeline-start").textContent = "No valid drift window recorded";
    $("timeline-end").textContent = "";
    document.querySelector(".timeline-track").hidden = true;
    return;
  }
  const span = end - start;
  const total = span + Math.max(span * 0.1, 60 * 60 * 1000);
  $("window-bar").style.width = (span / total * 100) + "%";
  $("observation-marker").style.left = Math.min(100, Math.max(0, (observed - start) / total * 100)) + "%";
  $("timeline-start").textContent = "Search begins · " + WakeTraceCase.formatUtc(start.toISOString());
  $("timeline-end").textContent = "Slick observed · " + WakeTraceCase.formatUtc(observed.toISOString());
  $("timeline-duration").textContent = Math.round(span / 3600000) + " hour search horizon";
}

function renderSources(sources) {
  const list = $("source-list");
  list.replaceChildren();
  if (!sources.length) {
    list.append(addTextElement("li", "No environmental source details are recorded."));
    return;
  }
  sources.forEach((source) => {
    const item = document.createElement("li");
    const heading = addTextElement("strong", [source.provider, source.dataset, source.version].filter(Boolean).join(" · ") || "Recorded source");
    const description = addTextElement("span", source.description || source.url || source.path || "No description supplied.");
    item.append(heading, description);
    list.append(item);
  });
}

function renderSarCandidates(candidates = []) {
  const list = $("sar-candidate-list");
  list.replaceChildren();
  if (!candidates.length) {
    list.append(addTextElement("p", "No SAR dark-feature screening candidates are recorded.", "empty-state"));
    return;
  }
  candidates.forEach((candidate, index) => {
    const card = document.createElement("article");
    card.className = "candidate-card";
    const top = document.createElement("div");
    top.className = "candidate-card-heading";
    top.append(addTextElement("h3", "Dark feature " + (index + 1)));
    top.append(addTextElement("span", "Screening " + candidate.screening_score + " / 100", "score-pill"));
    card.append(top);
    card.append(addTextElement("p", (candidate.pixel_count || 0) + " pixels · " + (candidate.contrast_from_scene_median_db ?? "—") + " dB contrast"));
    if (candidate.explanation) card.append(addTextElement("p", candidate.explanation, "muted"));
    list.append(card);
  });
}

function renderSettings(settings = {}) {
  const list = $("settings-list");
  list.replaceChildren();
  const entries = Object.entries(settings);
  if (!entries.length) entries.push(["Status", "No simulation settings recorded"]);
  const explanations = {
    "algorithm": "The image-screening steps used to find unusually dark connected areas.",
    "backscatter units expected": "Radar brightness unit expected by the image screen.",
    "polarization": "The orientation of the radar signal used to make this image.",
    "band": "Which radar image layer was read.",
    "dark percentile": "How dark a pixel must be compared with other usable pixels to be screened.",
    "minimum contrast db": "The minimum radar-brightness difference required to keep a dark feature.",
    "minimum component pixels": "The minimum number of connected image pixels needed to keep a feature.",
    "maximum candidates": "The largest number of dark features the screen will return.",
    "water mask used": "Whether a separate land/water mask was used.",
    "valid pixel count": "How many usable image pixels were checked.",
    "dark threshold db": "The radar-brightness cutoff used to mark dark pixels.",
    "scene median db": "The middle radar-brightness value in the scene, used as a comparison.",
    "connected components before filtering": "The number of joined dark areas found before small or weak ones were removed.",
    "candidates returned": "How many dark areas remained for review.",
    "direction": "Whether the model moves forward or backward in time.",
    "duration hours": "The length of the modeled time period.",
    "ensemble size": "How many slightly varied sample paths were used to illustrate spread.",
    "wind east m s": "Eastward wind component used by the model, in metres per second.",
    "wind north m s": "Northward wind component used by the model, in metres per second.",
    "current east m s": "Eastward ocean-current component used by the model, in metres per second.",
    "current north m s": "Northward ocean-current component used by the model, in metres per second.",
    "random seed": "A repeatable starting number so this synthetic example can be generated the same way again.",
    "method": "The calculation method used; compare this with the model name and recorded data sources."
  };
  entries.forEach(([key, value]) => {
    const row = document.createElement("div");
    const readableKey = key.replaceAll("_", " ");
    const shortKey = readableKey.split(" · ").pop().toLowerCase();
    row.append(addTextElement("dt", readableKey));
    const definition = document.createElement("dd");
    definition.append(document.createTextNode(typeof value === "object" ? JSON.stringify(value) : String(value)));
    const explanation = explanations[shortKey];
    if (explanation) definition.append(addTextElement("small", explanation));
    row.append(definition);
    list.append(row);
  });
}

function renderCandidates(candidates = []) {
  $("candidate-count").textContent = String(candidates.length);
  const list = $("candidate-list");
  list.replaceChildren();
  if (!candidates.length) {
    list.append(addTextElement("p", "No AIS candidates are included in this case. This is not evidence that vessels were absent.", "empty-state"));
    return;
  }
  candidates.forEach((candidate) => {
    const card = document.createElement("article");
    card.className = "candidate-card";
    const top = document.createElement("div");
    top.className = "candidate-card-heading";
    top.append(addTextElement("h3", "#" + (candidate.rank || "—") + " · " + (candidate.vessel_id || "Unknown vessel ID")));
    top.append(addTextElement("span", Number.isFinite(candidate.priority_score) ? candidate.priority_score + " / 100" : "No score", "score-pill"));
    card.append(top);
    if (candidate.explanation) card.append(addTextElement("p", candidate.explanation));
    if (candidate.data_quality_note) card.append(addTextElement("p", candidate.data_quality_note, "muted"));
    list.append(card);
  });
}

WakeTraceCase.load()
  .then((caseData) => {
    WakeTraceCase.markSynthetic(caseData);
    const detection = caseData.detection || {};
    const drift = caseData.drift || {};
    document.title = "WakeTrace | Evidence | " + (caseData.title || caseData.case_id || "Case");
    $("case-title").textContent = caseData.title || caseData.case_id || "Untitled case";
    $("case-subtitle").textContent = caseData.practice_result
      ? "Generated practice run · Observation " + WakeTraceCase.formatUtc(detection.acquired_at)
      : "Case " + (caseData.case_id || "ID unavailable") + " · Observation " + WakeTraceCase.formatUtc(detection.acquired_at);
    $("model-name").textContent = drift.model && drift.model !== "not-run" ? drift.model : "No drift simulation available";
    $("ensemble-size").textContent = Number.isFinite(drift.ensemble_size) && drift.ensemble_size > 0
      ? drift.ensemble_size + " particles" : "Unavailable";
    $("release-window").textContent = drift.release_window?.start && drift.release_window?.end
      ? WakeTraceCase.formatUtc(drift.release_window.start) + " – " + WakeTraceCase.formatUtc(drift.release_window.end)
      : "Unavailable";
    $("uncertainty-note").textContent = drift.uncertainty_note || "No drift estimate or uncertainty statement is available.";
    renderTimeline(caseData);
    const detectionSources = detection.provenance?.input_sources || (detection.source
      ? [{ provider: detection.source, description: "Acquired · " + WakeTraceCase.formatUtc(detection.acquired_at) }]
      : []);
    const driftSources = drift.provenance?.input_sources || caseData.provenance?.environmental_data || [];
    renderSources([...detectionSources, ...driftSources]);
    renderSarCandidates(detection.candidates || []);
    renderSettings({
      ...Object.fromEntries(Object.entries(detection.provenance?.settings || {}).map(([key, value]) => ["Satellite · " + key, value])),
      ...Object.fromEntries(Object.entries(drift.provenance?.settings || {}).map(([key, value]) => ["Drift · " + key, value])),
    });
    renderCandidates(caseData.vessel_candidates || []);
  })
  .catch((error) => {
    $("case-title").textContent = "Case data unavailable";
    $("case-subtitle").textContent = error.message;
    $("case-badge").textContent = "NO CASE";
  });
