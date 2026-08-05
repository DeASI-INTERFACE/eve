---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-05"
---

# First-class memory

## Summary

Memory lets an agent carry useful knowledge across sessions. Unlike conversation
history, memory is a durable, subject-scoped collection of claims that the agent
can recall, add, revise, and erase.

Declaring a resolved memory collection enables the complete memory lifecycle:

1. **Recall** finds relevant existing memories before a response and through a
   model tool.
2. **Remember** creates or revises a memory when the model or application knows
   something should persist.
3. **Capture** examines accepted user-authored input after a completed turn and
   extracts cited durable claims for future turns.
4. **Forget** erases a record, while an administrative purge erases the
   subject's entire collection.

Capture is the automatic ingestion path. Without it, an agent remembers only
when the response model happens to call `memory_remember` or application code
writes a record. Routine facts and preferences would therefore be lost even
though the user clearly stated them. Capture closes that gap without delaying
or changing the response: it runs after the turn completes, considers only
eligible authored input, and must cite the text supporting every proposed
memory.

```text
before response   collection ---- automatic recall ----> turn context
during response   response model -- remember / forget --> collection
after completion  authored input -------- capture ------> collection
application       trusted outcome ------ MemoryClient --> collection
```

A collection is one coherent capability. There are no read-only, write-only,
tools-off, or recall-disabled variants. Capture has no feature flag, although a
collection's `prepareSource` hook may skip any source. Data that should not be
mutable by the agent belongs in instructions, RAG, application state, or an
external system of record instead.

eve owns the slot grammar, trusted scope derivation, lifecycle, canonical public
model, context rendering, and first-party provider integration. Applications
own credentials, databases, stable environment identity, deployment
preparation, retention, and operator authorization.

## What belongs in memory

Memory is for reusable knowledge that should outlive the session but is not the
application's source of truth. This boundary prevents the memory store from
becoming a transcript database, knowledge base, or authorization system.

| Information                                                      | Owner                                       |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Active-turn and per-session state                                | eve messages, compaction, and `defineState` |
| Conversation archive and transcript search                       | Session/world storage or an application API |
| External documents and product knowledge                         | RAG or a knowledge integration              |
| Cross-session facts, preferences, events, and reusable knowledge | Memory                                      |
| Balances, permissions, order status, and other application truth | Application system of record                |
| Trusted instructions, skills, and autonomous self-modification   | Instructions, skills, and evaluation        |

One memory file defines a **collection**: one purpose, provider, and subject
scope. A collection may hold records for many isolated subjects; a `user`
collection is not itself one user. Records are atomic text claims with optional
occurrence time, expiry, and citations. V1 does not label records as facts,
preferences, or episodes because those labels do not yet change behavior.

The design makes these commitments:

- Trusted runtime identity determines the subject. Model input never selects a
  scope, and memory is disclosed only to a channel-attested private audience.
- Application, environment, graph node, collection path, and subject jointly
  isolate storage while allowing redeployments in one environment to share it.
- Recall is bounded, attributed, treated as untrusted data, and transient to the
  current turn.
- Model-proposed writes cite eligible source text. eve verifies the citation;
  whether the claim is semantically entailed remains an evaluation concern.
- Writes are idempotent and read-your-writes. Automatic capture starts only
  after a completed turn and never changes that turn's outcome.
- Erased content cannot reappear through recall, replay, stale indexes, or
  application reads. Canonical state is authoritative; embeddings and indexes
  are rebuildable projections.

## Authoring API

The author chooses only the collection's purpose, persistence provider, and
scope. Declaring it opts into automatic recall, capture, and all memory tools;
forget always requires approval.

### Slot grammar

```text
agent/memory.ts            # one collection named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # collection named "user"
  preferences.ts           # collection named "preferences"
```

Each module default-exports `defineMemory(...)`. Identity comes from the path,
so there is no `name` field. The named directory is non-recursive and accepts
modules only; shared code belongs in `agent/lib/`. Invalid nesting and
flat-file/directory collisions fail discovery.

Collection slugs use lowercase snake case (`[a-z][a-z0-9_]*`) and are at most
48 characters. This keeps generated mutation tool names within eve's
64-character tool-name limit. Authored tools may not collide with
`memory_recall` or generated `memory_remember_*` and `memory_forget_*` names.

Local directory-form subagents may declare the same slot. Their graph node ID
namespaces each collection, so subagents do not share memory implicitly. The
built-in `agent` tool uses the root node's collections. Single-file and remote
subagents do not own local memory slots.

