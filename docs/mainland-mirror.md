# 独立静态部署

用 `python3 scripts/build_mainland_mirror.py mainland-dist` 导出发布目录。构建会核验原始运行文件；地图边界、南海线段、城市表及 11 个历史气候变量按原始数据发布。导出目录使用相对路径，可放在域名根目录或站点子目录。

历史气候模式随包提供地形阴影、海岸线、水域、地名和全部气候数据。默认筛选和基础地形无需访问外部地图瓦片、字体或地理编码服务。放大时，地图按需从 [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) 加载更细的海拔，更新地形阴影和气候着色；两条入口都失败时，仍用站内海拔绘制。精细海拔修正只改变显示和地点估计，气候数据的时间范围和空间采样不变。

水域遮罩取自 Natural Earth 的 [海洋](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/) 和 [湖泊](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-lakes/) 数据，只包含水域几何。构建时把范围大或孔洞多的水域分成相接的小面，避免小比例尺下的浏览器瓦片裁切误盖陆地。要重建遮罩，将两个源压缩包保存为 `ne_10m_ocean.zip` 和 `ne_10m_lakes.zip`，用 `python3 scripts/build_water_mask.py <源数据目录> localization/maps/water-mask-v2.json.gz` 生成。

完整版按原图的比例尺显示中文国家、省州和海洋名称、国界和省州界。中国省界与普通省级名称取自已有中国地图数据；其他区域的线和名称取自 Natural Earth，发布前剔除会与中国地图重复的要素。中国轮廓和南海线段仍由原有图层绘制。放大后异步加载 [OpenFreeMap](https://openfreemap.org/) 的高速、干线和主路、河流及细水岸。详细瓦片只绘制交通和水系；瓦片不可用时，显示随站点发布的 Natural Earth 主干路和主要河流。气候筛选独立于这些图层。实时预报仅在选择联网功能时请求预报服务。

要重新生成站内底图，用 `python3 scripts/build_basemap.py <源数据目录>`。将 Natural Earth 的 `ne_10m_roads.zip`、`ne_10m_rivers_lake_centerlines.zip`、`ne_50m_admin_0_countries.zip`、`ne_10m_admin_0_boundary_lines_land.zip`、`ne_10m_admin_1_states_provinces_lines.zip`、`ne_10m_admin_1_states_provinces.zip` 分别保存为 `roads.zip`、`rivers_lake_centerlines.zip`、`countries.zip`、`country-lines.zip`、`state-lines.zip`、`state-areas.zip`。生成器核验源文件的 SHA-256，依赖 pyshp 2.3.1 和 Shapely 2.1.2。

发布首页包含压缩的地图程序、样式、轻量版界面、历史气候和实时预报计算程序。收到首页后，两种模式无需另行下载 JavaScript 或 CSS 文件即可启动；底图和数据仍按需读取。首页无法解压时，可加载本站保留的兼容入口。历史模式不会预先启动实时预报的计算程序。

静态数据优先从本站读取。如果首批数据迟迟没有收到，或请求失败，会尽快尝试备用线路；持续收到数据的慢请求可以继续下载。公开站点的构建可加 `--backup-revision <GitHub 提交 SHA>`，使用 jsDelivr 的 Gcore、Fastly 和默认线路上该提交的相同公开数据。每个文件最多同时进行两次尝试，成功后取消其他尝试。备用请求不携带站点凭证，只在长度和 SHA-256 都匹配时使用。更换数据版本时，应使用包含相同数据的已发布提交重新固定备用版本。未配置备用时仍会重试本站文件。

浏览器无法启动完整地图时会自动打开轻量版，也可在站点网址末尾加 `?map=lite` 直接打开。轻量版提供中国和全球底图、城市搜索、点选及历史气候详情，与完整版共用同一套 ERA5 数据和计算。轻量版也能查看地点天气和未来 24 小时预报；全球预报图层在完整版中。

轻量版会先显示筛选结果及基本气候指标，再加载补充指标。补充下载失败时，可重试并保留已显示的结果。历史数据不覆盖远洋及南极洲的部分位置。

实时天气需联网。地点数据来自 Open-Meteo，展示模式估计及其有效时间；全球图层来自 NOAA GFS。两路可以独立加载。全球图层的下载可在同一 NOAA 数据集的两个公开 S3 入口间重试；地点和图层失败后均会提示重试，不会把历史气候当作当前天气。

## 发布到 GitHub Pages

`gh-pages` 分支的根目录存放发布文件。仓库管理员在 **Settings → Pages** 中选择 **Deploy from a branch**，分支选 **gh-pages**，目录选 **/(root)**，点击 **Save**。发布后的实际网址以仓库 Pages 页给出的地址为准。

## 发布到其他静态托管

将 `mainland-dist/` 内的文件放到托管的发布目录，保持 `assets/` 和 `data/` 的层级。主页为 `index.html`；JavaScript 需以 JavaScript 类型提供，`.bin` 文件按原始字节提供。使用 HTTPS，并且不要将资源请求重定向到登录页。

也可以运行 `python3 scripts/build_standalone_atlas.py mainland-dist weather-atlas-offline.html`，生成可下载的完整地图备用文件。在现代浏览器中打开本地 HTML，即可使用随文件提供的地图与历史数据，无需访问 GitHub Pages。实时天气和更细的地图瓦片仍取决于相应的数据服务。

`mirror-manifest.json` 包含发布文件的 SHA256，可比对线上返回内容。浏览器核验在项目子路径挂载页面，阻断外部脚本和样式文件，检查完整版的默认筛选和轻量版的城市详情，并验证解压失败时的兼容入口。启用正式网址后仍要从中国大陆线路检查真实首页和资源；开发测试不能替代这一步。

浏览器测试使用 [OpenFreeMap 深圳瓦片](https://tiles.openfreemap.org/planet/20261101_080013_pt/10/836/446.pbf)（© OpenMapTiles、© OpenStreetMap contributors，SHA-256 `234120fcda1e28ca1a084913ea8c60568d03110f6b895a9776a24b02f658d568`），检查路网、河流和水岸真实渲染，以及禁止外部瓦片时的本地回退。该固定样本只用于测试，发布站点会读取当前的瓦片目录。
