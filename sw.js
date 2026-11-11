// FRAME FX — service worker
//
// Estrategia:
//   - Shell (HTML, CSS, JS, fuente, íconos): precache versionado.
//   - Tracker (modelo + wasm + bundle): cache-first, se guarda la primera vez
//     que se usa la cámara y se conserva entre actualizaciones de la app.
//   - Navegación: red primero; si no hay red, sirve el index cacheado.
//
// IMPORTANTE: al publicar cambios en el shell, subí SHELL_VERSION. El navegador
// solo detecta una actualización si cambia el contenido de este archivo.

const SHELL_VERSION = "v4";
const SHELL_CACHE = `framefx-shell-${SHELL_VERSION}`;
const RUNTIME_CACHE = "framefx-runtime-v1";

const scope = self.registration.scope;
const url = (path) => new URL(path, scope).href;
const INDEX = url("./index.html");
const VENDOR_PATH = new URL("./vendor/", scope).pathname;

const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/main.js",
  "./js/shaders.js",
  "./js/demo.js",
  "./js/pwa.js",
  "./vendor/fonts/space-grotesk-latin.woff2",
  "./vendor/mediapipe/vision_bundle.mjs",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
].map(url);

async function precache() {
  const cache = await caches.open(SHELL_CACHE);

  // cache: "reload" evita que el HTTP cache del navegador nos devuelva una
  // versión vieja justo cuando estamos instalando una nueva.
  //
  // allSettled: que un asset lento o caído no cancele la instalación entera.
  // Si falta algo, el fetch normal lo trae y lo cachea en runtime.
  const results = await Promise.allSettled(
    SHELL.map(async (asset) => {
      const response = await fetch(asset, { cache: "reload" });
      if (!response.ok) {
        throw new Error(`No se pudo cachear ${asset}`);
      }
      await cache.put(asset, response);
    })
  );

  if (results.every((r) => r.status === "rejected")) {
    throw new Error("No se pudo cachear ningún asset del shell");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("framefx-shell-") && key !== SHELL_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestURL = new URL(request.url);
  if (requestURL.origin !== self.location.origin) return;

  // Navegación: red primero para traer HTML nuevo; offline cae al shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        return (
          (await caches.match(INDEX)) ||
          (await caches.match(url("./"))) ||
          Response.error()
        );
      })
    );
    return;
  }

  // Modelo de manos, wasm y runtime: cache-first y se conservan.
  if (requestURL.pathname.startsWith(VENDOR_PATH)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // Resto del shell: cache-first. Se refresca al activar una nueva versión.
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});
