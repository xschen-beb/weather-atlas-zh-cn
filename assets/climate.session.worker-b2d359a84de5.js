// Transport adapter only: decoding, checksums, interpolation and statistics
// remain in the original climate.worker-BYFoMrb0.js module.
const pendingFetches = new Map();
const earlyMessages = [];
let fetchSequence = 0;
let scientificWorkerReady = false;
self.fetch = input => new Promise((resolve, reject) => {
  const fetchId = ++fetchSequence;
  pendingFetches.set(fetchId, { resolve, reject });
  self.postMessage({ type: "wa-climate-fetch", fetchId,
    url: typeof input === "string" ? input : input.url || String(input) });
});
self.addEventListener("message", event => {
  const reply = event.data;
  if (reply?.type === "wa-climate-bytes") {
    event.stopImmediatePropagation();
    const pending = pendingFetches.get(reply.fetchId);
    if (!pending) return;
    pendingFetches.delete(reply.fetchId);
    if (reply.error) pending.reject(new Error(reply.error));
    else {
      try { pending.resolve(new Response(reply.body, { status: reply.status, headers: reply.headers })); }
      catch (error) { pending.reject(error); }
    }
  } else if (!scientificWorkerReady) {
    earlyMessages.push(reply);
    event.stopImmediatePropagation();
  }
});
try {
  await import("./climate.worker-BYFoMrb0.js");
  scientificWorkerReady = true;
  for (const data of earlyMessages) self.dispatchEvent(new MessageEvent("message", { data }));
  earlyMessages.length = 0;
} catch (error) {
  self.postMessage({ type: "error", error: String(error?.message || error) });
}
