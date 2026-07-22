# DoneWise Provider Contract (v1)

This document is the source of truth for how the DoneWise desktop app talks to a
**provider** — any service holding the shared todo board. The reference implementation
is the adapter in [`../adapter/`](../adapter/); anything that speaks this contract works.

Design constraints the contract serves:

- **The app pulls.** Desktops sleep and power off; nothing ever pushes to them.
- **The agent is slow and periodic.** An LLM agent reorganises the board on its own
  schedule (minutes to hours). The contract must tolerate a multi-minute agent
  read-modify-write overlapping live user activity.
- **Home-lab scale.** One user, one board, bearer tokens. No users, scopes, or paging.

## Data model

Order of every array is display order — there are no position fields.

### Task

```json
{
  "id": "3f6c1a9e-6e6d-4c1e-9d0a-2f4b8a7c5d21",
  "title": "buy printer paper",
  "done": false,
  "done_at": null,
  "created_at": "2026-07-21T09:12:00Z",
  "created_by": "user",
  "notes": ""
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique string. The app mints UUIDv4s; an agent may use any unique string. Never reused. |
| `title` | yes | 1–500 characters. The agent may rewrite it (tidy phrasing). |
| `done` | no (default `false`) | **App-owned** — see authority matrix. |
| `done_at` | — | RFC 3339 or `null`. Set/cleared by the provider when `done` flips. |
| `created_at` | — | RFC 3339. Set by the provider if omitted on create. |
| `created_by` | no | `"user"` or `"agent"`. Informative only. |
| `notes` | no | Free text, agent-writable. |

### Group

```json
{
  "id": "client-proposal",
  "name": "Client proposal",
  "priority": "high",
  "tasks": [ /* ordered Task objects */ ]
}
```

`id` is a stable string chosen by whoever creates the group (the provider slugifies
`name` if omitted on write). `priority` is `"high" | "medium" | "low"` — the app renders
these as red / amber / green. Keeping an `id` while changing `name` is a rename;
changing the `id` is a new group.

### Board

The only top-level document:

```json
{
  "version": 1,
  "revision": 42,
  "updated_at": "2026-07-21T10:00:00Z",
  "groups": [ /* ordered Group objects — agent-controlled order */ ],
  "inbox":  [ /* ordered Task objects not yet grouped */ ]
}
```

`revision` is a monotonic integer bumped by the provider on **every** mutation.
`inbox` is deliberately *not* a group (no name, no priority): the app renders it
specially, and "ungrouped" can never be confused with a real group.

## Authentication

Two bearer tokens, sent as `Authorization: Bearer <token>`:

- **app token** — the desktop app. May not call `PUT /v1/board`.
- **agent token** — the agent. Full access.

If the provider is configured without an agent token, the app token has full access
(standalone/testing). That is the entire auth model.

## Endpoints

All under `/v1`. Requests and responses are `application/json`.

### `GET /v1/board` — app + agent

Returns the full board. The response carries `ETag: "<revision>"`; requests may send
`If-None-Match` and receive `304 Not Modified` when nothing changed. This makes the
app's 30–60 s poll effectively free, and lets an agent skip a run entirely.

### `POST /v1/tasks` — app (agents may also use it)

Create a task in the inbox. Body: `{"id": "<uuid>", "title": "..."}` (`id` optional —
provider mints one if absent; `created_by` optional).

**Idempotent on `id`**: replaying a create with an id the provider already has returns
`200` with the existing task instead of duplicating. This is what makes the app's
offline-queue replay safe. Response: the task object plus `"revision"`.

### `PATCH /v1/tasks/{id}` — app

Body: `{"done": true|false}` and/or `{"title": "..."}` — **no other fields**;
anything else is a `400`. The provider sets/clears `done_at` on done-flips. A `2xx`
response is the app's **sync acknowledgement** for the change. `404` if the task no
longer exists — the app must treat that as acknowledged (the agent already archived
it). Title PATCHes carry user-initiated renames; the agent may still rewrite titles
in a later `PUT` (see the authority matrix).

### `DELETE /v1/tasks/{id}` — app + agent

Remove a task (typo'd entry etc.). `404` means already gone and callers treat it as
success. Response: `{"revision": N}`.

### `PUT /v1/board` — agent only

The agent's bulk verb: replace the board's *organisation* in one call.

```json
{
  "base_revision": 42,
  "groups": [ /* full group list, ordered, with tasks */ ],
  "inbox":  [ /* remaining ungrouped tasks */ ]
}
```

`base_revision` (required) is the `revision` from the `GET` the agent worked from.
This is **not a blind overwrite** — the provider merges (below). Optional strict mode:
send `If-Match: "<revision>"` to get a `409` instead of a merge; usually unnecessary.

### `GET /healthz` — no auth

`200 {"status": "ok", "revision": N}`.

### Errors

Plain HTTP codes with `{"error": "<code>", "message": "..."}` bodies: `400` invalid
body, `401` bad/missing token, `403` app token on `PUT /v1/board`, `404` unknown task,
`409` failed `If-Match`, `413` body over 1 MiB.

## Authority and reconciliation

### Who owns what (provider-enforced, not honour-system)

| Field | Owner | Enforcement |
|---|---|---|
| Task creation | app (and agent) | `POST` → inbox; agent-new tasks arrive via `PUT` |
| `done`, `done_at` | **app** | On `PUT`, `done` in the payload is **ignored for tasks the provider already knows** — stored done-state always wins. (Unknown tasks may arrive `done: true`, e.g. imports.) |
| Grouping, order, group set/names/priorities, `notes` | **agent** | Only writable via `PUT`; `PATCH` accepts only `done` and `title` |
| `title` | shared | User renames arrive via `PATCH`; the agent's `PUT` may later rewrite (last write wins — renames are rare, tidying is the agent's job) |
| Task deletion | agent (by omission from `PUT`), either side via `DELETE` | See merge rule 2 |

### The merge (`PUT /v1/board` with `base_revision = B`)

The provider tracks, per task, the revision at which it first appeared
(`created_rev`). On `PUT`:

1. **Task in payload and known to the store** → organisation (group, order, title,
   notes) from the payload; `done`/`done_at` from the store. Always.
2. **Task in store but absent from the payload**:
   - `created_rev > B` — the agent never saw it (created mid-think) → **preserve it,
     place it in the inbox**.
   - `created_rev ≤ B` — the agent saw it and deliberately dropped it → **delete**
     (this is how completed tasks get archived).
3. **Task in payload but unknown** → create as given (mint an id if absent).
4. **Groups** are replaced wholesale from the payload — there is no app-owned group
   state.
5. Bump `revision` once; persist atomically.

This gives lock-free safety for the realistic race — a multi-minute agent run
overlapping user activity — without CAS retry loops.

### Consequences both sides must implement

- **Agent regroups a task the user just ticked** → rule 1: it moves, stays done.
- **App's queued `PATCH` gets `404`** → the agent archived it while the desktop was
  offline; the app records it as acknowledged and keeps its local struck-through view.
- **User unticks a task the agent already archived** → `PATCH` returns `404`; the app
  `POST`s a *new* task (same title, fresh id) which lands in the inbox for regrouping.
- **App offline queue** — the app replays queued `POST` / `PATCH` / `DELETE` in order
  *before* its next `GET`. `POST` is idempotent on id, `PATCH` sets absolute state,
  `DELETE` treats `404` as success: replay is therefore always safe.
- **Concurrent agents** are out of scope: one agent per board is assumed. The last
  `PUT` wins under the merge rules.

## Done-task lifecycle

1. User ticks → app `PATCH {"done": true}` → `2xx` = acknowledgement; the app records
   `synced_done_at` locally.
2. The agent sees the completion on its next `GET`, records it wherever it likes
   (its retention is its own business), and **archives it by omitting it** from its
   next `PUT` → the provider deletes it.
3. The app keeps showing the done task (struck through) even after it vanishes from
   the board, until 7 days after `synced_done_at`, then purges it locally.
4. Providers running agentless may set a retention option (see the adapter's
   `DONEWISE_DONE_RETENTION_DAYS`) to auto-drop old done tasks.

## Versioning

Path prefix `/v1` + `"version": 1` in the board document. A breaking change becomes
`/v2`. That is the whole policy. Providers must ignore unknown fields in requests, and
clients must ignore unknown fields in responses.
