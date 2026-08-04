---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-01"
---

# First-class memory

## Summary

Add memory to eve as a first-class agent slot: durable cross-session knowledge that an agent can recall, remember, and forget. Remembering a replacement revises an existing record.

Declaring a resolved memory collection enables one coherent capability. eve:

- recalls relevant memories automatically before the response;
- makes every collection searchable through one shared recall tool;
- contributes collection-bound remember and forget tools;
- captures durable claims from accepted turns; and
- enforces scope, provenance, approval, budget, revision, and erasure semantics.

These behaviors are intrinsic. No configuration can create read-only, write-only, tools-off, or recall-disabled memory collections, and no flag disables capture; the one code-level escape hatch is `prepareSource`, which may skip any source for a collection. Data that should not be mutable by the agent belongs in instructions, RAG, application state, or an external system of record instead.

eve owns the slot grammar, trusted scope derivation, recall and mutation lifecycle, canonical public model, context rendering, and first-party provider integration. Applications own credentials, databases, stable environment identity, deployment preparation, retention, and authorization inputs.

## Boundary and invariants

One memory file defines a **collection**: one purpose, provider, and subject scope. At runtime, its scope definition resolves one subject for the turn. A `user` collection can therefore contain many isolated users; the file is not itself one user.

| Capability                                                        | Owner                                       | Memory |
| ----------------------------------------------------------------- | ------------------------------------------- | ------ |
| Active-turn and per-session state                                 | eve messages, compaction, and `defineState` | No     |
| Conversation archive and transcript search                        | Session/world storage or an application API | No     |
| External documents and product knowledge                          | RAG or a knowledge integration              | No     |
| Cross-session facts, preferences, events, and reusable knowledge  | Memory slot                                 | Yes    |
| Application truth such as balances, permissions, and order status | Application system of record                | No     |
| Trusted instructions, skills, and autonomous self-modification    | Instructions, skills, and evaluation        | No     |

The design has eight invariants:

1. A declared and resolved collection always provides the complete memory capability.
2. Trusted runtime identity derives scope, and a channel-attested private audience gates disclosure; model input controls neither.
3. A versioned application, environment, graph-node, and collection-path namespace isolates every collection while surviving redeploys in the same environment.
4. Automatic and explicit recall are bounded, attributed, untrusted, and transient to the active turn.
5. Model-proposed memories require citations to eligible source text. eve verifies citation integrity; semantic entailment remains an evaluation target rather than a security guarantee.
6. Model mutations are idempotent and read-your-writes. Capture begins only from an accepted completed turn and never changes that turn's response outcome.
7. Forget and purge make content unreachable through every live memory operation. Payload-free barriers prevent replay from recreating erased content.
8. Canonical writes are durable and read-your-writes. Embeddings and indexes are rebuildable projections that may lag only when stale candidates are revalidated against canonical state.

Records are atomic text claims with optional occurrence time, expiry, and citations. V1 does not impose `fact`, `preference`, or `episode` kinds because those labels do not yet produce distinct behavior.

## Authoring API

### Slot grammar

```text
agent/memory.ts            # one collection named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # collection named "user"
  preferences.ts           # collection named "preferences"
```

Every module default-exports `defineMemory(...)`. Identity comes from the path; there is no `name` field. The named directory is non-recursive and module-only. Invalid nesting and flat-file/directory collisions fail discovery. Collection slugs are lowercase snake case (`[a-z][a-z0-9_]*`) with a 48-character maximum, so generated mutation tool names stay within eve's 64-character tool-name limit and never mix separator styles. Generated memory tool names are reserved: an authored tool that collides with `memory_recall` or a generated `memory_remember_*`/`memory_forget_*` name fails discovery, like subagent/tool name collisions. Shared code belongs in `agent/lib/`.

Local directory-form subagents may declare the same slot. The graph node ID namespaces each collection, so declared subagents never share memory implicitly. The built-in `agent` tool invokes the root node and uses the root's collections. Single-file and remote subagents do not own local memory slots.

### Definition

Every collection requires three author decisions: purpose, persistence, and scope.

```ts title="agent/memory.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { memory } from "./lib/memory";

export default defineMemory({
  description: "Stable facts and preferences for the authenticated user.",
  provider: memory,
  scope: byPrincipal(),
});
```

This collection automatically recalls, exposes all memory tools, and captures durable claims. Forget always requires approval.

The public definition stays intentionally small:

```ts
interface MemoryDefinition {
  readonly description: string;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  readonly capture?: {
    readonly model?: AgentStaticModelDefinition;
    readonly reasoning?: AgentReasoningDefinition;
    readonly modelOptions?: AgentModelOptionsDefinition;
    readonly instructions?: string;
    readonly prepareSource?: MemorySourcePreparer;
  };
}

interface MemorySourcePrepareContext {
  readonly collection: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly auth: SessionAuthContext;
  readonly signal: AbortSignal;
}

type MemorySourcePreparer = (
  text: string,
  context: MemorySourcePrepareContext,
) => string | null | Promise<string | null>;
```

