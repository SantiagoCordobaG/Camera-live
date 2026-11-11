import {
  HandLandmarker,
  FilesetResolver,
} from "../vendor/mediapipe/vision_bundle.mjs";
import { baseVert, baseFrag, fxFragSource } from "./shaders.js";
import { createDemo } from "./demo.js";
import { initPWA, setAppActive } from "./pwa.js";

/* ------------------------------------------------------------------ setup */

const $ = (id) => document.getElementById(id);

const canvas = $("gl");
const overlay = $("overlay");
const video = $("video");
const octx = overlay.getContext("2d");

const params = new URLSearchParams(location.search);
const IS_DEMO = params.has("demo");

const WASM_PATH = new URL("../vendor/mediapipe/wasm", import.meta.url).href;
const MODEL_PATH = new URL("../vendor/models/hand_landmarker.task", import.meta.url).href;

/* --------------------------------------------------------------- calidad */
// En el teléfono lo que más pesa es el fill-rate del shader, la resolución
// interna y la subida de textura desde la cámara. Estos perfiles bajan todo
// eso sin cambiar el look.
const COARSE = window.matchMedia("(pointer: coarse)").matches;
const SMALL_SCREEN = Math.min(screen.width, screen.height) <= 820;
const WEAK_DEVICE =
  (navigator.hardwareConcurrency || 8) <= 4 ||
  (navigator.deviceMemory || 8) <= 4;

const TIERS = {
  high: { renderScale: 1, maxWidth: 1440, taps: 8, detectMs: 33, glow: true, dprCap: 2 },
  mid: { renderScale: 1, maxWidth: 960, taps: 5, detectMs: 45, glow: false, dprCap: 2 },
  low: { renderScale: 0.75, maxWidth: 760, taps: 3, detectMs: 66, glow: false, dprCap: 1.5 },
};
const TIER_ORDER = ["low", "mid", "high"];

function pickTier() {
  // ?q=low|mid|high fuerza un perfil (útil para comparar en el celular).
  const forced = (params.get("q") || "").toLowerCase();
  if (TIERS[forced]) return forced;
  if (COARSE || SMALL_SCREEN) return WEAK_DEVICE ? "low" : "mid";
  return WEAK_DEVICE ? "mid" : "high";
}

let tierName = pickTier();
const quality = () => TIERS[tierName];

const state = {
  running: false,
  starting: false,
  demo: false,
  source: null,
  stream: null,
  landmarker: null,
  feed: null,
  deviceId: null,

  mirror: true,
  amount: 0.72,
  style: 0,

  quad: null,
  target: null,
  presence: 0,
  lostFrames: 0,
  jumpFrames: 0,
  frameActive: false,
  lastQuadAt: 0,

  frozen: false,
  freezeByGesture: false,
  freezeTime: 0,
  fistSince: 0,
  openSince: 0,
  lastDetect: 0,
  lastVideoTime: -1,
  detectCount: 0,
  lastHands: 0,
  lastDetectError: null,
  trackerDelegate: null,
  trackerError: null,

  W: 1280,
  H: 720,
  srcW: 1280,
  srcH: 720,
  fps: 60,
  lastFrame: performance.now(),
  lastStatusAt: 0,
  lastHintAt: 0,

  // Subida de textura: solo cuando la cámara entrega un cuadro nuevo.
  videoDirty: true,
  lastUploadTime: -1,

  // Degradado adaptativo si el equipo no llega a 24 fps.
  startedAt: 0,
  slowSince: 0,

  capture: {
    photo: false,
    record: false,
  },

  rec: {
    active: false,
    recorder: null,
    chunks: [],
    canvas: null,
    ctx: null,
    startedAt: 0,
    timer: null,
  },
};

/* ----------------------------------------------------------------- webgl */

const gl = canvas.getContext("webgl", {
  alpha: false,
  // MSAA no aporta nada acá (un quad a pantalla completa con textura lineal) y
  // en móvil cuesta caro.
  antialias: false,
  depth: false,
  stencil: false,
  // preserveDrawingBuffer obliga a la GPU a conservar una copia del buffer en
  // cada frame; en teléfonos es una de las causas más grandes de trabazón.
  // Las fotos y la grabación se resuelven copiando el canvas dentro del mismo
  // frame, justo después de dibujar.
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
});

if (!gl) {
  showError(
    "Tu navegador no soporta WebGL",
    "Probá con Chrome, Edge, Firefox o Safari actualizado. La app necesita WebGL para el filtro."
  );
}

function compileShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error("Shader error:", log);
    throw new Error("No se pudo compilar el shader: " + log);
  }
  return sh;
}

function makeProgram(vertSrc, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("No se pudo linkear el programa: " + gl.getProgramInfoLog(p));
  }
  return p;
}

let baseProg;
let fxProg = null;
let fxTaps = 0;
let baseU, fxU, baseA, fxA;

