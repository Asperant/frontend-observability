# OpenObserve Sanitization Backstop

## OpenObserve v0.91.0 Pipeline Behavior

OpenObserve v0.91.0 realtime user pipelines match ingestion records by the full source stream
identity: `org_id`, `stream_type`, and `stream_name`. For the lab RUM streams this means the
pipeline source and stream nodes must use `org_id: "default"` with `stream_type: "logs"` and
`stream_name: "_rumdata"` or `"_rumlog"`.

VRL runtime errors and `abort` are not treated as a fail-closed drop in this version. The pipeline
runtime can return the original row after a VRL failure, so sanitization must avoid relying on VRL
error behavior for privacy guarantees.

The fail-closed model is explicit and matches the pipeline exactly as deployed by
[`scripts/lab/provision-sanitization.mjs`](../scripts/lab/provision-sanitization.mjs):

```text
source
-> classify-and-sanitize   (function node)
-> allow-sanitized         (condition node: _chicek_drop == false)
-> correlation-normalize   (function node, Stage 10)
-> cleanup                 (function node)
-> destination
```

The classify function never copies raw records into debug fields. It marks high-risk records with
`_chicek_drop = true`. The `allow-sanitized` condition node is the actual fail-closed backstop:
only records where `_chicek_drop == false` are allowed to continue past it, so anything the
classify step flagged is dropped there, before any node downstream of it ever sees the record.

`correlation-normalize` (added in Stage 10, frontend correlation) runs _after_ the drop condition,
on records that have already been judged safe. It re-validates and normalizes the
`chicek.correlation.*` fields for query use; it has no `_chicek_drop`-setting logic of its own and
cannot re-admit a record the condition node already dropped. It is not part of the security
boundary — `allow-sanitized` is — and its presence does not change the Stage 9 security invariant:
unsafe records never reach a stream a client or dashboard query can read.

`cleanup` runs last: it removes the internal `_chicek_drop` marker and adds the safe policy version
metadata, so nothing pipeline-internal leaks into the record actually written to the destination
stream.

As stated above, this design does not rely on VRL `abort` behavior as a fail-closed mechanism —
the `allow-sanitized` condition node's routing is the only thing this project treats as
security-relevant here. A VRL runtime error in any function node is assumed to potentially return
the original (unsanitized) row rather than abort the pipeline, which is exactly why the drop
decision is enforced by a condition node the record must pass through, not by trusting that a
classify/cleanup function failure stops the row.