### Collection definition

```ts title="agent/memory.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { memory } from "./lib/memory";

export default defineMemory({
  description: "Stable facts and preferences for the authenticated user.",
  provider: memory,
  scope: byPrincipal(),
});
```

`description` tells the model what belongs in the collection. `provider`
chooses persistence. `scope` determines the subject from trusted runtime
identity. `MemoryProvider` and `MemoryScopeDefinition` are opaque eve values.

V1 exposes no custom provider, scope resolver, extractor, embedder, tag schema,
collection weight, tool toggle, or token-budget API.

### Capture configuration

The optional `capture` block tunes automatic extraction; omitting it uses eve's
defaults. It does not turn capture on.

```ts
capture: {
  model: "anthropic/claude-sonnet-5",
  reasoning: "low",
  instructions: "Prefer durable preferences over one-time requests.",
  prepareSource(text) {
    return redactSensitiveText(text);
  },
},
```

| Option          | Purpose                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | Pins a capture-only Gateway model ID or AI SDK `LanguageModel`. Dynamic selection is not allowed because replay must use one durable model choice. Omission uses the agent's compiled static model. |
| `reasoning`     | Sets capture reasoning effort. It inherits the agent setting only when capture also uses the agent model.                                                                                           |
| `modelOptions`  | Sets capture provider options. When capture uses the agent model, omission inherits the agent's options and an explicit value replaces them. An overridden model inherits no options.               |
| `instructions`  | Adds collection-specific guidance without expanding eligible sources, bypassing citations, or weakening limits.                                                                                     |
| `prepareSource` | Minimizes or redacts one normalized source for this collection. Returning `null` skips its capture.                                                                                                 |

`prepareSource` receives trusted collection, source, time, auth, and abort
context. Its result affects only capture; it does not change response input,
automatic recall, or citations made by the explicit remember tool. Returning
`null` unconditionally is the sanctioned way to run a collection without
automatic capture while preserving explicit and application writes.

## Memory lifecycle

The lifecycle separates retrieving knowledge, deliberately changing it, and
learning opportunistically from completed turns. That separation gives callers
a fast response path, a guaranteed write path when needed, and a best-effort
automatic path for ordinary conversation.

### Recall: make existing memory useful

Recall supplies relevant cross-session context. Merely storing records would
not help the agent unless eve retrieved them at the right time and clearly
distinguished them from trusted instructions.

Automatic recall runs after compaction and before the first response-model
request. Its query combines the latest normalized input with a bounded visible
window for references such as “that restaurant.” It selects relevant and recent
records under one wall-clock and token budget, then renders a length-delimited
data block with collection, purpose, handle, revision time, and available
citation. A fixed trusted instruction labels the block as untrusted data.
Memory content does not change eve's permission or approval gates, although
stored prompt injection can still influence model behavior.

The model can also call `memory_recall` later in the turn with a new query,
optional collection, occurrence-time range, and result limit. Omitting the
collection searches every resolved collection using eve-owned rank fusion,
diversity, deterministic tie-breaking, and a cumulative per-turn budget.

Recall is availability-tolerant but disclosure-strict. A failed collection
contributes only a sanitized `deadline_exceeded` or `unavailable` status while
successful collections still return results. If all automatic recall fails,
the response still runs with an outage status rather than pretending the
subject has no memories. If all explicit recall fails, the tool returns
`memory_recall_unavailable` so the model can react.

Before every eve-owned model request, eve revalidates scope, purge generation,
expiry, definition, and exact canonical revisions. Retrieval projections may
nominate candidates, but cannot resurrect superseded, expired, erased, or
purged content. Recalled payloads live only in the transient turn overlay, not
durable transcript history.

### Explicit remember: guarantee a write

Explicit remember is for knowledge that must be available immediately or whose
durability is part of the current task. It avoids waiting for capture and makes
the new value visible to later model steps in the same turn.

The model writes through a collection-bound tool, so it never chooses the
subject or write scope. A proposed memory must quote an eligible normalized
source handle from the current turn. To revise a record, the model supplies the
current memory handle as `supersedes`; stale handles conflict rather than
overwriting newer knowledge.

Application code can create and revise records without a model citation because
it is already inside the trusted application boundary. A revision is a full
replacement under the same logical record ID and requires the expected current
revision. Both model and application mutations are idempotent, commit before
reporting success, and provide read-your-writes behavior.