// Compila (o cambia) la variante del shader de efecto según el perfil activo.
function buildFxProgram(taps) {
  if (fxProg && fxTaps === taps) return;
  const prog = makeProgram(baseVert, fxFragSource(taps));
  if (fxProg) gl.deleteProgram(fxProg);
  fxProg = prog;
  fxTaps = taps;
  fxU = {
    uVideo: gl.getUniformLocation(prog, "uVideo"),
    uRes: gl.getUniformLocation(prog, "uRes"),
    uTime: gl.getUniformLocation(prog, "uTime"),
    uMirror: gl.getUniformLocation(prog, "uMirror"),
    uAmount: gl.getUniformLocation(prog, "uAmount"),
    uStyle: gl.getUniformLocation(prog, "uStyle"),
    uPresence: gl.getUniformLocation(prog, "uPresence"),
  };
  fxA = gl.getAttribLocation(prog, "aPos");
}

if (gl) {
  try {
    baseProg = makeProgram(baseVert, baseFrag);

    baseU = {
      uVideo: gl.getUniformLocation(baseProg, "uVideo"),
      uMirror: gl.getUniformLocation(baseProg, "uMirror"),
    };
    baseA = gl.getAttribLocation(baseProg, "aPos");

    buildFxProgram(quality().taps);
  } catch (err) {
    console.error(err);
    showError("Error al iniciar el filtro", String(err.message || err));
  }
}

const vbo = gl && gl.createBuffer();

const tex = gl && gl.createTexture();
if (gl) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

const FULLSCREEN = new Float32Array([
  -1, -1, 1, -1, -1, 1,
  -1, 1, 1, -1, 1, 1,
]);

// Reutilizado para los vértices del marco: evita alocar 12 floats por frame.
const fxVerts = new Float32Array(12);

/* --------------------------------------------------------------- helpers */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function toast(msg, ms = 2200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("is-on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-on"), ms);
}

// Instalación, service worker y wake lock (no bloquea si el navegador no los
// soporta).
initPWA(toast);

function setStatus(mode, text) {
  const el = $("status");
  el.dataset.state = mode;
  $("statusText").textContent = text;
}

function showError(title, text) {
  $("errorTitle").textContent = title;
  $("errorText").textContent = text;
  $("errorCard").hidden = false;
  setStatus("error", "Error");
}

/* ------------------------------------------------------------ hand frame */

function toPoint(lm) {
  const x = state.mirror ? 1 - lm.x : lm.x;
  return { x: x * state.W, y: lm.y * state.H };
}

function computeQuad(landmarks) {
  if (!landmarks || landmarks.length < 2) return null;

  const hands = landmarks.slice(0, 2).map((lm) => {
    const index = toPoint(lm[8]);
    const thumb = toPoint(lm[4]);
    const wrist = toPoint(lm[0]);
    const mid = toPoint(lm[9]);
    return {
      index,
      thumb,
      wristX: wrist.x,
      scale: Math.hypot(wrist.x - mid.x, wrist.y - mid.y) + 1,
    };
  });

  // "L" abierta: pulgar e índice separados. Con histéresis para no perder
  // el marco al girar un poco las manos.
  const needed = state.frameActive ? 0.2 : 0.72;
  for (const h of hands) {
    if (dist(h.thumb, h.index) < h.scale * needed) return null;
  }

  hands.sort((a, b) => a.wristX - b.wristX);
  const [A, B] = hands;

  // Orden anatómico: índice izq, índice der, pulgar der, pulgar izq.
  const pts = [A.index, B.index, B.thumb, A.thumb];

  // Descartar marcos degenerados (manos pegadas o cruzadas en el mismo lugar).
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const hull = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const area = Math.abs(
    hull.reduce((acc, p, i) => {
      const q = hull[(i + 1) % 4];
      return acc + p.x * q.y - q.x * p.y;
    }, 0) / 2
  );

  const minArea = state.frameActive ? 0.004 : 0.009;
  if (area < state.W * state.H * minArea) return null;

  return pts;
}

function isFist(lm) {
  if (!lm || lm.length < 21) return false;
  const wrist = lm[0];
  const pairs = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ];
  let curled = 0;

  // Si la punta queda más cerca de la muñeca que su falange, el dedo está
  // cerrado. Pedimos 3 de 4 para tolerar el pulgar y dedos a medio cerrar.
  for (const [tip, pip] of pairs) {
    if (dist(lm[tip], wrist) < dist(lm[pip], wrist) * 0.96) curled++;
  }
  return curled >= 3;
}

function resetTracking() {
  state.quad = null;
  state.target = null;
  state.presence = 0;
  state.lostFrames = 0;
  state.jumpFrames = 0;
  state.frameActive = false;
  state.lastQuadAt = 0;
  state.lastVideoTime = -1;

  state.frozen = false;
  state.freezeByGesture = false;
  state.fistSince = 0;
  state.openSince = 0;
  $("freeze").hidden = true;
  $("btnFreeze").classList.remove("is-on");
  document.body.classList.remove("is-frozen");
}

