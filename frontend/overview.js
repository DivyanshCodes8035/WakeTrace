const $ = (id) => document.getElementById(id);

WakeTraceCase.load()
  .then((caseData) => {
    const detection = caseData.detection || {};
    const drift = caseData.drift || {};
    WakeTraceCase.markSynthetic(caseData);
    $("case-title").textContent = caseData.title || caseData.case_id || "Untitled case";
    $("case-subtitle").textContent = "Case " + (caseData.case_id || "ID unavailable") + " · Observation " + WakeTraceCase.formatUtc(detection.acquired_at);
    $("overview-observed").textContent = WakeTraceCase.formatUtc(detection.acquired_at);
    const candidateCount = Array.isArray(detection.candidates) ? detection.candidates.length : 0;
    $("overview-confidence").textContent = candidateCount
      ? candidateCount + " dark-feature candidate(s) · review required"
      : Number.isFinite(detection.confidence)
        ? Math.round(detection.confidence * 100) + "% · model output" : "Not calibrated / unavailable";
    $("overview-model").textContent = drift.model && drift.model !== "not-run" ? drift.model : "Not run";
    if (!drift.origin_zone) {
      $("overview-note-text").textContent = "No modeled origin geometry is available yet. A drift result needs a slick boundary plus time-matched wind and current data.";
    }
  })
  .catch((error) => {
    $("case-title").textContent = "Case data unavailable";
    $("case-subtitle").textContent = error.message;
    $("case-badge").textContent = "NO CASE";
    $("overview-note-text").textContent = "Check that the case JSON file is available, then reload this page.";
  });
