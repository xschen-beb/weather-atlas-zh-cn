// Chinese presentation rules; authoritative geometry is served locally.
function waZhChinaAddress(address) {
  const regions={tw:'台湾省',hk:'香港特别行政区',mo:'澳门特别行政区'};
  const byName={'Taiwan':'台湾省','Republic of China':'台湾省','中华民国':'台湾省','中華民國':'台湾省','台湾':'台湾省','臺灣':'台湾省','台湾省':'台湾省','Hong Kong':'香港特别行政区','香港':'香港特别行政区','Macao':'澳门特别行政区','Macau':'澳门特别行政区','澳门':'澳门特别行政区','澳門':'澳门特别行政区'};
  const region=regions[String(address.country_code||'').toLowerCase()]||byName[address.country];
  return region?{...address,country:'中国',country_code:'cn',state:region}:address;
}
function nv(coastUrl) {
  const style=waBaseMapStyle(coastUrl);
  const regionNames=['Taiwan','Republic of China','Hong Kong','Hong Kong S.A.R.','Macao','Macau','Macau S.A.R','台湾','臺灣','台灣','台湾省','臺灣省','香港','香港特别行政区','香港特別行政區','澳门','澳門','澳门特别行政区','澳門特別行政區'];
  const boundaryNames=[...regionNames,'China','People\'s Republic of China','中国','中華人民共和國','中华人民共和国','CN','TW','HK','MO'];
  const inNames=field=>['match',['coalesce',['get',field],''],regionNames,true,false];
  const isRegion=['any',inNames('name'),inNames('name_en'),inNames('name:en'),['match',['coalesce',['get','iso_a2'],['get','country_code'],''],['TW','HK','MO','tw','hk','mo'],true,false]];
  const box=(west,south,east,north)=>({type:'Polygon',coordinates:[[[west,south],[east,south],[east,north],[west,north],[west,south]]]});
  const regionalAreas={type:'MultiPolygon',coordinates:[box(119.2,21.6,122.2,25.7).coordinates,box(113.45,22.08,114.55,22.65).coordinates]};
  for(const layer of style.layers) {
    if(layer.id==='place-country') layer.filter=['all',layer.filter,['!',isRegion]];
    if(layer.id==='place-state') layer.filter=['all',layer.filter,['!',isRegion]];
    if(layer.id==='boundary-country') layer.filter=['all',layer.filter,
      ...['adm0_l','adm0_r'].map(field=>['!', ['match',['coalesce',['get',field],''],boundaryNames,true,false]]),
      ['!', ['within',regionalAreas]]];
  }
  style.sources['china-map']={type:'geojson',data:new URL('china-map.geojson',coastUrl).href,tolerance:0,maxzoom:14,
    attribution:'中国地图数据：<a href="https://geojson.cn/data/atlas/tiandi">天地图 / GeoJSON.CN</a>'};
  // Insert before labels, keeping borders above both weather and climate fields.
  const insert=style.layers.findIndex(layer=>layer.id==='water-name');
  style.layers.splice(insert,0,
    {id:'china-outline',type:'line',source:'china-map',filter:['==',['get','kind'],'outline'],layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'rgba(45,45,55,0.55)','line-width':['interpolate',['linear'],['zoom'],1,.6,5,1.1,10,2]}},
    {id:'china-maritime-dashes',type:'line',source:'china-map',filter:['==',['get','kind'],'maritime-dashes'],layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'rgba(45,45,55,0.7)','line-width':['interpolate',['linear'],['zoom'],0,.8,5,1.5,10,2]}});
  style.layers.push({id:'china-region-labels',type:'symbol',source:'china-map',minzoom:3,filter:['==',['get','kind'],'region-label'],layout:{'text-field':['get','name'],'text-font':['Noto Sans Regular'],'text-size':['interpolate',['linear'],['zoom'],3,10,7,12],'text-max-width':9,'text-padding':4},paint:{'text-color':'rgba(44,47,51,0.72)','text-halo-color':'rgba(255,255,255,0.85)','text-halo-width':1.3}});
  return style;
}
