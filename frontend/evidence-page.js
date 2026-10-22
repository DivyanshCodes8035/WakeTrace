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
  entries.forEach(([key, value]) => {
    const row = document.createElement("div");
    row.append(addTextElement("dt", key.replaceAll("_", " ")));
    row.append(addTextElement("dd", typeof value === "object" ? JSON.stringify(value) : String(value)));
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
    document.title = "WakeTrace | Evidence | " + (caseData.case_id || "Case");
    $("case-title").textContent = caseData.title || caseData.case_id || "Untitled case";
    $("case-subtitle").textContent = "Case " + (caseData.case_id || "ID unavailable") + " · Observation " + WakeTraceCase.formatUtc(detection.acquired_at);
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
