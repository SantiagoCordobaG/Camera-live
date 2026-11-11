// Feed sintético para probar la app sin cámara (?demo).
// Dibuja una "persona" con las manos armando el marco y devuelve landmarks
// falsos con el mismo formato que MediaPipe (21 puntos, coords normalizadas).

const W = 1280;
const H = 720;

const SKIN = "#e3ab84";
const SKIN_DARK = "#bd7f59";
const SKIN_LIGHT = "#f5cdae";

export function createDemo() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const bg = document.createElement("canvas");
  bg.width = W;
  bg.height = H;
  paintBackdrop(bg.getContext("2d"));

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, 0, 0);

    const hands = sampleHands(t);
    drawSubject(ctx, t);
    drawHand(ctx, hands.left, -1);
    drawHand(ctx, hands.right, 1);

    // Grano suave para que el shader tenga textura.
    ctx.save();
    ctx.globalAlpha = 0.03;
    for (let i = 0; i < 240; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      ctx.fillStyle = Math.random() > 0.5 ? "#ffffff" : "#000000";
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }

  function landmarks(t) {
    const { left, right } = sampleHands(t);
    return [toLandmarks(left), toLandmarks(right)];
  }

  return { canvas, draw, landmarks };
}

/* ------------------------------------------------------------- landmarks */

function sampleHands(t) {
  const s1 = Math.sin(t * 0.85);
  const s2 = Math.sin(t * 0.65 + 1.7);

  const left = {
    wrist: [0.236 + s1 * 0.0015, 0.565],
    middleMcp: [0.276 + s1 * 0.002, 0.475],
    indexMcp: [0.293 + s1 * 0.0025, 0.408],
    indexTip: [0.302 + s1 * 0.003, 0.272 + Math.sin(t * 1.25) * 0.003],
    thumbTip: [0.302 + s2 * 0.003, 0.586 + Math.cos(t * 1.05) * 0.003],
  };

  const right = {
    wrist: [1 - 0.238 + s2 * 0.0015, 0.561],
    middleMcp: [1 - 0.278 + s2 * 0.002, 0.472],
    indexMcp: [1 - 0.295 + s2 * 0.0025, 0.405],
    indexTip: [1 - 0.304 + s2 * 0.003, 0.276 + Math.sin(t * 1.15 + 2) * 0.003],
    thumbTip: [1 - 0.304 + s1 * 0.003, 0.583 + Math.cos(t * 0.95 + 1) * 0.003],
  };

  return { left, right };
}

function toLandmarks(h) {
  const pts = Array.from({ length: 21 }, () => ({ x: h.wrist[0], y: h.wrist[1], z: 0 }));
  pts[0] = { x: h.wrist[0], y: h.wrist[1], z: 0 };
  pts[4] = { x: h.thumbTip[0], y: h.thumbTip[1], z: 0 };
  pts[5] = { x: h.indexMcp[0], y: h.indexMcp[1], z: 0 };
  pts[8] = { x: h.indexTip[0], y: h.indexTip[1], z: 0 };
  pts[9] = { x: h.middleMcp[0], y: h.middleMcp[1], z: 0 };
  return pts;
}

/* --------------------------------------------------------------- backdrop */

