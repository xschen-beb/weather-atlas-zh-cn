// All routes serve the same public static bytes. Verify before returning data.
const HEADER_TIMEOUT = 9000;
const STALL_TIMEOUT = 8000;
const TOTAL_TIMEOUT = 90000;
const HEDGE_DELAY = 1800;

async function verify(body, [size, sha], required) {
  if (body.byteLength !== size) throw new Error('Data size checksum mismatch');
  if (!globalThis.crypto?.subtle) {
    if (required) throw new Error('Data checksum verification not supported');
    return body;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('');
  if (hash !== sha) throw new Error('Data checksum mismatch');
  return body;
}

async function download(route, entry, controller, progress) {
  const {url,cache,primary} = route;
  const [size, , priority = 'high'] = entry;
  const {signal} = controller;
  const timeout = () => controller.abort(new Error('Request timeout'));
  let idle = setTimeout(timeout, HEADER_TIMEOUT);
  const total = setTimeout(timeout, TOTAL_TIMEOUT);
  let reader, done = false;
  try {
    const res = await fetch(url, {cache,priority,credentials:primary?'same-origin':'omit',redirect:'error',signal});
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    // Measure time without any progress rather than cutting off a healthy,
    // slow download of a multi-megabyte climate file after a fixed interval.
    clearTimeout(idle);
    idle = setTimeout(timeout, STALL_TIMEOUT);
    if (!res.body?.getReader) return await verify(await res.arrayBuffer(),entry,!primary);
    reader = res.body.getReader();
    const data = new Uint8Array(size);
    let offset = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      if (!chunk.value?.byteLength) continue;
      if (offset + chunk.value.byteLength > size) throw new Error('Data size checksum mismatch');
      progress();
      clearTimeout(idle);
      idle = setTimeout(timeout, STALL_TIMEOUT);
      data.set(chunk.value,offset);
      offset += chunk.value.byteLength;
    }
    clearTimeout(idle);
    if (offset !== size) throw new Error('Data size checksum mismatch');
    return await verify(data.buffer,entry,!primary);
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    if (reader) {
      if (!done) void reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
  }
}

export function createAtlasDataReader(files, backupBases = []) {
  const pending = new Map();

  function request(relative, url) {
    const entry = files[relative];
    const routes = [{url,cache:'default',primary:true}];
    if (globalThis.crypto?.subtle) {
      for (const base of backupBases) {
        const candidate = new URL(relative,base);
        if (!routes.some(route=>route.url.href===candidate.href)) routes.push({url:candidate,cache:'force-cache',primary:false});
      }
    }
    routes.push({url,cache:'reload',primary:true});

    return new Promise((resolve,reject)=>{
      const active = new Set();
      let next = 0, finished = false, hedge, deadline, primaryError, lastError;
      const delay = entry[2] === 'low' ? HEDGE_DELAY * 2 : HEDGE_DELAY;

      function finish(error, body) {
        if (finished) return;
        finished = true;
        clearTimeout(hedge);
        clearTimeout(deadline);
        for (const attempt of active) attempt.controller.abort(error ?? new Error('Another data route succeeded'));
        if (error) reject(new Error(`Atlas data ${relative}: ${error.message || 'Network request failed'}`,{cause:error}));
        else resolve(body);
      }

      function schedule() {
        clearTimeout(hedge);
        if (finished || next >= routes.length || active.size !== 1) return;
        const [attempt] = active;
        // Don't duplicate a healthy transfer on a slow connection.
        if (!attempt.receiving && next < routes.length - 1) {
          hedge = setTimeout(start, Math.max(0, delay - (Date.now() - attempt.started)));
        }
      }

      function start() {
        if (finished || active.size >= 2 || next >= routes.length) return;
        const route = routes[next++];
        const controller = new AbortController();
        const attempt = {controller,started:Date.now(),receiving:false};
        active.add(attempt);
        schedule();
        download(route,entry,controller,()=>{
          if (!attempt.receiving) { attempt.receiving = true; schedule(); }
        }).then(body=>{
          active.delete(attempt);
          finish(null,body);
        },error=>{
          active.delete(attempt);
          if (finished) return;
          if (route.primary) primaryError = error;
          lastError = error;
          if (!active.size && next < routes.length) start();
          else if (!active.size) finish(primaryError || lastError || new Error('Network request failed'));
          else schedule();
        });
      }

      // Map layers can retry without restarting the page. Bound the whole
      // round, including all routes, so successive slow routes cannot pile up.
      if (entry[3]) deadline = setTimeout(()=>finish(new Error('Request timeout')),entry[3]);
      start();
    });
  }

  async function bytes(base, relative) {
    if (!Object.hasOwn(files,relative)) throw new Error('Unsupported data file');
    const url = new URL(relative,new URL(base,location.href));
    if (url.origin !== new URL(location.href).origin) throw new Error('Unsupported data URL');
    const key = url.href;
    let promise = pending.get(key);
    if (!promise) {
      const read = globalThis.waReadEmbeddedData;
      promise = (read ? Promise.resolve().then(()=>verify(read(relative),files[relative],false)) : request(relative,url))
        .finally(() => pending.delete(key));
      pending.set(key,promise);
    }
    // A consumer can transfer its buffer into a worker without detaching another's.
    return (await promise).slice(0);
  }
  return {
    bytes,
    async json(base, relative) {
      return JSON.parse(new TextDecoder().decode(await bytes(base,relative)));
    },
  };
}