`MemoryProvider` and `MemoryScopeDefinition` are opaque eve values. V1 has no public custom provider, scope-resolver, extractor, embedder, tag schema, collection weight, tool toggle, or token-budget API.

### Capture configuration

Capture is intrinsic. Omit `capture` to use eve's defaults; the block only configures capture:

```ts
capture: {
  model: "anthropic/claude-sonnet-5",
  reasoning: "low",
  modelOptions: {
    providerOptions: {
      gateway: { serviceTier: "flex" },
    },
  },
  instructions: "Prefer durable preferences over one-time requests.",
  prepareSource(text, context) {
    return text;
  },
},
```

- `model` selects the capture-only model. It accepts a Gateway ID or direct AI SDK `LanguageModel`, but not dynamic selection because a durable intent must pin one replayable model. Omission uses the agent's compiled static model.
- `reasoning` sets provider-agnostic AI SDK reasoning effort. With no model override, omission inherits the agent setting. An overridden model uses its provider default unless set explicitly.
- `modelOptions` forwards provider-specific options only to capture calls. With no model override, omission inherits agent options and an explicit value replaces them. An overridden model inherits no options.
- `instructions` supplements eve's versioned extraction policy. It cannot expand eligible sources, bypass citations, or weaken hard limits.
- `prepareSource` is a capture-only minimization and redaction hook. It receives bounded normalized inbound text and trusted collection, source, time, auth, and abort context. It returns transformed text or `null` to skip capture for that source and collection. It does not alter response input, automatic recall, or explicit remember citations. An unconditional `null` is the sanctioned code-level way to run a collection without automatic capture; explicit remember and application writes still work.

V1 capture accepts only authored inbound text. It excludes assistant output, imported threads, channel/client context, instructions, reasoning, tool traffic, approvals, attachments, abandoned attempts, and uncommitted output.

**Recording action outcomes.** Assistant output is ineligible as capture source and citation evidence because it can be attacker-influenced through prompt injection. The sanctioned path for durable action memory — "the agent booked the 3pm flight" — is an application write: the tool that performs the action records the outcome through `ctx.getMemory(...)`, which commits with `origin: "application"` and needs no model citation.

## Model tools

Memory tools are intrinsic framework operations, not ordinary authored tools. They cannot be disabled, replaced, or independently configured. This deliberately diverges from the `disableTool()` sentinel available for framework default tools: declaring the collection is the opt-in, and the slot always carries its complete capability.

The shared tool is `memory_recall`. The flat slot contributes `memory_remember` and `memory_forget`; named collections contribute `memory_remember_<collection>` and `memory_forget_<collection>`.

```ts
interface MemoryRecallToolInput {
  readonly query: string;
  readonly collection?: string;
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit?: number;
}

interface MemoryRememberToolInput {
  readonly content: string;
  readonly citation: {
    readonly sourceHandle: string;
    readonly quote: string;
  };
  readonly occurredAt?: string;
  readonly expiresAt?: string;
  readonly supersedes?: string;
}

interface MemoryForgetToolInput {
  readonly handle: string;
}
```

Mutation tools are collection-bound, so the model never chooses a write scope.

Model-facing records use signed short-lived handles rather than canonical IDs:

```ts
interface MemoryToolRecord {
  readonly collection: string;
  readonly handle: string;
  readonly content: string;
  readonly observedAt: string;
  readonly occurredAt?: string;
  readonly expiresAt?: string;
  readonly citations: readonly { readonly quote: string }[];
}

interface MemoryRecallToolResult {
  readonly memories: readonly MemoryToolRecord[];
  readonly failures: readonly {
    readonly collection: string;
    readonly code: "deadline_exceeded" | "unavailable";
    readonly retryable: boolean;
  }[];
  readonly truncated: boolean;
}

type MemoryRememberToolResult =
  | {
      readonly status: "created" | "revised";
      readonly memory: MemoryToolRecord;
    }
  | { readonly status: "erased" | "purged" };

interface MemoryForgetToolResult {
  readonly status: "erased" | "purged";
}
```

`memory_recall` searches every resolved collection when `collection` is omitted. eve owns cross-collection allocation, rank fusion, deterministic ties, diversity, and the cumulative per-turn result budget. A partial recall returns usable memories plus sanitized collection failures; failure of every selected collection fails the tool. Provider scores and messages never reach the model.

Every framework-normalized source is rendered with a source handle. A remember citation is `{ sourceHandle, quote }`; the normalized quote must occur in that source. `supersedes` references the current memory handle. Recalled memory, assistant output, imported context, and tool results are ineligible evidence.

