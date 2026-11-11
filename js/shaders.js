// GLSL ES 1.0 — WebGL1 compatible.

export const baseVert = /* glsl */ `
  attribute vec2 aPos;
  varying vec2 vScreen;

  void main() {
    vScreen = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

export const baseFrag = /* glsl */ `
  precision highp float;

  varying vec2 vScreen;

  uniform sampler2D uVideo;
  uniform float uMirror;

  void main() {
    vec2 uv = vec2(uMirror > 0.5 ? 1.0 - vScreen.x : vScreen.x, 1.0 - vScreen.y);
    vec3 c = texture2D(uVideo, uv).rgb;

    // Un poco de contraste y desaturación para que el marco resalte.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 0.86);
    c = pow(c, vec3(1.06)) * 0.9;

    // Viñeta suave.
    vec2 p = vScreen - 0.5;
    float vig = 1.0 - smoothstep(0.34, 0.92, length(p) * 1.25);
    c *= mix(0.48, 1.0, vig);

    // Grano sutil.
    float n = fract(sin(dot(vScreen * 941.0, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * 0.025;

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`;

const fxFragBody = /* glsl */ `
  precision highp float;

  varying vec2 vScreen;

  uniform sampler2D uVideo;
  uniform vec2  uRes;
  uniform float uTime;
  uniform float uMirror;
  uniform float uAmount;
  uniform float uStyle;
  uniform float uPresence;


  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  vec2 toUV(vec2 p) {
    return vec2(uMirror > 0.5 ? 1.0 - p.x : p.x, p.y);
  }

  vec3 videoAt(vec2 p) {
    return texture2D(uVideo, toUV(clamp(p, vec2(0.002), vec2(0.998)))).rgb;
  }

  // Mapa de color "ácido": azul profundo -> cian -> verde -> lima -> ámbar
  // -> rojo -> magenta. Es el ADN del look de la referencia.
  vec3 gradient(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = vec3(0.015, 0.035, 0.20);
    c = mix(c, vec3(0.00, 0.42, 0.98), smoothstep(0.05, 0.2, t));
    c = mix(c, vec3(0.00, 0.96, 0.86), smoothstep(0.2, 0.36, t));
    c = mix(c, vec3(0.25, 1.00, 0.55), smoothstep(0.36, 0.5, t));
    c = mix(c, vec3(0.72, 1.00, 0.12), smoothstep(0.5, 0.64, t));
    c = mix(c, vec3(1.00, 0.92, 0.08), smoothstep(0.64, 0.72, t));
    c = mix(c, vec3(1.00, 0.18, 0.22), smoothstep(0.72, 0.85, t));
    c = mix(c, vec3(1.00, 0.12, 0.68), smoothstep(0.85, 0.97, t));
    return c;
  }

  // Paleta térmica: negro violeta -> vino -> naranja -> ámbar -> blanco.
  vec3 thermalGradient(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = vec3(0.020, 0.005, 0.090);
    c = mix(c, vec3(0.160, 0.020, 0.420), smoothstep(0.04, 0.22, t));
    c = mix(c, vec3(0.550, 0.040, 0.280), smoothstep(0.22, 0.42, t));
    c = mix(c, vec3(0.960, 0.220, 0.050), smoothstep(0.42, 0.60, t));
    c = mix(c, vec3(1.000, 0.660, 0.060), smoothstep(0.60, 0.76, t));
    c = mix(c, vec3(1.000, 0.950, 0.620), smoothstep(0.76, 0.90, t));
    c = mix(c, vec3(1.000, 1.000, 1.000), smoothstep(0.90, 1.00, t));
    return c;
  }

  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    vec2 s = vec2(vScreen.x, 1.0 - vScreen.y);
    float amt = clamp(uAmount, 0.0, 1.0);

    // El "datamosh" cambia a saltos, no de forma continua.
    float tq = floor(uTime * 12.0) / 12.0;

    /* ---------------------------------------------------------- warp */
    // Cada estilo tiene su dosis de deformación: el líquido exagera, VHS se
    // queda en un temblor horizontal y térmico/pixel priorizan la lectura.
    float warpScale = 1.0;
    if (uStyle > 2.5 && uStyle < 3.5) warpScale = 0.55;
    else if (uStyle > 3.5 && uStyle < 4.5) warpScale = 0.4;
    else if (uStyle > 4.5) warpScale = 0.25;

    float warp =
      mix(0.006, 0.032, amt) *
      (uStyle > 1.5 && uStyle < 2.5 ? 1.8 : 1.0) *
      warpScale;
    vec2 p = s;
    p.x += sin(s.y * 9.0 + uTime * 2.1 + sin(s.y * 21.0)) * warp;
    p.y += cos(s.x * 7.0 - uTime * 1.7) * warp * 0.75;
    p += (vec2(vnoise(s * 2.6 + tq * 0.35), vnoise(s * 2.6 + 19.3 - tq * 0.4)) - 0.5) * warp * 1.5;

    /* --------------------------------------------- bloques desplazados */
    float rows = mix(72.0, 30.0, amt);
    vec2 cell = floor(s * vec2(rows * 1.6, rows));
    float rnd = hash21(cell * 0.017 + floor(tq * 9.0));
    float gate = step(0.9 - 0.08 * amt, hash21(cell * 0.031 + 3.7));
    vec2 disp = vec2((rnd - 0.5) * 0.07 * amt * gate, 0.0);

    float rowRnd = hash21(vec2(floor(s.y * rows), floor(tq * 7.0)));
    disp.x += (rowRnd - 0.5) * 0.035 * amt * step(0.8, rowRnd);
    disp.y += (hash21(vec2(cell.x, floor(tq * 5.0))) - 0.5) * 0.004 * amt * gate;

    // Remolino suave tipo liquify.
    vec2 d = s - 0.5;
    float rr = length(d);
    float ang = amt * 0.5 * sin(uTime * 0.8 + rr * 9.0) * (1.0 - smoothstep(0.05, 0.55, rr));
    float ca2 = cos(ang);
    float sa2 = sin(ang);
    p = 0.5 + mat2(ca2, -sa2, sa2, ca2) * (p - 0.5);

    vec2 q = p + disp;

    // VHS: banda de tracking que arrastra la imagen y filas que se rompen.
    if (uStyle > 2.5 && uStyle < 3.5) {
      float bandY = fract(uTime * 0.085);
      float bandMask = 1.0 - smoothstep(0.0, 0.05, abs(s.y - bandY));
      q.x += bandMask * (0.03 + 0.05 * amt) *
        (hash21(vec2(floor(s.y * 260.0), floor(tq * 26.0))) - 0.5);

      float dropRow = step(0.996, hash21(vec2(floor(s.y * 110.0), floor(tq * 20.0))));
      q.x += dropRow * (hash21(vec2(s.y * 91.0, tq)) - 0.5) * 0.04;
    }

    // Pixel: se muestrea en una grilla gruesa para que el glitch sea legible.
    if (uStyle > 4.5) {
      q = mix(s, q, 0.3);
      vec2 grid = mix(vec2(210.0, 124.0), vec2(120.0, 68.0), amt);
      q = (floor(q * grid) + 0.5) / grid;
    }

    /* --------------------------------------- aberración cromática base */
    float ca = (0.0015 + 0.0075 * amt) * (1.0 + 0.45 * sin(uTime * 2.3));
    vec3 base;
    base.r = videoAt(q + vec2(ca, 0.0)).r;
    base.g = videoAt(q).g;
    base.b = videoAt(q - vec2(ca, 0.0)).b;

    /* ------------------------------------ estelas tipo pixel-sorting */
    float l0 = luma(base);
    float sortMask = smoothstep(0.3, 0.62, l0) * amt;
    float dir = hash21(vec2(floor(s.y * 130.0), 11.0)) > 0.5 ? 1.0 : -1.0;
    vec3 streak = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < STREAK_TAPS; i++) {
      float fi = float(i) / float(STREAK_TAPS - 1);
      float off = fi * fi * 0.22 * amt * dir;
      float w = 1.0 - fi * 0.6;
      streak += videoAt(q + vec2(off, 0.0)) * w;
      wsum += w;
    }
    streak /= wsum;
    base = mix(base, streak, sortMask * 0.85);

    /* --------------------------------------------------------- bordes */
    vec2 e = 1.6 / uRes;
    float lx1 = luma(videoAt(q + vec2(e.x, 0.0)));
    float lx2 = luma(videoAt(q - vec2(e.x, 0.0)));
    float ly1 = luma(videoAt(q + vec2(0.0, e.y)));
    float ly2 = luma(videoAt(q - vec2(0.0, e.y)));
    float edge = clamp(length(vec2(lx1 - lx2, ly1 - ly2)) * 6.0, 0.0, 1.0);
    edge = pow(edge, 0.75);

    /* ---------------------------------------------------------- color */
    float lum = luma(base);
    float flow = vnoise(s * vec2(4.0, 3.0) + uTime * 0.05) - 0.5;
    vec3 col;

    if (uStyle < 0.5) {
      // ÁCIDO: mapa topográfico eléctrico, verdes y cian con rojos.
      float t = 0.03 + lum * 1.24 + edge * 0.34 + flow * 0.12;
      vec3 g = gradient(t);

      // Curvas de nivel finas, como la referencia.
      float band = abs(fract(lum * 9.0 + flow * 0.7 + edge * 1.4) - 0.5);
      float contour = smoothstep(0.45, 0.5, band);
      g = mix(g, vec3(0.85, 1.0, 0.55), contour * 0.4);

      col = mix(g, base * 1.12, 0.16);
      col += edge * vec3(0.12, 0.92, 0.62) * 0.32;
      col = floor(col * 18.0) / 18.0;
    } else if (uStyle < 1.5) {
      // NEÓN: violeta / magenta / cian con más cromo.
      float t = lum * 1.1 + 0.04 + flow * 0.1;
      vec3 g = mix(vec3(0.28, 0.02, 0.5), gradient(t), 0.58);
      col = mix(base * vec3(0.72, 0.82, 1.22), g * 1.3, 0.76);
      col += edge * vec3(1.0, 0.1, 0.72) * 0.6;
      col = floor(col * 16.0) / 16.0;
    } else if (uStyle < 2.5) {
      // LÍQUIDO: menos paleta, más deformación y cromo.
      float t = lum * 1.05 + uTime * 0.02 + flow * 0.14;
      vec3 g = gradient(t);
      col = mix(base * vec3(1.04, 1.1, 1.0), g * 1.12, 0.5);
      col = mix(col, col.gbr, 0.16);
      col += edge * vec3(0.25, 0.85, 1.0) * 0.5;
      col = floor(col * 20.0) / 20.0;
    } else if (uStyle < 3.5) {
      // VHS: cinta gastada, cromo desplazado y banda de tracking.
      vec3 v = mix(vec3(lum), base, 0.7);
      v *= vec3(1.02, 0.97, 1.06);
      v += edge * vec3(0.32, 0.1, 0.42) * 0.55;

      float bandY = fract(uTime * 0.085);
      float band = 1.0 - smoothstep(0.0, 0.055, abs(s.y - bandY));
      v += band * vec3(0.16, 0.22, 0.14) * (0.4 + 0.4 * amt);

      float scanVhs = 0.7 + 0.3 * sin(s.y * uRes.y * 1.7);
      v *= mix(1.0, scanVhs, 0.45 + 0.3 * amt);

      float dropout = step(0.997, hash21(vec2(floor(s.y * 320.0), floor(tq * 40.0))));
      v = mix(v, vec3(0.92, 0.97, 0.9), dropout * 0.7);

      col = floor(v * 12.0) / 12.0;
    } else if (uStyle < 4.5) {
      // TÉRMICO: la luma se vuelve temperatura, con halos en los bordes.
      float t = clamp(lum * 1.06 + edge * 0.18 + flow * 0.04, 0.0, 1.0);
      vec3 th = thermalGradient(t);
      th += edge * vec3(1.0, 0.72, 0.22) * 0.28;
      th = mix(th, vec3(1.0, 0.97, 0.82), pow(edge, 2.0) * 0.2);
      col = floor(th * 24.0) / 24.0;
    } else {
      // PIXEL: paleta reducida a 6 pasos y dither ordenado por celda.
      float t = clamp(lum + flow * 0.12, 0.0, 1.0);
      vec3 g = gradient(floor(t * 6.0) / 6.0);
      col = mix(base, g, 0.62);

      vec2 cellPx = floor(s * uRes / 3.0);
      float dith = hash21(cellPx);
      col += (dith - 0.5) * 0.2;
      col = floor(col * 4.0 + 0.5) / 4.0;
    }

    /* ----------------------------------------------- textura de señal */
    float scan = 0.86 + 0.14 * sin(s.y * uRes.y * 1.08 + uTime * 21.0);
    col *= mix(1.0, scan, 0.35 + 0.35 * amt);

    float grain = hash21(s * uRes + fract(uTime) * 43.0) - 0.5;
    col += grain * (0.055 + 0.05 * amt);

    // Micro líneas horizontales que aparecen a saltos.
    float tear = step(0.985, hash21(vec2(floor(s.y * 220.0), floor(tq * 30.0))));
    col *= 1.0 - tear * 0.5;

    // Leve viñeta para cerrar el marco.
    vec2 pc = s - 0.5;
    col *= 1.0 - dot(pc, pc) * 0.28;

    // Fundido con la imagen limpia al aparecer / desaparecer el marco.
    col = mix(videoAt(s), col, clamp(uPresence, 0.0, 1.0));

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// El bucle de estelas (STREAK_TAPS muestras de textura por píxel) es la parte
// más cara del shader. En pantallas chicas compilamos una variante con menos
// muestras: el look se mantiene y el costo de fill-rate baja casi a la mitad.
// El tope del for tiene que ser una constante, por eso se inyecta acá.
export function fxFragSource(taps = 8) {
  const n = Math.max(2, Math.min(16, Math.round(taps)));
  return `#define STREAK_TAPS ${n}\n` + fxFragBody;
}

export const fxFrag = fxFragSource(8);
