// Private hosting attaches visitor access to page requests. Read climate files
// in that page, then transfer their bytes to the unchanged scientific worker.
function waClimateWorker(workerUrl) {
  const worker = new Worker(workerUrl, { type: "module" });
  const climateRoot = new URL("../data/climate/", workerUrl);
  const files = new Set(["meta.json", "cells.bin", "feels.bin", "tmax.bin", "tmin.bin",
    "dew.bin", "sst.bin", "cloud.bin", "precip.bin", "wind.bin", "snow.bin", "sun.bin", "uv.bin"]);
  worker.addEventListener("message", async event => {
    const request = event.data;
    if (request?.type !== "wa-climate-fetch") return;
    event.stopImmediatePropagation();
    const reply = { type: "wa-climate-bytes", fetchId: request.fetchId };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const url = new URL(request.url);
      const name = url.pathname.slice(climateRoot.pathname.length);
      if (url.origin !== location.origin || url.origin !== climateRoot.origin ||
          !url.pathname.startsWith(climateRoot.pathname) || !files.has(name) || url.search || url.hash) {
        throw new Error("Unsupported climate data URL");
      }
      const response = await fetch(url.href, {
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      // Keep HTTP failures visible to the original decoder, which reports them
      // and clears its pending file promise so another attempt can retry.
      const body = await response.arrayBuffer();
      worker.postMessage({ ...reply, status: response.status,
        headers: { "content-type": response.headers.get("content-type") || "application/octet-stream",
          "content-length": String(body.byteLength) }, body }, [body]);
    } catch (error) {
      worker.postMessage({ ...reply, error: String(error?.message || error) });
    } finally {
      clearTimeout(timeout);
    }
  });
  return worker;
}
