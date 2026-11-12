"""Ship the core map, styles and climate worker in the Pages HTML response."""

import base64
import gzip
import hashlib
import json
import re


BOOT = r'''
<script type="module">
  const notice = document.getElementById("status");
  const label = document.getElementById("statusText");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "chip";
  retry.style.pointerEvents = "auto";
  retry.textContent = "重试启动";
  retry.onclick = () => location.reload();

  function showFailure(message) {
    notice.classList.remove("hidden");
    notice.classList.add("error");
    notice.querySelector(".spinner")?.classList.add("hidden");
    label.textContent = message;
    if (!retry.isConnected) notice.append(retry);
  }

  async function startAtlas() {
    const external = () => import(__EXTERNAL_ENTRY__);
    const packed = document.getElementById("atlas-startup-code");
    if (!globalThis.DecompressionStream) return external();
    let url;
    try {
      const bytes = Uint8Array.from(atob(packed.textContent.trim()), c => c.charCodeAt(0));
      const source = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const code = await new Response(source).arrayBuffer();
      if (code.byteLength !== Number(packed.dataset.bytes)) throw new Error("Incomplete startup bundle");
      url = URL.createObjectURL(new Blob([code], {type:"text/javascript"}));
    } catch {
      return external();
    }
    try {
      await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  notice.classList.remove("hidden");
  label.textContent = "正在启动地图…";
  const timer = setTimeout(() => showFailure("地图启动超时，请重试。"), 15000);
  try {
    await startAtlas();
    if (retry.isConnected) {
      retry.remove();
      if (label.textContent === "地图启动超时，请重试。") {
        notice.classList.remove("error");
        notice.querySelector(".spinner")?.classList.remove("hidden");
        label.textContent = "正在加载地图…";
      }
    }
  } catch (error) {
    console.error(error);
    showFailure("地图启动失败，请重试。");
  } finally {
    clearTimeout(timer);
  }
</script>
'''

EMBEDDED_WORKER = r'''
function waEmbeddedClimateWorker() {
  const url=URL.createObjectURL(new Blob([waEmbeddedClimateSource],{type:"text/javascript"}));
  const release=()=>URL.revokeObjectURL(url);
  try {
    const worker=new Worker(url,{type:"module"});
    worker.addEventListener("message",release,{once:true});
    worker.addEventListener("error",release,{once:true});
    return worker;
  } catch(error) {
    release();
    throw error;
  }
}
'''


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one startup source match: {old[:100]}")
    return text.replace(old, new, 1)


def scope_module(source, exports):
    source = re.sub(r"^export (?=(?:async )?function\b)", "", source, flags=re.M)
    if re.search(r"^(?:import |export )", source, flags=re.M):
        raise ValueError("Unsupported static dependency in startup bundle")
    return "(()=>{\n" + source + "\nreturn {" + ",".join(exports) + "};\n})()"


def inline_app(app, assets, lite_name, lite_css):
    # The executable bytes come from the HTML's origin. Keep the original
    # asset directory for the optional live worker and climate data URL scope.
    imports = [
        ("atlas-data-*.js", "createAtlasDataReader", "{createAtlasDataReader}", ["createAtlasDataReader"]),
        ("atlas-forecast-*.js", "fetchPointForecast as Rv, readGfsIndex",
         "{fetchPointForecast:Rv,readGfsIndex}", ["fetchPointForecast", "readGfsIndex"]),
    ]
    for pattern, specifier, bindings, exports in imports:
        dependency, = assets.glob(pattern)
        code = scope_module(dependency.read_text(), exports)
        app = replace_once(app, f'import {{{specifier}}} from "./{dependency.name}";',
                           f"const {bindings}={code};")

    lite = (assets / lite_name).read_text()
    link = (
        "  const css = document.createElement('link');\n"
        "  css.rel = 'stylesheet';\n"
        f"  css.href = new URL('{lite_css}', import.meta.url).href;\n"
        "  document.head.append(css);\n"
    )
    lite = replace_once(lite, link, "")
    lite = scope_module(lite, ["startLite"])
    app = replace_once(app,
        f'import(new URL("{lite_name}", import.meta.url).href).then(({{startLite}})=>startLite({{',
        "Promise.resolve().then(()=>waEmbeddedStartLite({")

    adapter, = assets.glob("climate.session.worker-*.js")
    science, = assets.glob("climate.worker-*.js")
    worker = replace_once(adapter.read_text(), f'await import("./{science.name}");',
                          "{\n" + science.read_text() + "\n}")
    app = replace_once(app, 'const worker=new Worker(workerUrl,{type:"module"});',
                       "const worker=waEmbeddedClimateWorker();")

    if app.count("import.meta.url") != 4:
        raise ValueError("Recheck relative module asset URLs")
    app = app.replace("import.meta.url", "waAssetBase")
    if re.search(r"^import\s", app, flags=re.M):
        raise ValueError("Startup still has an external static import")
    return (
        'const waAssetBase=new URL("./assets/",location.href).href;\n'
        f"const {{startLite:waEmbeddedStartLite}}={lite};\n"
        f"const waEmbeddedClimateSource={json.dumps(worker, ensure_ascii=False)};\n"
        + EMBEDDED_WORKER + app
    )


def embed_startup(html, app, assets, entry, lite_name, lite_css):
    code = inline_app(app, assets, lite_name, lite_css).encode("utf-8")
    compressed = base64.b64encode(gzip.compress(code, mtime=0)).decode("ascii")
    packed = (
        f'<script id="atlas-startup-code" type="application/octet-stream" '
        f'data-bytes="{len(code)}" data-sha256="{hashlib.sha256(code).hexdigest()}">'
        f"{compressed}</script>"
    )
    bootstrap = replace_once(BOOT, "__EXTERNAL_ENTRY__", json.dumps(f"./assets/{entry}"))
    html = replace_once(html, f'<script type="module" crossorigin src="./assets/{entry}"></script>',
                        packed + bootstrap)
    sheet = re.compile(r'<link rel="stylesheet"[^>]+href="\./assets/([^/"<>]+\.css)"[^>]*>')
    links = list(sheet.finditer(html))
    if len(links) != 2:
        raise ValueError("Unexpected stylesheet entries in the map HTML")
    css = "\n".join((assets / name).read_text() for name in [*(m.group(1) for m in links), lite_css])
    if re.search(r"</style|@import", css, re.I):
        raise ValueError("Unexpected markup or import in startup styles")
    return sheet.sub("", html, count=len(links)).replace("</head>", f"<style>\n{css}\n</style>\n</head>", 1)
