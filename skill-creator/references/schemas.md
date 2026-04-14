# JSON Schemas

## evals.json
```json
{"skill_name":"name","evals":[{"id":1,"prompt":"prompt","expected_output":"desc","files":[],"expectations":["assertion"]}]}
```

## grading.json
```json
{"expectations":[{"text":"...","passed":true,"evidence":"..."}],"summary":{"passed":0,"failed":0,"total":0,"pass_rate":0.0}}
```

## benchmark.json
```json
{"metadata":{"skill_name":"...","timestamp":"..."},"runs":[{"eval_id":0,"configuration":"with_skill","run_number":1,"result":{"pass_rate":0.0,"passed":0,"total":0}}],"run_summary":{},"notes":[]}
```