### Capture: learn from ordinary conversation

Capture is a post-turn extraction workflow. It exists so a user can say “I am
vegetarian” naturally without also asking the agent to remember it or relying
on the response model to decide that a memory tool call is warranted.

For each collection resolved when the turn begins, capture proceeds as follows:

1. A durable `completed` turn checkpoint records the accepted authored source
   IDs. Failed, cancelled, abandoned, deferred, or adapter-consumed turns are
   ineligible.
2. `prepareSource` minimizes or rejects each source for that collection.
3. The pinned capture model compares the prepared text with current canonical
   memory and proposes an add, supersede, or no-op with exact citations.
4. eve validates source hashes, citation offsets, bounds, purge generation, and
   revision expectations before committing the proposal idempotently.

Capture retains the subject and private audience sealed at turn admission; it
never resolves later background work against new auth. A revision conflict
causes a new proposal against fresh canonical state rather than a blind write
retry.

V1 accepts only authored inbound text. It excludes assistant output, imported
threads, channel/client context, instructions, reasoning, tool traffic,
approvals, attachments, abandoned attempts, and uncommitted output. This keeps
attacker-influenced assistant or tool output from becoming its own evidence.

Action outcomes such as “the agent booked the 3pm flight” therefore use an
application write from the tool that performed the action. Application truth
still belongs in its system of record; the memory is only a reusable account of
the outcome.

Capture runs after the response settles and transient failures are retried. It
cannot fail or alter the completed response, and V1 provides no polling or
freshness barrier. The next turn may not see a captured claim yet. Callers that
need immediate durability use explicit remember or an application write.

Capture preserves source order. A delayed older turn may add a historical event
but cannot supersede state learned from a newer source. Replays reuse the same
source IDs and exact proposal receipt; definition, purge-generation, or
provider-incarnation changes make stale work obsolete rather than redirecting
it to a new store.

### Forget and purge: make memory reversible

Memory must support correction and deletion because it stores personal,
model-generated knowledge. `memory_forget` erases one logical record and always
uses the existing tool-approval flow. If the session cannot request approval,
the tool returns `memory_approval_unavailable`; it does not park or fail the
turn. Applications may erase through a subject-bound client, while trusted
operator workflows may purge the subject's entire collection.

Forget removes the record, every revision, and revision-owned evidence from all
live operations. Purge is the complete operation when semantically duplicated
claims may exist. Payload-free erasure receipts and generation barriers remain
long enough to prevent workflow or idempotency replay from recreating content.
A replay against erased content returns only `erased` or `purged`.
The remaining receipts contain no memory payload, but are still pseudonymous
operational data governed by retention policy.

This is a live logical unreachability guarantee, not a promise to sanitize MVCC
pages, WAL, replicas, backups, workflow journals, transcripts, telemetry, or
model-provider retention. Restoring an older database requires replaying a
separately retained erasure ledger before serving traffic.

## Model tools

Tools let the response model search beyond automatic context and deliberately
manage memory during a turn. They are framework operations rather than ordinary
authored tools, so declaring a collection always contributes the full set.

| Tool                                                | Important inputs                                                                         | Result                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `memory_recall`                                     | Query, optional collection and occurrence range, limit.                                  | Memories, sanitized per-collection failures, and whether the result was truncated.              |
| `memory_remember` or `memory_remember_<collection>` | Content, source handle and quote, optional occurrence/expiry time and superseded handle. | `created` or `revised` with the live record; replay after erasure returns `erased` or `purged`. |
| `memory_forget` or `memory_forget_<collection>`     | Current memory handle.                                                                   | `erased` or `purged`.                                                                           |

The flat slot uses unsuffixed mutation names; directory collections use their
collection suffix. Mutation tools are collection-bound. Model-facing records
contain a signed short-lived handle rather than a canonical ID, plus collection,
content, observation and optional occurrence/expiry times, and citation quotes.

Every normalized authored source is shown to the model with a source handle.
Remember accepts a quote only when it occurs in that source. Recalled memory,
assistant output, imported context, and tool results are not eligible evidence.
`supersedes` and forget handles must identify the current revision in the same
sealed scope.

Expected failures have stable codes:

| Code                          | Meaning                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `memory_handle_expired`       | Recall again to obtain a fresh handle.                                               |
| `memory_revision_conflict`    | The referenced revision or purge generation is stale.                                |
| `memory_handle_invalid`       | The handle is malformed, tampered with, or belongs to another scope.                 |
| `memory_citation_invalid`     | The source handle or quote failed validation.                                        |
| `memory_approval_unavailable` | The session cannot request forget approval; use an application or admin surface.     |
| `memory_recall_unavailable`   | Every selected collection failed; the result includes sanitized collection failures. |

