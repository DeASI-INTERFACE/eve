---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-05"
---

# First-class memory

## Proposal

Memory lets an agent carry useful knowledge across sessions. Unlike conversation history, memory is a durable, scoped collection of claims that the agent can recall, add, revise, and erase.

Declaring a resolved memory collection enables one lifecycle:

```text
before response   collection ---- automatic recall ----> turn context
during response   response model -- remember / forget --> collection
after completion  authored input -------- capture ------> collection
application       trusted outcome -------- direct write --> collection
```

Capture is the automatic ingestion path. It runs after a completed turn and extracts cited durable claims from user-authored input. Without capture, the agent remembers only when the response model chooses to call a tool or application code writes a record.

The proposal treats a collection as one coherent opt-in: automatic recall, model tools, capture, application access, and erasure semantics ship together. Data that should not be mutable by the agent belongs in instructions, RAG, application state, or an external system of record instead.

This document focuses on the authoring model and observable behavior. Exact schemas, error catalogs, workflow machinery, and provider internals are deferred until the product decisions are accepted.

## Questions for review

These are the main decisions this proposal asks the team to evaluate:

| Question                                                  | Proposed direction                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should ordinary conversation create memory automatically? | Yes. A post-turn capture pass learns durable claims that the response model did not explicitly remember.                                                      |
| Should collections expose partial capabilities?           | No. Declaring a collection enables recall, remember, forget, capture, and application access together.                                                        |
| How should memory be partitioned?                         | A scope function returns one ordered tuple of trusted runtime parts. V1 requires an authenticated user principal first and may append channel-provided parts. |
| When may personal memory be disclosed?                    | Only when trusted auth resolves the same principal and the channel attests that the response audience is private to that principal.                           |
| Should application and administrative access ship in V1?  | Yes. Applications need to record trusted outcomes, and operators need subject export, correction, and purge.                                                  |
| Which providers are public in V1?                         | First-party PostgreSQL for production plus explicit local and test providers. A public custom-provider protocol is deferred.                                  |

## What belongs in memory

Memory is for reusable knowledge that should outlive the session but is not the application's source of truth.

| Information                                                      | Owner                                       |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Active-turn and per-session state                                | eve messages, compaction, and `defineState` |
| Conversation archive and transcript search                       | Session/world storage or an application API |
| External documents and product knowledge                         | RAG or a knowledge integration              |
| Cross-session facts, preferences, events, and reusable knowledge | Memory                                      |
| Balances, permissions, order status, and other application truth | Application system of record                |
| Trusted instructions, skills, and autonomous self-modification   | Instructions, skills, and evaluation        |

The core terms are:

- A **collection** is one authored memory file with one purpose, provider, and scope definition. It may contain records for many isolated users and partitions.
- A **record** is one atomic text claim with citations. Replacing its content creates a new revision under the same logical record.
- A **scope tuple** is the ordered set of trusted runtime identities that selects one isolated partition, such as `[principal]` or `[principal, workspace, channel]`.
- A **subject** is the authenticated user represented by the first scope part. Administrative export and purge span every partition for that subject.

V1 does not classify records as facts, preferences, or episodes because those labels do not yet change behavior.

## Authoring experience

### Collection files

An agent may declare one flat collection or a directory of named collections:

```text
agent/memory.ts            # one collection named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # collection named "user"
  preferences.ts           # collection named "preferences"
```

Each module default-exports `defineMemory(...)`. Collection identity comes from its path rather than a `name` field. Local directory-form subagents may declare their own collections; graph-node identity keeps them isolated from the root and from one another.

```ts title="agent/memory.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { memory } from "./lib/memory";

export default defineMemory({
  description: "Stable facts and preferences for the authenticated user.",
  provider: memory,
  scope: byPrincipal(),
});
```

`description` tells the model what belongs in the collection. `provider` chooses persistence. `scope` resolves one partition for the current turn. Declaring the collection enables the complete lifecycle; forget always requires approval.

### Scope

The low-level scope type is a function that returns one ordered tuple of trusted parts or `null`:

```ts
type MemoryScopeDefinition = (context: MemoryScopeContext) => readonly MemoryScopePart[] | null;
```

V1 requires the authenticated user principal as the first part. `byPrincipal()` is sugar for returning `[principal]`. Later parts may partition the user's memory more narrowly.

