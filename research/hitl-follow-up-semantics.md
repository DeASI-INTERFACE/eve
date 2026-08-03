---
issue: TBD
status: proposed
last_updated: "2026-08-03"
---

# HITL follow-up semantics

## Summary

An accepted user message must never disappear behind an unresolved HITL request
while the session returns to waiting. Every accepted delivery must resolve the
request, continue as ordinary turn input, or be rejected visibly.

The current harness makes blocking behavior intrinsic to request kind:

```text
tool-approval -> required
session-limit -> required
question      -> dismissable
```

That is insufficient for shared sessions. Whether a request blocks a later
delivery can depend on the actor whose turn produced the request and the actor
sending the delivery.

The working approval rule is:

```text
same actor as the requesting turn     -> approval blocks the delivery
different actor from requesting turn -> approval does not block the delivery
```

This rule is separate from response authority. The request's owning tool
decides who may answer it; that tool API is outside this proposal.

## Related work

- [PR #1368](https://github.com/vercel/eve/pull/1368) proposes the tool-owned
  responder authorization contract. This proposal treats that authority
  decision as an input and focuses on whether the unresolved request blocks a
  delivery.
- [PR #1231](https://github.com/vercel/eve/pull/1231) makes every message
  supersede unresolved input, denying unanswered approvals before continuing.
  This proposal differs by making approval blocking actor-relative rather than
  applying one supersession rule to every sender.
- [PR #142](https://github.com/vercel/eve/pull/142) binds Slack HITL responses
  to the verified actor for the current Slack turn. That is a channel-specific
  enforcement of response authority, not a general follow-up blocking rule.

## Current behavior

The harness classifies every tool approval and session limit as `"required"`
and every question as `"dismissable"` in
[`classifyInputRequest`](../packages/eve/src/harness/input-request-class.ts#L27-L44).

When an unrelated message arrives while a required request is unresolved, eve
stores the delivery in `deferredStepInput`, keeps the request unresolved, and
reparks without a model call:

```text
WAITING(request R) + message M
  -> retain R
  -> defer M
  -> WAITING(request R)
```

See
[`resolvePendingInput`](../packages/eve/src/harness/input-requests.ts#L150-L162).
The sender receives no authoritative server event describing this disposition.
`client.input.responded` is only a client-local optimistic projection
([`ClientInputRespondedEvent`](../packages/eve/src/client/reducer.ts#L33-L52)).

Questions take a different path. An unrelated message marks a dismissable
request ignored, clears the request batch, and continues with the message
([`resolvePendingInput`](../packages/eve/src/harness/input-requests.ts#L164-L183)).

## Identities

This proposal distinguishes three identities:

- **Session initiator:** the principal that created the durable session,
  exposed as `session.auth.initiator`.
- **Delivery actor:** the principal attached to the current delivery, exposed
  as `session.auth.current` while processing it.
- **Request actor:** the delivery actor whose turn produced the HITL request.

The request actor is not currently persisted. `SessionTurn` contains only `id`
and `sequence`, while `InputRequest` carries no actor:

- [`SessionTurn`](../packages/eve/src/channel/types.ts#L56-L65)
- [`InputRequest`](../packages/eve/src/runtime/input/types.ts#L39-L71)

Relational blocking requires the runtime to retain enough identity to compare
the request actor with a later delivery actor. The protocol must not expose
more principal data than a channel is allowed to render.

## Invariant

For every accepted delivery `D`:

```text
accepted(D)
  -> eventually exactly one of resolved(D), forwarded(D), rejected(D)

session.waiting
  -> D is not hidden in deferred input
```

An explicit rejection may leave the request unresolved. This is not a wedge:
the delivery has a terminal outcome, the sender receives feedback, and the
request remains actionable.

The invalid transition is:

```text
accepted(D) -> deferred(D) -> session.waiting
```

Approval response isolation is different. The AI SDK requires an approval
response to be processed separately from a message in the same delivery
([`resolvePendingInput`](../packages/eve/src/harness/input-requests.ts#L199-L238)).
That internal sequencing is valid only when the message proceeds automatically
before the next external `session.waiting`; it cannot become another
human-dependent queue.

## Relational rule

Let:

```text
R = unresolved HITL request
A = request actor
D = incoming delivery
B = delivery actor
```

The runtime evaluates two independent decisions:

```text
authority = R.tool.mayRespond(B, D)
blocking  = blocks(R, A, B, D)
```

The initial scenario matrix is:

| Request actor | Delivery actor | Delivery                          | Request behavior | Delivery behavior         |
| ------------- | -------------- | --------------------------------- | ---------------- | ------------------------- |
| A             | A              | Authorized response               | Resolve          | Resume                    |
| A             | A              | Unauthorized response             | Keep unresolved  | Reject visibly            |
| A             | A              | Unrelated message                 | Block            | Reject visibly            |
| A             | B              | Authorized response               | Tool decides     | Resume or reject visibly  |
| A             | B              | Unrelated message                 | Do not block     | Forward without deferring |
| A             | A or B         | Question response                 | Tool decides     | Resolve or reject visibly |
| A             | A or B         | Unrelated message during question | Tool decides     | Forward or reject visibly |

No scenario may defer an accepted user delivery across `session.waiting`.

## Meaning of non-blocking

A non-blocking approval still needs a precise transcript outcome. An
unadjudicated AI SDK approval call cannot remain in a transcript that continues
normally; the current classifier calls this out directly
([`input-request-class.ts`](../packages/eve/src/harness/input-request-class.ts#L27-L37)).

Possible semantics are:

1. Resolve the approval as denied, cancelled, ignored, or superseded, then
   continue with the new delivery.
2. Preserve the approval for its request actor while processing the new actor
   on an independent turn or transcript branch.
3. Route the new actor's delivery to another session.

This proposal does not select among them. The choice must preserve the
invariant and the AI SDK transcript contract.

## Observable disposition

The server needs an authoritative event for deliveries handled while HITL is
unresolved. The final event name remains open, but its data must correlate the
delivery and expose the decisions needed by channels and conformance tests:

```ts
{
  deliveryId: string;
  requestId: string;
  authority: "allowed" | "rejected" | "not-applicable";
  requestDisposition: "resolved" | "kept" | "ignored";
  deliveryDisposition: "consumed" | "forwarded" | "rejected";
  reason?: string;
}
```

Channels use this event to render rejection feedback or preserve the active
prompt. Tests use it to prove that every accepted delivery reached a terminal
disposition rather than inferring behavior from later model output.

## Validation matrix

Conformance scenarios vary:

- request kind: approval, question, session limit;
- actor relation: request actor or different actor;
- delivery shape: structured response, plain message, or both;
- text interpretation: option match, freeform, or unmatched;
- timing: parked, active turn, or stale response;
- topology: root session or proxied subagent;
- cardinality: one request or a mixed request batch.

Each scenario asserts the intended request and delivery dispositions and the
governing invariant. HTTP, Slack, and other channels normalize their native
inputs into the same matrix.

## Open questions

1. Does a non-blocking approval resolve as denied, cancelled, ignored, or
   superseded?
2. Can a different actor proceed in the same transcript while the original
   approval remains unresolved?
3. What exact request-actor identity must be persisted?
4. How does request-actor identity survive delivery coalescing and subagent
   proxying?
5. How do mixed request batches behave when only some requests block a
   delivery?
6. What event name best represents the authoritative disposition?
