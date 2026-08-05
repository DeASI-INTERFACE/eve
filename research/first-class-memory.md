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

Capture is the automatic ingestion path. It runs after a completed turn and extracts durable claims from user-authored input. Without capture, the agent remembers only when the response model chooses to call a tool or application code writes a record.

The proposal treats a collection as one coherent opt-in: automatic recall, model tools, capture, application access, and erasure semantics ship together. Data that should not be mutable by the agent belongs in instructions, RAG, application state, or an external system of record instead.

This document focuses on the authoring model, provider boundary, and observable behavior. Exact error catalogs, workflow machinery, and provider-specific implementation details are deferred until the product decisions are accepted.

## Questions for review

These are the main decisions this proposal asks the team to evaluate:

| Question                                                     | Proposed direction                                                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should ordinary conversation create memory automatically?    | Yes. A post-turn capture pass learns durable claims that the response model did not explicitly remember.                                                                                              |
| Should a resolved collection separate read and write access? | No in V1. Resolving a collection enables recall, remember, forget, and capture together. Recall-only contexts are a plausible future need, but this proposal does not introduce per-operation policy. |
| Should model-facing forget require approval?                 | Open. V1 defines erasure behavior independently from whether the product requires confirmation or approval before invoking it.                                                                        |
| How should memory be partitioned?                            | A scope function returns one ordered tuple of opaque, trusted runtime identifiers. The tuple is only a partition key; its parts have no built-in ownership, privacy, or audience semantics.           |
| Can the model choose a different scope?                      | No. eve resolves and locks each collection's scope for the turn. Automatic recall, model operations, and capture can access only that partition.                                                      |
| Should application and administrative access ship in V1?     | Yes. Applications need to record trusted outcomes, and operators need partition-level inspection, correction, export, and purge.                                                                      |
| Can authors implement custom providers in V1?                | Yes. `MemoryProvider` is a public V1 extension point. eve ships PostgreSQL for production plus explicit local and test providers, while other providers implement the same contract.                  |

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

- A **collection** is one authored memory file with one purpose, provider, and scope definition. It may contain records for many isolated partitions.
- A **record** is one atomic text claim with an eve-assigned origin: `capture`, `model`, or `application`. Replacing its content creates a new revision under the same logical record.
- A **scope tuple** is the ordered composite key that selects one isolated partition. Its parts are opaque, stable identifiers obtained from trusted runtime context, such as `[userId, channelId]` or `[workspaceId]`.

Origin answers how the current revision was created without claiming that the record is correct or authoritative. Capture considers only user-authored input from a completed turn, but that restriction is an internal lifecycle rule rather than durable evidence attached to the record. Model writes may still be mistaken, user input may be incorrect, and application-written memory remains a reusable account rather than the application's system of record. All recalled memory is therefore untrusted data regardless of origin.

V1 does not classify records as facts, preferences, or episodes because those labels do not yet change behavior.

## Authoring experience

### Collection files

An agent may declare one flat collection or a directory of named collections:

```text
agent/memory.ts            # one collection named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # collection named "user"
  workspace.ts             # collection named "workspace"
```

Each module default-exports `defineMemory(...)`. Collection identity comes from its path rather than a `name` field. `user.ts` and `workspace.ts` may use the same provider while their collection paths and resolved tuples keep their records isolated. Local directory-form subagents may declare their own collections; graph-node identity keeps them isolated from the root and from one another.

```ts title="agent/memory/user.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { memory } from "../lib/memory";

export default defineMemory({
  description: "Stable facts and preferences for the current user.",
  provider: memory,
  scope: byPrincipal(),
});
```

`description` tells the model what belongs in the collection. `provider` chooses persistence. `scope` resolves one partition for the current turn. Declaring the collection enables the complete lifecycle.

The imported `memory` value is a `MemoryProvider`. An application can use the PostgreSQL provider shipped by eve or implement the public provider contract described below. Collection definitions do not configure storage or retrieval themselves.

### Scope

The low-level scope type is a function that returns one ordered tuple of opaque, trusted identifiers or `null`:

```ts
type MemoryScopeDefinition = (context: MemoryScopeContext) => readonly MemoryScopePart[] | null;
```

Scope parts have no built-in entity types, and no position has special meaning. `[userId, channelId]` means only that both values identify the partition. `byPrincipal()` is sugar for the common single-part tuple using the current authenticated principal; this proposal does not name other helpers.

