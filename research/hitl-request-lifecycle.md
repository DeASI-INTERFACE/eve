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

1. **Never hide a user message.** Process it or reject it visibly before eve
   waits again.
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

### Every message gets an outcome

Before the next `session.waiting`, `session.completed`, or `session.failed`, an
accepted user message must produce one of:

- `message.received`: eve forwarded it into a turn;
- `message.rejected`: eve did not forward it and tells the channel why.

There is no third outcome where eve stores the message and waits silently.

A request response and a message may arrive together. Handle them separately:
the response follows the request events from PR #1368; the message still emits
`message.received` or `message.rejected`.

### Unrelated messages do not change requests

Only an explicitly correlated response may settle a request. The configured
response policy must allow that response first.

An unrelated message leaves the request exactly as it was. This includes text
such as `approve`: match text only after establishing the current actor and
checking whether text responses are allowed for that request.

### Keep requests usable

If a response is rejected, the same request remains available to a later valid
responder. Keep its owner, ID, originating actor, and suspended transcript.

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

The event carries the request ID, a stable reason, and whether eve dismissed
the owned request or only an upstream copy. If a parent drops a child's routed
copy, it emits `input.dismissed` before forgetting it. This tells the channel to
remove the prompt without claiming that the child settled its request.

## Expected behavior

| Existing request | New input                        | Request after input | Message outcome                         |
| ---------------- | -------------------------------- | ------------------- | --------------------------------------- |
| A's request      | Valid authorized response from A | Settled             | Consumed                                |
| A's request      | Valid authorized response from B | Settled             | Consumed                                |
| A's request      | Invalid or unauthorized response | Unchanged           | Rejected visibly                        |
| A's request      | Unrelated message from A         | Unchanged           | Rejected visibly                        |
| A's request      | Unrelated message from B         | Unchanged           | Process independently or reject visibly |
| Any request      | Stale request ID                 | Unchanged           | Rejected visibly                        |

The safe behavior today is visible rejection. Processing an unrelated message
while preserving the request needs transcript isolation.

## Why independent processing is hard

The AI SDK cannot continue the same transcript past an unresolved approval.
Eve stores the approval suffix outside committed history and adds it back only
with the matching approval response
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L186-L239)).

To process B's message while preserving A's request, eve needs an independent
transcript path. That could be another turn head or another session. This
document does not pick the implementation.

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

## Open questions

1. Reject unrelated messages or process them on an isolated transcript?
2. What stable actor identity should be stored with the request?
3. Which dismissal reasons do channels need?
4. How should mixed request batches appear and close upstream?
