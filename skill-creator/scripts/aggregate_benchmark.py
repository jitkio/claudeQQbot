#!/usr/bin/env python3
"""Aggregate run results into benchmark summary."""
import argparse, json, math, sys
from datetime import datetime, timezone
from pathlib import Path

def calc_stats(values):
    if not values: return {"mean":0.0,"stddev":0.0,"min":0.0,"max":0.0}
    n=len(values); mean=sum(values)/n
    stddev=math.sqrt(sum((x-mean)**2 for x in values)/(n-1)) if n>1 else 0.0
    return {"mean":round(mean,4),"stddev":round(stddev,4),"min":round(min(values),4),"max":round(max(values),4)}

def load_runs(d):
    search=d/"runs" if (d/"runs").exists() else d
    results={}
    for ed in sorted(search.glob("eval-*")):
        eid=0
        mp=ed/"eval_metadata.json"
        if mp.exists():
            try: eid=json.loads(mp.read_text()).get("eval_id",0)
            except: pass
        for cd in sorted(ed.iterdir()):
            if not cd.is_dir() or not list(cd.glob("run-*")): continue
            cfg=cd.name
            if cfg not in results: results[cfg]=[]
            for rd in sorted(cd.glob("run-*")):
                gf=rd/"grading.json"
                if not gf.exists(): continue
                try: g=json.loads(gf.read_text())
                except: continue
                r={"eval_id":eid,"run_number":int(rd.name.split("-")[1]),
                   "pass_rate":g.get("summary",{}).get("pass_rate",0),
                   "passed":g.get("summary",{}).get("passed",0),
                   "total":g.get("summary",{}).get("total",0),
                   "time_seconds":g.get("timing",{}).get("total_duration_seconds",0),
                   "tokens":0,"tool_calls":g.get("execution_metrics",{}).get("total_tool_calls",0),
                   "errors":g.get("execution_metrics",{}).get("errors_encountered",0),
                   "expectations":g.get("expectations",[]),"notes":[]}
                tf=rd/"timing.json"
                if r["time_seconds"]==0 and tf.exists():
                    try:td=json.loads(tf.read_text());r["time_seconds"]=td.get("total_duration_seconds",0);r["tokens"]=td.get("total_tokens",0)
                    except:pass
                results[cfg].append(r)
    return results

def aggregate(results):
    summary={}
    configs=list(results.keys())
    for c in configs:
        runs=results.get(c,[])
        if not runs: summary[c]={"pass_rate":calc_stats([]),"time_seconds":calc_stats([]),"tokens":calc_stats([])}; continue
        summary[c]={"pass_rate":calc_stats([r["pass_rate"] for r in runs]),"time_seconds":calc_stats([r["time_seconds"] for r in runs]),"tokens":calc_stats([r.get("tokens",0) for r in runs])}
    if len(configs)>=2:
        a,b=summary.get(configs[0],{}),summary.get(configs[1],{})
        summary["delta"]={"pass_rate":f"{a.get('pass_rate',{}).get('mean',0)-b.get('pass_rate',{}).get('mean',0):+.2f}",
                          "time_seconds":f"{a.get('time_seconds',{}).get('mean',0)-b.get('time_seconds',{}).get('mean',0):+.1f}",
                          "tokens":f"{a.get('tokens',{}).get('mean',0)-b.get('tokens',{}).get('mean',0):+.0f}"}
    return summary

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("benchmark_dir",type=Path)
    p.add_argument("--skill-name",default="")
    args=p.parse_args()
    results=load_runs(args.benchmark_dir)
    summary=aggregate(results)
    runs_list=[]
    for c in results:
        for r in results[c]:
            runs_list.append({"eval_id":r["eval_id"],"configuration":c,"run_number":r["run_number"],
                              "result":{"pass_rate":r["pass_rate"],"passed":r["passed"],"total":r["total"],
                                        "time_seconds":r["time_seconds"],"tokens":r.get("tokens",0)},
                              "expectations":r["expectations"],"notes":r["notes"]})
    benchmark={"metadata":{"skill_name":args.skill_name,"timestamp":datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
               "runs":runs_list,"run_summary":summary,"notes":[]}
    out=args.benchmark_dir/"benchmark.json"
    out.write_text(json.dumps(benchmark,indent=2))
    print(f"Generated: {out}")