Remember and forget are idempotent framework side effects. eve checkpoints a stable operation ID and exact request before execution, reports success only after the provider commits, and makes the result visible to later model steps. Replay returns the original result while its content remains live; after forget or purge it returns payload-free `erased` or `purged`. A later-abandoned response does not roll back a completed mutation.

Expected tool failures use stable codes:

- `memory_handle_expired`: recall again for a fresh handle;
- `memory_revision_conflict`: the addressed revision or purge generation is stale;
- `memory_handle_invalid`: the handle is malformed, tampered, or belongs to another scope;
- `memory_citation_invalid`: the source handle or quote failed validation;
- `memory_approval_unavailable`: the session cannot request the required forget approval because it lacks the input capability; erase through the application or admin surface instead; and
- `memory_recall_unavailable`: every selected collection failed, with sanitized collection codes.

Forget approval rides the existing tool-approval pipeline. In a session that cannot park for input, `memory_forget` returns `memory_approval_unavailable` as an expected tool failure; it never parks a task turn or fails the turn.

The failed `memory_recall_unavailable` result carries the same sanitized `failures` entries as a partial success and no provider messages or scores.

Memory content never enters durable transcript history: history stores payload-free placeholders that preserve call/result pairing, and validated transient turn content supplies the payloads, so erasure reaches every live surface. Workflow journals may retain normalized source envelopes under world retention.

## Application control

Application code never uses a provider directly. `MemoryClient` is subject-bound: eve creates it only from matching current auth and private audience, and every method retains that sealed scope. A separate `MemoryAdminClient` is available only through the explicit trusted-operator route surface for data access, rectification, and erasure workflows. Public IDs, revision tokens, handles, and cursors are opaque strings.

```ts
interface MemoryRecordCitation {
  readonly sourceView: "normalized" | "capture-prepared";
  readonly sourceId: string;
  readonly quote: string;
}

interface MemoryRevision {
  readonly revision: string;
  readonly content: string;
  readonly origin: "capture" | "model-tool" | "application";
  readonly observedAt: string;
  readonly occurredAt?: string;
  readonly expiresAt?: string;
  readonly citations: readonly MemoryRecordCitation[];
}

interface MemoryRecord extends MemoryRevision {
  readonly recordId: string;
}

interface MemoryRecallInput {
  readonly query: string;
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit?: number;
}

interface MemoryRecallResult {
  readonly records: readonly MemoryRecord[];
  readonly truncated: boolean;
}

interface MemoryListInput {
  readonly cursor?: string;
  readonly limit?: number;
}

interface MemoryPage {
  readonly records: readonly MemoryRecord[];
  readonly cursor: string | null;
}

type MemoryRememberInput =
  | {
      readonly content: string;
      readonly occurredAt?: string;
      readonly expiresAt?: string;
    }
  | {
      readonly recordId: string;
      readonly expectedRevision: string;
      readonly content: string;
      readonly occurredAt?: string;
      readonly expiresAt?: string;
    };

interface MemoryMutationOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

type MemoryErrorCode =
  | "revision_conflict"
  | "idempotency_conflict"
  | "invalid_cursor"
  | "export_invalidated"
  | "unavailable";

declare class MemoryOperationError extends Error {
  readonly name: "MemoryOperationError";
  readonly code: MemoryErrorCode;
  readonly retryable: boolean;
}

type MemoryRememberResult =
  | { readonly status: "created" | "revised"; readonly record: MemoryRecord }
  | { readonly status: "erased" | "purged" };

type MemoryForgetResult =
  | { readonly status: "erased"; readonly erasedAt: string }
  | { readonly status: "not_found" | "purged" };

interface MemoryClient {
  recall(input: MemoryRecallInput, options?: { signal?: AbortSignal }): Promise<MemoryRecallResult>;
  get(
    input: { readonly recordId: string },
    options?: { signal?: AbortSignal },
  ): Promise<MemoryRecord | null>;
  list(input?: MemoryListInput, options?: { signal?: AbortSignal }): Promise<MemoryPage>;
  remember(
    input: MemoryRememberInput,
    options: MemoryMutationOptions,
  ): Promise<MemoryRememberResult>;
  forget(
    input: { readonly recordId: string; readonly expectedRevision?: string },
    options: MemoryMutationOptions,
  ): Promise<MemoryForgetResult>;
}

type MemoryAdminClient = Omit<MemoryClient, "recall"> & {
  exportRecords(options?: { signal?: AbortSignal }): AsyncIterable<{
    readonly recordId: string;
    readonly revisions: readonly MemoryRevision[];
  }>;
  purge(
    options: MemoryMutationOptions,
  ): Promise<{ readonly status: "purged"; readonly purgeId: string; readonly purgedAt: string }>;
};
```