Model mutations use checkpointed operation IDs. Exact replay returns the
original result while it remains live, changed input conflicts, and a later
abandoned response does not roll back an already committed mutation. Durable
history stores payload-free call/result placeholders; validated transient turn
state supplies live memory content.

## Application control

Application access covers cases the model should not own: recording successful
tool actions, building subject data views, correcting records, and satisfying
export or erasure requests. Applications use eve clients rather than accessing
providers directly, preserving the same scope and revision semantics as model
tools.

`ctx.getMemory(collection)` returns a subject-bound `MemoryClient` for the
current graph node. An unknown collection throws; a collection unresolved for
the current principal returns `null`. The client supports `recall`, `get`,
`list`, `remember`, and `forget`. The subject binding is sealed into the client,
including mutations, so it cannot be redirected by method input.

| Operation  | Input and behavior                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `recall`   | Query, optional occurrence range, and limit; returns records plus a truncation flag.                   |
| `get`      | Record ID; returns the current live record or `null`.                                                  |
| `list`     | Optional cursor and limit; returns one ordered page of live records.                                   |
| `remember` | New content, or record ID plus expected revision and replacement content; requires an idempotency key. |
| `forget`   | Record ID and optional expected revision; requires an idempotency key.                                 |

```ts
const memory = await ctx.getMemory("user");

await memory?.remember({ content: "The 3pm flight was booked." }, { idempotencyKey: bookingId });
```

Route handlers can enumerate root and local-subagent collection descriptors,
then acquire one of two clients:

- `getMemory({ address, auth, audience })` requires verified subject auth and a
  matching private-audience attestation. It returns `null` when that auth does
  not resolve the collection.
- `getMemoryAdmin({ address, principal, operator })` is the explicit trusted
  operator path. It never impersonates the subject, requires the application to
  authorize the operator, and records operator fingerprint, reason, target,
  operation, and outcome.

The admin client adds snapshot export and full-scope purge, but not semantic
recall. Aggregate subject export and purge enumerate collections and acquire an
admin client for each. Node IDs and public record IDs, revision tokens, handles,
and cursors are opaque; applications obtain node addresses from enumeration
rather than constructing them.

An admin principal address supplies an authenticator, optional issuer, and
principal ID. It must match the same exact authority tuple used when the record
was written; there is no fuzzy or cross-authority lookup. Unknown collection
addresses and malformed principal addresses throw rather than returning
`null`.

Observable client semantics are:

- Corrections replace the full record and require its ID plus expected
  revision. Forget may optionally require an expected revision.
- Application writes need no model citation, but bounds, encoding, and expiry
  rules still apply.
- `recall`, `get`, and `list` exclude expired records. `list` orders live records
  by observation time descending, then record ID ascending.
- Idempotency keys bind scope, method, and normalized request. Changed input
  returns `idempotency_conflict`; replay after erasure is payload-free.
- Cursors bind collection, scope, purge generation, snapshot, and order. Invalid,
  expired, wrong-scope, or pre-purge cursors return `invalid_cursor`.
- Export reads one snapshot. Concurrent forget or purge invalidates it; only a
  clean iterator completion means the export is complete.
- Expected failures expose a stable `MemoryOperationError` name, machine code,
  and retryability rather than provider errors. Only sanitized availability
  failures are retryable.

## Trusted scope and namespace

Long-lived memory creates a cross-session disclosure risk: if subject identity
or delivery privacy came from model-controlled input, one caller could read or
write another caller's records. eve therefore resolves scope only from trusted
runtime identity and independently verifies that the response destination is
private to that same subject.

### Principal scope

V1 provides only `byPrincipal()`. It reads `auth.current`, requires a `user`
principal, and constructs identity from:

- protocol version;
- authority type: `issuer` when present, otherwise `authenticator`;
- the non-empty authority value; and
- the non-empty principal ID.

Display names, attributes, `subject`, `auth.initiator`, and authored payloads do
not affect identity. A collection resolves only when the current principal and
a sealed private-audience attestation match exactly. The attestation is minted
by the channel runtime after it verifies every response path is restricted to
that principal; it cannot be copied from or constructed by a payload. Local
subagents inherit the root turn's attestation and cannot mint another.

