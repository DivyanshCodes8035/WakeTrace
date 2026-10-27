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
    { kind: "tanker", x: 0.2, y: 0.34, heading: 0.18, speed: 0.022, scale: 1.7, wake: [] },
    { kind: "cargo", x: 0.76, y: 0.56, heading: 3.4, speed: 0.028, scale: 1.25, wake: [] },
    { kind: "workboat", x: 0.4, y: 0.7, heading: -0.5, speed: 0.034, scale: 0.9, wake: [] },
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

  function drawSlick(time) {
    const cx = width * (0.52 + Math.sin(time * 0.12) * 0.03);
    const cy = height * (0.48 + Math.cos(time * 0.09) * 0.025);
    const rx = width * (0.28 + Math.sin(time * 0.18) * 0.025);
    const ry = height * (0.14 + Math.cos(time * 0.15) * 0.016);
    const rot = -0.35 + Math.sin(time * 0.07) * 0.08;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(1, 0.78);

    const film = ctx.createRadialGradient(0, 0, 4, 0, 0, Math.max(rx, 12));
    film.addColorStop(0, "rgba(6, 4, 2, 0.88)");
    film.addColorStop(0.42, "rgba(18, 12, 4, 0.78)");
    film.addColorStop(0.72, "rgba(40, 28, 8, 0.42)");
    film.addColorStop(1, "rgba(18, 80, 70, 0)");
    ctx.fillStyle = film;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rx * 0.28, ry * 0.12, rx * 0.55, ry * 0.62, 0.4, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * Math.PI * 2 + time * 0.15;
      const px = Math.cos(a) * rx * (0.72 + Math.sin(time * 0.8 + i) * 0.06);
      const py = Math.sin(a) * ry * (0.72 + Math.cos(time * 0.7 + i) * 0.06);
      const hue = (170 + i * 14 + time * 28) % 360;
      ctx.fillStyle = `hsla(${hue}, 90%, 62%, 0.42)`;
      ctx.beginPath();
      ctx.ellipse(px, py, 7 + (i % 4), 3.2, a, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(190, 255, 230, 0.45)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.92, ry * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function pushWake(ship, x, y) {
    const max = small ? 42 : 70;
    ship.wake.push({ x, y, life: 1, heading: ship.heading, scale: ship.scale });
    if (ship.wake.length > max) ship.wake.shift();
  }

  function seedWakes() {
    for (const ship of ships) {
      ship.wake = [];
      const max = small ? 36 : 56;
      for (let i = max; i >= 0; i -= 1) {
        const back = (max - i) * 7;
        ship.wake.push({
          x: ship.x * width - Math.cos(ship.heading) * back,
          y: ship.y * height - Math.sin(ship.heading) * back * 0.72,
          life: i / max,
          heading: ship.heading,
          scale: ship.scale,
        });
      }
    }
  }

  function drawWakes() {
    for (const ship of ships) {
      for (const w of ship.wake) {
        const spread = (1 - w.life) * 18 * w.scale;
        ctx.save();
        ctx.translate(w.x, w.y);
        ctx.rotate(w.heading);
        ctx.globalAlpha = w.life * 0.5;
        ctx.fillStyle = "rgba(236, 254, 255, 0.95)";
        ctx.beginPath();
        ctx.ellipse(-10 * w.scale, spread, 16 * w.scale, 3.2 + spread * 0.35, 0, 0, Math.PI * 2);
        ctx.ellipse(-10 * w.scale, -spread, 16 * w.scale, 3.2 + spread * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        w.life -= 0.012;
      }
      ship.wake = ship.wake.filter((w) => w.life > 0);
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

  function drawShips(dt) {
    for (const ship of ships) {
      ship.x += Math.cos(ship.heading) * ship.speed * dt;
      ship.y += Math.sin(ship.heading) * ship.speed * dt * 0.72;
      if (ship.x > 1.12) ship.x = -0.1;
      if (ship.x < -0.12) ship.x = 1.1;
      if (ship.y > 1.12) ship.y = -0.08;
      if (ship.y < -0.12) ship.y = 1.08;

      const px = ship.x * width;
      const py = ship.y * height;
      pushWake(ship, px, py);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ship.heading);
      ctx.scale(1, 0.78);
      const bob = Math.sin(t * 2.4 + ship.x * 8) * 1.2;
      ctx.translate(0, bob);
      drawHull(ship.kind, ship.scale);
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
    drawSlick(t);
    drawWakes();
    drawShips(dt);
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
