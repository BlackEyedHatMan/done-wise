# DoneWise — GNOME App Plan

*Design inspiration: [`docs/artwork/done-wise-app-design.png`](artwork/done-wise-app-design.png).*

## What DoneWise is

DoneWise is a GNOME top-bar todo app. Clicking the panel icon opens a popup showing all
tasks organised into named **context groups** (a project, "Work", whatever fits), each
group carrying a **priority** rendered as a red / amber / green accent. Tasks are ticked
off directly in the popup; a quick-add entry captures new ones.

Groupings and priorities can be decided by an **AI agent** — but the app is
**agent-agnostic**. Used alone, you add tasks, create groups, and set group priorities
manually. Plug in an agent (any agent) and it takes over naming, grouping, prioritising,
and ordering, via a small documented REST contract. The first consumer is *Estelle*,
a Hermes personal-assistant agent running on a home-lab Kubernetes cluster.

### Deliberate scope cuts (vs the mockup)

- No main window, no left sidebar (Inbox/Today/Planned/Projects/Done), no tags pane.
  The popup **is** the app.
- No Now/Next/Later buckets and no per-task priority pills — the AI (or the user)
  expresses priority at the *group* level only.
- Group accent colours are red/amber/green (priority), not arbitrary tag colours.

## Architecture decisions

### 1. "System tray" ⇒ GNOME Shell extension

GNOME has no real system tray; a persistent top-bar icon with a popup is only cleanly
achievable as a **GNOME Shell extension** (`PanelMenu.Button` + `PopupMenu`, running
inside the shell). Same conclusion and stack as the sibling scroll-scold project:
GJS/ESM, shell versions 46–50, GTK4/libadwaita prefs in a separate process, packed
with `gnome-extensions pack`.

### 2. The app owns its board

All state lives locally in `~/.local/state/done-wise/board.json` — "temporary but
persistent": it survives reboots, and completed tasks are purged on a rolling cycle
(default 7 days after their completion has been acknowledged). No long-term archive.

### 3. Agents integrate via a pull-based provider contract

A desktop is a poor server (asleep or off at any time), so agents never push to it.
Instead DoneWise **polls** a provider endpoint implementing the open contract in
[`provider-contract.md`](provider-contract.md), and pushes back completions and newly
added tasks. No provider configured ⇒ pure standalone mode.

- The provider holds the shared **board**; the agent reorganises it on its own schedule
  ("periodic librarian" — see [`agent-integration-guide.md`](agent-integration-guide.md)).
- A reference provider (the **adapter**, `adapter/`) ships in this repo: a small Go
  service any agent operator can deploy; the agent drives it with a handful of `curl`
  calls.
- Division of authority: the **app owns done-state and task creation**; the **agent owns
  grouping, group names/priorities, ordering, and titles**. The adapter enforces this.

### 4. Estelle (first consumer — lives outside this repo)

Estelle's only native API is an LLM chat endpoint (slow, budget-capped) and her todo
state is freeform markdown — unusable for polling. Her operator deploys the adapter to
the cluster and updates her todo skill to curl it. All of that wiring (kustomize
overlay, ArgoCD Application, secrets, skill update) belongs to her repo, not this one.

## UI design (popup)

```
┌──────────────────────────────────┐
│ DoneWise              ● sync  ⚙ │   header: title, sync-status dot, prefs gear
├──────────────────────────────────┤
│ [ Add a task…               ]    │   quick-add St.Entry (Enter adds, stays open)
├──────────────────────────────────┤
│ ▌Inbox                        2  │   virtual group (ungrouped), neutral accent
│   ☐ new thing I just typed       │
│ ▌Client proposal              3  │   ▌= 4px accent bar, red (high priority)
│   ☐ reply to client           ⋯ │   ⋯ expands inline: move/reorder/delete
│   ☑ finalise roadmap             │   done: dimmed, drops to bottom on rebuild
│ ▌Errands                      2  │   amber (medium) …scrolls when long
├──────────────────────────────────┤
│ ＋ New group                     │   inline entry; new groups default medium
└──────────────────────────────────┘
```

Key popup mechanics (each is a known GNOME gotcha, handled deliberately):

- **Checkbox rows never close the menu** — the row overrides `activate()` without
  chaining to the base implementation (which closes the menu).
- **Quick-add focus** — the entry sits in a non-reactive menu item; keyboard focus is
  grabbed via an idle-deferred `global.stage.set_key_focus()` when the menu opens.
- **Scrolling** — group sections live in an `St.ScrollView` whose `max-height` is capped
  at ~60 % of the monitor work area when the menu opens.
- **In-place ticking** — check/uncheck updates the row directly; done tasks only sink to
  the bottom of their section on the next structural rebuild, so rows never jump under
  the pointer.
- Local groups get inline edit controls (rename, priority cycle, reorder, delete);
  provider-owned groups render header-only — their structure belongs to the agent.

## Module layout

