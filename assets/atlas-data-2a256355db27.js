// Public static data only. The source Site keeps its separate session transport.
export function createAtlasDataReader(files, backupBase) {
  const pending = new Map();

  async function download(url, [size, sha], {cache, credentials, timeout}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timeout')), timeout);
    try {
      const res = await fetch(url, {cache, credentials, redirect: 'error', signal: controller.signal});
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.arrayBuffer();
      if (body.byteLength !== size) throw new Error('Data size checksum mismatch');
      if (globalThis.crypto?.subtle) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
        const hash = Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('');
        if (hash !== sha) throw new Error('Data checksum mismatch');
      } else if (credentials === 'omit') {
        throw new Error('Data checksum verification not supported');
      }
      return body;
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(relative, url) {
    let error;
    for (const [cache,timeout] of [['default',14000],['reload',10000]]) {
      try { return await download(url, files[relative], {cache,credentials:'same-origin',timeout}); }
      catch (failure) { error = failure; }
    }
    if (backupBase && globalThis.crypto?.subtle) {
      try {
        return await download(new URL(relative,backupBase), files[relative],
          {cache:'force-cache',credentials:'omit',timeout:14000});
      } catch { /* Preserve the site's error for the user and allow another attempt. */ }
    }
    throw new Error(`Atlas data ${relative}: ${error?.message || 'Network request failed'}`, {cause:error});
  }

  async function bytes(base, relative) {
    if (!Object.hasOwn(files,relative)) throw new Error('Unsupported data file');
    const url = new URL(relative,new URL(base,location.href));
    if (url.origin !== location.origin) throw new Error('Unsupported data URL');
    const key = url.href;
    let promise = pending.get(key);
    if (!promise) {
      promise = request(relative,url).finally(() => pending.delete(key));
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
