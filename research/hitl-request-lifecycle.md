---
issue: TBD
status: proposed
last_updated: "2026-08-03"
---

# HITL requests must not wedge sessions

## The problem

Today, a user can send a message while an approval is waiting and get no useful
response.

```text
approval waits
  -> user sends unrelated message
  -> eve hides the message in deferredStepInput
  -> eve waits for the approval again
```

No model call runs. If nobody answers the approval, the message stays hidden.
The session looks broken.

This proposal sets three rules:

1. **Pending requests never block the conversation.** An unrelated message runs
   as a normal turn. The request just stays unanswered.
2. **Do not steal someone else's request.** An unrelated message cannot approve,
   deny, cancel, dismiss, or replace an existing HITL request.
3. **Show request closure.** Emit `input.requested` before waiting, then emit a
   settlement event or `input.dismissed` when the request stops being usable.

## Who owns what

- The **owner session** stores and settles the request. A child agent owns its
  own request even when a parent shows that request to the channel.
- The **originating actor** is the user whose turn created the request.
- The **current actor** is the user sending the new message or response.

These are different identities. Session admission does not grant permission to
change a HITL request.

## Rules

### Pending requests never block

A HITL request waits out of band. It is not a gate on the session.

An unrelated message runs as a normal turn and emits `message.received` before
the next `session.waiting`, `session.completed`, or `session.failed`. There is
no outcome where eve stores the message and waits silently.

This works because the unresolved approval suffix is already kept out of
committed history; only the pending batch holds it
([`tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts#L2098-L2131)). The
transcript stays valid without the approval. Blocking is a policy choice in
`resolvePendingInput`, not an AI SDK requirement.

A request response and a message may arrive together. Handle them separately:
the response follows the request events from PR #1368; the message still runs
as a normal turn.

### Unrelated messages do not change requests

Only an explicitly correlated response may settle a request. The configured
response policy must allow that response first.

An unrelated message leaves the request exactly as it was. This includes text
such as `approve`: match text only after establishing the current actor and
checking whether text responses are allowed for that request.

One exception, declared by the owning tool: `ask_question` lets a follow-up
message from the originating actor supersede its own question. That emits
`input.dismissed` with reason `superseded`. Approvals never do this.

### Answer late, answer fine

A pending request stays answerable after other turns run. When a valid
authorized response arrives, eve splices the stored approval suffix plus the
response into the transcript at that point, exactly as resume works today
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L186-L239)).

"Stale" changes meaning: a response is stale only when its request is no longer
pending, not merely because other turns ran in between.

One constraint: requests raised by the same model step share one stored suffix,
so they form a **suffix group**. Each request in the group keeps its own
lifecycle, but the suffix splices into the transcript once, when the last
member settles or dismisses. An approved tool in a group therefore runs only
after its sibling requests close. Splicing per member would either duplicate
the assistant tool-call message or leave a sibling's call dangling; the AI
SDK's prompt conversion throws `MissingToolResultsError` for a dangling call
without an approval response (`convert-to-language-model-prompt.ts` in
`ai@7.0.38`).

## Show the whole request lifecycle

Channels cannot keep native prompts accurate unless eve tells them when a
request appears and when it disappears.

### Request created

Every nonautomatic approval that can wait for a person must become an
`InputRequest` and emit `input.requested` before eve can wait, route, or dismiss
it.

### Request dismissed

Emit `input.dismissed` whenever a request stops being actionable without the
normal response settlement from PR #1368.

```text
input.requested
  -> normal settlement event from PR #1368
  or
  -> input.dismissed
```

The event carries the request ID, a reason, and whether eve dismissed the owned
request or only an upstream copy. If a parent drops a child's routed copy, it
emits `input.dismissed` before forgetting it. This tells the channel to remove
the prompt without claiming that the child settled its request.

The reasons are:

- `superseded`: a newer prompt or follow-up replaced the request under the
  owner's declared rule (questions dismissed by their originating actor;
  session-limit prompts replaced by a re-prompt);
- `cancelled`: the turn or session holding the request was cancelled;
- `session-ended`: the session timed out, completed, or failed with the request
  still open;
- `route-lost`: a parent dropped its routed copy of a child request
  (projection scope only).

## Expected behavior

| Existing request | New input                               | Request after input     | Message outcome  |
| ---------------- | --------------------------------------- | ----------------------- | ---------------- |
| A's request      | Valid authorized response from A        | Settled                 | Consumed         |
| A's request      | Valid authorized response from B        | Settled                 | Consumed         |
| A's request      | Invalid or unauthorized response        | Unchanged               | Rejected visibly |
| A's approval     | Unrelated message from A                | Unchanged, still open   | Runs as a turn   |
| A's approval     | Unrelated message from B                | Unchanged, still open   | Runs as a turn   |
| A's question     | Unrelated message from A                | Dismissed as superseded | Runs as a turn   |
| A's question     | Unrelated message from B                | Unchanged, still open   | Runs as a turn   |
| Any request      | Response to a request no longer pending | Change no request       | Rejected visibly |

Session limits are not part of this table. A session-limit prompt is a runtime
gate, not an ownable request. While the violation holds, a new delivery must
get a fresh prompt as its visible outcome instead of queueing behind a stale
one; the cancellation path already works this way
([`settle-cancelled-turn-step.ts`](../packages/eve/src/execution/settle-cancelled-turn-step.ts#L123-L139)).
Session-limit prompts do emit `input.requested` today
([`session-limit-enforcement.ts`](../packages/eve/src/harness/session-limit-enforcement.ts#L157-L164)),
so a re-prompt closes the previous prompt with
`input.dismissed(superseded)` rather than duplicating an open one.

## What implementation needs

Two structural changes carry all of this:

1. **Pending requests become a collection.** Today one singleton batch holds
   the whole pending state
   ([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L394-L405)).
   If a later turn raises its own HITL while an earlier request is open, the
   batch would be overwritten. Key pending requests by `requestId`, each with
   its stored approval suffix and originating actor.
2. **Requests bind their originating actor.** Snapshot the verified
   `{ issuer, principalId }` at request creation. When the channel has no
   verified principal, treat all deliveries in the session as the same actor.
   Coalescing must not merge deliveries from different actors into one turn
   input.

The acceptance gate for the late splice is an integration test extending
[`tool-loop-generate-approval-resume.integration.test.ts`](../packages/eve/src/harness/tool-loop-generate-approval-resume.integration.test.ts)
with a normal turn between the approval request and its response. SDK core
accepts the resulting consecutive-assistant shape; provider converters are the
remaining risk to verify.

## Current behavior to remove

The originating actor is not bound to `InputRequest` today. `SessionTurn`
contains only `id` and `sequence`, and `InputRequest` has no actor:

- [`SessionTurn`](../packages/eve/src/channel/types.ts#L76-L85)
- [`InputRequest`](../packages/eve/src/runtime/input/types.ts#L39-L71)

The current harness marks approvals as `"required"` and questions as
`"dismissable"`, without considering the current actor
([`classifyInputRequest`](../packages/eve/src/harness/input-request-class.ts#L27-L44)).

An unrelated message behind a required request is compacted into
`deferredStepInput`; the model is not called and the session waits again
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L150-L162),
[`tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts#L680-L700)).

Questions instead resolve as ignored and the message continues
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L164-L183)).