Scope resolves independently for each collection. On one Slack turn, `user.ts` could resolve `[userId, channelId]` while `workspace.ts` resolves `[workspaceId]`; both collections can participate in that turn without sharing records.

The contents of `MemoryScopeContext` are intentionally not designed in this proposal. It will expose stable identifiers from trusted runtime context and some form of channel access for values such as a Slack workspace, user, channel, or thread. Memory does not interpret those values. A continuation token is not automatically a scope part because it may be more specific or less stable than the partition the author wants.

Returning `null` leaves the collection unavailable for that turn. Scope parts cannot come from model input or unattested message fields.

## Lifecycle

| Phase                        | Behavior                                                                                    | Why                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Before the response          | eve recalls relevant and recent records into transient turn context.                        | Existing memory must be present before it can improve the response.                            |
| During the model loop        | The model may recall with a new query, remember a claim, revise a claim, or request forget. | Explicit actions provide immediate and deliberate control.                                     |
| After a completed turn       | Capture proposes additions, replacements, or no-ops from that turn's user-authored input.   | Routine conversation can create memory without delaying the response.                          |
| During an application action | Trusted code may write the durable outcome directly.                                        | Action results should come from the system that performed the action, not assistant narration. |

### Recall

Automatic recall runs after compaction and before the first response-model request. Its query uses the latest normalized input plus a bounded visible window for references such as “that restaurant.” The result combines relevant and recent records under a turn budget.

The model may also recall later with a new query and optional collection. Omitting the collection searches every resolved collection.

Recalled memories are attributed to their collection and presented as untrusted data. They do not change permissions, and their payloads do not enter durable transcript history. A collection outage does not fail the turn; successful collections still contribute and failures remain distinguishable from an empty result.

### Explicit remember and application writes

Explicit remember is for knowledge that must be durable and visible immediately. The model writes a claim through a collection-bound tool. It revises a claim by addressing the current recalled record; stale revisions conflict rather than overwriting newer knowledge. eve marks these revisions with the `model` origin.

Application code can write through scope-bound memory access. This is the path for trusted action outcomes such as “the 3pm flight was booked.” eve marks these revisions with the `application` origin, but the application system remains the source of truth; memory is only a reusable account of the outcome.

### Capture

Capture is a background extraction pass created only by a successfully completed turn. Failed, cancelled, abandoned, deferred, or adapter-consumed turns are not eligible. It uses the exact collection scopes locked for the completed turn rather than resolving them again against later runtime state.

Capture uses a separate model invocation after the turn. Its configuration surface is deferred until implementation demonstrates a concrete need.

For each eligible collection, the capture invocation compares user-authored input with current memory and proposes an addition, replacement, or no-op. eve marks committed revisions with the `capture` origin.

V1 capture excludes assistant output, reasoning, tool traffic, imported context, and attachments. This prevents assistant- or tool-produced content from becoming durable automatically. Trusted action outcomes use application writes instead.

Capture does not delay or change the completed response. Its writes are eventually consistent, so the next turn may not see them. Callers needing immediate durability use explicit remember or an application write.

### Forget and purge

Forget removes one logical record and its revisions from every live memory operation.

An administrative purge removes every record in the addressed collection partition. Broader administrative selectors are separate from the scope tuple and deferred. Erased content cannot return through recall, stale indexes, application reads, or workflow replay.

These are live logical erasure guarantees. Database remnants, replicas, backups, journals, transcripts, telemetry, and model-provider retention remain governed by their own policies.

## Scope and isolation

Long-lived memory creates a cross-session disclosure risk, so model-controlled input never chooses scope parts.

Scope parts come from trusted auth, application, or channel context and include enough authority to remain stable and collision-free. Display names and model-visible attributes do not define them. The memory system treats every part as an opaque identifier rather than inferring whether it represents a user, workspace, channel, or another entity.

eve resolves each collection's scope from the admitted turn and locks it for that turn. Automatic recall, model operations, and capture use only the locked collection and tuple; their schemas never accept an alternate scope. A tuple does not itself express ownership, access policy, or response audience.

Missing required parts or a `null` scope result makes that collection unavailable. eve emits content-free diagnostics rather than silently falling back to a different partition.

The provider namespace also includes stable application, environment, graph-node, and collection-path identity. Redeployments in one environment share memory, while different environments, subagents, collections, and resolved tuples do not. Changing the order or meaning of scope parts requires migration.

