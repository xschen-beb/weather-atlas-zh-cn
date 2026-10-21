from pathlib import Path
from datetime import date,timedelta
import re,csv,json,math,statistics
ROOT=Path('extract'); OUT=Path('out-fast'); OUT.mkdir(exist_ok=True); station='58349'
def qc_ok(q): return str(q)=='0'
def tv(v):
    try:x=int(v)
    except:return None
    return None if x==32766 else x/10
def pv(v):
    try:x=int(v)
    except:return None
    if x==32766:return None
    if x==32700:return 0.05
    if 32000<=x<=32999:return (x-32000)/10
    if 31000<=x<=31999:return (x-31000)/10
    if 30000<=x<=30999:return (x-30000)/10
    return x/10
temp={}; pre={}; nt=np=0
for p in ROOT.rglob('*TEM-12001-*.TXT'):
    m=re.search(r'(\d{6})\.TXT$',p.name)
    if not m or not 1991<=int(m.group(1)[:4])<=2020:continue
    for line in p.open(encoding='gb18030',errors='ignore'):
        a=line.split()
        if len(a)<13 or a[0]!=station:continue
        d=date(*map(int,a[4:7])); nt+=1
        temp[d]={'tmean_c':tv(a[7]) if qc_ok(a[10]) else None,'tmax_c':tv(a[8]) if qc_ok(a[11]) else None,'tmin_c':tv(a[9]) if qc_ok(a[12]) else None,'qc_tmean':a[10],'qc_tmax':a[11],'qc_tmin':a[12]}
for p in ROOT.rglob('*PRE-13011-*.TXT'):
    m=re.search(r'(\d{6})\.TXT$',p.name)
    if not m or not 1991<=int(m.group(1)[:4])<=2020:continue
    for line in p.open(encoding='gb18030',errors='ignore'):
        a=line.split()
        if len(a)<13 or a[0]!=station:continue
        d=date(*map(int,a[4:7])); np+=1
        pre[d]={'prcp_mm':pv(a[9]) if qc_ok(a[12]) else None,'qc_prcp':a[12],'trace_precip':int(a[9]=='32700' and qc_ok(a[12]))}
dates=sorted(set(temp)|set(pre)); rows=[]
for d in dates:
    t=temp.get(d,{}); p=pre.get(d,{})
    rows.append({'date':d.isoformat(),'year':d.year,'mmdd':d.strftime('%m-%d'),'tmean_c':t.get('tmean_c'),'tmax_c':t.get('tmax_c'),'tmin_c':t.get('tmin_c'),'qc_tmean':t.get('qc_tmean'),'qc_tmax':t.get('qc_tmax'),'qc_tmin':t.get('qc_tmin'),'prcp_mm':p.get('prcp_mm'),'qc_prcp':p.get('qc_prcp'),'trace_precip':p.get('trace_precip')})
def write(path,rows):
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
write(OUT/'suzhou_58349_1991_2020_daily_qc0.csv',rows)
b={}
for r in rows:
    z=b.setdefault(r['mmdd'],{k:[] for k in ['tmean_c','tmax_c','tmin_c','prcp_mm']})
    for k in z:
        if r[k] is not None:z[k].append(float(r[k]))
def mean(x):return statistics.fmean(x) if x else None
def q(x,p):
    if not x:return None
    s=sorted(x);u=(len(s)-1)*p;a=math.floor(u);c=math.ceil(u);return s[a] if a==c else s[a]*(c-u)+s[c]*(u-a)
agg=[];d=date(2000,1,1)
while d<=date(2000,12,31):
    mm=d.strftime('%m-%d');z=b.get(mm,{k:[] for k in ['tmean_c','tmax_c','tmin_c','prcp_mm']});pr=z['prcp_mm']
    agg.append({'mmdd':mm,'n_tmean':len(z['tmean_c']),'mean_tmean_c':mean(z['tmean_c']),'p10_tmean_c':q(z['tmean_c'],.1),'p90_tmean_c':q(z['tmean_c'],.9),'n_tmax':len(z['tmax_c']),'mean_tmax_c':mean(z['tmax_c']),'n_tmin':len(z['tmin_c']),'mean_tmin_c':mean(z['tmin_c']),'n_prcp':len(pr),'mean_prcp_mm':mean(pr),'wet_day_pct':sum(x>=.1 for x in pr)/len(pr)*100 if pr else None,'trace_or_wet_pct':sum(x>0 for x in pr)/len(pr)*100 if pr else None,'heavy10_pct':sum(x>=10 for x in pr)/len(pr)*100 if pr else None,'heavy25_pct':sum(x>=25 for x in pr)/len(pr)*100 if pr else None});d+=timedelta(days=1)
write(OUT/'suzhou_58349_1991_2020_mmdd_climatology.csv',agg)
meta={'source':'CMA SURF_CLI_CHN_MUL_DAY_V3.0 via Zenodo 20025511','station':'58349','period':'1991-2020','temperature_rows':nt,'precip_rows':np,'merged_rows':len(rows),'date_min':rows[0]['date'] if rows else None,'date_max':rows[-1]['date'] if rows else None,'n_tmean_min_nonleap':min(r['n_tmean'] for r in agg if r['mmdd']!='02-29'),'n_tmean_max_nonleap':max(r['n_tmean'] for r in agg if r['mmdd']!='02-29'),'n_prcp_min_nonleap':min(r['n_prcp'] for r in agg if r['mmdd']!='02-29'),'n_prcp_max_nonleap':max(r['n_prcp'] for r in agg if r['mmdd']!='02-29'),'feb29_tmean':next(r['n_tmean'] for r in agg if r['mmdd']=='02-29'),'feb29_prcp':next(r['n_prcp'] for r in agg if r['mmdd']=='02-29')}
(OUT/'metadata.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8');print('META',json.dumps(meta,ensure_ascii=False));print('FIRST5',json.dumps(agg[:5],ensure_ascii=False))