The contents of `MemoryScopeContext` are intentionally not designed in this proposal. It will expose the trusted principal and some form of channel access for stable, attested parts such as a Slack workspace, channel, or thread. A continuation token is not automatically a scope part because it may be more specific or less stable than the partition the author wants.

Returning `null` leaves the collection unavailable for that turn. Scope parts cannot come from model input or unattested message fields.

## Lifecycle

| Phase                        | Behavior                                                                                    | Why                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Before the response          | eve recalls relevant and recent records into transient turn context.                        | Existing memory must be present before it can improve the response.                            |
| During the model loop        | The model may recall with a new query, remember a claim, revise a claim, or request forget. | Explicit actions provide immediate and deliberate control.                                     |
| After a completed turn       | Capture proposes cited additions, replacements, or no-ops from eligible authored input.     | Routine conversation can create memory without delaying the response.                          |
| During an application action | Trusted code may write the durable outcome directly.                                        | Action results should come from the system that performed the action, not assistant narration. |

### Recall

Automatic recall runs after compaction and before the first response-model request. Its query uses the latest normalized input plus a bounded visible window for references such as “that restaurant.” The result combines relevant and recent records under a turn budget.

The model may also recall later with a new query and optional collection. Omitting the collection searches every resolved collection.

Recalled memories are attributed to their collection and presented as untrusted data. They do not change permissions or approval requirements, and their payloads do not enter durable transcript history. A collection outage does not fail the turn; successful collections still contribute and failures remain distinguishable from an empty result.

### Explicit remember and application writes

Explicit remember is for knowledge that must be durable and visible immediately. The model writes through a collection-bound tool and cites an eligible source quote from the current turn. It revises a claim by addressing the current recalled record; stale revisions conflict rather than overwriting newer knowledge.

Application code can write through scope-bound memory access without a model citation. This is the path for trusted action outcomes such as “the 3pm flight was booked.” The application system remains the source of truth; memory is only a reusable account of the outcome.

### Capture

Capture is a background extraction pass created only by a successfully completed turn. Failed, cancelled, abandoned, deferred, or adapter-consumed turns are not eligible. It pins the exact scope and audience resolved at admission rather than evaluating later auth or channel state.

Capture uses a separate model invocation after the turn. Its configuration surface is deferred until implementation demonstrates a concrete need.

For each eligible collection, the capture invocation compares user-authored input with current memory and proposes an addition, replacement, or no-op with exact citations. eve validates the cited source before committing.

V1 capture excludes assistant output, reasoning, tool traffic, approvals, imported context, and attachments. Assistant or tool output may be attacker-influenced and cannot serve as its own evidence; trusted action outcomes use application writes instead.

Capture does not delay or change the completed response. Its writes are eventually consistent, so the next turn may not see them. Callers needing immediate durability use explicit remember or an application write.

### Forget and purge

Forget removes one logical record and its revisions from every live memory operation. The model-facing forget tool always uses the existing approval flow; if the session cannot request approval, the model must direct the user to an application or administrative surface.

An administrative purge removes every record in the subject's collection across all scope partitions. Erased content cannot return through recall, stale indexes, application reads, or workflow replay.

These are live logical erasure guarantees. Database remnants, replicas, backups, journals, transcripts, telemetry, and model-provider retention remain governed by their own policies.

## Scope and privacy

Long-lived memory creates a cross-session disclosure risk, so model-controlled input never chooses the user principal or response audience.

The principal scope part comes from `auth.current` and requires `principalType: "user"`. Its identity includes the authenticator or issuer and the principal ID; display names, attributes, `subject`, and `auth.initiator` do not define identity. Additional parts from the future channel accessor only partition that principal's storage.

A collection resolves only when its tuple begins with the current principal and the channel attests that every response path is private to that principal. Partitioning personal memory by Slack channel does not make a public Slack reply private; a public destination still leaves the collection unresolved.

Missing required parts, anonymous or non-user auth, a `null` scope result, or a mismatched audience makes recall, tools, capture, and application access unavailable. eve emits content-free diagnostics rather than silently falling back to a broader scope.

The provider namespace also includes stable application, environment, graph-node, and collection-path identity. Redeployments in one environment share memory, while different environments, subagents, collections, and resolved tuples do not. Changing the order or meaning of scope parts requires migration.

