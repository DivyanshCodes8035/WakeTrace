(() => {
  const canvas = document.getElementById("overview-hero-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: false });
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = window.matchMedia("(max-width: 700px)").matches;

  const water = document.createElement("canvas");
  const waterCtx = water.getContext("2d", { alpha: false });

  const waves = [
    { amp: 1.15, len: 78, dir: 0.38, speed: 1.15 },
    { amp: 0.7, len: 38, dir: 0.92, speed: 1.55 },
    { amp: 0.38, len: 18, dir: -0.22, speed: 2.1 },
    { amp: 0.18, len: 9, dir: 1.7, speed: 2.8 },
  ].map((w) => ({
    ...w,
    k: (Math.PI * 2) / w.len,
    cx: Math.cos(w.dir),
    sy: Math.sin(w.dir),
  }));

  const ships = [
    {
      kind: "tanker", route: [[-0.16, 0.3], [0.22, 0.25], [0.68, 0.15], [1.16, 0.22]],
      duration: 68, offset: 0.27, scale: 1.35, phase: 0.4, wake: [], wakeTimer: 0,
    },
    {
      kind: "cargo", route: [[1.16, 0.7], [0.78, 0.62], [0.34, 0.84], [-0.16, 0.76]],
      duration: 84, offset: 0.68, scale: 1.02, phase: 2.1, wake: [], wakeTimer: 0,
    },
    {
      kind: "workboat", route: [[-0.16, 0.91], [0.22, 0.84], [0.68, 0.98], [1.16, 0.86]],
      duration: 102, offset: 0.43, scale: 0.72, phase: 4.3, wake: [], wakeTimer: 0,
    },
  ];

  const glitter = Array.from({ length: small ? 40 : 90 }, () => ({
    x: Math.random(),
    y: Math.random(),
    phase: Math.random() * Math.PI * 2,
    size: 0.6 + Math.random() * 1.8,
  }));

  let width = 0;
  let height = 0;
  let dpr = 1;
  let cols = 160;
  let rows = 90;
  let pixels = null;
  let running = false;
  let visible = true;
  let inView = true;
  let raf = 0;
  let last = 0;
  let t = 0;

  function heightAt(x, y, time) {
    let h = 0;
    for (let i = 0; i < waves.length; i += 1) {
      const w = waves[i];
      h += w.amp * Math.sin(w.k * (x * w.cx + y * w.sy) - w.speed * time);
    }
    return h;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.min(small ? 120 : 176, Math.max(88, Math.floor(width * 0.14)));
    rows = Math.min(small ? 68 : 96, Math.max(50, Math.floor(height * 0.12)));
    water.width = cols;
    water.height = rows;
    pixels = waterCtx.createImageData(cols, rows);
    seedWakes();
  }

  function paintWater(time) {
    const data = pixels.data;
    const sunX = 0.7;
    const sunY = 0.16;
    for (let y = 0; y < rows; y += 1) {
      const ny = y / rows;
      for (let x = 0; x < cols; x += 1) {
        const nx = x / cols;
        const wx = nx * 180;
        const wy = ny * 110;
        const h = heightAt(wx, wy, time);
        const hx = heightAt(wx + 2.2, wy, time);
        const hy = heightAt(wx, wy + 2.2, time);
        const light = Math.max(0, (h - hx) * 0.55 + (h - hy) * 0.95);
        const n = Math.max(0, Math.min(1, (h + 2.1) / 4.2));
        const spark = Math.pow(Math.max(0, light), 3.2);
        const sun = Math.max(0, 1 - Math.hypot(nx - sunX, ny - sunY) * 1.35);
        const r = 18 + n * 50 + light * 110 + spark * 230 + sun * 80 + ny * 12;
        const g = 110 + n * 90 + light * 130 + spark * 220 + sun * 90 + ny * 22;
        const b = 128 + n * 70 + light * 90 + spark * 210 + sun * 55 + ny * 28;
        const i = (y * cols + x) * 4;
        data[i] = Math.min(255, r);
        data[i + 1] = Math.min(255, g);
        data[i + 2] = Math.min(255, b);
        data[i + 3] = 255;
      }
    }
    waterCtx.putImageData(pixels, 0, 0);
  }

  function pushWake(ship) {
    ship.wake.push({ x: ship.x, y: ship.y, age: 0, heading: ship.heading, scale: ship.scale });
    if (ship.wake.length > 42) ship.wake.shift();
  }

  function seedWakes() {
    for (const ship of ships) {
      ship.wake = [];
      ship.wakeTimer = 0;
    }
  }

  function drawWakes(dt) {
    for (const ship of ships) {
      for (const wake of ship.wake) wake.age += dt;
      ship.wake = ship.wake.filter((wake) => wake.age < 2.6);

      ctx.save();
      ctx.fillStyle = "#b9f5ee";
      for (let i = 0; i < ship.wake.length; i += 1) {
        const wake = ship.wake[i];
        const fade = Math.max(0, 1 - wake.age / 2.6);
        if (fade <= 0.03) continue;
        ctx.globalAlpha = fade * 0.82;
        ctx.beginPath();
        ctx.arc(wake.x, wake.y, Math.max(0.85, 1.35 * wake.scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawHull(kind, scale) {
    ctx.lineJoin = "round";
    if (kind === "tanker") {
      ctx.fillStyle = "#c4ccd4";
      ctx.strokeStyle = "#1a2430";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(38 * scale, 0);
      ctx.quadraticCurveTo(32 * scale, -9 * scale, 8 * scale, -10 * scale);
      ctx.lineTo(-36 * scale, -9 * scale);
      ctx.quadraticCurveTo(-44 * scale, 0, -36 * scale, 9 * scale);
      ctx.lineTo(8 * scale, 10 * scale);
      ctx.quadraticCurveTo(32 * scale, 9 * scale, 38 * scale, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#d97706";
      ctx.fillRect(-34 * scale, -8.5 * scale, 10 * scale, 17 * scale);
      ctx.fillStyle = "#334155";
      ctx.fillRect(8 * scale, -7 * scale, 14 * scale, 14 * scale);
      ctx.fillStyle = "#94a3b8";
      ctx.fillRect(12 * scale, -11 * scale, 6 * scale, 5 * scale);
      ctx.fillStyle = "#0f172a";
      for (let i = 0; i < 5; i += 1) ctx.fillRect((-22 + i * 6) * scale, -6 * scale, 3.2 * scale, 12 * scale);
    } else if (kind === "cargo") {
      ctx.fillStyle = "#dbe7ef";
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(30 * scale, 0);
      ctx.quadraticCurveTo(22 * scale, -8 * scale, 4 * scale, -8.5 * scale);
      ctx.lineTo(-26 * scale, -7.5 * scale);
      ctx.quadraticCurveTo(-32 * scale, 0, -26 * scale, 7.5 * scale);
      ctx.lineTo(4 * scale, 8.5 * scale);
      ctx.quadraticCurveTo(22 * scale, 8 * scale, 30 * scale, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#b45309";
      ctx.fillRect(-8 * scale, -7 * scale, 18 * scale, 14 * scale);
      ctx.fillStyle = "#1e3a5f";
      ctx.fillRect(-24 * scale, -6 * scale, 10 * scale, 12 * scale);
      ctx.fillStyle = "#64748b";
      ctx.fillRect(-22 * scale, -10 * scale, 6 * scale, 4 * scale);
    } else {
      ctx.fillStyle = "#f8fafc";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(18 * scale, 0);
      ctx.quadraticCurveTo(10 * scale, -5.5 * scale, -4 * scale, -5 * scale);
      ctx.lineTo(-16 * scale, -3.5 * scale);
      ctx.quadraticCurveTo(-19 * scale, 0, -16 * scale, 3.5 * scale);
      ctx.lineTo(-4 * scale, 5 * scale);
      ctx.quadraticCurveTo(10 * scale, 5.5 * scale, 18 * scale, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(-6 * scale, -3.4 * scale, 8 * scale, 6.8 * scale);
      ctx.fillStyle = "#0ea5e9";
      ctx.beginPath();
      ctx.arc(6 * scale, 0, 1.6 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBowLight(kind, scale) {
    const bow = (kind === "tanker" ? 38 : kind === "cargo" ? 30 : 18) * scale;
    const length = (kind === "tanker" ? 66 : kind === "cargo" ? 56 : 42) * scale;
    const spread = (kind === "tanker" ? 13 : kind === "cargo" ? 11 : 8) * scale;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const beam = ctx.createLinearGradient(bow, 0, bow + length, 0);
    beam.addColorStop(0, "rgba(255, 236, 32, 0.72)");
    beam.addColorStop(0.3, "rgba(255, 216, 12, 0.48)");
    beam.addColorStop(0.72, "rgba(255, 196, 8, 0.14)");
    beam.addColorStop(1, "rgba(255, 180, 0, 0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(bow - 1 * scale, -2.3 * scale);
    ctx.lineTo(bow + length, -spread);
    ctx.quadraticCurveTo(bow + length + 7 * scale, 0, bow + length, spread);
    ctx.lineTo(bow - 1 * scale, 2.3 * scale);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawBowLamps(kind, scale) {
    const bow = (kind === "tanker" ? 38 : kind === "cargo" ? 30 : 18) * scale;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "rgba(255, 190, 0, 1)";
    ctx.shadowBlur = 16 * scale;
    ctx.fillStyle = "#fff13d";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(bow - 1.5 * scale, side * 2.3 * scale, 1.55 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function smoothstep(value) {
    const n = Math.max(0, Math.min(1, value));
    return n * n * (3 - 2 * n);
  }

  function routePose(ship) {
    const phase = (t / ship.duration + ship.offset) % 1;
    const [p0, p1, p2, p3] = ship.route;
    const u = phase;
    const v = 1 - u;
    const x = v ** 3 * p0[0] + 3 * v ** 2 * u * p1[0] + 3 * v * u ** 2 * p2[0] + u ** 3 * p3[0];
    const y = v ** 3 * p0[1] + 3 * v ** 2 * u * p1[1] + 3 * v * u ** 2 * p2[1] + u ** 3 * p3[1];
    const dx = 3 * v ** 2 * (p1[0] - p0[0]) + 6 * v * u * (p2[0] - p1[0]) + 3 * u ** 2 * (p3[0] - p2[0]);
    const dy = 3 * v ** 2 * (p1[1] - p0[1]) + 6 * v * u * (p2[1] - p1[1]) + 3 * u ** 2 * (p3[1] - p2[1]);
    const fade = smoothstep(phase / 0.1) * smoothstep((1 - phase) / 0.1);
    return { x, y, heading: Math.atan2(dy * height, dx * width), fade };
  }

  function updateShips(dt) {
    for (const ship of ships) {
      const pose = routePose(ship);
      ship.x = pose.x * width;
      ship.y = pose.y * height;
      ship.heading = pose.heading;
      ship.opacity = pose.fade;
      if (ship.opacity > 0.82) {
        ship.wakeTimer += dt;
        if (ship.wakeTimer >= 0.12) {
          pushWake(ship);
          ship.wakeTimer %= 0.12;
        }
      } else if (ship.opacity < 0.12) {
        ship.wakeTimer = 0;
      }
    }
  }

  function drawShips() {
    for (const ship of ships) {
      if (ship.opacity <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = ship.opacity;
      ctx.translate(ship.x, ship.y);
      ctx.rotate(ship.heading + Math.sin(t * 0.32 + ship.phase) * 0.008);
      ctx.scale(1, 0.78);
      ctx.translate(0, Math.sin(t * 1.1 + ship.phase) * 0.45);
      ctx.shadowColor = "rgba(2, 10, 18, 0.38)";
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 1.5;
      drawBowLight(ship.kind, ship.scale);
      drawHull(ship.kind, ship.scale);
      drawBowLamps(ship.kind, ship.scale);
      ctx.restore();
    }
  }

  function drawGlitter(time) {
    for (const g of glitter) {
      const pulse = Math.sin(time * 4 + g.phase);
      if (pulse < 0.35) continue;
      ctx.globalAlpha = (pulse - 0.35) * 0.55;
      ctx.fillStyle = "#ecfeff";
      ctx.beginPath();
      ctx.arc(g.x * width, g.y * height, g.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawScan(time) {
    const y = ((time * 28) % (height + 160)) - 80;
    const band = ctx.createLinearGradient(0, y - 40, 0, y + 40);
    band.addColorStop(0, "rgba(45, 212, 191, 0)");
    band.addColorStop(0.5, "rgba(94, 234, 212, 0.12)");
    band.addColorStop(1, "rgba(45, 212, 191, 0)");
    ctx.fillStyle = band;
    ctx.fillRect(0, y - 40, width, 80);
    ctx.strokeStyle = "rgba(165, 243, 252, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(width * 0.5, height * 0.45, height * 0.15, width * 0.5, height * 0.5, height * 0.78);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(2, 8, 14, 0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    const haze = ctx.createLinearGradient(0, 0, 0, height * 0.35);
    haze.addColorStop(0, "rgba(120, 190, 210, 0.14)");
    haze.addColorStop(1, "rgba(120, 190, 210, 0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, width, height * 0.35);
  }

  function paintFrame(now) {
    const dt = Math.min(0.05, ((now - last) / 1000) || 0.016);
    last = now;
    t += dt;
    paintWater(t * 18);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(water, 0, 0, width, height);
    drawGlitter(t);
    updateShips(dt);
    drawWakes(dt);
    drawShips();
    drawScan(t);
    drawVignette();
  }

  function loop(now) {
    if (!running) return;
    paintFrame(now);
    if (!reduced && visible && inView) raf = requestAnimationFrame(loop);
    else running = false;
  }

  function start() {
    last = performance.now();
    paintFrame(last);
    if (reduced) {
      running = false;
      cancelAnimationFrame(raf);
      return;
    }
    if (running) return;
    running = true;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  resize();
  start();

  window.addEventListener("resize", () => {
    resize();
    start();
  });

  document.addEventListener("visibilitychange", () => {
    visible = document.visibilityState !== "hidden";
    if (inView) start();
    else stop();
  });

  const hero = canvas.closest(".overview-hero");
  if ("IntersectionObserver" in window && hero) {
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView) start();
      else stop();
    }, { threshold: 0.02 });
    io.observe(hero);
  }
})();