Collection authors decide what a partition represents through the collection's purpose and scope definition. Shared memory remains origin-labeled and untrusted, and must never become an instruction or permission source. V1 still excludes memory without an explicit scope tuple.

## Framework capabilities

### Model capabilities

| Capability | Purpose                                 |
| ---------- | --------------------------------------- |
| Recall     | Search one or all resolved collections. |
| Remember   | Create or replace a claim.              |
| Forget     | Erase one recalled record.              |

These are framework-provided, collection-aware operations rather than authored tools. Mutations are collection-bound so the model never supplies a scope. Their exact names, schemas, record references, and errors belong in the implementation contract.

### Application access

Application code needs a scope-bound way to record trusted outcomes during a turn. Routes outside a bound turn may also need partition-level inspection and correction after independently authorizing the caller and resolving the target tuple. The exact client types and method inventory are deferred until these callers are implemented.

The exact route-facing channel access is likewise deferred with the channel scope API.

Operator-authorized administration can inspect, correct, export, and purge an addressed collection partition without impersonating a turn. Operator identity, reason, target, operation, and outcome are audited. Broader selectors and the exact administration API are deferred.

## Observable guarantees

- Each model operation remains bound to the collection scopes locked for its turn; unavailable or invalid scope fails closed.
- eve records whether each revision was created by capture, an explicit model operation, or application code. Origin is informational and does not establish correctness or authority.
- Explicit model and application writes are idempotent, commit before reporting success, and are visible to later steps in the same turn.
- Capture starts only after a completed turn, never changes that turn's outcome, and may become visible later.
- Superseded, erased, and purged records are absent from live operations.
- Canonical records are authoritative. Embeddings and search indexes are rebuildable projections and cannot resurrect stale content.

## Provider contract

`MemoryProvider` is a public V1 extension point. eve ships a PostgreSQL provider, but a collection can use any conforming provider. The provider owns canonical persistence and retrieval within one collection partition. eve owns collection discovery, trusted scope resolution, origin assignment, model operations, cross-collection behavior, budgets, rendering, and final disclosure validation.

The public contract should have this shape; exact field names and error types will be fixed by the implementation plan:

```ts
type MemoryOrigin = "capture" | "model" | "application";

interface MemoryRecord {
  readonly id: string;
  readonly revision: string;
  readonly content: string;
  readonly origin: MemoryOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MemoryProviderPartition {
  /** Stable, collision-resistant value created by eve. */
  readonly key: string;
}

interface MemoryProviderRequest {
  /** Framework-created stable storage key; providers treat it as opaque. */
  readonly partition: MemoryProviderPartition;
  readonly signal: AbortSignal;
}

interface MemoryProvider {
  ready(input: MemoryProviderRequest): Promise<void>;

  recall(
    input: MemoryProviderRequest & { readonly query: string; readonly limit: number },
  ): Promise<{ readonly records: readonly MemoryRecord[]; readonly truncated: boolean }>;
  get(input: MemoryProviderRequest & { readonly recordId: string }): Promise<MemoryRecord | null>;
  list(
    input: MemoryProviderRequest & { readonly cursor?: string; readonly limit: number },
  ): Promise<{
    readonly records: readonly MemoryRecord[];
    readonly cursor?: string;
  }>;

  write(
    input: MemoryProviderRequest & {
      readonly operationId: string;
      readonly content: string;
      readonly origin: MemoryOrigin;
      readonly replace?: {
        readonly recordId: string;
        readonly expectedRevision: string;
      };
    },
  ): Promise<MemoryRecord>;
  erase(
    input: MemoryProviderRequest & {
      readonly operationId: string;
      readonly recordId: string;
      readonly expectedRevision?: string;
    },
  ): Promise<{ readonly erased: boolean }>;
  purge(input: MemoryProviderRequest & { readonly operationId: string }): Promise<void>;
}
```

Every operation receives an opaque partition key produced by eve from stable application, environment, graph-node, collection-path, and resolved-scope identity. It also receives an abort signal and operation-specific limits or deadlines. The model and authored application code never construct the partition key.

`recall` receives a plain-text query and returns ranked current records. `get` and `list` provide canonical reads for application access, validation, inspection, and export. `write` creates or replaces a record and receives the content, eve-assigned origin, an eve-assigned operation ID for idempotency, and the expected revision when replacing a record. `erase` removes one logical record and its revisions; `purge` removes the addressed partition. Provider record IDs, revision tokens, and cursors pass through eve but remain semantically opaque.