Missing, anonymous, non-user, shared, unknown, or mismatched identity leaves the
collection unresolved. Automatic recall, tools, capture, outbox work, and the
application client are all absent; eve never falls back to another scope. A
content-free trace event, development notice, and `/info` resolution descriptor
make this fail-closed outcome visible without exposing memory content.

Before memory ships, delivery must preserve an immutable envelope for each
source: source ID, order, provenance, auth, audience, and fingerprints.
Coalescing may combine model input only after grouping compatible envelopes and
never across auth or audience fingerprints. Built-in channels enforce private
destination ownership on every lifecycle route before attesting privacy.

V1 deliberately excludes anonymous, service, runtime, schedule, shared, and
agent-global scopes. A shared store would let persisted prompt injection from
any caller influence every caller. Shared scopes should ship only with explicit
shared-scope disclosure semantics, not weaker guarantees than private memory.

The local development host is the sole exception: it may project the existing
`local-dev` caller into a module-private memory principal and audience. This
does not turn that caller into a user for connections, permissions, governance,
or authored callbacks, and it cannot exist outside the local provider runtime.

### Storage namespace

The provider receives an opaque digest of a versioned namespace. Each component
exists to prevent an otherwise plausible collision:

| Component       | Isolation behavior                                                     |
| --------------- | ---------------------------------------------------------------------- |
| Application ID  | Stable root identity; display or package renames do not change memory. |
| Environment ID  | Separates production, preview, development, and other targets.         |
| Graph node ID   | Separates the root agent from each local subagent.                     |
| Collection path | Separates independently authored collections.                          |
| Principal tuple | Separates subjects and authentication authorities.                     |

Application and environment IDs come from stable provider configuration.
Vercel integrations may derive them from project and target environment;
self-hosted applications provide them explicitly. Hostname, working directory,
`NODE_ENV`, Git SHA, build path, and deployment ID are not stable fallbacks.

Redeployments in the same environment share memory. Different applications,
environments, nodes, collection paths, and principals do not share implicitly.
Renaming a graph node or collection path requires migration.

## Sources, provenance, and turn ordering

Memory claims need durable evidence, but capture-specific redaction must not
silently change what the response model saw. eve therefore keeps two immutable
views of eligible authored text.

| View                        | Created                                | Used by                                                                |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Framework-normalized source | Once for each accepted authored source | Recall query, response source handles, and explicit remember citations |
| Capture-prepared source     | Once per source and collection         | Capture model, capture validation, and capture-origin citations        |

Framework normalization identifies authored text before adapters merge model
messages, converts it to well-formed NFC Unicode, normalizes line endings,
removes blank parts, joins ordered text parts, and applies a versioned UTF-8
bound. It retains source ID, digest, order, provenance, trusted time, auth, and
audience fingerprints.

`prepareSource` creates the second view. Response-model handles bind the
normalized digest; capture citations bind the prepared digest and preparation
fingerprint. Recall returns immutable stored excerpts and never reruns source
preparation.

```text
accept and seal source envelopes
        |
normalize authored text
        |
compact history -> automatic recall -> response-model loop
                                      |        |
                              memory tools   terminal checkpoint
                                                  |
                                      prepare per collection
                                                  |
                                          capture outbox
```

The terminal checkpoint is internal machinery required to distinguish a
completed turn from streaming output that was later cancelled or failed. A
normal response and a completed human-input boundary are capture-eligible;
authorization or task waits are deferred; failed and cancelled turns are not.
Workflow replay preserves the same classification and source IDs.

Normalized source envelopes remain in the world/session journal under world
retention. Memory providers retain only cited excerpts and payload-free source
receipts, not complete source objects. Memory erasure therefore does not claim
to remove original text from journals, transcripts, telemetry, or provider
retention.

## Canonical records and consistency

The canonical store makes mutation and erasure authoritative; retrieval indexes
only help find candidates. This distinction is necessary because an eventually
updated embedding must never make a stale record visible again.

Each logical record points to one current immutable revision. A revision stores
content, origin (`capture`, `model-tool`, or `application`), observation time,
optional occurrence and expiry times, and citations. Corrections append a
revision under the same logical ID using compare-and-swap. V1 has no implicit
decay, confidence score, autonomous inference, or graph relation.

`observedAt` is trusted commit time. `occurredAt` describes when the claim's
event happened. `expiresAt` removes it from live operations at the deadline.
Occurrence-time filtering excludes records without `occurredAt`; without a
filter those records remain eligible. Retained expired and superseded revisions
appear only in administrative export until retention or erasure removes them.

