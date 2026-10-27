/* WakeTrace guided, button-led simulation (v2: professional rendering).
   Loads AFTER map-page.js. Reuses the page's map, result data and helpers; draws its own
   canvas scene (feathered slick, oil plume, routes, wakes) and vessel markers.
   Add ?guided=0 to the URL to get the classic page back. */
(() => {
  "use strict";
  if (new URLSearchParams(window.location.search).get("guided") === "0") return;
  try { if (!map || !layers || !animationLayer || !$) return; } catch (error) { return; }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = document.querySelector(".map-page-stage");
  const mapPanel = $("map-panel");
  if (!stage || !mapPanel) return;

  const TAU = Math.PI * 2;
  const ms = (s) => new Date(s).getTime();
  const pad2 = (n) => String(n).padStart(2, "0");
  const hhmm = (t) => { const d = new Date(t); return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()); };
  const dayUtc = (t) => new Date(t).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" }) + " · UTC";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smooth = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
  const distKm = (aLat, aLon, bLat, bLon) => Math.hypot((bLon - aLon) * Math.cos((aLat + bLat) / 2 * Math.PI / 180) * 111.195, (bLat - aLat) * 111.195);
  const bearingOf = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
  const hash = (i, k, j) => (Math.sin((i + 1) * 12.9898 + (k + 1) * 78.233 + j * 37.719) * 43758.5453) % 1;
  const NAMES = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const compass = (deg) => NAMES[Math.round(deg / 22.5) % 16];
  const P = (lat, lon) => map.latLngToContainerPoint([lat, lon]);
  const NEUTRAL = "#bfe9f5";

  let result = null, done = -1, playing = false, flowOn = false, vecCache = null;
  const flowLayer = L.layerGroup().addTo(map);
  const vesselLayer = L.layerGroup().addTo(map);
  const whatifLayer = L.layerGroup().addTo(map);
  map.createPane("flowPane").style.zIndex = 450;
  map.getPane("flowPane").style.pointerEvents = "none";
  const simPane = map.createPane("simPane");
  simPane.style.zIndex = 430; simPane.style.pointerEvents = "none";
  const cvs = document.createElement("canvas");
  cvs.className = "sim-canvas";
  simPane.appendChild(cvs);
  const ctx = cvs.getContext("2d");
  let scaleControl = null;

  const chip = (_icon, text) => { $("map-overlay-chip").innerHTML = '<span class="g-dot"></span>' + text; };
  const msg = (text) => { const m = $("map-message"); m.textContent = text; m.hidden = false; };

  const sim = {
    active: false, t: 0, playing: false, last: 0, D: 9000, T0: 0, T1: 1,
    frames: [], cents: [], cloud: [], slick: [], slickKm2: 0, origin: null, release: null, vessels: [], ranked: false,
    showSlick: false, showOrigin: false, showParticles: false, showVessels: false, showFlow: false,
  };

  /* ---------- geometry helpers ---------- */
  function ringsOf(g) {
    if (!g) return [];
    if (g.type === "Feature") return ringsOf(g.geometry);
    if (g.type === "Polygon") return [g.coordinates[0]];
    if (g.type === "MultiPolygon") return g.coordinates.map((p) => p[0]);
    return [];
  }
  function smoothRing(ring) {
    let p = ring.map((q) => [q[0], q[1]]);
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
    if (p.length < 4) return p;
    for (let pass = 0; pass < 2; pass += 1) {
      const n = p.length;
      p = p.map((q, i) => { const a = p[(i + n - 1) % n], b = p[(i + 1) % n]; return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4]; });
    }
    const out = [];
    for (let i = 0; i < p.length; i += 1) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    return out;
  }
  function ringAreaKm2(r) {
    const lat0 = r.reduce((s, q) => s + q[1], 0) / r.length;
    const kx = 111.195 * Math.cos(lat0 * Math.PI / 180), ky = 111.195;
    let a = 0;
    for (let i = 0; i < r.length - 1; i += 1) a += (r[i][0] * kx) * (r[i + 1][1] * ky) - (r[i + 1][0] * kx) * (r[i][1] * ky);
    return Math.abs(a) / 2;
  }
  function inPoly(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToPolyKm(lat, lon, ring) {
    if (inPoly(lat, lon, ring)) return 0;
    const kx = 111.195 * Math.cos(lat * Math.PI / 180), ky = 111.195;
    let best = Infinity;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const ax = (ring[i][0] - lon) * kx, ay = (ring[i][1] - lat) * ky, bx = (ring[i + 1][0] - lon) * kx, by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? clamp(-(ax * dx + ay * dy) / len, 0, 1) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

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

  /* ---------- scene data ---------- */
  const TYPES = { "SIM-VESSEL-01": "Oil tanker", "SIM-VESSEL-02": "Bulk carrier", "SIM-VESSEL-03": "Fishing vessel", "SIM-VESSEL-04": "Survey vessel" };
  const posAt = (v, t) => candidatePositionAt(v.tp, new Date(t));

  function buildSegs(fixes) {
    const segs = [];
    let cur = [];
    const at = (i) => fixes[Math.max(0, Math.min(fixes.length - 1, i))];
    for (let i = 0; i < fixes.length - 1; i += 1) {
      const p1 = fixes[i], p2 = fixes[i + 1];
      if (p2.t - p1.t > 2 * 3600000) { if (cur.length) segs.push(cur); cur = []; continue; }
      const p0 = at(i - 1), p3 = at(i + 2);
      for (let s = 0; s < 8; s += 1) {
        const q = s / 8, q2 = q * q, q3 = q2 * q;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * q + (2 * a - 5 * b + 4 * c - d) * q2 + (-a + 3 * b - 3 * c + d) * q3);
        cur.push({ t: p1.t + (p2.t - p1.t) * q, lat: f(p0.lat, p1.lat, p2.lat, p3.lat), lon: f(p0.lon, p1.lon, p2.lon, p3.lon) });
      }
      if (i === fixes.length - 2) cur.push({ t: p2.t, lat: p2.lat, lon: p2.lon });
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function mkVessel(id, tp, extra, candidate) {
    const fixes = (tp || []).map((p) => ({ t: ms(p.time), lon: Number(p.coordinates?.[0]), lat: Number(p.coordinates?.[1]) }))
      .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.lon) && Number.isFinite(f.lat)).sort((a, b) => a.t - b.t);
    if (fixes.length < 2) return null;
    let lenKm = 0;
    for (let i = 1; i < fixes.length; i += 1) lenKm += distKm(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
    const hours = (fixes[fixes.length - 1].t - fixes[0].t) / 3600000;
    return {
      id, tp, fixes, extra, candidate, type: TYPES[id] || "Vessel", segs: buildSegs(fixes),
      t0: fixes[0].t, t1: fixes[fixes.length - 1].t, kn: hours > 0 ? lenKm / hours / 1.852 : 0,
      color: NEUTRAL, hd: null, marker: null, hull: null, root: null, m: {}, score: 0, rank: 0,
    };
  }

  function makeExtras() {
    const o = sim.origin;
    if (!o) return [];
    const c = currentVec();
    const sp = Math.hypot(c.u, c.v) || 1;
    const ex = c.u / sp, ey = c.v / sp;           // unit vector along the drift
    const mLat = 111195, mLon = 111195 * Math.cos(o.cLat * Math.PI / 180);
    const S = sim.T1 - sim.T0;
    const line = (id, aKm0, bKm0, aKm1, bKm1, f0, f1, stepMin, wobbleKm) => {
      const tp = [];
      const n = Math.max(2, Math.round((f1 - f0) * S / (stepMin * 60000)));
      for (let i = 0; i <= n; i += 1) {
        const q = i / n;
        const a = (aKm0 + (aKm1 - aKm0) * q) * 1000;
        const b = (bKm0 + (bKm1 - bKm0) * q + wobbleKm * Math.sin(q * Math.PI * 1.6)) * 1000;
        const E = a * ex + b * (-ey), N = a * ey + b * ex;
        tp.push({ time: new Date(sim.T0 + (f0 + (f1 - f0) * q) * S).toISOString(), coordinates: [o.cLon + E / mLon, o.cLat + N / mLat] });
      }
      return mkVessel(id, tp, true, null);
    };
    return [
      line("SIM-VESSEL-03", -7.5, 9.5, 6.5, 5.0, 0.22, 0.72, 10, 0.6),
      line("SIM-VESSEL-04", -14, -21, 12, -18.5, 0.12, 0.88, 12, -0.8),
    ].filter(Boolean);
  }

  const explainBackend = (text) => ({
    originKm: (() => { const m = /was ([\d.]+) km from the modeled origin/.exec(text || ""); return m ? parseFloat(m[1]) : null; })(),
    pathKm: (() => { const m = /model-path distance was ([\d.]+) km/.exec(text || ""); return m ? parseFloat(m[1]) : null; })(),
    cpaT: (() => { const m = /at (\d{4}-\d\d-\d\dT[\d:]+Z)/.exec(text || ""); return m ? ms(m[1]) : null; })(),
    inside: /inside the drift release window/i.test(text || ""),
  });

  function computeMetrics(v) {
    const o = sim.origin;
    let best = Infinity, bestT = null;
    if (o) for (let t = v.t0; t <= v.t1; t += 300000) {
      const p = posAt(v, t);
      if (!p) continue;
      const d = distToPolyKm(p[0], p[1], o.ring);
      if (d < best) { best = d; bestT = t; }
    }
    let pathBest = Infinity;
    sim.frames.forEach((f) => {
      const p = posAt(v, f.t);
      if (!p) return;
      f.pos.forEach((q) => { if (q) pathBest = Math.min(pathBest, distKm(p[0], p[1], q[1], q[0])); });
    });
    const parsed = v.candidate ? explainBackend(v.candidate.explanation) : null;
    const overlap = clamp((Math.min(v.t1, sim.T1) - Math.max(v.t0, sim.T0)) / Math.max(1, sim.T1 - sim.T0), 0, 1);
    const m = {
      originKm: parsed?.originKm ?? (Number.isFinite(best) ? best : null),
      pathKm: parsed?.pathKm ?? (Number.isFinite(pathBest) ? pathBest : null),
      cpaT: parsed?.cpaT ?? bestT,
      inside: parsed ? parsed.inside : v.t0 >= sim.T0 && v.t1 <= sim.T1,
      overlap,
    };
    m.fo = m.originKm == null ? 0 : Math.exp(-m.originKm / 11.2);
    m.fp = m.pathKm == null ? 0 : Math.exp(-m.pathKm / 42);
    m.fc = m.inside ? 1 : overlap;
    v.m = m;
    const backend = Number(v.candidate?.priority_score);
    v.estimated = !Number.isFinite(backend);
    v.score = Number.isFinite(backend) ? backend : 100 * (0.45 * m.fo + 0.35 * m.fp + 0.20 * m.fc);
    v.why = v.candidate?.explanation || ("Closest approach " + (m.originKm == null ? "n/a" : m.originKm.toFixed(1) + " km") + " to the modeled origin zone" + (m.cpaT ? " at " + hhmm(m.cpaT) + " UTC" : "") + ". Nearest modeled oil particle at the same time: " + (m.pathKm == null ? "n/a" : m.pathKm.toFixed(1) + " km") + ". AIS reports " + (m.inside ? "fall inside" : "only partly cover") + " the release window. Fictional track scored in the browser with the same three factors.");
  }

  function buildScene() {
    Object.assign(sim, { frames: [], cents: [], cloud: [], slick: [], origin: null, release: null, vessels: [], slickKm2: 0 });
    const d = result.drift || {};
    const fr = (d.animation?.frames || []).filter((f) => f && f.time && Array.isArray(f.positions));
    const n = fr.length ? Math.min(...fr.map((f) => f.positions.length)) : 0;
    if (fr.length >= 2 && n > 0) {
      sim.frames = fr.map((f) => ({ t: ms(f.time), pos: f.positions.slice(0, n).map((p) => (Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite) ? [p[0], p[1]] : null)) }))
        .sort((a, b) => a.t - b.t);
      sim.cents = sim.frames.map((f) => {
        const ok = f.pos.filter(Boolean);
        return ok.length ? { t: f.t, lon: ok.reduce((s, q) => s + q[0], 0) / ok.length, lat: ok.reduce((s, q) => s + q[1], 0) / ok.length } : null;
      }).filter(Boolean);
      for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) sim.cloud.push({ i, rx: hash(i, k, 1), ry: hash(i, k, 2), s: 0.6 + 0.4 * Math.abs(hash(i, k, 3)) });
    }
    const rings = (result.detection?.candidates || []).flatMap((c) => ringsOf(c.geometry));
    sim.slick = rings.map(smoothRing);
    sim.slickKm2 = rings.reduce((s, r) => s + ringAreaKm2(r), 0);
    const oz = ringsOf(d.origin_zone)[0];
    if (oz) {
      const open = oz.slice(0, -1);
      sim.origin = { ring: oz, sm: smoothRing(oz), cLat: open.reduce((s, q) => s + q[1], 0) / open.length, cLon: open.reduce((s, q) => s + q[0], 0) / open.length };
    }
    const sp = result.simulation?.source_point?.coordinates;
    sim.release = Array.isArray(sp) ? sp : null;
    const cands = (result.vessel_candidates || []).map((c) => mkVessel(c.vessel_id, c.track_positions, false, c)).filter(Boolean);
    if (sim.frames.length >= 2) { sim.T0 = sim.frames[0].t; sim.T1 = sim.frames[sim.frames.length - 1].t; }
    else if (cands.length) { sim.T0 = Math.min(...cands.map((v) => v.t0)); sim.T1 = Math.max(...cands.map((v) => v.t1)); }
    else { sim.T1 = ms(result.scene?.datetime) || Date.now(); sim.T0 = sim.T1 - 6 * 3600000; }
    sim.D = clamp(Math.max(sim.frames.length - 1, 1) * 650, 8000, 14000);
    sim.vessels = cands.concat(makeExtras());
    sim.vessels.forEach(computeMetrics);
    [...sim.vessels].sort((a, b) => b.score - a.score).forEach((v, i) => { v.rank = i + 1; });
  }

  function sceneBounds(withVessels) {
    const pts = [];
    sim.slick.forEach((r) => r.forEach((q) => pts.push([q[1], q[0]])));
    if (sim.origin) sim.origin.ring.forEach((q) => pts.push([q[1], q[0]]));
    if (sim.release) pts.push([sim.release[1], sim.release[0]]);
    sim.frames.forEach((f) => f.pos.forEach((q) => { if (q) pts.push([q[1], q[0]]); }));
    if (withVessels) sim.vessels.forEach((v) => v.fixes.forEach((q) => pts.push([q.lat, q.lon])));
    return pts.length ? L.latLngBounds(pts) : null;
  }
  function fitScene(withVessels) {
    const b = sceneBounds(withVessels);
    if (b) map.fitBounds(b, { padding: [60, 60], maxZoom: 13, animate: !reduceMotion });
  }

  /* ---------- canvas rendering ---------- */
  function syncCanvas() {
    const s = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (cvs.width !== Math.round(s.x * dpr) || cvs.height !== Math.round(s.y * dpr)) {
      cvs.width = Math.round(s.x * dpr); cvs.height = Math.round(s.y * dpr);
      cvs.style.width = s.x + "px"; cvs.style.height = s.y + "px";
    }
    L.DomUtil.setPosition(cvs, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return s;
  }
  map.on("zoomstart", () => { cvs.style.visibility = "hidden"; });
  map.on("zoomend", () => { cvs.style.visibility = "visible"; });

  function labelBox(text, x, y, color) {
    ctx.save();
    ctx.font = "600 10px ui-monospace, Consolas, monospace";
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = "rgba(7,22,33,0.82)"; ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(x, y - 13, w, 18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color || "#e8f2f3"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 6, y - 4);
    ctx.restore();
  }

  function drawGrid(s) {
    const b = map.getBounds();
    const raw = (b.getEast() - b.getWest()) / 5;
    const steps = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
    const step = steps.find((x) => x >= raw) || 5;
    const dec = Math.max(0, Math.ceil(-Math.log10(step)));
    const c = b.getCenter();
    ctx.save();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(190,225,235,0.10)"; ctx.setLineDash([2, 7]);
    ctx.fillStyle = "rgba(200,230,240,0.55)"; ctx.font = "500 10px ui-monospace, Consolas, monospace";
    for (let k = Math.ceil(b.getWest() / step); k * step <= b.getEast(); k += 1) {
      const x = P(c.lat, k * step).x;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s.y); ctx.stroke();
      if (x > 300) { ctx.textAlign = "left"; ctx.fillText((k * step).toFixed(dec) + "°", x + 4, 12); }
    }
    for (let k = Math.ceil(b.getSouth() / step); k * step <= b.getNorth(); k += 1) {
      const y = P(k * step, c.lng).y;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s.x, y); ctx.stroke();
      if (y > 120 && y < s.y - 90) { ctx.textAlign = "right"; ctx.fillText((k * step).toFixed(dec) + "°", s.x - 6, y - 4); }
    }
    ctx.restore();
  }

  function featherRing(ring, opt) {
    const pts = ring.map((q) => P(q[1], q[0]));
    if (pts.length < 3) return null;
    let cx = 0, cy = 0;
    pts.forEach((p) => { cx += p.x; cy += p.y; });
    cx /= pts.length; cy /= pts.length;
    const R = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) || 1;
    const path = (sc) => { ctx.beginPath(); pts.forEach((p, i) => { const x = cx + (p.x - cx) * sc, y = cy + (p.y - cy) * sc; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); };
    return { pts, cx, cy, R, path, opt };
  }

  function drawSlick(alpha) {
    if (!sim.slick.length) return;
    const t = performance.now() / 1000;
    const br = 1 + 0.012 * Math.sin(t * 0.9);
    sim.slick.forEach((ring) => {
      const f = featherRing(ring);
      if (!f) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = "rgba(255,176,84,0.55)"; ctx.shadowBlur = 26;
      ctx.fillStyle = "rgba(24,15,8,0.38)"; f.path(1.02 * br); ctx.fill();
      ctx.shadowBlur = 0;
      [[0.92, 0.16], [0.8, 0.16], [0.66, 0.18], [0.5, 0.18], [0.34, 0.2]].forEach(([sc, a]) => { ctx.fillStyle = "rgba(12,8,5," + a + ")"; f.path(sc * br); ctx.fill(); });
      const ang = t * 0.35, gx = Math.cos(ang) * f.R, gy = Math.sin(ang) * f.R;
      const g = ctx.createLinearGradient(f.cx + gx, f.cy + gy, f.cx - gx, f.cy - gy);
      g.addColorStop(0, "rgba(120,200,255,0.7)"); g.addColorStop(0.5, "rgba(255,206,140,0.75)"); g.addColorStop(1, "rgba(190,140,255,0.6)");
      ctx.strokeStyle = g; ctx.lineWidth = 1.4; f.path(br); ctx.stroke();
      ctx.strokeStyle = "rgba(255,200,120,0.28)"; ctx.lineWidth = 1; ctx.setLineDash([3, 5]); f.path(1.07 * br); ctx.stroke(); ctx.setLineDash([]);
      if (alpha > 0.5) {
        const xs = f.pts.map((p) => p.x), ys = f.pts.map((p) => p.y), pad = 12;
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad, L2 = 14;
        ctx.strokeStyle = "rgba(255,226,184,0.95)"; ctx.lineWidth = 1.6;
        [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, sx, sy]) => { ctx.beginPath(); ctx.moveTo(x, y + sy * L2); ctx.lineTo(x, y); ctx.lineTo(x + sx * L2, y); ctx.stroke(); });
        ctx.globalAlpha = 1;
        labelBox("DF-01 · POSSIBLE DARK FEATURE · ≈ " + sim.slickKm2.toFixed(sim.slickKm2 < 10 ? 1 : 0) + " km²", x0, y0 - 6, "#ffe2b8");
      }
      ctx.restore();
    });
  }

  function drawOrigin() {
    const o = sim.origin;
    if (o) {
      const f = featherRing(o.sm);
      if (f) {
        ctx.save();
        ctx.shadowColor = "rgba(70,214,196,0.6)"; ctx.shadowBlur = 24;
        ctx.fillStyle = "rgba(70,214,196,0.16)"; f.path(1); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(140,242,228,0.9)"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]); f.path(1); ctx.stroke(); ctx.setLineDash([]);
        const top = Math.min(...f.pts.map((p) => p.y));
        labelBox("POSSIBLE ORIGIN · UNCERTAIN", f.cx - 74, top - 8, "#9ff3e8");
        ctx.restore();
      }
    }
    if (sim.release) {
      const p = P(sim.release[1], sim.release[0]);
      ctx.save();
      ctx.strokeStyle = "#ff8a80"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x - 11, p.y); ctx.lineTo(p.x - 3, p.y); ctx.moveTo(p.x + 3, p.y); ctx.lineTo(p.x + 11, p.y); ctx.moveTo(p.x, p.y - 11); ctx.lineTo(p.x, p.y - 3); ctx.moveTo(p.x, p.y + 3); ctx.lineTo(p.x, p.y + 11); ctx.stroke();
      ctx.restore();
      labelBox("FICTIONAL RELEASE POINT", p.x + 14, p.y + 18, "#ffb4ac");
    }
  }

  function frameAt(tms) {
    const F = sim.frames;
    if (tms <= F[0].t) return { k: 0, w: 0 };
    if (tms >= F[F.length - 1].t) return { k: F.length - 2, w: 1 };
    let k = 0;
    while (k < F.length - 2 && F[k + 1].t <= tms) k += 1;
    return { k, w: (tms - F[k].t) / (F[k + 1].t - F[k].t) };
  }
  function partAt(i, fa) {
    const a = sim.frames[fa.k].pos[i], b = sim.frames[fa.k + 1].pos[i];
    if (!a || !b) return a || b || null;
    return [a[0] + (b[0] - a[0]) * fa.w, a[1] + (b[1] - a[1]) * fa.w];
  }
  function blob(x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(" + rgb + "," + a + ")"); g.addColorStop(0.55, "rgba(" + rgb + "," + (a * 0.45) + ")"); g.addColorStop(1, "rgba(" + rgb + ",0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }

  function drawPlume(tt, prog) {
    const F = sim.frames;
    if (F.length < 2) return;
    const fa = frameAt(tt), n = F[0].pos.length;
    const fade = clamp(prog * 12, 0.25, 1);
    // mean path
    if (sim.cents.length > 1) {
      ctx.save();
      ctx.lineWidth = 1.6; ctx.strokeStyle = "rgba(255,226,184,0.25)"; ctx.setLineDash([2, 6]);
      ctx.beginPath(); sim.cents.forEach((c, i) => { const q = P(c.lat, c.lon); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.stroke();
      ctx.setLineDash([]); ctx.strokeStyle = "rgba(255,214,150,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath();
      let last = null, started = false;
      sim.cents.forEach((c) => { if (c.t <= tt) { const q = P(c.lat, c.lon); if (started) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); started = true; } last = q; } });
      const cur = (() => { const k = sim.cents.findIndex((c) => c.t > tt); if (k <= 0) return null; const a = sim.cents[k - 1], b = sim.cents[k], w = (tt - a.t) / (b.t - a.t); return [a.lat + (b.lat - a.lat) * w, a.lon + (b.lon - a.lon) * w]; })();
      if (cur) { const q = P(cur[0], cur[1]); if (started) ctx.lineTo(q.x, q.y); if (last) { const ang = Math.atan2(q.y - last.y, q.x - last.x); ctx.stroke(); ctx.fillStyle = "rgba(255,214,150,0.95)"; ctx.beginPath(); ctx.moveTo(q.x + Math.cos(ang) * 9, q.y + Math.sin(ang) * 9); ctx.lineTo(q.x + Math.cos(ang + 2.5) * 7, q.y + Math.sin(ang + 2.5) * 7); ctx.lineTo(q.x + Math.cos(ang - 2.5) * 7, q.y + Math.sin(ang - 2.5) * 7); ctx.closePath(); ctx.fill(); } } else ctx.stroke();
      ctx.restore();
    }
    // trails
    ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,196,120,0.16)";
    const base = [];
    for (let i = 0; i < n; i += 1) {
      const p = partAt(i, fa);
      base[i] = p ? P(p[1], p[0]) : null;
      ctx.beginPath();
      let st = false;
      for (let k = 0; k <= fa.k; k += 1) { const q0 = F[k].pos[i]; if (!q0) continue; const q = P(q0[1], q0[0]); if (st) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); st = true; } }
      if (base[i] && st) { ctx.lineTo(base[i].x, base[i].y); ctx.stroke(); }
    }
    ctx.restore();
    // plume blobs
    const sp = 60 + 320 * smooth(prog);
    const pts = base.filter(Boolean).slice();
    sim.cloud.forEach((c) => {
      if (!base[c.i]) return;
      const p = partAt(c.i, fa);
      const mLon = 111195 * Math.cos(p[1] * Math.PI / 180);
      pts.push(P(p[1] + (c.ry * sp * c.s) / 111195, p[0] + (c.rx * sp * c.s) / mLon));
    });
    ctx.save();
    ctx.globalAlpha = fade;
    pts.forEach((q) => blob(q.x, q.y, 17, "255,170,70", 0.1));
    pts.forEach((q) => blob(q.x, q.y, 8, "18,11,6", 0.34));
    ctx.restore();
    // uncertainty envelope (2 sigma)
    const bp = base.filter(Boolean);
    if (bp.length >= 3) {
      const mx = bp.reduce((s, q) => s + q.x, 0) / bp.length, my = bp.reduce((s, q) => s + q.y, 0) / bp.length;
      let sxx = 0, syy = 0, sxy = 0;
      bp.forEach((q) => { sxx += (q.x - mx) ** 2; syy += (q.y - my) ** 2; sxy += (q.x - mx) * (q.y - my); });
      sxx /= bp.length; syy /= bp.length; sxy /= bp.length;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(0.5, tr / 2 - disc), ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      ctx.save();
      ctx.strokeStyle = "rgba(220,240,246,0.55)"; ctx.lineWidth = 1.2; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.ellipse(mx, my, 2 * Math.sqrt(l1) + 14, 2 * Math.sqrt(l2) + 14, ang, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------- vessels: routes, wakes, markers ---------- */
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; };
  const rankColor = (v) => (v.score >= 90 ? "#ff6b5e" : v.score >= 60 ? "#ffb347" : v.score >= 40 ? "#f2d46b" : "#8fb4c9");

  function drawVessels(tt) {
    sim.vessels.forEach((v) => {
      const col = v.color, lead = sim.ranked && v.rank === 1;
      ctx.save();
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      v.segs.forEach((seg) => {
        ctx.setLineDash([5, 6]); ctx.strokeStyle = rgba(col, 0.3); ctx.lineWidth = 1.5;
        ctx.beginPath(); seg.forEach((d, i) => { const q = P(d.lat, d.lon); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.stroke();
        ctx.setLineDash([]); ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = lead ? 3 : 2.2; ctx.shadowColor = rgba(col, 0.7); ctx.shadowBlur = 8;
        ctx.beginPath();
        let st = false;
        for (let i = 0; i < seg.length; i += 1) { const d = seg[i]; if (d.t > tt) break; const q = P(d.lat, d.lon); if (st) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); st = true; } }
        const cur = posAt(v, tt);
        if (cur && st) { const q = P(cur[0], cur[1]); ctx.lineTo(q.x, q.y); }
        if (st) ctx.stroke();
        ctx.shadowBlur = 0;
      });
      // hourly time ticks
      ctx.font = "500 9px ui-monospace, Consolas, monospace";
      for (let h = Math.ceil(v.t0 / 3600000) * 3600000; h <= v.t1; h += 3600000) {
        const p = posAt(v, h);
        if (!p) continue;
        const q = P(p[0], p[1]), passed = h <= tt;
        ctx.fillStyle = rgba(col, passed ? 0.95 : 0.45); ctx.strokeStyle = "rgba(7,22,33,0.8)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(q.x, q.y, 2.8, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "rgba(232,242,243," + (passed ? 0.85 : 0.45) + ")"; ctx.textAlign = "left"; ctx.fillText(hhmm(h), q.x + 6, q.y - 6);
      }
      // wake
      const p0 = posAt(v, tt);
      if (p0) {
        let pq = P(p0[0], p0[1]);
        for (let k = 1; k <= 12; k += 1) {
          const p = posAt(v, tt - k * 120000);
          if (!p) break;
          const q = P(p[0], p[1]);
          ctx.strokeStyle = "rgba(236,250,255," + (0.55 * (1 - k / 13)) + ")"; ctx.lineWidth = Math.max(0.6, 2.6 * (1 - k / 13));
          ctx.beginPath(); ctx.moveTo(pq.x, pq.y); ctx.lineTo(q.x, q.y); ctx.stroke(); pq = q;
        }
      }
      // closest approach marker once ranked
      if (sim.ranked && v.m.cpaT) {
        const p = posAt(v, v.m.cpaT);
        if (p) {
          const q = P(p[0], p[1]);
          ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, TAU); ctx.stroke();
          ctx.restore(); ctx.save();
          labelBox("CPA " + hhmm(v.m.cpaT), q.x + 10, q.y + 22, "#e8f2f3");
        }
      }
      ctx.restore();
    });
  }

  const vesselHtml = (v) => '<div class="vx"><i class="vx-halo"></i><svg class="vx-hull" viewBox="0 0 24 40" aria-hidden="true"><path class="vx-body" d="M12 1.5C16 8 18 16 17.4 30L16 38.5H8L6.6 30C6 16 8 8 12 1.5Z"/><rect class="vx-bridge" x="9" y="28" width="6" height="5.5" rx="1"/><path class="vx-line" d="M12 5v20"/></svg><span class="vx-label">' + v.id + "</span></div>";
  const popupHtml = (v) => "<strong>" + v.id + "</strong><br>" + v.type + " · fictional AIS track<br>Avg speed " + v.kn.toFixed(1) + " kn · heading " + Math.round(v.hd || 0) + "°" +
    (sim.ranked ? "<br>Review priority " + v.score.toFixed(1) + " / 100 (#" + v.rank + ")" : "") + "<br><em>Screening lead only, not proof.</em>";

  function ensureMarkers() {
    sim.vessels.forEach((v) => {
      if (v.marker) return;
      v.marker = L.marker([0, 0], { icon: L.divIcon({ className: "vx-wrap", html: vesselHtml(v), iconSize: [34, 34], iconAnchor: [17, 17] }), opacity: 0, keyboard: false }).addTo(vesselLayer);
      v.marker.bindPopup(() => popupHtml(v));
      const e = v.marker.getElement();
      v.root = e && e.querySelector(".vx"); v.hull = e && e.querySelector(".vx-hull");
    });
  }
  function applyColors() {
    sim.vessels.forEach((v) => {
      if (!v.root) return;
      v.root.style.setProperty("--vc", v.color);
      v.root.classList.toggle("is-lead", sim.ranked && v.rank === 1);
    });
  }
  function updateMarkers(tt) {
    sim.vessels.forEach((v) => {
      if (!v.marker) return;
      const p = posAt(v, tt);
      if (!p || !sim.showVessels) { v.marker.setOpacity(0); return; }
      v.marker.setLatLng(p).setOpacity(1);
      const a = posAt(v, tt - 240000), b = posAt(v, tt + 240000);
      let h = v.hd;
      if (a && b) h = bearingOf(a, b); else if (a) h = bearingOf(a, p); else if (b) h = bearingOf(p, b);
      if (h != null) { v.hd = v.hd == null ? h : v.hd + (((h - v.hd + 540) % 360) - 180) * 0.3; }
      if (v.hull && v.hd != null) v.hull.style.transform = "rotate(" + v.hd.toFixed(1) + "deg)";
    });
  }

  /* ---------- draw loop ---------- */
  let clockB, clockS, clockRange, playBtn2;
  function draw() {
    const s = syncCanvas();
    ctx.clearRect(0, 0, s.x, s.y);
    drawGrid(s);
    const tt = sim.T0 + sim.t * (sim.T1 - sim.T0);
    if (sim.showOrigin) drawOrigin();
    if (sim.showSlick) drawSlick(sim.showParticles ? 0.3 + 0.7 * smooth(sim.t) : 1);
    if (sim.showParticles) drawPlume(tt, sim.t);
    if (sim.showVessels) drawVessels(tt);
    updateMarkers(tt);
    if (clockB) {
      clockB.textContent = hhmm(tt); clockS.textContent = dayUtc(tt);
      if (document.activeElement !== clockRange) clockRange.value = String(Math.round(sim.t * 1000));
    }
  }
  function loop(ts) {
    window.requestAnimationFrame(loop);
    if (!sim.active || !ctx) return;
    if (sim.playing) {
      sim.t += (ts - sim.last) / sim.D; sim.last = ts;
      if (sim.t >= 1) { sim.t = 1; sim.playing = false; syncPlay(); }
    } else sim.last = ts;
    draw();
  }
  window.requestAnimationFrame(loop);

  /* ---------- layout and controls ---------- */
  const layout = el("div", "guided-layout");
  stage.before(layout);
  const side = el("aside", "guided-side");
  side.setAttribute("aria-label", "Guided simulation steps");
  layout.append(side, stage);
  const gauges = el("div", "guided-gauges");
  const legend = el("div", "guided-legend");
  const north = el("div", "guided-north");
  north.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(200,230,240,.5)" stroke-width="1"/><path d="M20 6l5 14h-10z" fill="#e8f2f3"/><path d="M20 34l-5-14h10z" fill="rgba(200,230,240,.35)"/><text x="20" y="5" text-anchor="middle" font-size="7" fill="#e8f2f3" font-weight="700">N</text></svg>';
  const tl = el("div", "guided-timeline");
  tl.hidden = true;
  tl.innerHTML = '<button type="button" class="gt-play" aria-label="Play or pause"></button><div class="gt-mid"><input class="gt-range" type="range" min="0" max="1000" value="0" aria-label="Simulation time"><div class="gt-ends"><span>Possible release</span><span>Slick observation</span></div></div><div class="gt-clock"><b>--:--</b><span></span></div>';
  stage.append(gauges, legend, north, tl);
  playBtn2 = tl.querySelector(".gt-play"); clockRange = tl.querySelector(".gt-range");
  clockB = tl.querySelector(".gt-clock b"); clockS = tl.querySelector(".gt-clock span");
  const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>', ICON_PAUSE = '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z"/></svg>';
  function syncPlay() { playBtn2.innerHTML = sim.playing ? ICON_PAUSE : ICON_PLAY; }
  playBtn2.addEventListener("click", () => { if (sim.t >= 1) sim.t = 0; sim.playing = !sim.playing; sim.last = performance.now(); syncPlay(); });
  clockRange.addEventListener("input", () => { sim.playing = false; sim.t = Number(clockRange.value) / 1000; syncPlay(); });
  function startClock() {
    sim.t = reduceMotion ? 1 : 0; sim.playing = !reduceMotion; sim.last = performance.now();
    tl.hidden = false; syncPlay();
  }

  function renderLegend() {
    legend.replaceChildren();
    const add = (cls, color, text) => { const r = el("div", "gl-row"); const i = el("i", "gl-sw " + cls); if (color) i.style.setProperty("--c", color); r.append(i, el("span", "", text)); legend.append(r); };
    if (sim.showSlick) add("gl-bracket", "#ffd9a0", "Possible dark feature");
    if (sim.showFlow) add("gl-arrow", "#bfefff", "Water current (assumed)");
    if (sim.showOrigin) add("gl-teal", "#7fe9db", "Possible origin (uncertain)");
    if (sim.showParticles) add("gl-oil", "#ffb15e", "Modeled oil (synthetic)");
    if (sim.showVessels && !sim.ranked) add("gl-line", NEUTRAL, "Vessel track (fictional AIS)");
    if (sim.showVessels && sim.ranked) { add("gl-line", "#ff6b5e", "Top review lead"); add("gl-line", "#ffb347", "Other candidates"); }
    legend.hidden = legend.childElementCount === 0;
  }

  const STEPS = [
    { label: "Find probable slick", dwell: 3500, title: "1 · Find the probable slick",
      text: "Satellite radar (SAR) makes calm, oil-smoothed water look dark. WakeTrace screens the image for dark patches and measures the area. Dark does not always mean oil (wind shadows and algae look similar), so this is only a possible slick." },
    { label: "Wind", dwell: 6500, title: "2 · Wind (what-if)",
      text: "Wind pushes floating oil too. A common rule of thumb is that oil moves with about 3% of the wind speed on top of the current. Use the slider and watch the orange oil path bend away from the teal current-only path. The origin and vessel ranking in later steps still use the calm-wind backend run." },
    { label: "Water flow", dwell: 4500, title: "3 · Water flow (current)",
      text: "Ocean current carries the oil. The animated arrows show the direction and speed used in this practice case, taken from how the modeled oil particles move." },
    { label: "Trace back to origin", dwell: -1, title: "4 · Trace back to a possible origin",
      text: "Running the current backwards from the slick gives a possible origin area (teal). It is an area, not a point, because the model is uncertain. The dark plume replays the drift from that area to the slick, and the dashed ellipse shows how widely the particles spread (2σ)." },
    { label: "Vessels in the area", dwell: -1, title: "5 · Vessels near the origin",
      text: "Ships broadcast their position with AIS. Four fictional vessels share the same clock as the drift: two from the backend run and two extra tracks. Ticks mark the hours, and a vessel appears only between its timestamped reports." },
    { label: "Find vessel leads", dwell: 0, title: "6 · Rank the vessel leads",
      text: "Each vessel gets a review priority from three factors: how close it came to the origin area, how close it was to the drifting oil at the same time, and how well its AIS reports cover the release window. It is an order for investigators, not the chance that a vessel is guilty." },
  ];

  side.append(el("div", "guided-kicker", "BUTTON-LED SIMULATION"),
    el("h2", "", "Follow the evidence one step at a time"),
    el("p", "guided-note", "Synthetic practice data. Press the steps in order."));
  const progress = el("div", "guided-progress");
  progress.innerHTML = "<i></i>";
  side.append(progress);
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
    progress.firstChild.style.width = ((done + 1) / STEPS.length * 100) + "%";
    playBtn.disabled = !result || done >= STEPS.length - 1;
    playBtn.textContent = playing ? "■ Stop" : "▶ Play all steps";
    resetBtn.disabled = !result;
  }

  /* ---------- steps ---------- */
  function stepSlick() {
    sim.showSlick = true;
    const sp = sim.slick.flatMap((r) => r.map((q) => [q[1], q[0]]));
    const c = sp.length ? L.latLngBounds(sp).getCenter() : null;
    const s = result.simulation.slick_point.coordinates;
    const target = c || L.latLng(s[1], s[0]);
    map.flyTo(target, 14, { animate: !reduceMotion, duration: 1.4 });
    chip("", "POSSIBLE SLICK · SYNTHETIC");
    msg(sim.slick.length ? "Possible dark patch highlighted · synthetic exercise only; not confirmed oil." : "No dark feature met the screening settings in this run.");
    renderLegend();
  }

  /* wind what-if (browser-side, simplified: oil drift = current + 3% of wind) */
  const wind = { speed: 8, from: 315 };
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
    let rel = sim.release || result.simulation.source_point.coordinates;
    let T = 6 * 3600;
    if (sim.frames.length >= 2) {
      const pts = sim.frames[0].pos.filter(Boolean);
      if (pts.length) rel = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
      T = (sim.T1 - sim.T0) / 1000;
    }
    const toward = ((wind.from + 180) % 360) * Math.PI / 180;
    const w = 0.03 * wind.speed;
    const uT = c.u + w * Math.sin(toward), vT = c.v + w * Math.cos(toward);
    const mLat = 111195, mLon = 111195 * Math.cos(rel[1] * Math.PI / 180);
    const at = (u, v, t, jx = 0, jy = 0) => [rel[1] + (v * t + jy) / mLat, rel[0] + (u * t + jx) / mLon];
    const start = [rel[1], rel[0]];
    const baseEnd = at(c.u, c.v, T), windEnd = at(uT, vT, T);
    L.polyline([start, baseEnd], { color: "#66d5ca", weight: 3, dashArray: "6 6", opacity: 0.95 }).bindPopup("Current only (calm wind)").addTo(whatifLayer);
    L.circleMarker(start, { radius: 6, color: "#fff", weight: 2, fillColor: "#ff8a80", fillOpacity: 1 }).bindPopup("Release point").addTo(whatifLayer);
    const trail = L.polyline([start, start], { color: "#ffb15e", weight: 3, opacity: 0.95 }).addTo(whatifLayer);
    const jit = (i, k) => hash(i, k, 5) * 220;
    const parts = Array.from({ length: 24 }, () => L.circleMarker(start, { radius: 3.5, color: "#fff2e0", weight: 1, fillColor: "#ffb15e", fillOpacity: 0.9 }).addTo(whatifLayer));
    const km = w * T / 1000;
    const dirName = compass(toward * 180 / Math.PI);
    chip("", wind.speed > 0 ? "WIND + CURRENT · WHAT-IF" : "WIND · CALM");
    msg(wind.speed > 0
      ? "Wind " + wind.speed + " m/s from " + compass(wind.from) + " moves the oil about " + km.toFixed(1) + " km toward " + dirName + " compared with current alone. The radar slick was generated with calm wind, so this is a sensitivity demo."
      : "Calm wind: the oil simply follows the current.");
    map.fitBounds(L.latLngBounds([start, baseEnd, windEnd]), { padding: [70, 70], maxZoom: 13, animate: !reduceMotion });
    const steps = reduceMotion ? 1 : 100;
    let k = 0;
    const frame = () => {
      const f = Math.min(1, k / steps), t = T * f;
      parts.forEach((m, i) => m.setLatLng(at(uT, vT, t, jit(i, 1) * (0.3 + f), jit(i, 2) * (0.3 + f))));
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

  function stepWind() { windCtl.hidden = false; runWhatIf(); }

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
          html: '<span class="flow-arrow" style="--rot:' + v.bearing.toFixed(1) + "deg;--delay:" + delay + 's"><svg viewBox="0 0 24 24"><path d="M12 3l5 7h-3.2v11h-3.6V10H7z"/></svg></span>',
        });
        L.marker([lat, lng], { icon, pane: "flowPane", interactive: false, keyboard: false }).addTo(flowLayer);
      }
    }
  }
  map.on("moveend", () => { if (flowOn) drawFlow(); });

  function stepFlow() {
    flowOn = true; sim.showFlow = true;
    map.getPane("flowPane").classList.remove("is-dim");
    drawFlow();
    const v = currentVec();
    gauges.querySelector(".g-flow")?.remove();
    const g = el("div", "guided-gauge g-flow");
    g.innerHTML = '<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="20" fill="none" stroke="#9fc3cf" stroke-width="1.5"/><text x="23" y="10" text-anchor="middle" font-size="8" fill="#9fc3cf">N</text><g transform="rotate(' + v.bearing.toFixed(1) + ' 23 23)"><path d="M23 9l7 11h-4.5v13h-5V20H16z" fill="#8fe9ff"/></g></svg>' +
      "<div><small>CURRENT</small><b>" + v.speed.toFixed(2) + " m/s → " + v.name + "</b><span>" + (v.derived ? "from modeled particle motion" : "assumed value") + "</span></div>";
    gauges.append(g);
    chip("", "WATER FLOW · SYNTHETIC");
    msg("Current ≈ " + v.speed.toFixed(2) + " m/s toward " + v.name + " (invented for this practice case).");
    renderLegend();
  }

  function stepOrigin() {
    sim.showOrigin = true; sim.showParticles = true; sim.showVessels = false; sim.ranked = false;
    map.getPane("flowPane").classList.add("is-dim");
    clearInterval(whatifTimer); whatifLayer.clearLayers(); windCtl.hidden = true;
    chip("", "POSSIBLE ORIGIN · UNCERTAIN");
    msg("The origin is an area, not a point. It would be uncertain even with real data.");
    fitScene(false);
    startClock();
    renderLegend();
  }

  function stepVessels() {
    sim.showOrigin = true; sim.showParticles = true; sim.showVessels = true; sim.ranked = false;
    sim.vessels.forEach((v) => { v.color = NEUTRAL; });
    ensureMarkers(); applyColors();
    chip("", "FICTIONAL AIS TRACKS");
    msg(sim.vessels.length + " fictional vessels have AIS reports in the area. Not yet ranked.");
    fitScene(true);
    startClock();
    renderLegend();
  }

  function stepRank() {
    sim.showVessels = true; sim.ranked = true;
    sim.vessels.forEach((v) => { v.color = rankColor(v); });
    ensureMarkers(); applyColors();
    renderStrip();
    chip("", "VESSEL LEADS RANKED");
    msg("Ranked by review priority. A lead is where to look first, not proof of responsibility.");
    startClock();
    renderLegend();
    strip.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  const dur = (a, b) => { const m = Math.round((b - a) / 60000); return Math.floor(m / 60) + "h " + pad2(m % 60) + "m"; };
  function renderStrip() {
    strip.replaceChildren(el("div", "eyebrow", "PROBABLE VESSEL LEADS BASED ON FACTORS"),
      el("h2", "", "Which vessels should investigators look at first?"));
    if (!sim.ranked) {
      strip.append(el("p", "muted guided-strip-empty", "Run steps 1 to 5, then press “Find vessel leads”. Factors: closest approach to the origin · drift-path proximity · AIS coverage."));
      return;
    }
    const table = el("div", "guided-table");
    const head = el("div", "guided-row head");
    ["VESSEL (AIS)", "CLOSEST APPROACH", "DRIFT-PATH PROXIMITY", "AIS COVERAGE", "REVIEW PRIORITY"].forEach((h) => head.append(el("span", "", h)));
    table.append(head);
    const cell = (main, sub, pct) => {
      const n = el("div");
      const bar = el("div", "guided-bar guided-bar-factor"), fill = el("i");
      fill.style.width = "0%"; bar.append(fill);
      n.append(el("strong", "", main), el("small", "", sub), bar);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = clamp(pct * 100, 0, 100) + "%"; }));
      return n;
    };
    [...sim.vessels].sort((a, b) => a.rank - b.rank).forEach((v, i) => {
      const row = el("div", "guided-row" + (v.rank === 1 ? " lead" : ""));
      row.style.animationDelay = i * 0.2 + "s";
      const name = el("div", "gr-name-cell");
      const top = el("div", "gr-name");
      const badge = el("span", "gr-rank", "#" + v.rank);
      badge.style.background = v.color;
      top.append(badge, el("strong", "", v.id));
      if (v.extra) top.append(el("span", "gr-tag", "extra"));
      const why = el("details"); why.append(el("summary", "", "Why this score?"), el("p", "", v.why));
      name.append(top, el("small", "", v.type + " · avg " + v.kn.toFixed(1) + " kn"), why);
      const m = v.m;
      const score = el("div");
      const bar = el("div", "guided-bar"), fill = el("i");
      fill.style.width = "0%"; bar.append(fill);
      score.append(el("strong", "gr-score", v.score.toFixed(1) + " / 100"), el("small", "", v.estimated ? "browser estimate" : "backend score"), bar);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = clamp(v.score, 0, 100) + "%"; }));
      row.append(name,
        cell(m.originKm == null ? "n/a" : m.originKm.toFixed(1) + " km", m.cpaT ? "at " + hhmm(m.cpaT) + " UTC" : "to origin zone", m.fo),
        cell(m.pathKm == null ? "n/a" : m.pathKm.toFixed(1) + " km", "to time-matched oil", m.fp),
        cell(m.inside ? "Inside window" : "Partial", "reports span " + dur(v.t0, v.t1), m.fc),
        score);
      table.append(row);
    });
    strip.append(table);
    const truthId = result.simulation.truth_vessel_id;
    const tv = sim.vessels.find((v) => v.id === truthId);
    if (truthId) strip.append(el("div", "guided-truth", "Ground truth (known only because this is synthetic): " + truthId + (tv ? " was the generated source and ranked #" + tv.rank + "." : " was the generated source but was not returned as a candidate.")));
    strip.append(el("p", "guided-disclaimer", "SIM-VESSEL-03 and 04 are extra fictional tracks scored in the browser with the same three factors; 01 and 02 use the backend scores. Review priority is a screening score, not a probability, and results do not establish responsibility."));
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
      await sleep(STEPS[i].dwell < 0 ? sim.D + 1200 : STEPS[i].dwell);
    }
    playing = false; refresh();
  }

  function clearAll() {
    playing = false; flowOn = false; vecCache = null; done = -1;
    Object.assign(sim, { playing: false, t: 0, showSlick: false, showOrigin: false, showParticles: false, showVessels: false, showFlow: false, ranked: false });
    flowLayer.clearLayers(); vesselLayer.clearLayers(); whatifLayer.clearLayers(); gauges.replaceChildren();
    clearInterval(whatifTimer); windCtl.hidden = true; tl.hidden = true;
    try { configureTrajectoryPlayback(null, []); } catch (error) { /* nothing playing */ }
    if (map.hasLayer(layers)) map.removeLayer(layers);
    if (simulationSlickMarker && map.hasLayer(simulationSlickMarker)) map.removeLayer(simulationSlickMarker);
    renderStrip(); renderLegend();
  }

  function enter() {
    clearAll();
    buildScene();
    document.body.classList.add("guided-mode");
    layout.classList.add("is-active");
    strip.hidden = false;
    sim.active = true;
    if (!scaleControl) scaleControl = L.control.scale({ imperial: false, position: "bottomright", maxWidth: 110 }).addTo(map);
    explainTitle.textContent = "What you are looking at";
    explainText.textContent = "A generated radar-style scene. Press “Find probable slick” to screen it for dark features.";
    refresh();
    setTimeout(() => {
      map.invalidateSize();
      if (result?.preview?.preview_bounds) map.fitBounds(L.latLngBounds(result.preview.preview_bounds), { padding: [28, 28], maxZoom: 11, animate: false });
      chip("", "SYNTHETIC RADAR SCENE");
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