function stepQuad(dt) {
  const W = state.W;
  const H = state.H;
  const diag = Math.hypot(W, H);

  if (state.target) {
    state.lostFrames = 0;
    state.lastQuadAt = performance.now();

    if (!state.quad) {
      state.quad = state.target;
      state.presence = Math.max(state.presence, 0.25);
    } else {
      let move = 0;
      for (let i = 0; i < 4; i++) move += dist(state.quad[i], state.target[i]);
      move /= 4;

      if (move > diag * 0.22) {
        // Salto grande: puede ser una mano que se cruza o un falso positivo.
        // Exigimos que se sostenga un par de frames antes de aceptarlo.
        state.jumpFrames++;
        if (state.jumpFrames >= 2) {
          state.quad = state.target;
          state.jumpFrames = 0;
        }
      } else {
        state.jumpFrames = 0;
        const a = 1 - Math.pow(0.66, dt * 60);
        state.quad = state.quad.map((p, i) => ({
          x: lerp(p.x, state.target[i].x, a),
          y: lerp(p.y, state.target[i].y, a),
        }));
      }
    }

    state.presence = Math.min(1, state.presence + dt * 5);
    state.frameActive = true;
  } else {
    state.lostFrames++;
    if (state.lostFrames > 9) {
      state.presence = Math.max(0, state.presence - dt * 3.4);
    }
    if (state.lostFrames > 45 || state.presence <= 0.001) {
      state.quad = null;
      state.presence = 0;
      state.frameActive = false;
    }
  }
}

/* ----------------------------------------------------------------- freeze */

function setFrozen(on, byGesture = false) {
  on = Boolean(on);
  if (on === state.frozen) return;

  state.frozen = on;
  state.freezeByGesture = on ? byGesture : false;
  state.fistSince = 0;
  state.openSince = 0;

  if (on) {
    // Congelamos el reloj del shader y dejamos de subir frames a la textura:
    // el último cuadro queda fijo sin necesidad de una copia extra.
    state.freezeTime = performance.now() / 1000;
  } else {
    state.target = null;
    state.lastVideoTime = -1;
  }

  $("freeze").hidden = !on;
  $("btnFreeze").classList.toggle("is-on", on);
  document.body.classList.toggle("is-frozen", on);
  setStatus(on ? "frozen" : "live", on ? "Congelado" : "En vivo");

  if (on) {
    toast(
      byGesture
        ? "Frame congelado · abrí las manos para seguir"
        : "Frame congelado · Espacio para seguir",
      2400
    );
  } else {
    toast("Frame en vivo", 1200);
  }
}

function toggleFreeze() {
  if (!state.running) return;
  setFrozen(!state.frozen);
}

function updateFreeze(hands, now) {
  const bothFists = hands && hands.length === 2 && hands.every(isFist);

  if (bothFists) {
    state.openSince = 0;
    if (state.frozen) return;

    if (!state.fistSince) {
      state.fistSince = now;
    } else if (
      now - state.fistSince > 260 &&
      (state.presence > 0.12 || now - state.lastQuadAt < 1500)
    ) {
      // Solo congelamos si había un marco reciente: así un puño suelto no
      // detiene la escena por accidente.
      setFrozen(true, true);
    }
    return;
  }

  state.fistSince = 0;
  if (!state.frozen || !state.freezeByGesture) return;

  // Si el tracker pierde las manos, dejamos el cuadro congelado: es preferible
  // a que la escena vuelva sola por un fallo de detección.
  if (!hands || hands.length === 0) {
    state.openSince = 0;
    return;
  }

  // Al abrir las manos esperamos un instante antes de volver al vivo.
  if (!state.openSince) {
    state.openSince = now;
  } else if (now - state.openSince > 180) {
    setFrozen(false);
  }
}

/* ------------------------------------------------------------------ render */

function resize(videoW, videoH) {
  const vw = Math.round(videoW) || 1280;
  const vh = Math.round(videoH) || 720;
  state.srcW = vw;
  state.srcH = vh;

  // Presupuesto de píxeles a partir de lo que ocupa la imagen en pantalla:
  // ancho visible (CSS) x DPR (con tope) x factor del perfil. Nunca por encima
  // de la resolución real de la cámara.
  const aspect = vw / vh;
  const cssW = window.innerWidth || vw;
  const cssH = window.innerHeight || vh;
  const shownW = Math.min(cssW, cssH * aspect);
  const dpr = Math.min(window.devicePixelRatio || 1, quality().dprCap);
  const targetW = Math.min(
    shownW * dpr * quality().renderScale,
    quality().maxWidth,
    vw
  );
  const scale = clamp(targetW / vw, 0.25, 1);
  const oldW = state.W;
  const oldH = state.H;

  state.W = Math.max(2, Math.round(vw * scale));
  state.H = Math.max(2, Math.round(vh * scale));

  canvas.width = state.W;
  canvas.height = state.H;
  overlay.width = state.W;
  overlay.height = state.H;
  if (state.rec.canvas) {
    state.rec.canvas.width = state.W;
    state.rec.canvas.height = state.H;
  }
  if (gl) gl.viewport(0, 0, state.W, state.H);
  state.videoDirty = true;

  // Al cambiar la resolución interna, las coordenadas viejas del marco dejan
  // de servir: forzamos una detección nueva.
  if (state.W !== oldW || state.H !== oldH) {
    state.quad = null;
    state.target = null;
    state.presence = 0;
    state.frameActive = false;
    state.lostFrames = 0;
    state.lastVideoTime = -1;
  }
}

function uploadTexture(source) {
  if (!gl) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return true;
  } catch (err) {
    // El video todavía no tiene un frame listo.
    return false;
  }
}

