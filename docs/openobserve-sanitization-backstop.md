# OpenObserve Sanitization Backstop

## OpenObserve v0.91.0 Pipeline Behavior

OpenObserve v0.91.0 realtime user pipelines match ingestion records by the full source stream
identity: `org_id`, `stream_type`, and `stream_name`. For the lab RUM streams this means the
pipeline source and stream nodes must use `org_id: "default"` with `stream_type: "logs"` and
`stream_name: "_rumdata"` or `"_rumlog"`.

VRL runtime errors and `abort` are not treated as a fail-closed drop in this version. The pipeline
runtime can return the original row after a VRL failure, so sanitization must avoid relying on VRL
error behavior for privacy guarantees.

The fail-closed model is explicit:

```text
source
-> classify-and-sanitize function
-> condition node allowing only _chicek_drop == false
-> cleanup function
-> destination
```

The classify function never copies raw records into debug fields. It marks high-risk records with
`_chicek_drop = true`; the condition node performs the actual drop; cleanup removes the internal
marker and adds the safe policy version metadata.