function paintBackdrop(c) {
  const wall = c.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, "#2b4a41");
  wall.addColorStop(0.55, "#203931");
  wall.addColorStop(1, "#132320");
  c.fillStyle = wall;
  c.fillRect(0, 0, W, H);

  // Luz cálida (izquierda) y fría (derecha).
  const warm = c.createRadialGradient(W * 0.08, H * 0.18, 20, W * 0.08, H * 0.18, W * 0.5);
  warm.addColorStop(0, "rgba(255, 196, 120, 0.34)");
  warm.addColorStop(1, "rgba(255, 196, 120, 0)");
  c.fillStyle = warm;
  c.fillRect(0, 0, W, H);

  const cool = c.createRadialGradient(W * 0.92, H * 0.35, 20, W * 0.92, H * 0.35, W * 0.45);
  cool.addColorStop(0, "rgba(80, 255, 220, 0.16)");
  cool.addColorStop(1, "rgba(80, 255, 220, 0)");
  c.fillStyle = cool;
  c.fillRect(0, 0, W, H);

  // Poster abstracto (sin texto: el espejo lo daría vuelta).
  c.save();
  c.translate(W * 0.115, H * 0.11);
  c.rotate(-0.02);
  c.fillStyle = "#efe9d8";
  c.fillRect(0, 0, W * 0.145, H * 0.32);
  c.fillStyle = "#c8ff3d";
  c.beginPath();
  c.arc(W * 0.052, H * 0.1, W * 0.045, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#20362f";
  c.beginPath();
  c.arc(W * 0.085, H * 0.17, W * 0.05, Math.PI, 0);
  c.fill();
  c.fillStyle = "#ff2fa0";
  c.fillRect(W * 0.018, H * 0.235, W * 0.108, 10);
  c.fillStyle = "#20362f";
  c.fillRect(W * 0.018, H * 0.258, W * 0.075, 6);
  c.fillRect(W * 0.018, H * 0.273, W * 0.095, 6);
  c.strokeStyle = "#20362f";
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(W * 0.02, H * 0.055);
  c.lineTo(W * 0.12, H * 0.025);
  c.stroke();
  c.restore();

  // Estante + objetos.
  c.fillStyle = "rgba(12, 24, 20, 0.55)";
  c.fillRect(W * 0.71, H * 0.055, W * 0.21, 9);
  c.fillStyle = "#3c5a4f";
  c.fillRect(W * 0.735, H * 0.018, 44, 40);
  c.fillStyle = "#ff2fa0";
  c.beginPath();
  c.arc(W * 0.855, H * 0.048, 17, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#c8ff3d";
  c.fillRect(W * 0.895, H * 0.022, 24, 32);

  // Lámpara colgante.
  c.strokeStyle = "rgba(8, 14, 12, 0.7)";
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(W * 0.62, 0);
  c.lineTo(W * 0.62, H * 0.09);
  c.stroke();
  const lamp = c.createRadialGradient(W * 0.62, H * 0.12, 4, W * 0.62, H * 0.12, 150);
  lamp.addColorStop(0, "rgba(255, 236, 180, 0.85)");
  lamp.addColorStop(1, "rgba(255, 236, 180, 0)");
  c.fillStyle = lamp;
  c.fillRect(W * 0.5, 0, W * 0.28, H * 0.34);
  c.fillStyle = "#1b2621";
  c.beginPath();
  c.moveTo(W * 0.6, H * 0.09);
  c.lineTo(W * 0.64, H * 0.09);
  c.lineTo(W * 0.655, H * 0.13);
  c.lineTo(W * 0.585, H * 0.13);
  c.closePath();
  c.fill();

  // Viñeta.
  const vig = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.72);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.55)");
  c.fillStyle = vig;
  c.fillRect(0, 0, W, H);
}

/* ---------------------------------------------------------------- subject */