A provider must implement:

- durable canonical records and read-your-writes behavior;
- strict isolation by the supplied partition key;
- atomic replacement using the expected revision;
- idempotent mutation replay using the supplied operation key;
- bounded ranked recall plus canonical `get` and paginated `list` reads;
- live erasure and purge barriers that prevent stale work or indexes from restoring content;
- readiness, cancellation, bounded inputs and outputs, and stable unavailable-versus-empty behavior.

Provider-specific deployment APIs may add schema migration, index preparation, backfill, or operational controls. The runtime `ready` method checks that the provider can safely serve the active configuration; eve does not require every provider to use a database or have a migration phase. Public provider conformance tests exercise the observable semantics above without prescribing a storage or retrieval architecture.

Custom providers use an eve helper that validates and brands the implementation:

```ts title="agent/lib/memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { store } from "./store";

export const memory = defineMemoryProvider({
  async ready(input) {
    await store.assertReady(input);
  },
  async recall(input) {
    return await store.recall(input);
  },
  async get(input) {
    return await store.get(input);
  },
  async list(input) {
    return await store.list(input);
  },
  async write(input) {
    return await store.write(input);
  },
  async erase(input) {
    return await store.erase(input);
  },
  async purge(input) {
    return await store.purge(input);
  },
});
```

The helper does not implement storage. It gives eve a stable protocol boundary while leaving the database, hosted memory service, or other backend entirely to the provider.

### Embeddings and vectors

eve neither requires nor creates embeddings or vectors. On write, eve gives the provider canonical record text. On recall, eve gives the provider a plain-text query. The provider decides whether and when to create embeddings, where to store vectors, and how to rank results.

A provider may use SQL filtering, full-text search, embeddings, a vector database, hybrid retrieval, an external memory service, or another strategy. It may embed records synchronously on write, asynchronously after write, lazily, or not at all. Embedding models, credentials, dimensions, preprocessing, vector indexes, backfills, cost, and query-embedding failures are provider-owned concerns. They do not appear in `defineMemory` or the base `MemoryProvider` contract.

Embeddings and search indexes are derived projections. Canonical records and revisions remain authoritative, and a provider must not return superseded, erased, or purged content through a stale projection. A retrieval or query-embedding failure is reported as unavailable rather than as an empty result.

### First-party providers

PostgreSQL is eve's production provider. Stable application and environment identity are required so deployments cannot accidentally share or split memory. Provider-specific options may configure PostgreSQL retrieval, including embeddings and vector indexing, without adding those concepts to the framework contract:

```ts title="agent/lib/memory.ts"
import { pgDatabase, postgresMemory } from "eve/memory/postgres";
import { pool } from "./database";

export const memory = postgresMemory({
  database: pgDatabase(pool),
  embedding: {
    model: "openai/text-embedding-3-small",
    dimensions: 1536,
  },
});
```

An explicit local provider supports persistent development memory without embeddings, and a deterministic test provider supports isolated tests. Their factory names, storage choices, and control surfaces are implementation details. Neither is available in production. Their existence demonstrates that conformance depends on memory behavior, not on vectors or a specific retrieval algorithm.

## Non-goals

- Read-only, write-only, recall-disabled, tool-disabled, or otherwise partial collections.
- A mutable `MEMORY.md`, model-managed memory filesystem, eve-operated hosted memory service, transcript store, RAG store, or application system of record. A custom provider may connect to an external memory service.
- Capturing assistant output, reasoning, tool payloads, attachments, or imported context.
- Memory without an explicit scope tuple, multiple simultaneous tuples for one collection in a turn, or implicit sharing between collections.
- Tags, typed record kinds, profiles, graph relations, confidence, autonomous inference, decay, or instruction modification.
- Framework-level custom extractor or standalone embedder interfaces. Providers may expose their own provider-specific extraction or embedding configuration.
- Physical sanitization guarantees for database remnants, replicas, backups, journals, transcripts, logs, telemetry, or model-provider retention.

## Implementation contract follow-up

Before V1 implementation lands, follow-up plans must define exact tool, client, and provider schemas; error codes; handles; cursors; limits; normalization; checkpoint and replay machinery; canonical tables; the provider conformance suite; PostgreSQL indexing and migration; and local inspection commands. Those details must satisfy the observable guarantees above without expanding the V1 product surface.

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