Each scope also maintains a purge generation, content revision, and monotonic
source sequence. Source receipts prevent duplicate capture, revision tokens
provide compare-and-swap, and erasure receipts prevent resurrection. Canonical
writes are durable and read-your-writes even while embeddings or indexes lag.

## Provider boundary

Providers persist canonical state and retrieve candidates within one
collection. eve retains the security- and product-defining behavior so changing
providers cannot change public memory semantics.

Providers own persistence, projections, readiness, migration, and
within-collection ranking. eve owns scope, public records, citations, handles,
tools, idempotency, deadlines, cross-collection fusion, budgets, rendering, and
final disclosure validation. V1 exposes only opaque first-party
`MemoryProvider` values. A public custom-provider API waits for production
evidence and a conformance kit.

### PostgreSQL reference provider

PostgreSQL is the production reference provider. It stores canonical records
and owns document and query embedding so the collection definition remains
independent of a retrieval strategy.

```ts title="agent/lib/memory.ts"
import { pgDatabase, postgresMemory } from "eve/memory/postgres";
import { pool } from "./database";
import { memoryNamespace } from "./environment";

export const memory = postgresMemory({
  database: pgDatabase(pool),
  namespace: memoryNamespace,
  embedding: {
    model: "openai/text-embedding-3-small",
    dimensions: 1536,
  },
});
```

The namespace supplies stable application and environment IDs. The Vercel
integration derives these for the common path; self-hosted applications provide
both. Missing or ambiguous identity fails readiness, and shared source must not
hardcode an environment name.

Embedding configuration accepts a Gateway ID or AI SDK `EmbeddingModel`,
required dimensions, separate document/query provider options, and a model
revision when eve cannot derive a stable identity. Retrieval uses deterministic
hybrid lexical, vector, and recency lanes. A query-embedding failure is an
availability failure, never an empty result.

Every retrieval-affecting choice contributes to one projection fingerprint.
Changing it builds and backfills a side-by-side generation, then activates it
atomically. Embeddings commit only while they still match canonical state;
recall rehydrates candidates from canonical rows.

`pgDatabase(pool)` wraps a structural connection-lease contract. It neither
adds a `pg` runtime dependency nor closes the caller's pool. Acquisition and
queries honor abort signals. Applications run
`preparePostgresMemory(provider)` at deploy time for migrations, validation,
backfill, and projection activation. `eve dev` and `eve start` check readiness
but never migrate implicitly. Failed preparation leaves the active generation
unchanged.

### Test and local providers

`createTestMemory()` returns an opaque deterministic provider plus a controller
with a fixed clock and queued `snapshot()` and `reset()` operations. It performs
no filesystem, network, wall-clock, random, or timer access, but enforces the
same canonical, revision, idempotency, expiry, citation, erase, purge, and cursor
semantics as production.

`localMemory()` is an explicit development provider; eve never substitutes it
for PostgreSQL. It uses Node's built-in `DatabaseSync` and stores canonical
state in `.eve/memory/v1/local.sqlite`, surviving hot reloads, worker
replacement, `/new`, and `eve dev` restarts. A bounded deterministic JavaScript
ranker supplies lexical, fuzzy, and recency retrieval without embeddings.

Local inspection and reset use `eve memory path|ls|show|recall|reset`. The store
is ignored and excluded from builds, content is trace-redacted by default, and
reset quarantines corrupt database files before creating a new incarnation.
Test and local providers require private test or development runtime capability
and are rejected by `eve build` and `eve start`; there is no production escape
hatch.

## Out of scope

- Partial-capability collections or configuration flags that disable capture.
  `prepareSource` remains the code-level per-source skip.
- A mutable `MEMORY.md` canonical store or model-managed memory filesystem.
- A hosted memory service, transcript store, RAG store, or application system
  of record.
- Capturing assistant output, reasoning, tool payloads, attachments, or imported
  context in V1.
- Shared or multiple scopes per collection, and implicit sharing.
- Tags, typed record kinds, profiles, graph relations, confidence, autonomous
  inference, decay, or autonomous instruction modification.
- Public custom extractor, embedder, or provider interfaces in V1.
- Raw-source retention and reprocessing as a provider feature.
- Physical sanitization guarantees for database remnants, replicas, backups,
  workflow journals, transcripts, logs, telemetry, or model-provider retention.

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
