/* WakeTrace guided, button-led simulation.
   Loads AFTER map-page.js. It reuses the page's own map, layers, playback and result data,
   and reveals them one step at a time. Add ?guided=0 to the URL to get the classic page back. */
(() => {
  "use strict";
  if (new URLSearchParams(window.location.search).get("guided") === "0") return;
  try { if (!map || !layers || !animationLayer || !$) return; } catch (error) { return; }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = document.querySelector(".map-page-stage");
  const mapPanel = $("map-panel");
  if (!stage || !mapPanel) return;

  let result = null, done = -1, playing = false, flowOn = false, vecCache = null;
  const gl = L.layerGroup().addTo(map);           // origin zone, tracks, release point
  const flowLayer = L.layerGroup().addTo(map);    // animated current arrows
  map.createPane("flowPane").style.zIndex = 450;
  map.getPane("flowPane").style.pointerEvents = "none";
  let sub = {};

  /* ---------- helpers ---------- */
  const chip = (icon, text) => { $("map-overlay-chip").innerHTML = '<span class="overlay-icon" aria-hidden="true">' + icon + "</span> " + text; };
  const msg = (text) => { const m = $("map-message"); m.textContent = text; m.hidden = false; };
  const show = (id, on = true) => { const n = $(id); if (n) n.hidden = !on; };
  const NAMES = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const compass = (deg) => NAMES[Math.round(deg / 22.5) % 16];
  const fit = (extraLatLng) => {
    let b = null;
    [layers, sub.origin, ...(sub.tracks || [])].forEach((l) => {
      const lb = l && l.getBounds && l.getBounds();
      if (lb && lb.isValid()) b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast());
    });
    if (extraLatLng) b = b ? b.extend(extraLatLng) : L.latLngBounds(extraLatLng, extraLatLng);
    if (b) map.fitBounds(b, { padding: [50, 50], maxZoom: 13, animate: !reduceMotion });
  };

  /* current direction/speed, derived from how the modeled particles actually move */
  function currentVec() {
    if (vecCache) return vecCache;
    const frames = (result?.drift?.animation?.frames || []).filter((f) => f && f.time && Array.isArray(f.positions));
    let u = 0.12, v = 0.03, derived = false;
    if (frames.length >= 2) {
      const a = frames[0], z = frames[frames.length - 1];
      const n = Math.min(a.positions.length, z.positions.length);
      let dLon = 0, dLat = 0, lat0 = 0, k = 0;
      for (let i = 0; i < n; i += 1) {
        const p = a.positions[i], q = z.positions[i];
        if (Array.isArray(p) && Array.isArray(q) && [p[0], p[1], q[0], q[1]].every(Number.isFinite)) {
          dLon += q[0] - p[0]; dLat += q[1] - p[1]; lat0 += p[1]; k += 1;
        }
      }
      const secs = (new Date(z.time) - new Date(a.time)) / 1000;
      if (k && secs > 0) {
        dLon /= k; dLat /= k; lat0 /= k;
        u = dLon * Math.cos(lat0 * Math.PI / 180) * 111195 / secs;
        v = dLat * 111195 / secs;
        derived = true;
      }
    }
    const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
    vecCache = { speed: Math.hypot(u, v), bearing, derived, name: compass(bearing) };
    return vecCache;
  }

  /* ---------- layout ---------- */
  const layout = el("div", "guided-layout");
  stage.before(layout);
  const side = el("aside", "guided-side");
  side.setAttribute("aria-label", "Guided simulation steps");
  layout.append(side, stage);
  const gauges = el("div", "guided-gauges");
  stage.append(gauges);

  const STEPS = [
    { label: "Find probable slick", dwell: 3500, title: "1 · Find the probable slick",
      text: "Satellite radar (SAR) makes calm, oil-smoothed water look dark. WakeTrace screens the image for dark patches. Dark does not always mean oil (wind shadows and algae look similar), so this is only a possible slick." },
    { label: "Wind", dwell: 3500, title: "2 · Wind",
      text: "Wind pushes floating oil along the surface. Real runs read hourly wind from Copernicus Marine. This practice case assumes calm wind (0 m/s) so the effect of the current can be shown on its own." },
    { label: "Water flow", dwell: 4500, title: "3 · Water flow (current)",
      text: "Ocean current carries the oil. The animated arrows show the direction and speed used in this practice case, taken from how the modeled oil particles move." },
    { label: "Trace back to origin", dwell: 7000, title: "4 · Trace back to a possible origin",
      text: "Running the current backwards from the slick gives a possible origin area (teal dashed). It is an area, not a point, because the model is uncertain. The teal dots replay the drift from that area to the slick." },
    { label: "Vessels in the area", dwell: 7000, title: "5 · Vessels near the origin",
      text: "Ships broadcast their position with AIS. These are fictional tracks. Ships move on the same clock as the drift, so you can see who was near the origin while oil could have been released." },
    { label: "Find vessel leads", dwell: 0, title: "6 · Rank the vessel leads",
      text: "Each vessel gets a review priority from three factors: how close it came to the origin area, how close it was to the drifting particles at the same time, and how well its AIS reports cover the release window. It is an order for investigators, not the chance that a vessel is guilty." },
  ];

  side.append(el("div", "guided-kicker", "BUTTON-LED SIMULATION"),
    el("h2", "", "Follow the evidence one step at a time"),
    el("p", "guided-note", "Synthetic practice data. Press the steps in order."));
  const list = el("ol", "guided-steps");
  const btns = STEPS.map((step, i) => {
    const li = el("li");
    const b = el("button", "guided-step-btn");
    b.type = "button";
    b.append(el("span", "num", String(i + 1)), el("span", "", step.label));
    b.addEventListener("click", () => runStep(i));
    li.append(b); list.append(li);
    return b;
  });
  const playBtn = el("button", "secondary-button", "▶ Play all steps");
  const resetBtn = el("button", "secondary-button", "Reset");
  const classic = el("a", "guided-classic", "Classic view");
  playBtn.type = resetBtn.type = "button";
  classic.href = window.location.pathname + "?demo=1&guided=0";
  const actions = el("div", "guided-actions"); actions.append(playBtn, resetBtn, classic);
  const explainTitle = el("h3", "", "What you are looking at");
  const explainText = el("p", "", "Press “Find probable slick” to start. Each button adds one layer to the map.");
  const explain = el("div", "guided-explain"); explain.append(explainTitle, explainText);
  side.append(list, actions, explain);

  const strip = el("section", "guided-strip panel");
  strip.hidden = true;
  strip.setAttribute("aria-live", "polite");
  mapPanel.after(strip);

  function refresh() {
    btns.forEach((b, i) => {
      b.disabled = !result || playing || i > done + 1;
      b.classList.toggle("is-done", i <= done);
      b.classList.toggle("is-next", i === done + 1 && !playing && !!result);
    });
    playBtn.disabled = !result || done >= STEPS.length - 1;
    playBtn.textContent = playing ? "■ Stop" : "▶ Play all steps";
    resetBtn.disabled = !result;
  }

  /* ---------- steps ---------- */
  function stepSlick() {
    layers.addTo(map);
    if (simulationSlickMarker) simulationSlickMarker.addTo(map);
    const s = result.simulation.slick_point.coordinates;
    map.flyTo([s[1], s[0]], 14, { animate: !reduceMotion, duration: 1.4 });
    const n = (result.detection.candidates || []).length;
    show("legend-slick", n > 0); show("legend-sim-slick");
    chip('<span aria-hidden="true">●</span>', "POSSIBLE SLICK · SYNTHETIC");
    msg(n ? "Possible dark patch highlighted · synthetic exercise only; not confirmed oil." : "No dark feature met the screening settings in this run.");
  }

  function stepWind() {
    gauges.querySelector(".g-wind")?.remove();
    const g = el("div", "guided-gauge g-wind");
    g.innerHTML = '<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="20" fill="none" stroke="#9fc3cf" stroke-width="1.5"/><circle class="ring" cx="23" cy="23" r="20" fill="none" stroke="#8fe9ff" stroke-width="2"/><circle cx="23" cy="23" r="3" fill="#8fe9ff"/><text x="23" y="10" text-anchor="middle" font-size="8" fill="#9fc3cf">N</text></svg>' +
      "<div><small>WIND</small><b>Calm · 0 m/s</b><span>assumed in practice case</span></div>";
    gauges.prepend(g);
    chip('<span aria-hidden="true">≋</span>', "WIND · CALM (ASSUMED)");
    msg("Wind is assumed calm in this synthetic case, so it adds no push. Real cases use Copernicus wind data.");
  }

  function drawFlow() {
    flowLayer.clearLayers();
    const v = currentVec();
    const b = map.getBounds().pad(-0.08);
    const cols = 8, rows = 5;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const lat = b.getSouth() + (r + 0.5) / rows * (b.getNorth() - b.getSouth());
        const lng = b.getWest() + (c + 0.5) / cols * (b.getEast() - b.getWest());
        const delay = (((c + r * 0.6) * 0.18) % 2).toFixed(2);
        const icon = L.divIcon({
          className: "flow-arrow-wrap", iconSize: [26, 26], iconAnchor: [13, 13],
          html: '<span class="flow-arrow" style="--rot:' + v.bearing.toFixed(1) + "deg;--delay:" + delay + 's"><svg viewBox="0 0 24 24"><path d="M12 3l6 8h-4v10h-4V11H6z"/></svg></span>',
        });
        L.marker([lat, lng], { icon, pane: "flowPane", interactive: false, keyboard: false }).addTo(flowLayer);
      }
    }
  }
  map.on("moveend", () => { if (flowOn) drawFlow(); });

  function stepFlow() {
    flowOn = true;
    map.getPane("flowPane").classList.remove("is-dim");
    drawFlow();
    const v = currentVec();
    gauges.querySelector(".g-flow")?.remove();
    const g = el("div", "guided-gauge g-flow");
    g.innerHTML = '<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="20" fill="none" stroke="#9fc3cf" stroke-width="1.5"/><text x="23" y="10" text-anchor="middle" font-size="8" fill="#9fc3cf">N</text><g transform="rotate(' + v.bearing.toFixed(1) + ' 23 23)"><path d="M23 9l7 11h-4.5v13h-5V20H16z" fill="#8fe9ff"/></g></svg>' +
      "<div><small>CURRENT</small><b>" + v.speed.toFixed(2) + " m/s → " + v.name + "</b><span>" + (v.derived ? "from modeled particle motion" : "assumed value") + "</span></div>";
    gauges.append(g);
    chip('<span aria-hidden="true">➜</span>', "WATER FLOW · SYNTHETIC");
    msg("Current ≈ " + v.speed.toFixed(2) + " m/s toward " + v.name + " (invented for this practice case).");
  }

  function stepOrigin() {
    ["origin", "src"].forEach((k) => { if (sub[k]) gl.removeLayer(sub[k]); });
    sub.origin = L.geoJSON(result.drift.origin_zone, { style: colors.origin }).bindPopup("Possible origin area · synthetic exercise").addTo(gl);
    const p = result.simulation.source_point.coordinates;
    sub.src = L.circleMarker([p[1], p[0]], { radius: 8, color: "#fff", weight: 3, fillColor: "#d44d69", fillOpacity: 1 })
      .bindPopup("Fictional release point planted for this exercise.").addTo(gl);
    map.getPane("flowPane").classList.add("is-dim");
    configureTrajectoryPlayback(result.drift, [], "Teal dots replay the modeled drift from the possible origin toward the slick. Synthetic practice data.");
    show("legend-origin"); show("legend-sim-source");
    chip('<span aria-hidden="true">↶</span>', "POSSIBLE ORIGIN · UNCERTAIN");
    msg("The origin is an area, not a point. It would be uncertain even with real data.");
    fit([p[1], p[0]]);
  }

  function stepVessels() {
    (sub.tracks || []).forEach((t) => gl.removeLayer(t));
    const cands = result.vessel_candidates || [];
    const neutral = { ...colors.track, color: "#bfe9f5" };
    sub.tracks = cands.map((c) => {
      if (!c.track) return null;
      return L.geoJSON({ type: "Feature", properties: {}, geometry: c.track }, {
        style: neutral,
        pointToLayer: (_f, latlng) => L.marker(latlng, { icon: vesselIcon("report") }),
      }).bindPopup(c.vessel_id + " · fictional vessel track").addTo(gl);
    });
    configureTrajectoryPlayback(result.drift, cands, "Ships and oil particles share one clock. Ships appear only between timestamped AIS reports; long gaps stay blank. Fictional data.");
    (trajectoryPlayback?.vessels || []).forEach(({ marker }) => marker.setIcon(vesselIcon("candidate")));
    show("legend-track", cands.length > 0);
    chip('<span aria-hidden="true">⛴</span>', "FICTIONAL AIS TRACKS");
    msg(cands.length + " fictional vessels have AIS reports near the possible origin. Not yet ranked.");
    fit();
  }

  const num = (re, text) => { const m = re.exec(text || ""); return m ? parseFloat(m[1]) : null; };
  const km = (x) => (x == null ? "see details" : x.toFixed(1) + " km");

  function stepRank() {
    const ranked = result.vessel_candidates || [];
    ranked.forEach((c, i) => {
      const t = (sub.tracks || [])[i];
      if (t) t.setStyle(candidateRouteStyle(i));
    });
    (trajectoryPlayback?.vessels || []).forEach(({ marker, candidate }) => {
      marker.setIcon(vesselIcon(ranked[0] && candidate.vessel_id === ranked[0].vessel_id ? "lead" : "candidate"));
    });
    renderStrip(ranked);
    chip('<span aria-hidden="true">★</span>', "VESSEL LEADS RANKED");
    msg("Ranked by review priority. A lead is where to look first, not proof of responsibility.");
    strip.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  function renderStrip(ranked) {
    strip.replaceChildren(el("div", "eyebrow", "PROBABLE VESSEL LEADS BASED ON FACTORS"),
      el("h2", "", "Which vessels should investigators look at first?"));
    if (!ranked) {
      strip.append(el("p", "muted guided-strip-empty", "Run steps 1 to 5, then press “Find vessel leads”. Factors: origin proximity · drift-path proximity · AIS coverage."));
      return;
    }
    const table = el("div", "guided-table");
    const head = el("div", "guided-row head");
    ["VESSEL (AIS)", "ORIGIN PROXIMITY", "DRIFT-PATH PROXIMITY", "AIS COVERAGE", "REVIEW PRIORITY"].forEach((h) => head.append(el("span", "", h)));
    table.append(head);
    ranked.forEach((c, i) => {
      const row = el("div", "guided-row" + (i === 0 ? " lead" : ""));
      row.style.animationDelay = i * 0.25 + "s";
      const name = el("div"); name.append(el("strong", "", "#" + (c.rank || i + 1) + " · " + c.vessel_id));
      const why = el("details"); why.append(el("summary", "", "Why this score?"), el("p", "", c.explanation || "No explanation recorded."));
      name.append(why);
      const o = num(/was ([\d.]+) km from the modeled origin/, c.explanation);
      const d = num(/model-path distance was ([\d.]+) km/, c.explanation);
      const inside = /inside the drift release window/i.test(c.explanation || "");
      const score = Number(c.priority_score);
      const sc = el("div"); sc.append(el("strong", "", Number.isFinite(score) ? score.toFixed(1) + " / 100" : "n/a"));
      const bar = el("div", "guided-bar"), fill = el("i"); fill.style.width = "0%"; bar.append(fill); sc.append(bar);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.max(0, Math.min(100, score || 0)) + "%"; }));
      const cell = (main, small) => { const n = el("div"); n.append(el("strong", "", main), el("small", "", small)); return n; };
      row.append(name, cell(km(o), "closest report to origin area"), cell(km(d), "to time-matched particles"),
        cell(inside ? "Inside window" : "Partial", "AIS reports vs release window"), sc);
      table.append(row);
    });
    strip.append(table);
    const truthId = result.simulation.truth_vessel_id;
    const tr = ranked.findIndex((c) => c.vessel_id === truthId) + 1;
    if (truthId) strip.append(el("div", "guided-truth", "Ground truth (known only because this is synthetic): " + truthId + (tr ? " was the generated source and ranked #" + tr + "." : " was the generated source but was not returned as a candidate.")));
    strip.append(el("p", "guided-disclaimer", "Review priority is a screening score, not a probability. Results are investigation leads and do not establish responsibility."));
  }

  const STEP_FNS = [stepSlick, stepWind, stepFlow, stepOrigin, stepVessels, stepRank];

  function runStep(i, force) {
    if (!result || (!force && (playing || i > done + 1))) return;
    STEP_FNS[i]();
    done = Math.max(done, i);
    explainTitle.textContent = STEPS[i].title;
    explainText.textContent = STEPS[i].text;
    $("map-description").textContent = "Step " + (i + 1) + " of " + STEPS.length + " · " + STEPS[i].label;
    refresh();
  }

  async function playAll() {
    if (playing) { playing = false; refresh(); return; }
    playing = true; refresh();
    for (let i = done + 1; i < STEPS.length && playing; i += 1) {
      runStep(i, true);
      await sleep(STEPS[i].dwell);
    }
    playing = false; refresh();
  }

  function clearAll() {
    playing = false; flowOn = false; vecCache = null; done = -1; sub = {};
    gl.clearLayers(); flowLayer.clearLayers(); gauges.replaceChildren();
    try { configureTrajectoryPlayback(null, []); } catch (error) { /* nothing playing */ }
    if (map.hasLayer(layers)) map.removeLayer(layers);
    if (simulationSlickMarker && map.hasLayer(simulationSlickMarker)) map.removeLayer(simulationSlickMarker);
    ["legend-slick", "legend-sim-slick", "legend-origin", "legend-track", "legend-particles", "legend-sim-source", "legend-dark-features"].forEach((id) => show(id, false));
    renderStrip(null);
  }

  function enter() {
    clearAll();
    document.body.classList.add("guided-mode");
    layout.classList.add("is-active");
    strip.hidden = false;
    explainTitle.textContent = "What you are looking at";
    explainText.textContent = "A generated radar-style scene. Press “Find probable slick” to screen it for dark features.";
    refresh();
    setTimeout(() => {
      map.invalidateSize();
      if (result?.preview?.preview_bounds) map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 11, animate: false });
      chip('<span aria-hidden="true">◉</span>', "SYNTHETIC RADAR SCENE");
      msg("Synthetic radar-style scene. Press “Find probable slick” to screen it.");
      $("map-description").textContent = "Guided simulation · press step 1 to screen the radar scene";
    }, 120);
  }

  playBtn.addEventListener("click", playAll);
  resetBtn.addEventListener("click", enter);

  /* Take over when the page finishes a simulation run (it stores the result here). */
  let pending;
  Object.defineProperty(window, "pendingSimulationResult", {
    configurable: true,
    get() { return pending; },
    set(value) {
      if (!value) { pending = value; return; }
      result = value;
      pending = null;   // makes map-page.js skip its own auto-zoom / one-shot reveal
      enter();
    },
  });
})();
