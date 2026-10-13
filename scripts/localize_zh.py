#!/usr/bin/env python3
"""Rebuild the Chinese runtime from the preserved, immutable upstream snapshot."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
LOCALE = ROOT / "localization"


def literal(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def main() -> None:
    original = (ROOT / "upstream/index-Dx2OKNjk.js").read_text()
    boundary = original.index('const iv="hillshade"')
    vendor, app = original[:boundary], original[boundary:]
    counts = {}

    def patch(old: str, new: str, *, required: bool = True) -> None:
        nonlocal app
        count = app.count(old)
        if required and not count:
            raise RuntimeError(f"Upstream localization target missing: {old[:120]}")
        app = app.replace(old, new)
        counts[old[:120]] = count

    # Localize descriptions, never decoder keys, condition IDs, or high/low directions.
    patch('v:"dew",group:"Sky & air",label:"Humidity"', 'v:"dew",group:"Sky & air",label:"露点温度"')
    patch('id:"precip",label:"Precipitation"', 'id:"precip",label:"降水强度"')
    patch('v:"precip",group:"Rain & wind",label:"Precipitation"', 'v:"precip",group:"Rain & wind",label:"日降水量"')
    patch('ae("Precipitation",pe)', 'ae(R.pop!==void 0?"降水概率 / 降水量":"降水强度",pe)')
    patch('return/^en-(US|LR)|^my\\b/.test(N)?"imperial":"metric"', 'return"metric"')

    weather = '''function Og(N,I=!0){const A={
      0:["晴",I?"☀️":"🌙"],1:["晴间少云",I?"🌤️":"🌙"],2:["多云",I?"⛅":"☁️"],3:["阴", "☁️"],
      45:["雾","🌫️"],48:["雾（伴有雾凇）","🌫️"],
      51:["弱毛毛雨",I?"🌦️":"🌧️"],53:["中等毛毛雨","🌧️"],55:["强毛毛雨","🌧️"],
      56:["弱冻毛毛雨","🌧️"],57:["强冻毛毛雨","🌧️"],61:["小雨",I?"🌦️":"🌧️"],63:["中雨","🌧️"],65:["大雨","🌧️"],
      66:["弱冻雨","🌧️"],67:["强冻雨","🌧️"],71:["小雪","🌨️"],73:["中雪","🌨️"],75:["大雪","❄️"],77:["雪粒","🌨️"],
      80:["弱阵雨",I?"🌦️":"🌧️"],81:["中等阵雨","🌧️"],82:["强阵雨","🌧️"],85:["弱阵雪","🌨️"],86:["强阵雪","🌨️"],
      95:["雷暴","⛈️"],96:["雷暴伴冰雹","⛈️"],97:["强雷暴","⛈️"],99:["雷暴伴强冰雹","⛈️"]
    },R=A[N];return R?{label:R[0],icon:R[1]}:{label:"—",icon:"·"}}'''
    og_start = app.index('function Og(')
    og_end = app.index('function kv(', og_start)
    patch(app[og_start:og_end], weather)

    # These functions return display descriptions. Keep the original threshold values.
    patch('function Zv(N){return N<2?"calm":N<12?"light air":N<29?"breezy":N<39?"windy":N<62?"very windy":"stormy"}',
          'function Zv(N){return N<2?"近乎无风":N<12?"微风":N<29?"有风":N<39?"风较大":N<62?"风很大":"强风"}')
    patch('function Wv(N){return N<10?"clear":N<35?"mostly clear":N<70?"partly cloudy":N<90?"mostly cloudy":"overcast"}',
          'function Wv(N){return N<10?"晴朗":N<35?"晴间少云":N<70?"多云":N<90?"云量较多":"阴天"}')
    sensations = '"dry":j<16?"comfortable":j<20?"humid":j<24?"muggy":"oppressive"'
    patch(sensations, '"较干燥":j<16?"较舒适":j<20?"较湿润":j<24?"闷湿":"闷湿难耐"')
    patch('function sx(N){return N<10?"dry":N<16?"comfortable":N<20?"humid":N<24?"muggy":"oppressive"}',
          'function sx(N){return N<10?"较干燥":N<16?"较舒适":N<20?"较湿润":N<24?"闷湿":"闷湿难耐"}')
    patch('function ax(N){return N<3?"low":N<6?"moderate":N<8?"high":N<11?"very high":"extreme"}',
          'function ax(N){return N<3?"低":N<6?"中等":N<8?"高":N<11?"很高":"极高"}')
    patch('function Hv(N){return N<3?"low":N<6?"moderate · sunscreen":N<8?"high · cover up midday":N<11?"very high · avoid midday sun":"extreme · stay in shade"}',
          'function Hv(N){return N<3?"低":N<6?"中等 · 注意防晒":N<8?"高 · 正午注意遮护":N<11?"很高 · 避开正午日晒":"极高 · 尽量待在阴凉处"}')
    dp_start = app.index('Dp={')
    dp_end = app.index('},Jv=', dp_start) + 1
    dp = app[dp_start:dp_end]
    short_reasons = {"cold":"冷","hot":"热","warm":"暖","dry":"干","humid":"湿",
                     "clear":"少云","cloudy":"多云","dull":"少日照","sunny":"多日照",
                     "wet":"多雨","calm":"弱风","windy":"强风","thin":"少积雪",
                     "deep":"深积雪","sea":"海温","dark":"短昼","long":"长昼"}
    for old, new in short_reasons.items():
        dp = dp.replace(literal(old), literal(new))
    patch(app[dp_start:dp_end], dp)

    translations = json.loads((LOCALE / "zh-CN.json").read_text())
    translated_literals = {}
    for old, new in translations.items():
        count = app.count(literal(old))
        if count:
            patch(literal(old), literal(new))
            translated_literals[old] = count

    templates = [
      ('Loading ${this.layer.label.toLowerCase()}…', '正在加载${this.layer.label}…'),
      ('Could not load GFS data: ${pe.message}', 'GFS 数据加载失败：${waZhError(pe.message)}'),
      ('${j.label} type', '${j.label}类型'),
      ('Run ${R.date.slice(0,4)}-${R.date.slice(4,6)}-${R.date.slice(6)} ${String(R.hour).padStart(2,"0")}Z · downscaled to terrain',
       '起报时间：${R.date.slice(0,4)}年${R.date.slice(4,6)}月${R.date.slice(6)}日 ${String(R.hour).padStart(2,"0")}:00 UTC · 已按当地地形修正'),
      ('Forecast unavailable: ${De.message}', '天气预报暂不可用：${waZhError(De.message)}'),
      (' · ${Math.round(Te)} m', ' · 海拔 ${Math.round(Te)} 米'),
      ('H ${Ht("temp",c.max)}  L ${Ht("temp",c.min)}', '最高 ${Ht("temp",c.max)}　最低 ${Ht("temp",c.min)}'),
      ('Feels ${Ht("temp",R.feels)}', '体感 ${Ht("temp",R.feels)}'),
      (' · gusts ${Ht("speed",R.gust,!1)}', ' · 阵风 ${Ht("speed",R.gust)}'),
      ('${c.sun.toFixed(1)} h', '${c.sun.toFixed(1)} 小时'),
      ('Point forecast: Open-Meteo (best model for this spot)${L?` · times in ${L.replace(/_/g," ")}`:""}. Map: NOAA GFS.',
       '地点预报：Open-Meteo（按地点自动选择预报模式）${L?`；时间采用${waZhTimeZone(L)}`:""}。地图预报：NOAA GFS。'),
      ('${L.label.toLowerCase()} ${N.dir==="high"?"高于":"低于"} ${j}', '${L.label}${N.dir==="high"?"高于":"低于"}${j}'),
      ('About 1 day in ${Math.max(2,Math.round(365/L))}', '约每 ${Math.max(2,Math.round(365/L))} 天有 1 天符合条件'),
      ('About ${Math.round(L/365*100)}% of days', '约 ${Math.round(L/365*100)}% 的日子符合条件'),
      ('${A} · best in ${bg(R)}', '${A} · ${bg(R)}最适宜'),
      ('${oe.label} all year', '全年${oe.label}'),
      ('${oe.label} in ${Qv(oe.a,oe.b)}', '${Qv(oe.a,oe.b)}${oe.label}'),
      ('Usually ${bg(ae)}.', '常见限制：${bg(ae)}。'),
      ('${N.slice(0,-1).join(", ")} and ${N[N.length-1]}', '${N.slice(0,-1).join("、")}和${N[N.length-1]}'),
      ('Chance of a matching day through the year; ${Math.round(N.perYear)} days a year in all', '全年符合条件的概率变化；估计每年共有 ${Math.round(N.perYear)} 天符合条件'),
      ('${Math.round(Q.frac*100)}% of ${hr[gi]} days ${Dp[Q.v][Q.dir][0]}', '${hr[gi]}约 ${Math.round(Q.frac*100)}% 的样本日${Dp[Q.v][Q.dir][0]}'),
      ('${$c(ft)}: ${Math.round(Te[ft]*100)}% chance of a matching day', '${$c(ft)}：符合条件的概率约为 ${Math.round(Te[ft]*100)}%'),
      ('${hr[j]}: ${Math.round(R)} of ${Ar[j]} days match your conditions (${Math.round(R/Ar[j]*100)}%)', '${hr[j]}：估计 ${Ar[j]} 天中约 ${Math.round(R)} 天符合筛选条件（${Math.round(R/Ar[j]*100)}%）'),
      ('Temperature ${N}', '气温 ${N}'),
      ('${hr[j]}: the afternoon feels like ${I(R)}${N.slice(1)} on average', '${hr[j]}：平均午后体感温度 ${I(R)}${N.slice(1)}'),
      ('${hr[j]}: average daytime high ${I(R)}${N.slice(1)}', '${hr[j]}：日间最高温度的平均值 ${I(R)}${N.slice(1)}'),
      ('${hr[j]}: average overnight low ${I(R)}${N.slice(1)}', '${hr[j]}：夜间最低温度的平均值 ${I(R)}${N.slice(1)}'),
      ('${hr[j]}: dew point ${I(R)}${N.slice(1)}, ${sx(R)}', '${hr[j]}：平均露点温度 ${I(R)}${N.slice(1)}，${sx(R)}'),
      ('${hr[j]}: ${R.toFixed(1)} hours of sunshine a day', '${hr[j]}：平均每日有 ${R.toFixed(1)} 小时日照'),
      ('${hr[j]}: UV index peaks around ${Math.round(R)} (${ax(R)})', '${hr[j]}：日最高紫外线指数的平均值约为 ${Math.round(R)}（${ax(R)}）'),
      ('${hr[j]}: ${Math.round(R)} days with little cloud (25% or less)', '${hr[j]}：约 ${Math.round(R)} 天的平均云量不超过 25%'),
      ('${hr[j]}: ${Math.round(R)} days with ${Ht("precip",1)} or more of rain or snow', '${hr[j]}：约 ${Math.round(R)} 天的降水量达到 ${Ht("precip",1)}（含雨、雪水当量）'),
      ('Total ${A}', '总量（${A}）'),
      ('${hr[j]}: ${Ht("precip",R)} of rain and melted snow in all', '${hr[j]}：估计月降水总量为 ${Ht("precip",R)}（含雨、雪水当量）'),
      ('${hr[j]}: snow on the ground on ${Math.round(R)} days', '${hr[j]}：约 ${Math.round(R)} 天有地面积雪'),
      ('Wind ${dl("speed")}', '风速（${dl("speed")}）'),
      ('${hr[j]}: strongest daytime wind ${Ht("speed",R)} on average', '${hr[j]}：白天最大持续风速的平均值 ${Ht("speed",R)}'),
      ('${hr[j]}: nearby sea ${I(R)}${N.slice(1)}', '${hr[j]}：附近海域的平均海表温度 ${I(R)}${N.slice(1)}'),
      ('Blend of ${N.cells} nearby ERA5 grid cells, mainly the one at', '由附近 ${N.cells} 个 ERA5 格点加权得到，主要格点位于'),
      ('ERA5 grid cell at', 'ERA5 格点位于'),
      ('° (avg. ${N.cellElev} m); temperatures shifted ${L>=0?"+":"−"}${Math.abs(L).toFixed(1)}° for this spot.',
       '°（平均海拔 ${N.cellElev} 米）；此处温度已按海拔差修正 ${L>=0?"+":"−"}${Math.abs(L).toFixed(1)}°。'),
      ("From 25 years of weather (ERA5 reanalysis, 2001–2025): one real day for each date, from nearby ~100 km grid cells, with temperatures adjusted to this spot's elevation (${Math.round(Ui.imperial?I*3.281:I)} ${Ui.imperial?\"ft\":\"m\"}). Hover a cell or the chart for details.",
       '基于 ERA5 2001—2025 年再分析数据：每个日历日期选取一个真实历史日，共 365 个样本日。附近格点约为百公里尺度；温度已按此处海拔（${Math.round(Ui.imperial?I*3.281:I)} ${Ui.imperial?"英尺":"米"}）修正。将鼠标移至表格或图表可查看详情。'),
      ('Downloading 25 years of weather history… ${(I/1e6).toFixed(1)} / ${(L/1e6).toFixed(1)} MB', '正在下载历史气候样本… ${(I/1e6).toFixed(1)} / ${(L/1e6).toFixed(1)} MB'),
      ('Climate data unavailable: ${I.message}', '气候数据暂不可用：${waZhError(I.message)}'),
      ('Query failed: ${j.message}', '筛选计算失败：${waZhError(j.message)}'),
      ('Remove ${I.label}', '移除${I.label}条件'),
      ('${P} days/yr', '${P} 天/年'),
      ('Live forecast unavailable: ${R.message}', '实时预报暂不可用：${waZhError(R.message)}'),
      ('${Math.round(I)} d', '${Math.round(I)} 天'),
      ('${Math.round(fe*3.281)} ft', '${Math.round(fe*3.281)} 英尺'),
      ('${Math.round(fe)} m', '${Math.round(fe)} 米'),
      ('chance around ${$c(this.doy)}', '${$c(this.doy)}前后符合条件的概率'),
      ('+ Clouds, humidity, UV, wind, snow & sea (${Fe.toFixed(1)} MB)', '+ 查看云量、露点、紫外线、风速、积雪及海温（${Fe.toFixed(1)} MB）'),
      ('Could not load: ${Ee.message}', '数据加载失败：${waZhError(Ee.message)}'),
      ('Live data unavailable: ${A.message}', '实时数据暂不可用：${waZhError(A.message)}'),
      ('Error: ${N.message}', '加载失败：${waZhError(N.message)}'),
      ('Near ${P.name}', '${P.name}附近'),
    ]
    for old, new in templates:
        patch(old, new)

    old_note = "Per year / By date: ERA5 reanalysis, 2001–2025, one real day per calendar day at every 1° land cell, in local solar time. Right now: the latest NOAA GFS forecast, comparing current temperatures and the current precipitation rate. Temperatures are adjusted to the local terrain (−6.5 °C per km)."
    patch(literal(old_note), literal('历史统计使用 ERA5 2001—2025 年再分析数据：每个 1° 陆地格点按日历日期各选取一个历史日，共 365 个样本日，日指标按当地太阳时计算。“实时匹配”使用最新 NOAA GFS 预报；其中降水条件按当前降水强度折算为 24 小时等效量，并非实际日累计降水量。温度按当地地形海拔修正（每升高 1 千米降低 6.5℃）。'))
    patch('precip:{v:"precip",kind:2,soft:.25}', 'precip:{v:"precip",kind:2,soft:.25,label:"降水强度（折算日量）"}')
    patch('return be("div",{class:"cond",title:I.hint}', 'return be("div",{class:"cond",title:this.mode==="now"&&I.v==="precip"?"当前降水强度乘以 24 小时的等效量，并非实际日累计降水量":I.hint}')

    # Preserve numeric hourly logic: Chinese formatted hours contain 时 and cannot be parsed by Number().
    patch('Number(Dh(Te,L,{hour:"numeric",hourCycle:"h23"}))===0', 'waZhHour(Te,L)===0')
    patch('toLocaleDateString(void 0,', 'toLocaleDateString("zh-CN",')
    patch('toLocaleTimeString(void 0,', 'toLocaleTimeString("zh-CN",')
    patch('toLocaleString(void 0,', 'toLocaleString("zh-CN",')
    patch('...L,timeZone:I', '...L,hour12:!1,timeZone:I')
    patch('toLocaleString("zh-CN",L)', 'toLocaleString("zh-CN",{...L,hour12:!1})')
    patch('hour:"numeric",minute:L.getMinutes()?"2-digit":void 0', 'hour:"2-digit",minute:"2-digit",hour12:!1')
    patch('const L=I>=0?"N":"S"', 'const L=I>=0?"北纬":"南纬"')
    patch('const R=A>=0?"E":"W"', 'const R=A>=0?"东经":"西经"')
    patch('`${Math.abs(I).toFixed(2)}°${L}, ${A.toFixed(2)}°${R}`', '`${L}${Math.abs(I).toFixed(2)}°，${R}${A.toFixed(2)}°`')
    patch('Qe.textContent=Fe[0]', 'Qe.textContent=String(Ke+1)')
    patch('es.forEach(R=>L.append(be("th",{scope:"col"},R[0])))', 'es.forEach((R,j)=>L.append(be("th",{scope:"col","aria-label":R},String(j+1))))')
    patch('ce=je=>je.length*5.2<=ft-Qe+4', 'ce=je=>Array.from(je).reduce((a,c)=>a+(/[\\u3400-\\u9fff]/.test(c)?9.5:5.2),0)<=ft-Qe+4')
    patch('A=Ui.imperial?"in":"mm";return[{title:', 'A=Ui.imperial?"英寸":"毫米";return[{title:')
    units_start = app.index('function dl(')
    units_end = app.index('function Ht(', units_start)
    units = app[units_start:units_end]
    for en, zh in {"mph":"英里/小时","km/h":"千米/小时","in":"英寸","mm":"毫米","in/h":"英寸/小时","mm/h":"毫米/小时","cm":"厘米","h":"小时"}.items():
        units = units.replace(literal(en), literal(zh))
    patch(app[units_start:units_end], units)

    patch('Ep=["coalesce",["get","name:en"],["get","name_en"],["get","name"]]',
          'Ep=["coalesce",["get","name:zh-Hans"],["get","name:zh"],["get","name_zh"],["get","name"]]')
    patch('accept-language=en', 'accept-language=zh-CN')
    patch('"text-transform":"uppercase"', '"text-transform":"none"')
    patch('"text-letter-spacing":.2', '"text-letter-spacing":.04')
    patch('"text-letter-spacing":.12', '"text-letter-spacing":.02')
    patch('"text-letter-spacing":.15', '"text-letter-spacing":.03')
    patch('elev:L[7]??null}))}', 'elev:L[7]??null,aliases:[L[8],L[9],L[10]].filter(Boolean)}))}')
    patch('if(Ns=0,N.length<2)', 'if(Ns=0,N.length<(/[\\u3400-\\u9fff]/.test(N)?1:2))')
    search_old = 'const I=Na.filter(A=>Rh(A.name).startsWith(N)),L=Na.filter(A=>!Rh(A.name).startsWith(N)&&Rh(`${A.name} ${A.country}`).includes(N));Qn=[...I,...L].slice(0,8)'
    patch(search_old, 'Qn=waZhCityMatches(Na,N).slice(0,8)')
    patch('hash:"map",attributionControl:!1', 'hash:"map",locale:waZhMapLocale,localIdeographFontFamily:"PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif",attributionControl:!1')
    patch('Terrain: <a ', '地形：<a ')
    for en, zh in {'Map forecast:':'地图预报：','Point forecasts:':'地点预报：','Places:':'地名：','Climate:':'历史气候：','Copernicus ERA5':'哥白尼 ERA5',' via <a':'，经 <a'}.items():
        patch(en, zh)

    helpers = r'''
const waZhMapLocale={"Map.Title":"天气与气候地图","AttributionControl.ToggleAttribution":"显示或隐藏数据来源","AttributionControl.MapFeedback":"地图反馈","NavigationControl.ZoomIn":"放大地图","NavigationControl.ZoomOut":"缩小地图","NavigationControl.ResetBearing":"地图朝向恢复正北"};
function waZhError(message){const text=String(message||"");if(/WebGL/i.test(text))return"浏览器需要支持 WebGL 2 才能显示地图";if(/abort|cancel/i.test(text))return"请求已取消";if(/checksum|corrupt|bad .*file/i.test(text))return"数据校验失败，请刷新后重试";if(/HTTP\s*(\d+)/i.test(text))return`服务器返回状态码 ${text.match(/HTTP\s*(\d+)/i)[1]}`;if(/No recent GFS|cycle/i.test(text))return"未找到近期可用的预报批次";if(/network|fetch|load failed|timeout/i.test(text))return"网络请求失败，请检查连接后重试";if(/unsupported|not supported/i.test(text))return"浏览器或数据格式暂不支持此功能";return"暂时无法完成请求，请稍后重试"}
function waZhHour(t,zone){try{return Number(new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",hourCycle:"h23",timeZone:zone}).formatToParts(new Date(t)).find(p=>p.type==="hour").value)}catch{return new Date(t).getHours()}}
function waZhTimeZone(zone){try{return new Intl.DateTimeFormat("zh-CN",{timeZone:zone,timeZoneName:"longGeneric"}).formatToParts(new Date()).find(p=>p.type==="timeZoneName").value}catch{return"该地点的当地时间"}}
function waZhCityMatches(cities,query){const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();const needle=norm(query);const first=[],other=[];for(const city of cities){const names=[city.name,...(city.aliases||[])];if(names.some(name=>norm(name).startsWith(needle)))first.push(city);else if(norm([city.name,city.country,...(city.aliases||[])].join(" ")).includes(needle))other.push(city)}return[...first,...other]}
'''
    app = helpers + app
    patch('function nv(N){', 'function waBaseMapStyle(N){')
    patch('const ee=c??P.county', 'P=waZhChinaAddress(P);const ee=c??P.county')
    app = (LOCALE / "map-style.js").read_text() + '\n' + app

    digest = hashlib.sha256((vendor + app).encode()).hexdigest()[:12]
    bundle = f"index-zh-CN-{digest}.js"
    for old in (DIST / "assets").glob('index-*.js'):
        old.unlink()
    (DIST / "assets" / bundle).write_text(vendor + app)

    html = (ROOT / "upstream/index.html").read_text()
    html_map = {'lang="en"':'lang="zh-CN"','<title>Weather Atlas</title>':'<title>天气与气候地图</title>',
                'Live global weather and a historical climate finder: discover where and when the weather matches what you like.':'全球天气与历史气候筛选：查看哪些地区、哪些日期符合你的天气偏好。',
                'aria-label="Weather map"':'aria-label="天气与气候地图"','aria-label="Mode"':'aria-label="地图模式"',
                '>Climate finder<':'>气候筛选<','>Live weather<':'>实时天气<',
                'placeholder="Search a city"':'placeholder="搜索城市（中文或英文）"','aria-label="Search a city"':'aria-label="搜索城市（中文或英文）"',
                'title="Switch units"':'title="切换公制与英制单位"','aria-label="Switch units"':'aria-label="切换公制与英制单位"',
                'title="Globe view"':'title="切换地球视图"','aria-label="Toggle globe view"':'aria-label="切换地球视图"',
                'aria-label="Controls"':'aria-label="筛选与图层控制"','aria-label="Show controls"':'aria-label="显示控制面板"',
                '>☰ Controls<':'>☰ 控制面板<','./assets/index-Dx2OKNjk.js':'./assets/'+bundle}
    for old, new in html_map.items():
        if old not in html:
            raise RuntimeError(f"HTML localization target missing: {old}")
        html = html.replace(old, new)
    html = html.replace('</head>', '    <link rel="stylesheet" href="./assets/zh-CN.css">\n  </head>')
    (DIST / "index.html").write_text(html)

    cities = json.loads((ROOT / "upstream/cities.json").read_text())
    names = json.loads((LOCALE / "city-names.zh-CN.json").read_text())["records"]
    countries = json.loads((LOCALE / "country-names.zh-CN.json").read_text())
    assert len(names) == len(cities["rows"])
    for row, item in zip(cities["rows"], names):
        assert row[0] == item["name_en"] and row[1] == item["country_en"]
        old_name, old_country = row[:2]
        row[0], row[1] = item["name_zh"], countries[old_country]
        if old_country in {"Taiwan", "Hong Kong S.A.R.", "Macau S.A.R"}:
            row[6] = 0  # These cities are not national capitals.
            row.extend([old_name, "China", old_country])
        else:
            row.extend([old_name, old_country, ""])

    cities["fields"].extend(["name_en", "country_en", "region_en"])
    (DIST / "data/cities.json").write_text(json.dumps(cities, ensure_ascii=False, separators=(',', ':')) + '\n')
    (DIST / "assets/zh-CN.css").write_text((LOCALE / "zh-CN.css").read_text())

    active = {"language":"zh-CN","origin":"https://weather.theojaffee.net/", "files":[]}
    for file in sorted(DIST.rglob('*')):
        if file.is_file():
            data = file.read_bytes()
            active["files"].append({"path":file.relative_to(DIST).as_posix(),"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    (ROOT / "active-manifest.json").write_text(json.dumps(active, ensure_ascii=False, indent=2) + '\n')
    report = {"language":"zh-CN","translated_literal_count":len(translated_literals),
              "template_and_context_patch_count":len(counts),"cities":len(names),"countries_regions":len(countries),
              "bundle":bundle,"upstream_bundle_sha256":hashlib.sha256(original.encode()).hexdigest()}
    (ROOT / "localization-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