```
src/
├── metadata.json            uuid done-wise@blackeyedhatman.com, shell 46–50
├── extension.js             wiring/lifecycle only
├── prefs.js                 GTK4/Adw preferences entry (separate process)
├── stylesheet.css
├── lib/
│   ├── constants.js         PURE  priorities, RAG colours, defaults
│   ├── board.js             PURE  board model + every mutation
│   ├── retention.js         PURE  rolling purge of done tasks
│   ├── syncProtocol.js      PURE  wire parsing + reconciliation (only wire-aware file)
│   ├── store.js             glue  async atomic JSON persistence, debounced save
│   ├── syncClient.js        glue  Soup 3 HTTP client (bearer, ETag)
│   ├── syncEngine.js        glue  push-then-pull cycle, backoff
│   ├── indicator.js         glue  panel button + menu shell
│   └── popup/               boardMenu, taskRow, groupHeader, quickAdd
├── prefsPages/generalPage.js
├── schemas/…gschema.xml
└── icons/                   done-wise-symbolic.svg (+ error variant)
tests/                       testBoard.js, testRetention.js, testSyncProtocol.js
adapter/                     Go reference provider (own README)
```

Pure modules are gi-free (injectable id-generator/clock) so they run under bare
`gjs -m` in tests; shell glue is kept thin. Persistence follows the scroll-scold rule:
GSettings for settings only, hot data in an async atomically-replaced JSON state file —
never dconf, never synchronous IO in shell code.

## Local data model (`board.json`)

```json
{
  "version": 1,
  "groups": [{"id": "…", "name": "Work", "priority": "high", "position": 0,
              "providerId": "g-work"}],
  "tasks":  [{"id": "uuid", "title": "…", "groupId": "…|null", "position": 0,
              "done": false, "completedAt": null, "createdAt": 0,
              "providerId": "uuid|null", "doneDirty": false,
              "lastProvider": {"groupId": "…", "position": 0, "done": false,
                               "title": "…"}}],
  "sync": {"lastSyncAt": null, "etag": null, "lastError": null}
}
```

- **Inbox is virtual**: `groupId: null`. It is never in `groups[]`, so no provider can
  rename or delete it.
- **The offline queue is derived, not stored**: pending creations are tasks with
  `providerId === null`; pending done-flips are `doneDirty === true`. One file holds
  everything, so the queue survives reboots for free and replay is idempotent.
- **IDs**: the app mints UUIDv4s which double as the wire task id (`POST /v1/tasks` is
  idempotent on id). `lastProvider` is the base snapshot for three-way merges.

## Sync behaviour (app side)

- Poll cycle (only when a provider URL is configured): **push then pull** — replay
  pending creates, then pending done-PATCHes, then `GET /v1/board` with
  `If-None-Match` (`304` ⇒ done) → parse → reconcile → save → refresh UI.
- Reconciliation: provider groups mirrored verbatim each pull; local-only groups always
  survive; provider wins on grouping/order/title **only when it actually changed them**
  since the last pull (three-way vs `lastProvider`); local `done` survives until its
  PATCH lands; a `404` on PATCH means the agent already archived the task —
  treated as acknowledged; unticking an archived task re-creates it as a new task.
- Errors: 401/403 → error icon, stop until settings change; network/5xx → exponential
  backoff (×2, capped 15 min). Local add/complete kicks a debounced push so changes
  reach the provider promptly between polls.

## Retention

`purge()` removes done tasks older than `retention-days` (default 7) — in synced mode
only once acknowledged. Runs at startup, every 6 h, and after each successful sync.

## Settings (GSettings `org.gnome.shell.extensions.done-wise`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `provider-url` | s | `""` | empty ⇒ standalone mode |
| `provider-token` | s | `""` | bearer token (plaintext in dconf — see README) |
| `poll-interval-seconds` | i | 300 | 30–3600 |
| `retention-days` | i | 7 | 1–90 |

## Testing & verification

- `make test` — pure-module suites under `gjs -m`: board mutation matrix, retention
  boundaries, sync parse-tolerance fixtures and the full reconcile matrix.
- `go test ./...` in `adapter/` — merge table tests + httptest contract tests;
  `adapter/hack/smoke.sh` curls a full day's flow and doubles as a conformance script
  for third-party providers.
- Manual: `make install` then `make nested` (nested Wayland shell), enable the
  extension, exercise the standalone and sync matrices; logs via
  `journalctl -f -o cat /usr/bin/gnome-shell`.

## Build order

1. Docs (this file, the contract, the agent guide) — committed first.
2. Extension scaffold (metadata, schema, Makefile, bare indicator).
3. Pure core + tests (board, retention).
4. Persistence (store) and popup UI (read-only → fully interactive).
5. Sync protocol + tests, then the Go adapter, then client/engine end-to-end.
6. Prefs page, icons, README.
7. *(outside this repo)* Estelle wiring: adapter overlay + ArgoCD app + skill update.
