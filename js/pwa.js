// PWA: instalación, service worker, aviso de actualización y wake lock.

const installBtn = document.getElementById("btnInstall");
const iosHint = document.getElementById("iosHint");
const updateBar = document.getElementById("update");
const updateBtn = document.getElementById("updateBtn");

let deferredPrompt = null;
let registration = null;
let refreshRequested = false;
let active = false;
let wakeLock = null;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function showInstall() {
  if (!installBtn || isStandalone()) return;
  installBtn.hidden = false;
}

function hideInstall() {
  if (installBtn) installBtn.hidden = true;
}

function showUpdate() {
  if (updateBar) updateBar.hidden = false;
}

export function initPWA(toast) {
  /* ------------------------------------------------------------ instalación */

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showInstall();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    hideInstall();
    toast?.("FRAME FX instalada", 2600);
  });

  installBtn?.addEventListener("click", async () => {
    if (!deferredPrompt) {
      toast?.("Para instalarla usá el menú del navegador → Instalar app", 4200);
      return;
    }

    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompt.prompt();

    try {
      await prompt.userChoice;
    } catch (err) {
      // El navegador puede cancelar el prompt; no hacemos nada.
    }
    hideInstall();
  });

  // iOS no dispara beforeinstallprompt: mostramos la instrucción manual.
  const ios =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (ios && !isStandalone() && iosHint) {
    iosHint.hidden = false;
    hideInstall();
  }

  if (isStandalone()) hideInstall();

  /* ---------------------------------------------------------- service worker */

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      registration = reg;

      if (reg.waiting && navigator.serviceWorker.controller) showUpdate();

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;

        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            showUpdate();
          }
        });
      });
    })
    .catch((err) => {
      console.warn("No se pudo registrar el service worker", err);
    });

  updateBtn?.addEventListener("click", () => {
    if (updateBar) updateBar.hidden = true;

    const waiting = registration?.waiting;
    if (!waiting) {
      location.reload();
      return;
    }

    refreshRequested = true;
    waiting.postMessage({ type: "SKIP_WAITING" });

    // Red de seguridad por si el navegador no dispara controllerchange.
    setTimeout(() => location.reload(), 3000);
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshRequested) location.reload();
  });

  // Buscar actualizaciones al volver a la app, sin spamear.
  let lastCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck < 30 * 60 * 1000) return;
    lastCheck = Date.now();
    registration?.update().catch(() => {});
  });
}

/* --------------------------------------------------------------- wake lock */

async function requestWakeLock() {
  if (wakeLock || !active) return;
  if (document.visibilityState !== "visible") return;
  if (!("wakeLock" in navigator)) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    wakeLock = null;
  }
}

export function setAppActive(on) {
  active = Boolean(on);

  if (active) {
    requestWakeLock();
  } else if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestWakeLock();
});
