(() => {
  const canvas = document.getElementById("overview-hero-canvas");
  if (!canvas) return;
  const hero = canvas.closest(".overview-hero");
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = window.matchMedia("(max-width: 700px)").matches;
  const SHOW_BOW_BEAMS = false; // set true to bring back the yellow headlight cones

  /* ── Sea layer: a WebGL fragment shader sits under this 2D canvas ───────── */
  const sea = document.createElement("canvas");
  sea.setAttribute("aria-hidden", "true");
  canvas.parentElement.insertBefore(sea, canvas);
  const gl = sea.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });

  const VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
  const FRAG = `
precision highp float;
uniform vec2 uCss; uniform float uDpr, uTime, uReveal;
uniform vec4 uA[3]; // ship x, y, heading, size
uniform vec4 uB[3]; // opacity, half length, half width

float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vn(p);p=p*2.03+vec2(17.1,9.2);a*=.5;}return s;}

// height + slope from 12 travelling wave trains, long swell down to fine ripples
vec3 waves(vec2 p,float t,float gust,float calm){
  float h=0.;vec2 g=vec2(0.);float lam=260.,s=.17;
  for(int i=0;i<12;i++){
    float fi=float(i);
    float ang=.55+sin(fi*2.399+1.3)*(.45+.09*fi);
    vec2 d=vec2(cos(ang),sin(ang));
    float k=6.28318/lam,ph=k*dot(d,p)-sqrt(5.6*k)*t;
    float e=exp(sin(ph)-1.),c=cos(ph);
    float sl=s*(i>4?mix(.8,1.3,gust)*(1.-.7*calm):1.);
    h+=sl*lam/6.28318*e; g+=d*sl*e*c;
    p+=d*e*c*sl*lam*.055; lam*=.74; s*=.9;
  }
  return vec3(h,g);
}

void main(){
  vec2 px=vec2(gl_FragCoord.x,uCss.y*uDpr-gl_FragCoord.y)/uDpr;
  float screenY=px.y/uCss.y,t=uTime;
  float reveal=uReveal,horizon=mix(.16,.39,reveal),sunX=.70,sunY=horizon-.135;
  float aspect=uCss.x/max(uCss.y,1.);
  if(screenY<horizon){
    float sy=clamp(screenY/max(horizon,.001),0.,1.);
    vec3 sky=mix(vec3(.012,.022,.052),vec3(.065,.066,.105),smoothstep(0.,.48,sy));
    sky=mix(sky,vec3(.30,.105,.125),smoothstep(.40,.69,sy));
    sky=mix(sky,vec3(.72,.245,.115),smoothstep(.64,.88,sy));
    sky=mix(sky,vec3(.92,.45,.22),smoothstep(.84,1.,sy));
    float cloudWarp=fbm(vec2(px.x/uCss.x*2.3-t*.003,sy*3.2));
    float cloudA=fbm(vec2(px.x/uCss.x*4.5+cloudWarp*.72+t*.002,sy*6.2+cloudWarp*.35));
    float cloudB=fbm(vec2(px.x/uCss.x*8.0-t*.005,sy*10.0));
    float clouds=(smoothstep(.55,.72,cloudA)*.78+smoothstep(.61,.77,cloudB)*.22);
    clouds*=smoothstep(.10,.30,sy)*(1.-smoothstep(.82,.98,sy));
    vec3 cloudTone=mix(vec3(.08,.09,.14),vec3(.78,.30,.18),smoothstep(.35,.9,sy));
    vec3 cloudLit=mix(vec3(.20,.19,.23),vec3(.98,.58,.34),smoothstep(.46,.94,sy));
    sky=mix(sky,mix(cloudTone,cloudLit,smoothstep(.55,.78,cloudA)*.55),clamp(clouds,0.,1.)*.30);
    vec2 sun=vec2((px.x/uCss.x-sunX)*aspect,screenY-sunY);
    float sunDist=length(sun);
    sky+=vec3(1.,.35,.12)*exp(-sunDist*sunDist/.026)*.34;
    sky+=vec3(1.,.78,.53)*(1.-smoothstep(.021,.034,sunDist))*.78;
    sky+=vec3(.16,.055,.025)*(fbm(vec2(px.x/uCss.x*7.,sy*8.+t*.002))-.5)*smoothstep(.1,.35,sy);
    sky=1.-exp(-sky*1.18);
    sky=pow(sky,vec3(.4545));
    sky+=(hash(gl_FragCoord.xy+t)-.5)/320.;
    gl_FragColor=vec4(sky,1.);
    return;
  }
  float yn=clamp((screenY-horizon)/max(1.-horizon,.001),0.,1.),k=.74+.40*yn;
  vec2 wp=vec2((px.x-uCss.x*.5)/k,log(k/.74)/.40*uCss.y/.85);

  // ships: wake, bow foam, shadow
  float calm=0.,foam=0.,shadow=0.;
  for(int i=0;i<3;i++){
    float op=uB[i].x;
    if(op>.01){
      float hd=uA[i].z,L=uB[i].y,W=uB[i].z;
      vec2 dir=vec2(cos(hd),sin(hd)),nr=vec2(-dir.y,dir.x),q=px-uA[i].xy;
      float al=dot(q,dir),la=dot(q,nr),d=-al-L*.9,dp=max(d,0.);
      float core=exp(-la*la/pow(W*.9+dp*.06,2.))*smoothstep(-6.,10.,d)*exp(-dp/(L*6.));
      float arm=exp(-pow(abs(la)-W-dp*.33,2.)/(1.6+dp*.012))*smoothstep(4.,30.,d)*exp(-dp/(L*5.));
      float fn=fbm(px*.12+float(i)*3.1),fine=vn(px*.7);
      float rim=exp(-pow((length(vec2(al/L,la/W))-1.1)*3.5,2.))*(.45+.55*smoothstep(-.2,.8,al/L));
      foam+=op*(smoothstep(.28,.62,fn*.8+core*.65-.12+fine*.12)*core+arm*.45*(.4+.6*fine)+rim*(.3+.5*fine));
      calm+=op*core;
      vec2 qs=q-vec2(-10.,12.)*(L/40.);
      shadow=max(shadow,op*smoothstep(1.5,.35,length(vec2(dot(qs,dir)/(L*1.05),dot(qs,nr)/(W*1.1))))*.55);
    }
  }
  calm=clamp(calm,0.,1.);

  float gust=smoothstep(.3,.7,fbm(wp*.0035+vec2(t*.004,0.)));
  vec3 w=waves(wp,t,gust,calm);
  vec3 n=normalize(vec3(-w.y,1.,w.z));
  float th=mix(1.2,.55,yn);
  vec3 V=normalize(vec3(0.,cos(th),-sin(th)));
  vec3 L=normalize(vec3(.38,.46,.80));
  vec3 R=reflect(-V,n);

  // reflected sky (Fresnel), with soft cloud variation
  float F=.02+.98*pow(1.-max(dot(n,V),0.),5.);
  float cl=fbm(R.xz/(R.y+.25)*2.2+t*.01);
  vec3 sky=mix(vec3(.20,.36,.46),vec3(.03,.11,.26),smoothstep(0.,1.,R.y*1.3))*(.8+.5*cl);
  float sd=max(dot(R,L),0.);
  sky+=vec3(1.,.82,.58)*(pow(sd,10.)*.22);

  // body colour: deep blue-teal, brighter where light passes through crests
  float depthN=fbm(wp*.004+7.);
  vec3 deepC=vec3(.003,.03,.065),midC=vec3(.006,.15,.21);
  vec3 body=mix(deepC,midC,.1+.6*depthN);
  float hn=clamp(w.x/16.,0.,1.);
  float diff=clamp(dot(n,L)*.5+.5,0.,1.);
  vec3 col=body*(.4+.9*diff)+vec3(.02,.30,.30)*pow(hn,2.0)*(.35+.65*diff)*.9;
  col=mix(col,sky,F*.95);
  float sp=pow(sd,1400.)*26.+pow(sd,140.)*1.4+pow(sd,22.)*.12;
  col+=vec3(1.,.93,.78)*sp*(1.-.85*calm);
  float sunPath=exp(-pow((px.x/uCss.x-sunX)/(.014+.075*yn),2.))*exp(-yn*1.2);
  col+=vec3(1.,.28,.075)*sunPath*(.018+.28*pow(sd,28.))*(1.-.75*calm);

  // whitecaps (patchy, wind-streaked) + wake foam
  vec2 sw=vec2(dot(wp,vec2(.85,.52)),dot(wp,vec2(-.52,.85)))*vec2(.22,.5);
  float cap=smoothstep(.74,1.04,hn+.5*(gust-.5)+.2*fbm(wp*.05+t*.08))*gust*gust;
  cap*=smoothstep(.45,.8,fbm(sw+t*.12));
  float f=clamp(cap*.65+foam,0.,1.);
  col=mix(col,vec3(.78,.90,.93)*(.5+.5*diff),f*.85);

  col*=1.-shadow*.65;
  col=mix(col,vec3(.30,.52,.58)*.55,pow(1.-yn,3.)*.45);           // distance haze
  col*=1.-.45*pow(length((px/uCss-.5)*vec2(1.,1.15)),2.2);         // vignette
  col=1.-exp(-col*1.3);
  col=pow(col,vec3(.4545));
  col+=(hash(gl_FragCoord.xy+t)-.5)/200.;                          // anti-banding grain
  gl_FragColor=vec4(col,1.);
}`;

  let prog = null, loc = {}, glOK = false;
  if (gl) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
    if (vs && fs) {
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const a = gl.getAttribLocation(prog, "a");
        gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
        ["uCss", "uDpr", "uTime", "uReveal", "uA", "uB"].forEach((n) => { loc[n] = gl.getUniformLocation(prog, n); });
        glOK = true;
      }
    }
  }
  if (!glOK) sea.remove(); // fallback: plain deep-water gradient drawn on the 2D canvas

  /* ── Ships ──────────────────────────────────────────────────────────────── */
  const SQUASH = 0.85;
  const dims = { tanker: [38, 10], cargo: [30, 8.5], workboat: [18, 5.5] };
  const ships = [
    { kind: "tanker", route: [[1.16, 0.58], [0.78, 0.53], [0.32, 0.50], [-0.16, 0.55]], duration: 68, offset: 0.27, scale: 1.35, phase: 0.4 },
    { kind: "cargo", route: [[1.16, 0.68], [0.78, 0.62], [0.34, 0.78], [-0.16, 0.72]], duration: 84, offset: 0.68, scale: 1.02, phase: 2.1 },
    { kind: "workboat", route: [[1.16, 0.88], [0.72, 0.82], [0.28, 0.93], [-0.16, 0.85]], duration: 102, offset: 0.43, scale: 0.72, phase: 4.3 },
  ];

  let width = 0, height = 0, dpr = 1, running = false, visible = true, inView = true, raf = 0, last = 0, t = 0, reveal = 0;
  const revealSeconds = 3.8;
  const persp = (yn) => 0.74 + 0.4 * yn; // same depth scale the shader uses

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    for (const c of [canvas, sea]) { c.width = Math.floor(width * dpr); c.height = Math.floor(height * dpr); }
    if (glOK) gl.viewport(0, 0, sea.width, sea.height);
  }

  // Light comes from the upper right; hull shading and shadows follow it.
  const LIGHT = [0.6, -0.8];
  const lightLocal = (heading) => [
    LIGHT[0] * Math.cos(-heading) - LIGHT[1] * Math.sin(-heading),
    LIGHT[0] * Math.sin(-heading) + LIGHT[1] * Math.cos(-heading),
  ];

  function hullPath(kind, s) {
    ctx.beginPath();
    if (kind === "tanker") {
      ctx.moveTo(38 * s, 0); ctx.quadraticCurveTo(32 * s, -9 * s, 8 * s, -10 * s); ctx.lineTo(-36 * s, -9 * s);
      ctx.quadraticCurveTo(-44 * s, 0, -36 * s, 9 * s); ctx.lineTo(8 * s, 10 * s); ctx.quadraticCurveTo(32 * s, 9 * s, 38 * s, 0);
    } else if (kind === "cargo") {
      ctx.moveTo(30 * s, 0); ctx.quadraticCurveTo(22 * s, -8 * s, 4 * s, -8.5 * s); ctx.lineTo(-26 * s, -7.5 * s);
      ctx.quadraticCurveTo(-32 * s, 0, -26 * s, 7.5 * s); ctx.lineTo(4 * s, 8.5 * s); ctx.quadraticCurveTo(22 * s, 8 * s, 30 * s, 0);
    } else {
      ctx.moveTo(18 * s, 0); ctx.quadraticCurveTo(10 * s, -5.5 * s, -4 * s, -5 * s); ctx.lineTo(-16 * s, -3.5 * s);
      ctx.quadraticCurveTo(-19 * s, 0, -16 * s, 3.5 * s); ctx.lineTo(-4 * s, 5 * s); ctx.quadraticCurveTo(10 * s, 5.5 * s, 18 * s, 0);
    }
    ctx.closePath();
  }

  function block(x, y, w, h, s, color, heading) {
    const [lx, ly] = lightLocal(heading);
    ctx.fillStyle = "rgba(2,10,18,0.35)"; // small cast shadow, then the block itself
    ctx.fillRect((x - lx * 2.2) * s, (y - ly * 2.2) * s, w * s, h * s);
    ctx.fillStyle = color;
    ctx.fillRect(x * s, y * s, w * s, h * s);
  }

  function drawHull(kind, s, heading) {
    ctx.lineJoin = "round";
    hullPath(kind, s);
    ctx.fillStyle = kind === "tanker" ? "#7b8792" : kind === "cargo" ? "#9ca8b3" : "#aab5bf";
    ctx.fill();
    ctx.save(); hullPath(kind, s); ctx.clip();
    const [lx, ly] = lightLocal(heading), r = 12 * s;
    const grad = ctx.createLinearGradient(-lx * r, -ly * r, lx * r, ly * r);
    grad.addColorStop(0, "rgba(2,12,24,0.42)"); grad.addColorStop(0.5, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(255,255,255,0.35)");
    ctx.fillStyle = grad; ctx.fillRect(-50 * s, -14 * s, 100 * s, 28 * s);
    ctx.restore();
    hullPath(kind, s); ctx.strokeStyle = "rgba(10,20,32,0.85)"; ctx.lineWidth = 1; ctx.stroke();

    if (kind === "tanker") {
      block(-34, -8.5, 10, 17, s, "#d97706", heading);
      block(8, -7, 14, 14, s, "#334155", heading);
      block(12, -11, 6, 5, s, "#94a3b8", heading);
      ctx.fillStyle = "#0f172a";
      for (let i = 0; i < 5; i += 1) ctx.fillRect((-22 + i * 6) * s, -6 * s, 3.2 * s, 12 * s);
    } else if (kind === "cargo") {
      const tints = ["#75614e", "#3b5267", "#6b4c4d", "#46615b", "#776d56", "#4a5662"];
      for (let c = 0; c < 5; c += 1) for (let row = 0; row < 3; row += 1) {
        block(-11 + c * 6.2, -6.2 + row * 4.3, 5.4, 3.8, s, tints[(c * 3 + row * 2) % tints.length], heading);
      }
      block(-24, -6, 10, 12, s, "#1e3a5f", heading);
      block(-22, -10, 6, 4, s, "#64748b", heading);
    } else {
      block(-6, -3.4, 8, 6.8, s, "#ef4444", heading);
      ctx.fillStyle = "#0ea5e9"; ctx.beginPath(); ctx.arc(6 * s, 0, 1.6 * s, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBowLight(kind, scale) {
    const bow = (kind === "tanker" ? 38 : kind === "cargo" ? 30 : 18) * scale;
    const length = (kind === "tanker" ? 66 : kind === "cargo" ? 56 : 42) * scale;
    const spread = (kind === "tanker" ? 13 : kind === "cargo" ? 11 : 8) * scale;
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const beam = ctx.createLinearGradient(bow, 0, bow + length, 0);
    beam.addColorStop(0, "rgba(255,236,32,0.72)"); beam.addColorStop(0.3, "rgba(255,216,12,0.48)");
    beam.addColorStop(0.72, "rgba(255,196,8,0.14)"); beam.addColorStop(1, "rgba(255,180,0,0)");
    ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(bow - scale, -2.3 * scale); ctx.lineTo(bow + length, -spread);
    ctx.quadraticCurveTo(bow + length + 7 * scale, 0, bow + length, spread); ctx.lineTo(bow - scale, 2.3 * scale);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  function drawNavLights(kind, scale) {
    const bow = (kind === "tanker" ? 38 : kind === "cargo" ? 30 : 18) * scale;
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    [[-1, "#ff4d4d"], [1, "#4dff9a"]].forEach(([side, color]) => {
      ctx.shadowColor = color; ctx.shadowBlur = 7 * scale; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(bow - 3 * scale, side * 2.6 * scale, 0.9 * scale, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  }

  const smoothstep = (v) => { const n = Math.max(0, Math.min(1, v)); return n * n * (3 - 2 * n); };

  function routePose(ship) {
    const u = (t / ship.duration + ship.offset) % 1, v = 1 - u;
    const [p0, p1, p2, p3] = ship.route;
    const x = v ** 3 * p0[0] + 3 * v ** 2 * u * p1[0] + 3 * v * u ** 2 * p2[0] + u ** 3 * p3[0];
    const y = v ** 3 * p0[1] + 3 * v ** 2 * u * p1[1] + 3 * v * u ** 2 * p2[1] + u ** 3 * p3[1];
    const dx = 3 * v ** 2 * (p1[0] - p0[0]) + 6 * v * u * (p2[0] - p1[0]) + 3 * u ** 2 * (p3[0] - p2[0]);
    const dy = 3 * v ** 2 * (p1[1] - p0[1]) + 6 * v * u * (p2[1] - p1[1]) + 3 * u ** 2 * (p3[1] - p2[1]);
    return { x, y, heading: Math.atan2(dy * height, dx * width), fade: smoothstep(u / 0.1) * smoothstep((1 - u) / 0.1) };
  }

  function updateShips() {
    for (const ship of ships) {
      const p = routePose(ship);
      ship.x = p.x * width; ship.y = p.y * height; ship.heading = p.heading; ship.opacity = p.fade;
      ship.s = ship.scale * persp(p.y);
    }
  }

  function drawShips() {
    for (const ship of ships) {
      if (ship.opacity <= 0.01) continue;
      const heading = ship.heading + Math.sin(t * 0.32 + ship.phase) * 0.008;
      ctx.save();
      ctx.globalAlpha = ship.opacity;
      ctx.translate(ship.x, ship.y); ctx.rotate(heading); ctx.scale(1, SQUASH);
      ctx.translate(0, Math.sin(t * 1.1 + ship.phase) * 0.45);
      if (SHOW_BOW_BEAMS) drawBowLight(ship.kind, ship.s);
      drawHull(ship.kind, ship.s, heading);
      drawNavLights(ship.kind, ship.s);
      ctx.restore();
    }
  }

  function renderSea() {
    const A = new Float32Array(12), B = new Float32Array(12);
    ships.forEach((s, i) => {
      const [hl, hw] = dims[s.kind];
      A.set([s.x, s.y, s.heading, s.s], i * 4);
      B.set([s.opacity, hl * s.s, hw * s.s * SQUASH, 0], i * 4);
    });
    gl.uniform2f(loc.uCss, width, height); gl.uniform1f(loc.uDpr, dpr); gl.uniform1f(loc.uTime, t);
    gl.uniform1f(loc.uReveal, reveal);
    gl.uniform4fv(loc.uA, A); gl.uniform4fv(loc.uB, B);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function paintFrame(now) {
    const dt = Math.min(0.05, ((now - last) / 1000) || 0.016);
    last = now; t += dt;
    reveal = reduced ? 1 : smoothstep(t / revealSeconds);
    updateShips();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (glOK) renderSea();
    else {
      const horizon = height * (0.16 + 0.23 * reveal);
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, "#101a32"); sky.addColorStop(0.58, "#874340"); sky.addColorStop(1, "#e88b46");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, width, horizon);
      const seaFill = ctx.createLinearGradient(0, horizon, 0, height);
      seaFill.addColorStop(0, "#182938"); seaFill.addColorStop(1, "#020a13");
      ctx.fillStyle = seaFill; ctx.fillRect(0, horizon, width, height - horizon);
      for (let row = 0; row < 34; row++) {
        const d = row / 33, y = horizon + (height - horizon) * (0.04 + d * 0.93);
        ctx.beginPath();
        for (let x = -8; x < width + 8; x += 16) {
          const phase = x * (0.013 + d * 0.02) + t * (0.7 + d * 0.5) + row * 1.3;
          const yy = y + Math.sin(phase) * (1 + d * 4) + Math.sin(phase * 0.53) * (0.5 + d * 1.8);
          if (x < 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.strokeStyle = `rgba(152,179,192,${0.025 + d * 0.045})`;
        ctx.lineWidth = 0.6 + d * 0.7; ctx.stroke();
      }
    }
    drawShips();
  }

  function loop(now) {
    if (!running) return;
    paintFrame(now);
    if (!reduced && visible && inView) raf = requestAnimationFrame(loop); else running = false;
  }
  function start() {
    last = performance.now(); paintFrame(last);
    if (reduced) { running = false; cancelAnimationFrame(raf); return; }
    if (running) return;
    running = true; raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resize();
  t = 0;
  start();
  window.addEventListener("resize", () => { resize(); start(); });
  document.addEventListener("visibilitychange", () => {
    visible = document.visibilityState !== "hidden";
    if (inView && visible) start(); else stop();
  });
  if ("IntersectionObserver" in window && hero) {
    new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView) start(); else stop();
    }, { threshold: 0.02 }).observe(hero);
  }
})();
