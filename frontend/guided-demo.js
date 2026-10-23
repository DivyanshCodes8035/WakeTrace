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
    vecCache = { u, v, speed: Math.hypot(u, v), bearing, derived, name: compass(bearing) };
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
    { label: "Wind", dwell: 6500, title: "2 · Wind (what-if)",
      text: "Wind pushes floating oil too. A common rule of thumb is that oil moves with about 3% of the wind speed on top of the current. Use the slider and watch the orange oil path bend away from the teal current-only path. The origin and vessel ranking in later steps still use the calm-wind backend run." },
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
  const explainText = el("p", "", "Press "Find probable slick" to start. Each button adds one layer to the map.");
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

  /* --- 1. stepSlick: enhanced with iridescent oil sheen rings --- */
  function stepSlick() {
    layers.addTo(map);
    if (simulationSlickMarker) simulationSlickMarker.addTo(map);
    const s = result.simulation.slick_point.coordinates;
    map.flyTo([s[1], s[0]], 14, { animate: !reduceMotion, duration: 1.4 });
    const n = (result.detection.candidates || []).length;
    show("legend-slick", n > 0); show("legend-sim-slick");
    chip('<span aria-hidden="true">●</span>', "POSSIBLE SLICK · SYNTHETIC");
    msg(n ? "Possible dark patch highlighted · synthetic exercise only; not confirmed oil." : "No dark feature met the screening settings in this run.");

    // Remove old rings if re-running
    (sub.slickRings || []).forEach((r) => gl.removeLayer(r));

    // Draw iridescent multi-ring oil sheen effect around the slick point
    const slickLL = [s[1], s[0]];
    const ring1 = L.circleMarker(slickLL, {
      radius: 22,
      fillColor: "#f59e0b",
      fillOpacity: 0.08,
      color: "#fcd34d",
      weight: 2,
      interactive: false,
    }).addTo(gl);
    const ring2 = L.circleMarker(slickLL, {
      radius: 35,
      fillColor: "#10b981",
      fillOpacity: 0.05,
      color: "#34d399",
      weight: 1.5,
      interactive: false,
    }).addTo(gl);
    const ring3 = L.circleMarker(slickLL, {
      radius: 48,
      fillColor: "#6366f1",
      fillOpacity: 0.04,
      color: "#818cf8",
      weight: 1,
      interactive: false,
    }).addTo(gl);
    sub.slickRings = [ring1, ring2, ring3];
  }

  /* ---------- wind what-if (browser-side, simplified: oil drift = current + 3% of wind) ---------- */
  const wind = { speed: 8, from: 315 };
  const whatifLayer = L.layerGroup().addTo(map);
  let whatifTimer = null, whatifDebounce = null;
  const DIRS = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];
  const windCtl = el("div", "guided-explain guided-wind-ctl");
  windCtl.hidden = true;
  windCtl.innerHTML = "<h3>Try a wind (what-if)</h3>" +
    '<label>Wind speed: <b id="gw-speed">8</b> m/s<input id="gw-range" type="range" min="0" max="15" step="1" value="8"></label>' +
    '<label>Blowing from<select id="gw-dir">' + DIRS.map(([n, d]) => '<option value="' + d + '"' + (d === 315 ? " selected" : "") + ">" + n + "</option>").join("") + "</select></label>" +
    "<p>Browser-side simplified model for explanation. Real runs use OpenDrift with Copernicus wind.</p>";
  side.append(windCtl);
  const trigger = () => { clearTimeout(whatifDebounce); whatifDebounce = setTimeout(() => { if (done >= 1 && done < 3) runWhatIf(); }, 150); };
  windCtl.querySelector("#gw-range").addEventListener("input", (e) => { wind.speed = Number(e.target.value); windCtl.querySelector("#gw-speed").textContent = wind.speed; trigger(); });
  windCtl.querySelector("#gw-dir").addEventListener("change", (e) => { wind.from = Number(e.target.value); trigger(); });

  function windGauge() {
    gauges.querySelector(".g-wind")?.remove();
    const toward = (wind.from + 180) % 360;
    const g = el("div", "guided-gauge g-wind");
    const needle = wind.speed > 0
      ? '<g transform="rotate(' + toward + ' 23 23)"><path d="M23 9l7 11h-4.5v13h-5V20H16z" fill="#ffb15e"/></g>'
      : '<circle class="ring" cx="23" cy="23" r="20" fill="none" stroke="#8fe9ff" stroke-width="2"/><circle cx="23" cy="23" r="3" fill="#8fe9ff"/>';
    g.innerHTML = '<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="20" fill="none" stroke="#9fc3cf" stroke-width="1.5"/><text x="23" y="10" text-anchor="middle" font-size="8" fill="#9fc3cf">N</text>' + needle + "</svg>" +
      "<div><small>WIND (WHAT-IF)</small><b>" + (wind.speed > 0 ? wind.speed + " m/s from " + compass(wind.from) : "Calm · 0 m/s") + "</b><span>you can change this</span></div>";
    gauges.prepend(g);
  }

  function runWhatIf() {
    clearInterval(whatifTimer);
    whatifLayer.clearLayers();
    windGauge();
    const c = currentVec();
    const frames = (result.drift?.animation?.frames || []).filter((f) => f && f.time && Array.isArray(f.positions));
    let rel = result.simulation.source_point.coordinates;
    let T = 6 * 3600;
    if (frames.length >= 2) {
      const pts = frames[0].positions.filter((q) => Array.isArray(q) && q.every(Number.isFinite));
      if (pts.length) rel = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
      const dt = (new Date(frames[frames.length - 1].time) - new Date(frames[0].time)) / 1000;
      if (dt > 0) T = dt;
    }
    const toward = ((wind.from + 180) % 360) * Math.PI / 180;
    const w = 0.03 * wind.speed;
    const uT = c.u + w * Math.sin(toward), vT = c.v + w * Math.cos(toward);
    const mLat = 111195, mLon = 111195 * Math.cos(rel[1] * Math.PI / 180);
    const at = (u, v, t, jx = 0, jy = 0) => [rel[1] + (v * t + jy) / mLat, rel[0] + (u * t + jx) / mLon];
    const start = [rel[1], rel[0]];
    const baseEnd = at(c.u, c.v, T), windEnd = at(uT, vT, T);
    L.polyline([start, baseEnd], { color: "#66d5ca", weight: 3, dashArray: "6 6", opacity: .95 }).bindPopup("Current only (calm wind)").addTo(whatifLayer);
    L.circleMarker(start, { radius: 7, color: "#fff", weight: 3, fillColor: "#d44d69", fillOpacity: 1 }).bindPopup("Release point").addTo(whatifLayer);
    const trail = L.polyline([start, start], { color: "#ffb15e", weight: 3, opacity: .95 }).addTo(whatifLayer);
    const jit = (i, k) => ((Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453) % 1) * 220;
    const parts = Array.from({ length: 24 }, (_, i) => L.circleMarker(start, { radius: 3.5, color: "#fff2e0", weight: 1, fillColor: "#ffb15e", fillOpacity: .9 }).addTo(whatifLayer));
    const km = w * T / 1000;
    const dirName = compass(toward * 180 / Math.PI);
    const note = wind.speed > 0
      ? "Wind " + wind.speed + " m/s from " + compass(wind.from) + " moves the oil about " + km.toFixed(1) + " km toward " + dirName + " compared with current alone. The radar slick was generated with calm wind, so this is a sensitivity demo."
      : "Calm wind: the oil simply follows the current.";
    chip('<span aria-hidden="true">≋</span>', wind.speed > 0 ? "WIND + CURRENT · WHAT-IF" : "WIND · CALM");
    msg(note);
    map.fitBounds(L.latLngBounds([start, baseEnd, windEnd]), { padding: [70, 70], maxZoom: 13, animate: !reduceMotion });
    const steps = reduceMotion ? 1 : 100;
    let k = 0;
    const frame = () => {
      const f = Math.min(1, k / steps), t = T * f;
      parts.forEach((m, i) => m.setLatLng(at(uT, vT, t, jit(i, 1) * (.3 + f), jit(i, 2) * (.3 + f))));
      trail.setLatLngs([start, at(uT, vT, t)]);
      if (k >= steps) {
        clearInterval(whatifTimer);
        if (wind.speed > 0) L.circleMarker(windEnd, { radius: 5, color: "#fff", weight: 2, fillColor: "#ffb15e", fillOpacity: 1 })
          .bindTooltip("+" + km.toFixed(1) + " km " + dirName + " from wind", { permanent: true, direction: "top" }).addTo(whatifLayer);
      }
      k += 1;
    };
    frame();
    if (!reduceMotion) whatifTimer = setInterval(frame, 50);
  }

  function stepWind() {
    windCtl.hidden = false;
    runWhatIf();
  }

  /* --- 3. drawFlow: enhanced with denser grid, speed-dependent opacity, size variation --- */
  function drawFlow() {
    flowLayer.clearLayers();
    const v = currentVec();
    const b = map.getBounds().pad(-0.08);
    const cols = 10, rows = 7;
    // Normalise speed to [0,1] for opacity scaling
    const speedNorm = Math.min(1, v.speed / 0.5); // cap at 0.5 m/s for visual max
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2; // grid centre indices
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const lat = b.getSouth() + (r + 0.5) / rows * (b.getNorth() - b.getSouth());
        const lng = b.getWest() + (c + 0.5) / cols * (b.getEast() - b.getWest());
        const delay = (((c + r * 0.6) * 0.18) % 2).toFixed(2);

        // Speed-dependent opacity: base 0.35, max 0.92
        const arrowOpacity = (0.35 + 0.57 * speedNorm).toFixed(2);

        // Subtle size variation based on position (±10%)
        const hashVal = Math.abs(Math.sin(c * 127.1 + r * 311.7) * 43758.5453) % 1;
        const sizePx = Math.round(22 + hashVal * 8); // 22–30 px range (~±15%)

        // Color: teal near centre, slight amber tint at edges
        const distFromCentre = Math.hypot((c - cx) / cx, (r - cy) / cy); // 0 centre → ~1.4 corner
        const edgeFactor = Math.min(1, distFromCentre / 1.2);
        // Interpolate hue: teal (180°) → amber (38°)
        const hue = Math.round(180 - edgeFactor * 142);
        const arrowColor = "hsl(" + hue + ",70%,60%)";

        const half = Math.round(sizePx / 2);
        const icon = L.divIcon({
          className: "flow-arrow-wrap",
          iconSize: [sizePx, sizePx],
          iconAnchor: [half, half],
          html: '<span class="flow-arrow" style="--rot:' + v.bearing.toFixed(1) + "deg;--delay:" + delay + "s;opacity:" + arrowOpacity + ';color:' + arrowColor + '"><svg viewBox="0 0 24 24" width="' + sizePx + '" height="' + sizePx + '"><path d="M12 3l6 8h-4v10h-4V11H6z"/></svg></span>',
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
    clearInterval(whatifTimer); whatifLayer.clearLayers(); windCtl.hidden = true;
    configureTrajectoryPlayback(result.drift, [], "Teal dots replay the modeled drift from the possible origin toward the slick. Synthetic practice data.");
    show("legend-origin"); show("legend-sim-source");
    chip('<span aria-hidden="true">↶</span>', "POSSIBLE ORIGIN · UNCERTAIN");
    msg("The origin is an area, not a point. It would be uncertain even with real data.");
    fit([p[1], p[0]]);
  }

  /* ---------- synthetic vessel definitions ---------- */
  const EXTRA_VESSELS = [
    {
      vessel_id: "MV PELAGIC STAR",
      rank: null,
      priority_score: null,
      explanation: "Synthetic AIS record for demonstration. Was 4.2 km from the modeled origin area. Model-path distance was 5.1 km. AIS reports do not cover the full release window.",
      track: null,
      track_positions: null,
    },
    {
      vessel_id: "MV AURORA CAPE",
      rank: null,
      priority_score: null,
      explanation: "Synthetic AIS record for demonstration. Was 7.8 km from the modeled origin area. Model-path distance was 9.3 km. Inside the drift release window.",
      track: null,
      track_positions: null,
    },
  ];

  /**
   * Build a plausible LineString GeoJSON track that passes near the origin centroid.
   * Uses a seeded pseudo-random based on vesselIndex so tracks differ.
   */
  function buildSyntheticTrack(originCoord, vesselIndex) {
    // originCoord = [lon, lat]
    const lon0 = originCoord[0], lat0 = originCoord[1];
    // Seed deterministic offsets per vessel
    const seed = (vesselIndex + 1) * 17.3;
    const rng = (s) => (Math.abs(Math.sin(s) * 43758.5453)) % 1;

    // Entry point: come in from one side
    const entryLonOff = (rng(seed) - 0.5) * 0.18;
    const entryLatOff = (rng(seed + 1) - 0.5) * 0.12;
    // Passage near origin
    const passLonOff = (rng(seed + 2) - 0.5) * 0.04;
    const passLatOff = (rng(seed + 3) - 0.5) * 0.03;
    // Exit point
    const exitLonOff = (rng(seed + 4) - 0.5) * 0.16;
    const exitLatOff = (rng(seed + 5) - 0.5) * 0.10;

    const coords = [
      [lon0 + entryLonOff, lat0 + entryLatOff],
      [lon0 + passLonOff * 0.6 + entryLonOff * 0.4, lat0 + passLatOff * 0.6 + entryLatOff * 0.4],
      [lon0 + passLonOff, lat0 + passLatOff],
      [lon0 + passLonOff * 0.4 + exitLonOff * 0.6, lat0 + passLatOff * 0.4 + exitLatOff * 0.6],
      [lon0 + exitLonOff, lat0 + exitLatOff],
    ];
    return { type: "LineString", coordinates: coords };
  }

  /**
   * Build synthetic track_positions array with timestamped positions.
   */
  function buildSyntheticTrackPositions(track, baseTimeISO) {
    const coords = track.coordinates;
    const base = baseTimeISO ? new Date(baseTimeISO).getTime() : Date.now() - 6 * 3600 * 1000;
    const stepMs = (6 * 3600 * 1000) / (coords.length - 1);
    return coords.map((c, i) => ({
      lon: c[0],
      lat: c[1],
      time: new Date(base + i * stepMs).toISOString(),
    }));
  }

  /**
   * Build a vessel marker with a heading indicator (SVG arrow) as a divIcon.
   */
  function vesselIconWithHeading(track, colorHex) {
    let headingDeg = 0;
    if (track && track.coordinates && track.coordinates.length >= 2) {
      const n = track.coordinates.length;
      const a = track.coordinates[n - 2], b = track.coordinates[n - 1];
      const dLon = b[0] - a[0], dLat = b[1] - a[1];
      headingDeg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    }
    const col = colorHex || "#3ed9c7";
    const html = `
      <div style="position:relative;width:32px;height:32px;">
        <!-- Heading line + arrowhead in vessel travel direction -->
        <svg style="position:absolute;top:0;left:0;width:32px;height:32px;overflow:visible;pointer-events:none;"
             viewBox="0 0 32 32" aria-hidden="true">
          <g transform="rotate(${headingDeg.toFixed(1)} 16 16)">
            <line x1="16" y1="16" x2="16" y2="-4" stroke="${col}" stroke-width="2" stroke-linecap="round"/>
            <polygon points="16,-4 13,-0 19,-0" fill="${col}"/>
          </g>
        </svg>
        <!-- Ship body icon -->
        <svg style="position:absolute;top:8px;left:8px;width:16px;height:16px;" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 17l9 4 9-4V9l-9-4-9 4z" fill="${col}" opacity="0.9"/>
          <rect x="10" y="5" width="4" height="6" fill="${col}"/>
        </svg>
      </div>`;
    return L.divIcon({
      className: "vessel-heading-icon",
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      html,
    });
  }

  /* --- 5. stepVessels: adds extra synthetic vessels, heading indicators, richer colors --- */
  const CANDIDATE_COLORS = ["#ff6b7e", "#f5bd58", "#81d4f5", "#b8a3ff"];

  function stepVessels() {
    (sub.tracks || []).forEach((t) => gl.removeLayer(t));
    (sub.syntheticMarkers || []).forEach((m) => gl.removeLayer(m));

    let cands = (result.vessel_candidates || []).slice();

    // Augment with extra synthetic vessels if fewer than 4
    const needed = Math.max(0, 4 - cands.length);
    const srcCoord = result.simulation.source_point.coordinates; // [lon, lat]
    const baseTime = (() => {
      const frames = (result.drift?.animation?.frames || []).filter((f) => f && f.time);
      return frames.length ? frames[0].time : new Date().toISOString();
    })();
    const realMaxScore = cands.reduce((mx, c) => Math.max(mx, Number(c.priority_score) || 0), 60);

    const extraScores = [realMaxScore - 15, realMaxScore - 25];
    for (let ei = 0; ei < needed; ei++) {
      const ev = { ...EXTRA_VESSELS[ei] };
      ev.rank = cands.length + ei + 1;
      ev.priority_score = Math.max(5, extraScores[ei] || (realMaxScore - 20 - ei * 10));
      ev.track = buildSyntheticTrack(srcCoord, ei);
      ev.track_positions = buildSyntheticTrackPositions(ev.track, baseTime);
      cands.push(ev);
    }

    sub.syntheticMarkers = [];

    sub.tracks = cands.map((c, i) => {
      if (!c.track) return null;
      const color = CANDIDATE_COLORS[i % CANDIDATE_COLORS.length];
      const style = { ...colors.track, color: "#bfe9f5" };

      // Place a heading-indicator marker at the last track point
      const trackCoords = c.track.coordinates;
      if (trackCoords && trackCoords.length > 0) {
        const lastCoord = trackCoords[trackCoords.length - 1];
        const hMarker = L.marker([lastCoord[1], lastCoord[0]], {
          icon: vesselIconWithHeading(c.track, color),
          interactive: true,
          title: c.vessel_id,
        }).bindPopup("<b>" + c.vessel_id + "</b><br>Fictional vessel · heading indicator").addTo(gl);
        sub.syntheticMarkers.push(hMarker);
      }

      return L.geoJSON({ type: "Feature", properties: {}, geometry: c.track }, {
        style,
        pointToLayer: (_f, latlng) => L.marker(latlng, { icon: vesselIcon("report") }),
      }).bindPopup(c.vessel_id + " · " + (c.track_positions ? "synthetic" : "fictional") + " vessel track").addTo(gl);
    });

    configureTrajectoryPlayback(result.drift, cands, "Ships and oil particles share one clock. Ships appear only between timestamped AIS reports; long gaps stay blank. Fictional data.");
    (trajectoryPlayback?.vessels || []).forEach(({ marker }) => marker.setIcon(vesselIcon("candidate")));
    show("legend-track", cands.length > 0);
    chip('<span aria-hidden="true">⛴</span>', "FICTIONAL AIS TRACKS");
    msg(cands.length + " vessels (including synthetic) have AIS reports near the possible origin. Not yet ranked.");
    fit();

    // Store augmented cands for stepRank to use
    sub.augmentedCands = cands;
  }

  const num = (re, text) => { const m = re.exec(text || ""); return m ? parseFloat(m[1]) : null; };
  const kmStr = (x) => (x == null ? "see details" : x.toFixed(1) + " km");

  /* --- 6. stepRank: uses augmented cands, colors all 4 tracks, richer vessel data --- */
  function stepRank() {
    const ranked = sub.augmentedCands || result.vessel_candidates || [];
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

  // Override candidateRouteStyle to use 4-color palette
  const _origCandidateRouteStyle = (typeof candidateRouteStyle === "function") ? candidateRouteStyle : null;
  function candidateRouteStyleEnhanced(i) {
    const base = _origCandidateRouteStyle ? _origCandidateRouteStyle(i) : {};
    return { ...base, color: CANDIDATE_COLORS[i % CANDIDATE_COLORS.length], weight: 3, opacity: 0.85 };
  }

  /* ---------- vessel type / flag / IMO data for strip ---------- */
  const VESSEL_TYPES = ["Bulk Carrier", "Tanker", "General Cargo", "Container Ship"];
  const FLAG_CODES = ["MHL", "PAN", "LBR", "BHS"];

  function fakeIMO(seed) {
    // 7-digit IMO number, seeded
    const n = Math.abs(Math.round(Math.sin(seed * 91.7) * 9000000)) % 9000000 + 1000000;
    return "IMO " + n;
  }
  function fakeMMSI(seed) {
    // 9-digit MMSI starting with 538 (Marshall Islands prefix)
    const n = Math.abs(Math.round(Math.sin(seed * 53.3) * 999999)) % 999999;
    return "538" + String(n).padStart(6, "0");
  }

  /* --- renderStrip: 6-column table with vessel type, flag, IMO/MMSI, status badge, confidence --- */
  function renderStrip(ranked) {
    strip.replaceChildren(el("div", "eyebrow", "PROBABLE VESSEL LEADS BASED ON FACTORS"),
      el("h2", "", "Which vessels should investigators look at first?"));
    if (!ranked) {
      strip.append(el("p", "muted guided-strip-empty", "Run steps 1 to 5, then press "Find vessel leads". Factors: origin proximity · drift-path proximity · AIS coverage."));
      return;
    }
    const table = el("div", "guided-table");
    const head = el("div", "guided-row head");
    ["VESSEL (AIS)", "VESSEL TYPE", "ORIGIN PROXIMITY", "DRIFT-PATH PROXIMITY", "AIS COVERAGE", "REVIEW PRIORITY"].forEach((h) => head.append(el("span", "", h)));
    table.append(head);

    ranked.forEach((c, i) => {
      const row = el("div", "guided-row" + (i === 0 ? " lead" : ""));
      row.style.animationDelay = i * 0.25 + "s";

      // Column 1: Vessel name + IMO/MMSI + flag sub-label
      const vtype = VESSEL_TYPES[i % VESSEL_TYPES.length];
      const flag = FLAG_CODES[i % FLAG_CODES.length];
      const imo = fakeIMO(i + 1);
      const mmsi = fakeMMSI(i + 1);
      const name = el("div");
      const nameStrong = el("strong", "", "#" + (c.rank || i + 1) + " · " + c.vessel_id);
      const imoSpan = el("small", "vessel-imo", imo + " · MMSI " + mmsi);
      const flagSpan = el("small", "vessel-flag", flag + " · " + vtype);
      const why = el("details");
      why.append(el("summary", "", "Why this score?"), el("p", "", c.explanation || "No explanation recorded."));
      name.append(nameStrong, document.createElement("br"), imoSpan, document.createElement("br"), flagSpan, why);

      // Column 2: Vessel type cell
      const vtypeCell = el("div");
      vtypeCell.append(el("strong", "", vtype), el("small", "", flag));

      // Columns 3-4: proximity
      const o = num(/was ([\d.]+) km from the modeled origin/, c.explanation);
      const d = num(/model-path distance was ([\d.]+) km/, c.explanation);
      const inside = /inside the drift release window/i.test(c.explanation || "");

      const score = Number(c.priority_score);

      // Status badge
      const statusLabel = i === 0 ? "PRIORITY" : i === 1 ? "REVIEW" : "MONITOR";
      const statusCls = i === 0 ? "badge-priority" : i === 1 ? "badge-review" : "badge-monitor";

      // Confidence indicator based on score
      let confLabel, confCls;
      if (score > 70) { confLabel = "▲ HIGH"; confCls = "conf-high"; }
      else if (score >= 40) { confLabel = "→ MED"; confCls = "conf-med"; }
      else { confLabel = "▼ LOW"; confCls = "conf-low"; }

      // Score cell
      const sc = el("div", "score-cell");
      const scoreLine = el("div", "score-line");
      const scoreBadge = el("span", "status-badge " + statusCls, statusLabel);
      const scoreVal = el("strong", "", Number.isFinite(score) ? score.toFixed(1) + " / 100" : "n/a");
      const confSpan = el("span", "conf-indicator " + confCls, confLabel);
      scoreLine.append(scoreVal, scoreBadge);
      const bar = el("div", "guided-bar"), fill = el("i"); fill.style.width = "0%"; bar.append(fill);
      sc.append(scoreLine, confSpan, bar);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.max(0, Math.min(100, score || 0)) + "%"; }));

      const cell = (main, small) => { const n = el("div"); n.append(el("strong", "", main), el("small", "", small)); return n; };
      row.append(name, vtypeCell,
        cell(kmStr(o), "closest report to origin area"),
        cell(kmStr(d), "to time-matched particles"),
        cell(inside ? "Inside window" : "Partial", "AIS reports vs release window"),
        sc);
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
    clearInterval(whatifTimer); whatifLayer.clearLayers(); windCtl.hidden = true;
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
    explainText.textContent = "A generated radar-style scene. Press "Find probable slick" to screen it for dark features.";
    refresh();
    setTimeout(() => {
      map.invalidateSize();
      if (result?.preview?.preview_bounds) map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 11, animate: false });
      chip('<span aria-hidden="true">◉</span>', "SYNTHETIC RADAR SCENE");
      msg("Synthetic radar-style scene. Press "Find probable slick" to screen it.");
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
