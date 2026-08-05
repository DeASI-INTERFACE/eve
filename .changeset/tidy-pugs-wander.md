---
"eve": patch
---

Instrumentation providers now subscribe to flat lifecycle event names matching each payload's `type`, instead of paired `before`/`after` hooks, and the events for one model attempt are named `step.*` rather than `attempt.*` to match the `agent.step` span they produce. Internal groundwork for a public provider surface; no change to the spans or attributes eve records.