function drawSubject(c, t) {
  const cx = W * (0.5 + Math.sin(t * 0.5) * 0.0025);
  const cy = H * (0.47 + Math.sin(t * 0.8) * 0.003);

  // Cuello (va primero: el torso y la cara lo recortan).
  c.fillStyle = SKIN_DARK;
  c.beginPath();
  c.roundRect(cx - W * 0.037, cy + H * 0.05, W * 0.074, H * 0.3, 30);
  c.fill();

  // Torso: sweater oscuro.
  const jacket = c.createLinearGradient(0, H * 0.76, 0, H);
  jacket.addColorStop(0, "#3c5f58");
  jacket.addColorStop(0.5, "#2a4944");
  jacket.addColorStop(1, "#1a302d");
  c.fillStyle = jacket;
  c.beginPath();
  c.moveTo(W * 0.2, H + 20);
  c.quadraticCurveTo(W * 0.235, H * 0.82, W * 0.34, H * 0.758);
  c.quadraticCurveTo(W * 0.43, H * 0.722, W * 0.5, H * 0.746);
  c.quadraticCurveTo(W * 0.57, H * 0.722, W * 0.66, H * 0.758);
  c.quadraticCurveTo(W * 0.765, H * 0.82, W * 0.8, H + 20);
  c.closePath();
  c.fill();

  // Sombra del mentón sobre el cuello.
  c.fillStyle = "rgba(90, 50, 32, 0.2)";
  c.beginPath();
  c.ellipse(cx, cy + H * 0.075, W * 0.036, H * 0.014, 0, 0, Math.PI * 2);
  c.fill();

  // Brillo de hombros.
  c.fillStyle = "rgba(255,255,255,0.06)";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(cx + s * W * 0.19, H * 0.78, W * 0.07, H * 0.013, s * 0.22, 0, Math.PI * 2);
    c.fill();
  }

  // Costura central.
  c.strokeStyle = "rgba(8, 24, 20, 0.3)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx, cy + H * 0.3);
  c.lineTo(cx, H);
  c.stroke();

  // Orejas.
  c.fillStyle = SKIN;
  c.beginPath();
  c.ellipse(cx - W * 0.108, cy + H * 0.015, W * 0.018, H * 0.038, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(cx + W * 0.108, cy + H * 0.015, W * 0.018, H * 0.038, 0, 0, Math.PI * 2);
  c.fill();

  // Cara.
  const skin = c.createRadialGradient(cx - W * 0.02, cy - H * 0.05, 10, cx, cy, W * 0.16);
  skin.addColorStop(0, SKIN_LIGHT);
  skin.addColorStop(0.6, SKIN);
  skin.addColorStop(1, SKIN_DARK);
  c.fillStyle = skin;
  c.beginPath();
  c.ellipse(cx, cy, W * 0.105, H * 0.155, 0, 0, Math.PI * 2);
  c.fill();

  // Pelo rizado.
  c.fillStyle = "#33241d";
  const curls = [
    [-0.095, -0.1, 0.034], [-0.07, -0.135, 0.038], [-0.035, -0.155, 0.04],
    [0.005, -0.16, 0.042], [0.045, -0.152, 0.04], [0.08, -0.128, 0.037],
    [0.1, -0.09, 0.032], [0.11, -0.045, 0.028], [-0.11, -0.055, 0.028],
    [-0.1, 0.0, 0.024], [0.105, 0.0, 0.024],
  ];
  for (const [dx, dy, r] of curls) {
    c.beginPath();
    c.arc(cx + W * dx, cy + H * dy, W * r, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = "rgba(255,255,255,0.05)";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    c.beginPath();
    c.arc(cx + Math.cos(a) * W * 0.09, cy - H * 0.09 + Math.sin(a) * H * 0.045, W * 0.012, 0, Math.PI * 2);
    c.fill();
  }

  // Cejas.
  c.strokeStyle = "#3a2a22";
  c.lineWidth = 7;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(cx - W * 0.062, cy - H * 0.045);
  c.quadraticCurveTo(cx - W * 0.042, cy - H * 0.058, cx - W * 0.022, cy - H * 0.047);
  c.moveTo(cx + W * 0.022, cy - H * 0.047);
  c.quadraticCurveTo(cx + W * 0.042, cy - H * 0.058, cx + W * 0.062, cy - H * 0.045);
  c.stroke();

  // Ojos.
  const blink = blinkAmount(t);
  for (const side of [-1, 1]) {
    const ex = cx + side * W * 0.042;
    const ey = cy - H * 0.012;
    c.fillStyle = "#f7efe6";
    c.beginPath();
    c.ellipse(ex, ey, W * 0.019, H * 0.016 * blink, 0, 0, Math.PI * 2);
    c.fill();
    if (blink > 0.4) {
      c.fillStyle = "#5a3a26";
      c.beginPath();
      c.arc(ex + Math.sin(t * 0.9) * 3, ey, W * 0.0085, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#150d09";
      c.beginPath();
      c.arc(ex + Math.sin(t * 0.9) * 3, ey, W * 0.004, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Nariz.
  c.strokeStyle = "rgba(140, 82, 55, 0.5)";
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(cx - W * 0.004, cy + H * 0.005);
  c.quadraticCurveTo(cx - W * 0.012, cy + H * 0.04, cx + W * 0.008, cy + H * 0.042);
  c.stroke();
  c.fillStyle = "rgba(120, 68, 45, 0.22)";
  c.beginPath();
  c.ellipse(cx, cy + H * 0.048, W * 0.022, H * 0.012, 0, 0, Math.PI * 2);
  c.fill();

  // Boca.
  c.strokeStyle = "rgba(110, 48, 44, 0.75)";
  c.lineWidth = 5;
  c.beginPath();
  c.moveTo(cx - W * 0.03, cy + H * 0.083);
  c.quadraticCurveTo(cx, cy + H * 0.093, cx + W * 0.03, cy + H * 0.083);
  c.stroke();
  c.fillStyle = "rgba(190, 90, 85, 0.35)";
  c.beginPath();
  c.ellipse(cx, cy + H * 0.088, W * 0.022, H * 0.006, 0, 0, Math.PI * 2);
  c.fill();

  // Sombra de mandíbula y brillo frente.
  c.fillStyle = "rgba(120, 70, 45, 0.12)";
  c.beginPath();
  c.ellipse(cx, cy + H * 0.1, W * 0.075, H * 0.05, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "rgba(255, 245, 225, 0.18)";
  c.beginPath();
  c.ellipse(cx - W * 0.03, cy - H * 0.08, W * 0.04, H * 0.03, -0.3, 0, Math.PI * 2);
  c.fill();
}

function blinkAmount(t) {
  const cycle = t % 4.2;
  if (cycle < 0.12) return Math.max(0.08, Math.abs(cycle - 0.06) / 0.06);
  return 1;
}

/* ------------------------------------------------------------------ hands */

function drawHand(c, hand, side) {
  const wrist = px(hand.wrist);
  const mcp = px(hand.middleMcp);
  const idxBase = px(hand.indexMcp);
  const idxTip = px(hand.indexTip);
  const thumbTip = px(hand.thumbTip);

  const palmAngle = Math.atan2(mcp.y - wrist.y, mcp.x - wrist.x);
  const palmCx = (wrist.x + mcp.x) / 2;
  const palmCy = (wrist.y + mcp.y) / 2;

  // Antebrazo: sale del cuadro por abajo y afuera.
  const forearm = {
    x: wrist.x + side * W * 0.1,
    y: wrist.y + H * 0.42,
  };
  capsule(c, wrist, forearm, W * 0.062, SKIN_DARK);

  // Sombra.
  c.save();
  c.translate(side * 6, 12);
  c.fillStyle = "rgba(0,0,0,0.16)";
  c.beginPath();
  c.ellipse(palmCx, palmCy + 18, W * 0.048, W * 0.082, palmAngle, 0, Math.PI * 2);
  c.fill();
  c.restore();

  // Palma.
  c.save();
  c.translate(palmCx, palmCy);
  c.rotate(palmAngle);
  const palm = c.createLinearGradient(0, -W * 0.05, 0, W * 0.05);
  palm.addColorStop(0, SKIN_LIGHT);
  palm.addColorStop(0.5, SKIN);
  palm.addColorStop(1, SKIN_DARK);
  c.fillStyle = palm;
  c.beginPath();
  c.roundRect(-W * 0.026, -W * 0.048, W * 0.052, W * 0.1, W * 0.024);
  c.fill();

  // Dedos recogidos: un relieve en el borde externo.
  c.fillStyle = SKIN_DARK;
  c.beginPath();
  c.roundRect(side * W * 0.011, -W * 0.03, W * 0.026, W * 0.082, W * 0.013);
  c.fill();

  c.strokeStyle = "rgba(130, 78, 52, 0.35)";
  c.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const yy = -W * 0.016 + i * W * 0.026;
    c.beginPath();
    c.moveTo(side * W * 0.008, yy);
    c.lineTo(side * W * 0.042, yy + W * 0.004);
    c.stroke();
  }
  c.restore();

  // Índice estirado, con dos falanges.
  const idxMid = {
    x: lerp(idxBase.x, idxTip.x, 0.55),
    y: lerp(idxBase.y, idxTip.y, 0.55),
  };
  capsule(c, idxBase, idxMid, W * 0.032, SKIN);
  capsule(c, idxMid, idxTip, W * 0.027, SKIN);
  c.fillStyle = SKIN_LIGHT;
  c.beginPath();
  c.ellipse(idxTip.x, idxTip.y, W * 0.016, W * 0.02, palmAngle, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "rgba(252, 232, 218, 0.9)";
  c.beginPath();
  c.ellipse(idxTip.x + side * 2, idxTip.y - 5, W * 0.009, W * 0.013, 0.12, 0, Math.PI * 2);
  c.fill();

  // Pulgar: apunta al centro del marco (la esquina inferior).
  const thumbBase = {
    x: palmCx - side * W * 0.02,
    y: palmCy + W * 0.028,
  };
  const thumbMid = {
    x: lerp(thumbBase.x, thumbTip.x, 0.5),
    y: lerp(thumbBase.y, thumbTip.y, 0.5),
  };
  capsule(c, thumbBase, thumbMid, W * 0.038, SKIN);
  capsule(c, thumbMid, thumbTip, W * 0.033, SKIN);
  c.fillStyle = SKIN_LIGHT;
  c.beginPath();
  c.ellipse(thumbTip.x, thumbTip.y, W * 0.018, W * 0.021, palmAngle + side * 0.5, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "rgba(252, 232, 218, 0.9)";
  c.beginPath();
  c.ellipse(thumbTip.x + side * 2, thumbTip.y - 5, W * 0.009, W * 0.013, 0.4, 0, Math.PI * 2);
  c.fill();
}

function capsule(c, a, b, width, color) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.stroke();
}

function px(p) {
  return { x: p[0] * W, y: p[1] * H };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