// Subir la textura es caro (copia el cuadro completo de la cámara a la GPU).
// Si la cámara entrega 30 fps, no tiene sentido hacerlo 60 veces por segundo.
function uploadIfNeeded() {
  if (!state.source || !gl) return;

  if (state.demo) {
    uploadTexture(state.source);
    return;
  }
  if (video.readyState < 2) return;

  // requestVideoFrameCallback marca los cuadros nuevos; currentTime cubre a los
  // navegadores que no lo tienen.
  if (!state.videoDirty && video.currentTime === state.lastUploadTime) return;

  if (uploadTexture(state.source)) {
    state.videoDirty = false;
    state.lastUploadTime = video.currentTime;
  }
}

function drawFullscreen() {
  gl.useProgram(baseProg);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(baseU.uVideo, 0);
  gl.uniform1f(baseU.uMirror, state.mirror ? 1 : 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(baseA);
  gl.vertexAttribPointer(baseA, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawFrameEffect(time) {
  const W = state.W;
  const H = state.H;
  const verts = fxVerts;
  const order = [0, 1, 2, 0, 2, 3];

  order.forEach((idx, i) => {
    const p = state.quad[idx];
    verts[i * 2] = (p.x / W) * 2 - 1;
    verts[i * 2 + 1] = 1 - (p.y / H) * 2;
  });

  gl.useProgram(fxProg);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(fxU.uVideo, 0);
  gl.uniform2f(fxU.uRes, W, H);
  gl.uniform1f(fxU.uTime, time);
  gl.uniform1f(fxU.uMirror, state.mirror ? 1 : 0);
  gl.uniform1f(fxU.uAmount, state.amount);
  gl.uniform1f(fxU.uStyle, state.style);
  gl.uniform1f(fxU.uPresence, state.presence);

  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(fxA);
  gl.vertexAttribPointer(fxA, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderGL(time) {
  if (!gl || !baseProg) return;
  gl.viewport(0, 0, state.W, state.H);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  drawFullscreen();

  if (fxProg && state.quad && state.presence > 0.004) {
    drawFrameEffect(time);
  }
}

function renderOverlay(time) {
  const W = state.W;
  const H = state.H;
  octx.clearRect(0, 0, W, H);

  if (!state.quad || state.presence < 0.005) return;

  const q = state.quad;
  const a = state.presence;
  const k = W / 1280;

  octx.save();
  octx.globalAlpha = a;
  octx.lineJoin = "round";
  octx.lineCap = "round";

  const grad = octx.createLinearGradient(q[0].x, q[0].y, q[2].x, q[2].y);
  grad.addColorStop(0, "rgba(200, 255, 61, 0.95)");
  grad.addColorStop(0.5, "rgba(61, 255, 239, 0.95)");
  grad.addColorStop(1, "rgba(255, 47, 160, 0.95)");

  octx.beginPath();
  octx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) octx.lineTo(q[i].x, q[i].y);
  octx.closePath();

  octx.strokeStyle = grad;
  octx.lineWidth = 2.4 * k;
  if (quality().glow) {
    octx.shadowColor = "rgba(190, 255, 90, 0.85)";
    octx.shadowBlur = 26 * k;
  } else {
    // Glow "falso" sin shadowBlur (que es muy caro en móvil): el mismo trazo,
    // más ancho y translúcido, debajo del principal.
    octx.save();
    octx.globalAlpha = a * 0.22;
    octx.lineWidth = 12 * k;
    octx.stroke();
    octx.restore();
    octx.lineWidth = 2.4 * k;
  }
  octx.stroke();

  // Esquinas tipo visor.
  octx.shadowBlur = 0;
  octx.strokeStyle = "rgba(240, 255, 205, 0.95)";
  octx.lineWidth = 4.2 * k;
  const seg = 20 * k;

  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const next = q[(i + 1) % 4];
    const p = q[i];

    const dp = Math.hypot(prev.x - p.x, prev.y - p.y) || 1;
    const dn = Math.hypot(next.x - p.x, next.y - p.y) || 1;

    octx.beginPath();
    octx.moveTo(p.x + ((prev.x - p.x) / dp) * seg, p.y + ((prev.y - p.y) / dp) * seg);
    octx.lineTo(p.x, p.y);
    octx.lineTo(p.x + ((next.x - p.x) / dn) * seg, p.y + ((next.y - p.y) / dn) * seg);
    octx.stroke();
  }

  // Puntitos pulsantes en las puntas.
  const pulse = 1 + Math.sin(time * 4) * 0.3;
  octx.fillStyle = "rgba(234, 255, 201, 0.95)";
  for (const p of q) {
    octx.beginPath();
    octx.arc(p.x, p.y, 2.2 * k * pulse, 0, Math.PI * 2);
    octx.fill();
  }

  octx.restore();
}

/* ------------------------------------------------------------------- loop */

function updateFps(dt) {
  if (dt > 0) state.fps = lerp(state.fps, 1 / dt, 0.06);
}

function updateHint() {
  const hint = $("hint");
  if (!state.running || state.frozen) {
    hint.hidden = true;
    return;
  }
  const idle = !state.demo && !state.target && performance.now() - state.lastQuadAt > 1600;
  hint.hidden = !idle;
}

function updateStatus(now) {
  if (now - state.lastStatusAt < 240) return;
  state.lastStatusAt = now;
  if (!state.running) return;

  const fps = Math.round(clamp(state.fps, 1, 120));
  if (state.frozen) {
    setStatus("frozen", "Congelado");
  } else if (state.demo) {
    setStatus("tracking", `Demo · ${fps} fps`);
  } else if (state.quad && state.presence > 0.5) {
    setStatus("tracking", `Marco activo · ${fps} fps`);
  } else {
    setStatus("live", `En vivo · ${fps} fps`);
  }
}

/* ------------------------------------------------- ajuste automático */

function applyQuality() {
  document.body.classList.toggle("is-lite", tierName === "low");
  if (gl && baseProg) {
    try {
      buildFxProgram(quality().taps);
    } catch (err) {
      console.warn("No se pudo compilar el shader liviano", err);
    }
  }
  resize(state.srcW, state.srcH);
}

// Si el equipo no sostiene ~27 fps durante unos segundos, bajamos un escalón.
// Solo se baja, nunca se sube: así no oscila entre perfiles.
function adaptQuality(now) {
  if (params.has("q") || state.demo) return;
  if (tierName === "low") return;
  if (now - state.startedAt < 4000) return;

  if (state.fps >= 27) {
    if (state.fps > 34) state.slowSince = 0;
    return;
  }
  if (!state.slowSince) {
    state.slowSince = now;
    return;
  }
  if (now - state.slowSince < 2500) return;

  const i = TIER_ORDER.indexOf(tierName);
  if (i <= 0) return;

  tierName = TIER_ORDER[i - 1];
  state.slowSince = 0;
  state.startedAt = now; // margen para que se estabilice el perfil nuevo
  applyQuality();
  toast("Ajustando calidad para mantener el ritmo", 2200);
  console.info("[framefx] perfil de calidad:", tierName);
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!state.running) return;

  const dt = Math.min(0.06, Math.max(0.001, (now - state.lastFrame) / 1000));
  state.lastFrame = now;
  updateFps(dt);
  const time = now / 1000;

  if (state.demo) {
    if (!state.frozen) {
      state.feed.draw(time);
      state.source = state.feed.canvas;
      state.target = computeQuad(state.feed.landmarks(time));
    }
  } else if (state.landmarker && video.readyState >= 2) {
    // Mientras está congelado seguimos detectando manos: es la única forma de
    // saber cuándo se abren para volver al vivo.
    if (
      video.currentTime !== state.lastVideoTime &&
      now - state.lastDetect > quality().detectMs
    ) {
      state.lastVideoTime = video.currentTime;
      state.lastDetect = now;
      state.detectCount++;
      try {
        const res = state.landmarker.detectForVideo(video, now);
        state.lastHands = res.landmarks.length;
        updateFreeze(res.landmarks, now);
        if (!state.frozen) state.target = computeQuad(res.landmarks);
      } catch (err) {
        state.lastDetectError = String(err && err.message);
        state.target = null;
      }
    }
  }

  if (!state.frozen) {
    stepQuad(dt);
    uploadIfNeeded();
  }

  // El shader y el overlay comparten el reloj congelado para que el cuadro
  // quede realmente quieto, incluso los puntitos del marco.
  const effectTime = state.frozen ? state.freezeTime : time;
  renderGL(effectTime);
  renderOverlay(effectTime);

  if (state.rec.active && state.rec.ctx) {
    state.rec.ctx.drawImage(canvas, 0, 0);
    state.rec.ctx.drawImage(overlay, 0, 0);
  }

  // Fotos y arranque de grabación se resuelven acá, con el buffer recién
  // dibujado (el contexto ya no conserva el buffer entre frames).
  flushCapture();

  updateHint();
  updateStatus(now);
  adaptQuality(now);
}

requestAnimationFrame(loop);

/* ------------------------------------------------------------- detection */

const IS_IOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// En Safari (iOS incluido) el delegate GPU de MediaPipe puede quedarse
// esperando para siempre al crear el landmarker. Preferimos CPU, que es más
// lento pero confiable, y dejamos ?gpu para forzarlo si hace falta.
const IS_SAFARI =
  IS_IOS ||
  (/safari/i.test(navigator.userAgent) &&
    !/chrome|chromium|crios|fxios|edg/i.test(navigator.userAgent));

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} tardó más de ${Math.round(ms / 1000)} s`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function createLandmarker(fileset, options, delegate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `El tracker (${delegate}) no respondió en ${Math.round(
            timeoutMs / 1000
          )} s`
        )
      );
    }, timeoutMs);

    HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    }).then(
      (tracker) => {
        if (settled) {
          // Llegó después del timeout: liberamos el recurso.
          try {
            tracker.close();
          } catch (err) {
            /* sin problema */
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(tracker);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function ensureTracker() {
  if (state.landmarker) return;

  setStatus("loading", "Cargando runtime…");
  state.trackerError = null;

  let fileset;
  try {
    fileset = await withTimeout(
      FilesetResolver.forVisionTasks(WASM_PATH),
      25000,
      "El runtime de MediaPipe"
    );
  } catch (err) {
    state.trackerError = String((err && err.message) || err);
    throw err;
  }

  const options = {
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  };

  const delegates = params.has("gpu")
    ? ["GPU", "CPU"]
    : params.has("cpu") || IS_SAFARI
      ? ["CPU"]
      : ["GPU", "CPU"];

  let lastError = null;

  for (const delegate of delegates) {
    if (delegate === "GPU") {
      setStatus("loading", "Cargando tracker (GPU)…");
    } else if (lastError) {
      setStatus("loading", "GPU no disponible · usando CPU…");
    } else {
      setStatus("loading", "Cargando tracker…");
    }

    try {
      state.landmarker = await createLandmarker(
        fileset,
        options,
        delegate,
        delegate === "GPU" ? 9000 : 45000
      );
      state.trackerDelegate = delegate;
      state.trackerError = null;
      console.info(`[FRAME FX] tracker listo con ${delegate}`);
      return;
    } catch (err) {
      lastError = err;
      state.trackerError = String((err && err.message) || err);
      console.warn(`[FRAME FX] tracker ${delegate} falló`, err);

      if (delegate === "GPU") {
        toast("GPU no disponible · probando CPU", 2200);
        // Damos un respiro para que Safari libere el contexto WebGL fallido.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  throw new Error(
    lastError
      ? `${lastError.message || lastError}. Probá recargar la página.`
      : "El tracker no pudo iniciarse."
  );
}

/* ---------------------------------------------------------------- camera */

const cameraSelect = $("camera");

// Avisa cuándo hay un cuadro nuevo de cámara: así no subimos la textura 60
// veces por segundo para un video que entrega 30.
if (typeof video.requestVideoFrameCallback === "function") {
  const onVideoFrame = () => {
    state.videoDirty = true;
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback(onVideoFrame);
}

function cameraName(device, index) {
  const label = (device.label || "").trim();
  return label || `Cámara ${index + 1}`;
}

function cameraConstraints(deviceId) {
  // En el celular pedimos 960x540 / 30 fps: alcanza de sobra para detectar
  // manos y baja a la mitad el costo de subir la textura a la GPU.
  // Si el tracker corre en CPU (Safari/iOS), bajamos todavía más: el cuello de
  // botella pasa a ser la inferencia y no tiene sentido alimentarla con más
  // píxeles de los que el modelo usa.
  const hi = quality().maxWidth >= 1100;
  const cpu = state.trackerDelegate === "CPU";
  const w = hi ? 1280 : cpu ? 640 : 960;
  const h = hi ? 720 : cpu ? 480 : 540;
  const videoConstraints = {
    width: { ideal: w },
    height: { ideal: h },
    frameRate: { ideal: cpu ? 24 : 30, max: hi ? 60 : 30 },
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  } else {
    videoConstraints.facingMode = "user";
  }
  return { audio: false, video: videoConstraints };
}

async function refreshCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  let cams = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cams = devices.filter((d) => d.kind === "videoinput");
  } catch (err) {
    return;
  }

  const active =
    state.deviceId ||
    state.stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId ||
    "";

  cameraSelect.innerHTML = "";

  if (!cams.length) {
    const empty = new Option("Sin cámaras", "");
    empty.disabled = true;
    cameraSelect.add(empty);
    cameraSelect.disabled = true;
    return;
  }

  cameraSelect.disabled = false;
  cams.forEach((cam, i) => {
    cameraSelect.add(new Option(cameraName(cam, i), cam.deviceId));
  });

  // Si la cámara guardada ya no está, mostramos la primera sin forzar cambio.
  cameraSelect.value = cams.some((cam) => cam.deviceId === active)
    ? active
    : cams[0].deviceId;
}

async function applyStream(stream) {
  const old = state.stream;
  state.stream = stream;
  video.srcObject = stream;

  const track = stream.getVideoTracks()[0];
  if (track) {
    state.deviceId = track.getSettings().deviceId || state.deviceId;
    track.addEventListener("ended", () => {
      if (state.stream !== stream) return;
      setStatus("error", "Sin cámara");
      toast("Se cortó la fuente de cámara", 3200);
      refreshCameras();
    });
  }

  old?.getTracks().forEach((t) => t.stop());

  await video.play().catch(() => {});
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
      setTimeout(resolve, 1500);
    });
  }

  resize(video.videoWidth || 1280, video.videoHeight || 720);
}

async function startCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(state.deviceId));
  } catch (err) {
    // La fuente guardada desapareció (por ejemplo, OBS sin cámara virtual).
    const stale =
      state.deviceId &&
      (err.name === "OverconstrainedError" || err.name === "NotFoundError");
    if (!stale) throw err;
    state.deviceId = null;
    stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(null));
  }

  await applyStream(stream);
  await refreshCameras();
}

async function switchCamera(deviceId) {
  if (!deviceId || deviceId === state.deviceId) return;
  const previous = state.deviceId;

  try {
    setStatus("loading", "Cambiando cámara…");
    const stream = await navigator.mediaDevices.getUserMedia(
      cameraConstraints(deviceId)
    );
    await applyStream(stream);
    state.deviceId = deviceId;
    resetTracking();
    await refreshCameras();
    persistSettings();
    const name = cameraSelect.selectedOptions[0]?.textContent || "fuente nueva";
    toast(`Cámara: ${name}`, 2000);
  } catch (err) {
    console.error(err);
    state.deviceId = previous;
    await refreshCameras();
    toast("No se pudo cambiar la cámara", 2600);
  }
}

/* --------------------------------------------------------------- booting */

async function boot(mode) {
  if (state.running || state.starting) return;
  state.starting = true;

  $("start").classList.add("is-hidden");
  $("dock").hidden = false;
  $("dockCam").hidden = mode === "demo";
  $("hint").hidden = true;
  setStatus("loading", "Iniciando…");

  try {
    if (mode === "demo") {
      state.demo = true;
      state.feed = createDemo();
      state.source = state.feed.canvas;
      resize(state.feed.canvas.width, state.feed.canvas.height);
    } else {
      setStatus("loading", "Cargando tracker…");
      await ensureTracker();
      setStatus("loading", "Pidiendo cámara…");
      await startCamera();
      state.source = video;
    }

    state.lastFrame = performance.now();
    state.startedAt = performance.now();
    resetTracking();
    state.running = true;

    // Mantiene la pantalla despierta mientras la app está en uso (si el
    // navegador soporta Screen Wake Lock).
    setAppActive(true);

    setStatus("live", "En vivo");
    if (mode === "demo") toast("Modo demo · sin cámara");
  } catch (err) {
    console.error(err);
    const denied =
      err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    if (denied) {
      showError(
        "Cámara bloqueada",
        "Dale permiso de cámara al navegador y volvé a intentar. En Chrome, revisá el candado de la barra de direcciones."
      );
    } else if (err && err.name === "NotFoundError") {
      showError(
        "No encontramos una cámara",
        "Conectá una cámara o probá el modo demo para ver el efecto."
      );
    } else if (state.trackerError) {
      showError(
        "El tracker no arrancó",
        `MediaPipe no pudo iniciarse en este dispositivo${
          IS_IOS ? " (iOS)" : ""
        }. Probá recargar, abrir la app con ?cpu o usar el modo demo. Detalle: ${
          state.trackerError
        }`
      );
    } else {
      showError(
        "No pudimos iniciar",
        "Revisá que la app se esté sirviendo por localhost o HTTPS y volvé a intentar. Detalle: " +
          String((err && err.message) || err)
      );
    }
    $("start").classList.remove("is-hidden");
  } finally {
    state.starting = false;
  }
}

/* ------------------------------------------------------------------- ui */

$("btnStart").addEventListener("click", () => boot("camera"));
$("btnDemo").addEventListener("click", () => boot("demo"));

cameraSelect.addEventListener("change", () => switchCamera(cameraSelect.value));

if (navigator.mediaDevices?.addEventListener) {
  // OBS Virtual Camera aparece/desaparece cuando se prende o apaga en OBS.
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (state.running && !state.demo) refreshCameras();
  });
}

if (params.has("debug")) window.__fx = state;

// Escape hatch para un service worker viejo o un cache roto:
// abrí la app con ?reset y se limpia todo antes de recargar.
if (params.has("reset")) {
  (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(regs.map((reg) => reg.unregister()));
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch (err) {
      console.warn("No se pudo limpiar el cache", err);
    }

    const next = new URL(location.href);
    next.searchParams.delete("reset");
    location.replace(next.toString());
  })();
}

if (IS_DEMO) {
  boot("demo");
} else if (params.has("autostart")) {
  boot("camera");
}

$("btnErrorClose").addEventListener("click", () => {
  $("errorCard").hidden = true;
  if (!state.running) $("start").classList.remove("is-hidden");
});

$("btnErrorRetry").addEventListener("click", () => {
  $("errorCard").hidden = true;
  if (!state.running && !state.starting) boot("camera");
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => setStyle(Number(chip.dataset.style)));
});

function setStyle(style) {
  state.style = style;
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("is-active", Number(chip.dataset.style) === style);
  });
  persistSettings();
}

const amount = $("amount");
amount.addEventListener("input", () => {
  state.amount = Number(amount.value) / 100;
  $("amountOut").textContent = amount.value;
  persistSettings();
});
state.amount = Number(amount.value) / 100;

function persistSettings() {
  try {
    localStorage.setItem(
      "framefx.v1",
      JSON.stringify({
        style: state.style,
        amount: Math.round(state.amount * 100),
        mirror: state.mirror,
        device: state.deviceId || "",
      })
    );
  } catch (err) {
    /* modo privado / storage bloqueado */
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("framefx.v1") || "null");
  } catch (err) {
    saved = null;
  }
  if (!saved) return;

  if (Number.isFinite(saved.style)) setStyle(clamp(Math.round(saved.style), 0, 5));
  if (saved.mirror === false) {
    state.mirror = false;
    $("btnMirror").classList.add("is-off");
  }
  if (typeof saved.device === "string" && saved.device) {
    state.deviceId = saved.device;
  }
  if (Number.isFinite(saved.amount)) {
    const v = clamp(Math.round(saved.amount), 0, 100);
    amount.value = String(v);
    state.amount = v / 100;
    $("amountOut").textContent = String(v);
  }

  persistSettings();
}

restoreSettings();

// El perfil de calidad se elige antes de dibujar el primer frame.
document.body.classList.toggle("is-lite", tierName === "low");

$("btnMirror").addEventListener("click", () => {
  state.mirror = !state.mirror;
  $("btnMirror").classList.toggle("is-off", !state.mirror);
  state.quad = null;
  state.target = null;
  state.presence = 0;
  persistSettings();
  toast(state.mirror ? "Espejo activado" : "Espejo desactivado", 1200);
});

$("btnFull").addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

$("btnHelp").addEventListener("click", () => ($("help").hidden = false));
$("btnHelpClose").addEventListener("click", () => ($("help").hidden = true));
$("help").addEventListener("click", (e) => {
  if (e.target.dataset.close !== undefined) $("help").hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;

  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    if (!e.repeat) toggleFreeze();
    return;
  }

  const key = e.key.toLowerCase();
  if (key === "1") setStyle(0);
  if (key === "2") setStyle(1);
  if (key === "3") setStyle(2);
  if (key === "4") setStyle(3);
  if (key === "5") setStyle(4);
  if (key === "6") setStyle(5);
  if (key === "r") toggleRecord();
  if (key === "s") snapshot();
  if (key === "m") $("btnMirror").click();
  if (key === "f") $("btnFull").click();
  if (key === "h") document.body.classList.toggle("ui-hidden");
  if (key === "?" || key === "/") $("help").hidden = false;
  if (key === "escape") $("help").hidden = true;
});

/* -------------------------------------------------------------- recording */

function ensureRecCanvas() {
  if (!state.rec.canvas) {
    const c = document.createElement("canvas");
    c.width = state.W;
    c.height = state.H;
    state.rec.canvas = c;
    state.rec.ctx = c.getContext("2d");
  }
  if (state.rec.canvas.width !== state.W || state.rec.canvas.height !== state.H) {
    state.rec.canvas.width = state.W;
    state.rec.canvas.height = state.H;
  }
  return state.rec.ctx;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toggleRecord() {
  if (!state.running) return;

  if (state.rec.active) {
    state.rec.recorder.stop();
    return;
  }

  // El arranque real se hace en flushCapture(), con el buffer recién pintado.
  state.capture.record = true;
}

function beginRecording() {
  if (!state.running || state.rec.active) return;

  const ctx2d = ensureRecCanvas();
  ctx2d.drawImage(canvas, 0, 0);
  ctx2d.drawImage(overlay, 0, 0);

  const stream = state.rec.canvas.captureStream(30);
  const mime = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));

  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 9_000_000,
    });
  } catch (err) {
    showError("No se pudo grabar", "Este navegador no soporta MediaRecorder.");
    return;
  }

  state.rec.chunks = [];
  state.rec.recorder = recorder;
  state.rec.active = true;
  state.rec.startedAt = performance.now();

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) state.rec.chunks.push(e.data);
  });

  recorder.addEventListener("stop", () => {
    const type = recorder.mimeType || mime || "video/webm";
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(state.rec.chunks, { type });
    if (blob.size) download(blob, `framefx_${stamp()}.${ext}`);
    clearInterval(state.rec.timer);
    state.rec.active = false;
    state.rec.recorder = null;
    $("rec").hidden = true;
    $("btnRec").classList.remove("is-recording");
    toast("Grabación guardada");
  });

  recorder.start(250);

  $("btnRec").classList.add("is-recording");
  $("rec").hidden = false;
  $("recTime").textContent = "00:00";
  state.rec.timer = setInterval(() => {
    const s = Math.floor((performance.now() - state.rec.startedAt) / 1000);
    $("recTime").textContent =
      String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 250);

  toast("Grabando · tocá otra vez para frenar");
}

$("btnRec").addEventListener("click", toggleRecord);

function snapshot() {
  if (!state.running) return;
  // Se resuelve en flushCapture(), dentro del frame que se acaba de dibujar.
  state.capture.photo = true;
}

function savePhoto() {
  const c = document.createElement("canvas");
  c.width = state.W;
  c.height = state.H;
  const ctx2d = c.getContext("2d");
  ctx2d.drawImage(canvas, 0, 0);
  ctx2d.drawImage(overlay, 0, 0);

  c.toBlob((blob) => {
    if (blob) {
      download(blob, `framefx_${stamp()}.png`);
      toast("Foto guardada");
    }
  }, "image/png");
}

function flushCapture() {
  if (state.capture.photo) {
    state.capture.photo = false;
    savePhoto();
  }
  if (state.capture.record) {
    state.capture.record = false;
    beginRecording();
  }
}

$("btnPhoto").addEventListener("click", snapshot);
$("btnFreeze").addEventListener("click", toggleFreeze);

/* ----------------------------------------------------------------- misc */

// Al rotar el teléfono cambia el tamaño visible: recalculamos el buffer interno.
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.running) return;
    const vw = state.demo ? state.feed.canvas.width : video.videoWidth || state.srcW;
    const vh = state.demo ? state.feed.canvas.height : video.videoHeight || state.srcH;
    resize(vw, vh);
  }, 220);
});

window.addEventListener("beforeunload", () => {
  setAppActive(false);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});

canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  showError(
    "Se perdió el contexto gráfico",
    "Recargá la página para volver a activar el filtro."
  );
});