Every method resolves to a plain value. Expected failures throw `MemoryOperationError` with a stable machine-readable `code` and a `retryable` flag, following the connection-error convention: guards match on `name` and `code` rather than `instanceof` because bundlers can duplicate class instances. `revision_conflict`, `idempotency_conflict`, `invalid_cursor`, and `export_invalidated` are never retryable; `unavailable` is the sanitized provider or deadline failure and is retryable. Benign outcomes — `not_found`, replay against erased content — are status values, not errors.

A correction is a full replacement and requires both record ID and expected revision. Forget without an expected revision erases the current logical record; with one, a stale target throws `revision_conflict`. Application writes need no model citation, but framework bounds and encoding rules still apply. Public timestamps are RFC 3339 instants; limits must be finite positive integers and are clamped to eve's versioned maximum.

An occurrence-time filter excludes records without `occurredAt`; without a filter those records remain eligible. `list` orders live records by `observedAt` descending and record ID ascending. Expired records are absent from recall, `get`, and `list`, but retained expired and superseded revisions remain in `exportRecords` until retention or erasure removes them.

An idempotency key binds scope, method, and normalized request. Exact replay returns the original result only while its content remains live. After forget or purge, replay returns payload-free `erased` or `purged`; it never returns deleted content or recreates the write. Changed input throws `idempotency_conflict`.

Cursors bind collection, scope, purge generation, snapshot, and order. Invalid, expired, wrong-scope, or pre-purge cursors throw `invalid_cursor` rather than restarting. Export iterates one snapshot. If forget or purge changes retained content, the next iterator operation rejects with `export_invalidated`; only clean iterator completion means the export is complete. Sanitized provider availability failures throw `unavailable`; raw database errors and physical keys remain internal.

## Trusted scope and namespace

V1 has one scope definition: `byPrincipal()`. It uses `auth.current`, requires `principalType: "user"`, and resolves this versioned tuple:

```ts
type CanonicalMemoryPrincipalV1 = readonly [
  version: 1,
  principalType: "user",
  authorityKind: "issuer" | "authenticator",
  authority: string,
  principalId: string,
];
```

`issuer` is preferred when present; otherwise eve uses `authenticator`. Required strings must be non-empty. Attributes, display names, `subject`, and `auth.initiator` never define identity.

The local provider has one dev-only exception: the trusted dev host may inject a branded memory principal projection for the existing `local-dev` caller. This does not change `SessionAuthContext`, does not make the caller a `user` for connections or governance, and cannot exist outside the local provider capability described below.

```ts
declare const deliveryAudienceBrand: unique symbol;

interface DeliveryAudience {
  readonly [deliveryAudienceBrand]: true;
}
```

The unique-symbol brand provides TypeScript opacity only. Runtime unforgeability comes from a sealed token created and validated by module-private channel-runtime identity; copied, deserialized, payload-authored, and merely shape-compatible objects fail validation. Built-in channels attach the token internally. Trusted custom-channel route handlers receive `attestPrivateAudience(auth)` and may call it only after enforcing that every response path is restricted to that principal. The sealed value binds registered channel identity and the same principal tuple. Local subagents inherit the sealed root-turn audience and cannot remint it.

A collection resolves only when current principal and private audience match exactly. Missing, anonymous, non-user, shared, unknown, or mismatched identity makes the collection unavailable: no automatic recall, tools, capture, outbox, or application client. It never falls back to another scope. Unavailability is fail-closed but never fail-silent: eve emits a content-free resolution diagnostic (a trace event and a dev-time notice) naming the collection and the failed condition, and `/info` descriptors report per-collection resolution state for the current caller.

Before memory ships, eve delivery must preserve one immutable envelope per source containing source ID, order, provenance, auth, audience, and fingerprints. Payloads cannot mint attestations. Coalescing may combine model input only after compatible envelopes are grouped and never across auth or audience fingerprints. Built-in channels must enforce private destination ownership on send, continue, stream, cancel, and reset paths before they attest privacy.

Canonical provider keys derive from this tuple and are passed as keyed opaque digests:

```ts
type CanonicalMemoryScopeV1 = readonly [
  protocol: "eve-memory",
  version: 1,
  applicationId: string,
  environmentId: string,
  graphNodeId: string,
  collectionPath: string,
  principal: CanonicalMemoryPrincipalV1,
];
```

`applicationId` and `environmentId` are stable provider configuration. Vercel integrations may derive them from project and target environment. Self-hosted applications must provide them explicitly; hostname, working directory, `NODE_ENV`, Git SHA, build path, and deployment ID are invalid fallbacks. `applicationId` is the sole stable root identity; package and display-name changes do not affect memory. `graphNodeId` is the root sentinel or path-derived local-subagent address. Redeployments in one environment share memory. Production, preview, development, different application IDs, nodes, paths, and app roots do not share implicitly. Node and collection path renames intentionally require migration.