A runtime action can return before an extracted approval is persisted and
emitted
([`tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts#L2034-L2118)).
Approval extraction also skips a request when its tool-call metadata cannot be
recovered
([`input-extraction.ts`](../packages/eve/src/harness/input-extraction.ts#L146-L151)).
Both paths must recover and expose the request or fail the turn explicitly.

For child agents, descendant cancellation can fail while the parent continues
([`cancel-descendant-turns-step.ts`](../packages/eve/src/execution/cancel-descendant-turns-step.ts#L96-L120)).
The parent currently clears every routed request afterward without telling the
channel
([`settle-cancelled-turn-step.ts`](../packages/eve/src/execution/settle-cancelled-turn-step.ts#L123-L139)).
The parent also drops all prior routes for a child whenever that child raises a
fresh request batch
([`proxy-input-requests.ts`](../packages/eve/src/harness/proxy-input-requests.ts#L44-L66)).
Under this design a child keeps running turns while old requests stay pending,
so routes must accumulate per request and close only with a settlement or
`input.dismissed`.

The server has no authoritative response event. `client.input.responded` is
only a client-side optimistic update
([`ClientInputRespondedEvent`](../packages/eve/src/client/reducer.ts#L33-L52)).

## Related work

- [PR #1368](https://github.com/vercel/eve/pull/1368): responder identity,
  authorization, Allow, Cancel, and request settlement.
- [PR #1231](https://github.com/vercel/eve/pull/1231): makes every message
  replace unresolved input. Replacing another actor's request breaks ownership.
- [PR #142](https://github.com/vercel/eve/pull/142): Slack-specific responder
  enforcement.

## Decisions

1. **Unrelated messages run as normal turns.** The pending request stays
   unanswered; nothing is rejected or deferred. The transcript already excludes
   the unresolved approval, so this needs no transcript branching.
2. **Actor identity is the verified principal.** Bind `{ issuer, principalId }`
   to the request at creation. No verified principal means single-actor
   session.
3. **Dismissal reasons are `superseded`, `cancelled`, `session-ended`, and
   `route-lost`.** The event's scope says whether the owned request closed or
   only a routed copy did.
4. **Batches are per-request.** `input.requested` already carries an array;
   each request settles or dismisses independently, and each appears exactly
   once as created and at most once as closed on every stream.
