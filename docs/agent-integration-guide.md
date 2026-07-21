# Plugging an AI agent into DoneWise

This guide is for agent developers: how to make *your* agent the brain behind
a DoneWise board. The wire details live in the [provider
contract](provider-contract.md); this is the working model and the loop.

## Mental model: you are a periodic librarian

The always-on component is the **provider** (deploy the [reference
adapter](../adapter/) or implement the contract yourself). It holds the board.
The desktop app polls it and pushes the user's completions and new tasks.
Nothing ever calls *you*, and you never push to the desktop — you visit the
board on your own schedule, tidy the shelves, and leave.

You own: group names, group priorities (`high`/`medium`/`low` → red/amber/
green in the app), which group each task is in, ordering, and titles. You do
**not** own done-state — the provider ignores any `done` you send for tasks it
already knows.

## Prerequisites

- A running provider and its base URL.
- Your `DONEWISE_AGENT_TOKEN` (the agent token, not the app token — yours can
  `PUT /v1/board`).

## The loop (the whole integration)

1. **Read** the board:

   ```sh
   curl -s $BASE/v1/board \
     -H "Authorization: Bearer $AGENT_TOKEN" \
     -H "If-None-Match: $LAST_ETAG"
   ```

   On `304` — nothing changed since your last visit; stop (this is what makes
   frequent cheap checks affordable even for an LLM agent: skip the whole
   run). Otherwise note the `ETag` and the body's `revision`.

2. **Understand what happened**: tasks in `inbox` are new (usually
   user-added, `created_by: "user"`); tasks with `"done": true` were completed
   — record them wherever your own memory lives *before* the next step.

3. **Reorganise**: decide groups, priorities, ordering, tidy titles. Archive
   completed tasks you have recorded by **omitting them** from your write.

4. **Write** the whole organisation back:

   ```sh
   curl -s -X PUT $BASE/v1/board \
     -H "Authorization: Bearer $AGENT_TOKEN" \
     -d '{
       "base_revision": '$REVISION',
       "groups": [
         {"id": "client-work", "name": "Client work", "priority": "high",
          "tasks": [{"id": "…", "title": "Reply to client about proposal"}]}
       ],
       "inbox": []
     }'
   ```

   `base_revision` must be the `revision` you read in step 1 — it protects
   tasks the user added while you were thinking (the provider preserves any
   task you never saw, instead of treating your omission as deletion).

## Rules you must respect

- **Never invent or rewrite task ids.** Keep the id you read; changing it is
  a delete plus an unrelated create.
- **Omission = archival.** Any task you saw (it existed at `base_revision`)
  and leave out of your `PUT` is deleted from the board. Record completions
  on your side first — the app purges its local copy after a week.
- **`done` you send is ignored** for existing tasks. To "complete" something
  from your side after acknowledgement, `PATCH` is app-only; instead simply
  archive it, or leave completion to the user.
- **One agent per board.** Concurrent agents are out of scope; last `PUT`
  wins.

## Occasionally useful

- Add a task yourself: `POST /v1/tasks` `{"title": "…", "created_by":
  "agent"}` (lands in the inbox; group it on your next pass) — or include it
  as a new task directly in your `PUT`.
- Remove a nonsense entry immediately: `DELETE /v1/tasks/{id}` (`404` =
  already gone, fine).
- Strict compare-and-swap: send `If-Match: "<revision>"` with your `PUT` to
  get a `409` instead of a merge. Usually unnecessary — the merge rules
  already protect user activity.

## Cadence

A few visits per day is plenty — after your morning planning, when a
conversation touches todos, before winding down. Users expect regrouping
"next time the agent thinks", not in real time; the app shows new tasks in
its Inbox until you group them.

## Conformance

Point [`adapter/hack/smoke.sh`](../adapter/hack/smoke.sh) at any provider
implementation to check the behaviours your loop depends on (idempotent
create, ETag flow, done-state authority, mid-think task preservation).