### V1 scope trade-off

V1 memory exists only for authenticated `user` principals. Agents behind `none()` auth (anonymous callers), service and `runtime` principals, schedule-driven turns, and unknown identities never resolve a collection: a declared slot compiles, tools and capture stay absent, and the resolution diagnostic above is the only observable. The `local-dev` projection is the sole dev-time exception.

This is deliberate. Cross-subject disclosure is the dominant memory risk, and trusted identity is the only safe scope key, so V1 refuses to guess a subject. An agent-global `byAgent()` scope was considered and deferred: it has no cross-subject disclosure boundary, but every caller reads and writes one shared store, so persisted prompt injection from any caller reaches every caller, and neither citations nor approval isolate subjects within it. Shared and global scopes wait for the shared-scope disclosure semantics in the final delivery phase rather than shipping with weaker guarantees than the private scope.

### Application addressing

In-turn callbacks stay bound to their current graph node:

```ts
interface SessionContext {
  getMemory(collection: string): Promise<MemoryClient | null>;
}
```

Unknown collections throw; unavailable principal scope returns `null`. Route handlers can enumerate and address root and local-subagent collections:

```ts
type MemoryNodeAddress =
  { readonly kind: "root" } | { readonly kind: "local-subagent"; readonly nodeId: string };

interface MemoryCollectionAddress {
  readonly node: MemoryNodeAddress;
  readonly collection: string;
}

interface MemoryCollectionDescriptor {
  readonly address: MemoryCollectionAddress;
  readonly description: string;
}

interface MemoryPrincipalAddress {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
}

interface RouteHandlerArgs {
  attestPrivateAudience(auth: SessionAuthContext): DeliveryAudience;
  listMemoryCollections(): readonly MemoryCollectionDescriptor[];
  getMemory(input: {
    readonly address: MemoryCollectionAddress;
    readonly auth: SessionAuthContext;
    readonly audience: DeliveryAudience;
  }): Promise<MemoryClient | null>;
  getMemoryAdmin(input: {
    readonly address: MemoryCollectionAddress;
    readonly principal: MemoryPrincipalAddress;
    readonly operator: {
      readonly auth: SessionAuthContext;
      readonly reason: string;
    };
  }): Promise<MemoryAdminClient>;
}
```

Enumeration is root first, then local node ID and collection name. Node IDs are opaque values obtained from enumeration, not constructed by applications. Remote subagents own memory remotely.

`getMemory(...)` requires a verified principal and an attested private audience — a handler lacking either has nothing to pass and must not call it — and returns `null` only when that auth does not resolve the collection's scope. The subject binding covers the entire client, including mutations, because its results may flow into that response.

`getMemoryAdmin(...)` requires no subject audience and never impersonates the subject. A `MemoryPrincipalAddress` canonicalizes exactly as scope resolution would — `issuer` is the authority when present, otherwise `authenticator` — and admin lookups match only that canonical tuple, with no fuzzy or cross-authority matching, so an operator must supply the same authority the records were written under. Unknown addresses and malformed principal addresses throw; the call never returns `null` because admin access does not depend on subject scope resolution. The application must authorize the operator before the call; eve records the operator fingerprint, reason, target, operation, and outcome. Admin clients are never exposed to model tools, callbacks, dynamic resolvers, or serialized payloads.

Aggregate data-subject export and purge iterate descriptors and acquire one admin client per collection. Arbitrary future custom scopes must register enumerable subject mappings. `/info` may expose descriptors for inspection, never subjects or content.

## Sources and lifecycle

### Source views

eve maintains two immutable views instead of overloading “prepared source”:

| View                        | Created                           | Consumers                                                   |
| --------------------------- | --------------------------------- | ----------------------------------------------------------- |
| Framework-normalized source | Once per accepted authored source | Recall query, response source handles, explicit citations   |
| Capture-prepared source     | Per source and collection         | Capture model, capture validation, capture-origin citations |

Framework normalization identifies authored text before adapters merge model messages, converts it to well-formed NFC Unicode, normalizes line endings, removes blank parts, joins ordered text parts, and applies a versioned UTF-8 bound. It preserves case, punctuation, and remaining whitespace. Each source retains its ID, normalization version, digest, order, provenance, trusted time, auth, and audience fingerprints.

`prepareSource` transforms only the second view. Returning `null` skips capture for that collection; it does not suppress recall or invalidate explicit source handles. Response-model handles bind the normalized digest. Model-tool citations bind normalized byte offsets; capture citations bind the prepared digest, preparation fingerprint, and prepared byte offsets. Recall returns stored immutable citations and never reruns preparation.