V1 excludes shared, anonymous, service, runtime, schedule, and agent-global memory. Shared memory needs a separate disclosure and persisted-prompt-injection design.

## Framework capabilities

### Model capabilities

| Capability | Purpose                                            |
| ---------- | -------------------------------------------------- |
| Recall     | Search one or all resolved collections.            |
| Remember   | Create or replace a cited claim in one collection. |
| Forget     | Erase one recalled record after approval.          |

These are framework-provided, collection-aware operations rather than authored tools. Mutations are collection-bound so the model never supplies a scope. Their exact names, schemas, record references, and errors belong in the implementation contract.

### Application access

Application code needs a scope-bound way to record trusted outcomes during a turn. Subject-facing routes may also need inspection and correction when they can provide matching auth, audience, and scope context. The exact client types and method inventory are deferred until these callers are implemented.

The exact route-facing channel access is likewise deferred with the channel scope API.

Operator-authorized administration addresses a principal rather than impersonating it. It can inspect, correct, export, and purge every partition for that subject in a collection. Operator identity, reason, target, operation, and outcome are audited. The exact administration API is deferred.

## Observable guarantees

- Scope and private audience are revalidated before disclosure; unavailable or invalid memory fails closed.
- Model-proposed writes cite eligible authored text. eve validates citation integrity, while semantic entailment remains an evaluation concern.
- Explicit model and application writes are idempotent, commit before reporting success, and are visible to later steps in the same turn.
- Capture starts only after a completed turn, never changes that turn's outcome, and may become visible later.
- Superseded, erased, and purged records are absent from live operations.
- Canonical records are authoritative. Embeddings and search indexes are rebuildable projections and cannot resurrect stale content.

## Provider strategy

Providers own persistence, within-collection retrieval, projections, readiness, and migration. eve owns public records, scope, citations, model operations, cross-collection behavior, budgets, rendering, and final disclosure validation.

PostgreSQL is the first production provider. Stable application and environment identity are required so deployments cannot accidentally share or split memory. Retrieval, indexing, and deployment preparation are implementation concerns.

An explicit local provider supports persistent development memory, and a deterministic test provider supports isolated tests. Their factory names, storage choices, and control surfaces are deferred. Neither is available in production.

V1 exposes opaque first-party providers only. A public custom-provider API waits for production evidence and a conformance kit.

## Non-goals

- Read-only, write-only, recall-disabled, tool-disabled, or otherwise partial collections.
- A mutable `MEMORY.md`, model-managed memory filesystem, hosted memory service, transcript store, RAG store, or application system of record.
- Capturing assistant output, reasoning, tool payloads, attachments, or imported context.
- Scope tuples without an authenticated user principal, multiple simultaneous tuples for one collection in a turn, or implicit sharing.
- Tags, typed record kinds, profiles, graph relations, confidence, autonomous inference, decay, or instruction modification.
- Public custom extractor, embedder, or provider interfaces.
- Physical sanitization guarantees for database remnants, replicas, backups, journals, transcripts, logs, telemetry, or model-provider retention.

## Deferred implementation work

Follow-up implementation plans should define exact tool and client schemas, error codes, handles, cursors, limits, normalization, source envelopes, checkpoint and replay machinery, canonical tables, provider conformance, PostgreSQL indexing and migration, and local inspection commands. Those details must satisfy the observable guarantees above without expanding the V1 product surface.

## Primary references

- [Supermemory: how it works](https://supermemory.ai/docs/concepts/how-it-works)
- [Zep context types](https://help.getzep.com/context-types.md)
- [Graphiti](https://github.com/getzep/graphiti)
- [Mem0: how memory works](https://docs.mem0.ai/core-concepts/how-it-works)
- [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [AI SDK embeddings](https://ai-sdk.dev/docs/ai-sdk-core/embeddings)
- [PostgreSQL full-text search](https://www.postgresql.org/docs/current/textsearch-indexes.html)
- [pgvector](https://github.com/pgvector/pgvector)
- [eve project layout](../docs/reference/project-layout.md)
- [eve state](../docs/guides/state.md)
- [eve turn execution](../packages/eve/src/execution/workflow-steps.ts)
