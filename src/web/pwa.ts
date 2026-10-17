/**
 * Registers the shell-only service worker for installed use. The dev server and the desktop app's `postreeve:`
 * protocol never get one: dev assets change on every edit, and the desktop app ships its bundle.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return;
  window.addEventListener("load", () => {
    // Plain HTTP on a non-loopback host is not a secure context; the app still works without the worker.
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, { once: true });
}