Normalized source envelopes live in the world/session journal under world retention. Memory providers retain only revision-owned cited excerpts and payload-free source receipts, not complete source objects. Memory erasure does not claim physical deletion from world journals, transcripts, telemetry, or model-provider retention.

### Turn lifecycle

```text
accept + seal per-source envelopes
        |
framework-normalize authored text
        |
compact and commit placeholder history
        |
recall + commit transient turn overlay
        |
validate + materialize -> one response-model attempt
        |
execute checkpointed memory tools during the loop
        |
commit terminal turn checkpoint + capture outbox
        |
settle response -> prepare per collection -> dispatch capture
```

This requires new execution primitives before the public API ships. eve must own model retries, disable nested SDK retries, preserve source provenance through coalescing, and commit terminal classification with durable session state. Stream events remain append-only and may already be visible; capture eligibility derives only from the durable checkpoint.

The checkpoint records the durable protocol outcome and accepted sources. It is internal execution machinery, not public API; it appears here only to define capture eligibility:

```ts
interface TurnTerminalCheckpoint {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly acceptedSourceIds: readonly string[];
}
```

| Turn path                                   | Outcome       | Capture                              |
| ------------------------------------------- | ------------- | ------------------------------------ |
| Normal response or completed HITL boundary  | `completed`   | Eligible authored normalized text    |
| Authorization, runtime action, or task wait | No checkpoint | Deferred                             |
| Recoverable or terminal turn failure        | `failed`      | Never                                |
| Cancellation before completion              | `cancelled`   | Never                                |
| Adapter consumes delivery without a turn    | No checkpoint | Never                                |
| Workflow replay                             | Same outcome  | Idempotent using the same source IDs |

A completed checkpoint creates no outbox for an unresolved collection. For a resolved collection, no authored text or a `null`/blank prepared source produces an internal `skipped` status. Capture retries transient failures; exhausted retries become `failed`, and stale generation or definition becomes `obsolete`. These content-free statuses appear in traces and diagnostics only. V1 exposes no capture polling or freshness barrier. A following turn may not observe capture; callers needing read-after-write use explicit remember or an application write.

### Recall

Recall runs after compaction and before the first response-model request. Its query uses the latest framework-normalized input plus a bounded visible window for coreference. It combines relevant and recent candidates under one token and wall-clock budget.

Transient provider and deadline failures do not fail the turn. Successful collections still contribute; each failed collection contributes only a content-free `unavailable` status and emits a diagnostic. If every collection fails, the response model still runs with that status rather than an empty-memory result. Scope, generation, expiry, signature, and canonical-integrity checks remain fail-closed for disclosure: invalid content is never supplied.

The explicit recall tool uses the same partial-success representation. When every explicitly selected collection fails, the tool returns `memory_recall_unavailable` so the model can react inside the loop; automatic recall instead places the equivalent status before the first model call. This preserves agent availability without representing an outage as “the user has no memories.”

The contribution is a length-delimited data block attributed by collection name, purpose, handle, revision time, and available citation. A fixed trusted instruction identifies it as untrusted data. It does not change eve permission or approval gates, although stored prompt injection can still influence the model.

Immediately before each eve-owned model request, eve rechecks scope, purge generation, expiry, definition fingerprint, and exact revisions. An unrelated write causes rehydration rather than whole-collection invalidation. A projection can nominate candidates only; canonical rehydration prevents superseded, expired, erased, or purged content from reappearing.

### Capture

For every collection resolved at turn admission, a completed checkpoint creates a payload-free outbox entry that references accepted normalized sources and pins collection, scope, purge generation, provider fingerprint and incarnation, preparation fingerprint, model and extraction versions, source sequence, audience, time, and provenance. It never reruns scope resolution. A provider-incarnation mismatch is terminal `obsolete` and cannot adopt a replacement store.

Capture executes as a durable, idempotent workflow against one strong canonical snapshot: the pinned model proposes add, supersede, or no-op operations with exact citations, and eve verifies preparation hashes, byte offsets, bounds, and revision expectations before committing the exact proposal with a replay receipt. Conflicts re-propose against fresh state rather than blindly retrying.

Each scope has a monotonic source sequence. A delayed older turn may add a historical event but cannot supersede state learned from a newer source.

## Canonical model and erasure

| Record                | Purpose                                   | Core fields                                                     |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `MemoryScopeVersion`  | Resurrection and cache invalidation       | purge generation, content revision, source sequence             |
| `MemorySourceReceipt` | Accepted-source identity and replay guard | source ID, keyed digest, clocks, preparation/provenance version |
| `MemoryCitation`      | Revision-owned evidence                   | source view/digest, version, byte offsets, quote                |
| `MemoryRevision`      | Immutable assertion revision              | IDs, content, origin, times, citations                          |
| `MemoryRecord`        | Current canonical view                    | current revision and derived expiry state                       |
| `MemoryHit`           | Provider recall result                    | canonical candidate ID and provider rank signals                |
| Erasure receipts      | Payload-free deletion evidence            | operation, target or generation, key version, time              |
| Admin audit events    | Trusted-operator accountability           | operator fingerprint, reason, target, operation, outcome, time  |

`observedAt` is canonical commit time, `occurredAt` is optional event time, and `expiresAt` excludes a record at or after its deadline according to the provider's trusted clock. Recall, `get`, and `list` exclude expired records; export includes retained expired revisions until retention or erasure removes them.

Corrections append a revision under one logical ID and require the current revision token. CAS ensures one current revision. Stale remember and forget handles conflict rather than changing newer data. V1 has no implicit decay, confidence score, autonomous inference, or graph relation.

Forget removes one logical record, its revisions, and revision-owned evidence from live operations. It does not find semantically duplicated claims; scope purge is the complete live-memory erasure operation. Payload-free receipts and generation barriers remain for at least the maximum replay and idempotency horizon. Accepted mutation receipts shed content when their target is erased and resolve future replay to `erased` or `purged`. Receipts are pseudonymous operational data, not literally data-free.

Restoring an older database requires replaying a separately retained erasure ledger before traffic resumes. Physical database remnants, replicas, backups, workflow journals, transcripts, telemetry, and model-provider retention remain governed by their own policies.

## Provider boundary

V1 publicly exposes only opaque first-party `MemoryProvider` values. A provider owns persistence, within-collection retrieval, projections, readiness, and migration. eve owns scope, canonical public semantics, citations, handles, tools, idempotency orchestration, deadlines, cross-collection fusion, budgets, rendering, and final disclosure validation.

The internal protocol must prove namespace isolation, durable canonical writes, strong formation reads, revision CAS, expiry, erase, purge barriers, bounded snapshot export, stale-projection rehydration, readiness, cancellation, limits, fingerprints, retention horizons, and race behavior. Public third-party support waits for production evidence and a branded provider API plus conformance kit.

### PostgreSQL reference provider

PostgreSQL owns both document and query embedding. `defineMemory` never accepts an embedding model; managed future providers may embed upstream or use a different retrieval strategy entirely.

```ts
interface MemoryEmbeddingCallOptions {
  readonly providerOptions?: Record<string, JsonObject>;
}

interface PostgresMemoryEmbeddingDefinition {
  readonly model: string | EmbeddingModel;
  readonly modelRevision?: string;
  readonly dimensions: number;
  readonly documentOptions?: MemoryEmbeddingCallOptions;
  readonly queryOptions?: MemoryEmbeddingCallOptions;
}

interface PostgresMemoryDefinition {
  readonly database: PostgresMemoryDatabase;
  readonly namespace: {
    readonly applicationId: string;
    readonly environmentId: string;
  };
  readonly embedding: PostgresMemoryEmbeddingDefinition;
}

interface PostgresMemoryConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly rows: readonly Row[] }>;
  release(): void;
}

interface PostgresMemoryPool {
  connect(options?: { readonly signal?: AbortSignal }): Promise<PostgresMemoryConnection>;
}

declare function pgDatabase(pool: PostgresMemoryPool): PostgresMemoryDatabase;
declare function postgresMemory(definition: PostgresMemoryDefinition): PostgresMemoryProvider;

declare function preparePostgresMemory(
  provider: PostgresMemoryProvider,
  options?: { readonly signal?: AbortSignal },
): Promise<{
  readonly status: "ready";
  readonly schemaVersion: number;
  readonly projectionFingerprint: string;
}>;
```

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

`memoryNamespace` must derive the current stable application and target environment. Never hardcode an environment name in shared source: preview and production must resolve different values, and a missing or ambiguous value fails provider readiness. The Vercel integration owns this derivation for the majority path: a first-party helper resolves `applicationId` from the project and `environmentId` from the target environment, so a Vercel-deployed application writes no namespace code. Self-hosted applications provide both explicitly.

The embedding model accepts a Gateway ID or direct AI SDK `EmbeddingModel`. Query and document call options may separately provide provider options for role-specific APIs. `modelRevision` defaults to the Gateway ID when `model` is a string; a direct `EmbeddingModel` instance, mutable alias, middleware, or custom endpoint requires an explicit revision because eve cannot derive a stable identity from it. Dimensions are required and verified because AI SDK models do not report them reliably.

Retrieval strategy is a provider implementation choice, not an author knob. V1 uses hybrid recall — lexical, vector, and recency lanes fused deterministically within the collection — over canonical rows; eve rehydrates canonical state and fuses collections. A canonical write is durable and read-your-writes even when its embedding has not yet committed; embeddings are rebuildable projections that commit only while they still match canonical state. Query-embedding failure is an operational recall failure, never an empty result; automatic recall reports the collection as `unavailable` under the policy above. Stable PostgreSQL memory has no lexical-only mode.

Every retrieval-affecting choice — model identity and revision, dimensions, call options, preprocessing, ranking, and fusion version — is covered by one projection fingerprint. Changing any of them builds a side-by-side projection generation and activates it atomically only after backfill. Runtime readiness verifies schema, pgvector, the active fingerprint, and completed backfill before a session uses memory.

`PostgresMemoryDatabase` and `PostgresMemoryProvider` are opaque branded values. `pgDatabase(pool)` accepts the structural lease contract above, never closes it, and adds no `pg` runtime dependency. Connections and queries must honor the supplied abort signal, including blocked acquisition and in-flight cancellation. `preparePostgresMemory(...)` runs migrations, canary validation, backfill, and projection activation; applications invoke it from a deploy-time step — a build command on Vercel, a migration job self-hosted — before new code serves traffic. eve never migrates implicitly: `eve dev` and `eve start` fail readiness rather than migrate on demand, and a failed prepare rejects without changing the active generation. Namespace migration freezes old writers and preserves purge generations and receipts. PostgreSQL erasure guarantees live logical unreachability, not immediate sanitization of MVCC pages, WAL, replicas, snapshots, or backups.

### Test and local providers

Tests create an isolated deterministic provider explicitly:

```ts
import { byPrincipal, defineMemory } from "eve/memory";
import { createTestMemory } from "eve/memory/testing";

const testMemory = createTestMemory();

export default defineMemory({
  description: "Stable user preferences.",
  provider: testMemory.provider,
  scope: byPrincipal(),
});
```

The controller provides a fixed controllable clock, queued `snapshot()` and `reset()` operations, and an opaque provider. It performs no filesystem, network, wall-clock, random, or timer access. It enforces the real canonical, CAS, idempotency, expiry, citation, erase, purge, and cursor semantics rather than acting as a permissive fake.

Local development selects an explicit provider; eve never silently substitutes it for PostgreSQL:

```ts title="agent/lib/memory.ts"
import { localMemory } from "eve/memory/local";

export const memory = localMemory();
```

`localMemory()` uses `DatabaseSync` directly from Node's built-in `node:sqlite`, adding no package, ORM, native addon, or database adapter. It stores canonical state in `.eve/memory/v1/local.sqlite`, enables WAL, and commits mutations with SQLite transactions. The path is rooted at the authored app rather than a generated snapshot, so memory survives hot reloads, worker replacement, `/new`, and `eve dev` restarts. Schema readiness gates generation activation; migrations require quiesced dev workers, and transactions fence the schema version and store incarnation.

The local provider stores no embeddings or search projection. It loads a bounded live scope and uses a shared versioned deterministic JavaScript ranker with lexical, fuzzy, and recent lanes. This is for lifecycle development and predictable tests, not evidence of production recall quality.

The loopback dev channel retains its existing `local-dev` auth identity. The trusted dev host supplies a separate module-private memory principal and private audience, with session ownership enforced on all lifecycle routes. This does not make the synthetic caller a user for connections, permissions, or authored callbacks.

Local inspection and reset are available through `eve memory path|ls|show|recall|reset`. These commands operate on the local provider's SQLite store only; they never connect to a production provider. Content is redacted from framework traces by default. The provider creates app-local ignore protection for `.eve/memory`, and build/deployment adapters hard-exclude it. Corruption fails closed and explicit reset quarantines the database, WAL, and SHM before creating a new incarnation.

The test and local providers are rejected by `eve build` and `eve start`; mounting additionally requires a module-private test or `eve dev` runtime capability rather than an environment variable. There is no production escape hatch or automatic migration to PostgreSQL.

## Out of scope

- Read-only, write-only, recall-disabled, or tool-disabled memory collections, and configuration flags that disable capture (`prepareSource` is the code-level per-source skip).
- A mutable `MEMORY.md` canonical store or model-managed memory filesystem.
- A hosted memory service, transcript store, RAG store, or application system of record.
- Capturing assistant output, reasoning, tool payloads, attachments, or imported context in V1.
- Shared scopes, multiple scopes per collection, or implicit sharing in V1.
- Tags, typed record kinds, profiles, graph relations, confidence, autonomous inference, decay, or autonomous instruction modification.
- Public custom extractor, embedder, or provider interfaces in V1.
- Raw-source retention and reprocessing as a provider feature.
- Physical sanitization guarantees for database remnants, replicas, backups, workflow journals, transcripts, logs, telemetry, or model-provider retention.

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
