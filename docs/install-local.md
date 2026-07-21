# Installing DoneWise locally

## Prerequisites

- GNOME Shell **46–50** (`gnome-shell --version`)
- `gnome-extensions` CLI and `glib-compile-schemas` (part of GNOME / `libglib2.0-bin`)
- `make`
- Optional, for the test suites: `gjs` (extension tests) and Go ≥ 1.24 (adapter tests)

## Install the extension

From the repo root:

```sh
make install
```

This compiles the GSettings schema, packs `src/` into
`dist/done-wise@blackeyedhatman.com.shell-extension.zip`, and installs it to
`~/.local/share/gnome-shell/extensions/`.

GNOME Shell only picks up newly installed extensions on session start:

- **Wayland**: log out and back in.
- **X11**: restarting the shell (Alt+F2, `r`, Enter) is enough.

Then enable it:

```sh
gnome-extensions enable done-wise@blackeyedhatman.com
```

The DoneWise checklist icon appears in the top bar. Click it: quick-add a
task with the entry (Enter adds and keeps the popup open), tick tasks off by
clicking their row, and manage groups via "＋ New group" and the ✎ button on
each group header.

## Configure (optional — AI provider sync)

Open the popup → ⚙ gear (or `gnome-extensions prefs done-wise@blackeyedhatman.com`):

- **Provider URL** — base URL of a service implementing the
  [provider contract](provider-contract.md) (e.g. a deployed
  [reference adapter](../adapter/)). Leave empty for standalone use.
- **App token** — the provider's `DONEWISE_APP_TOKEN`.
- **Poll interval** and **completed-task retention** to taste.

To try sync locally without a cluster, run the adapter on your machine:

```sh
cd adapter
DONEWISE_APP_TOKEN=app DONEWISE_AGENT_TOKEN=agent \
DONEWISE_DATA_DIR=/tmp/done-wise DONEWISE_LISTEN_ADDR=:8080 go run .
```

then set Provider URL `http://localhost:8080` and token `app`. Play the agent
role yourself with `adapter/hack/smoke.sh` or curl (see the
[agent integration guide](agent-integration-guide.md)).

## Try it in a nested shell (no logout needed)

```sh
make install
make nested            # nested Wayland GNOME Shell in a window
# inside the nested session's terminal:
gnome-extensions enable done-wise@blackeyedhatman.com
```

Logs while testing: `journalctl -f -o cat /usr/bin/gnome-shell` (look for
`[done-wise]` lines).

## Where state lives

- Board data: `~/.local/state/done-wise/board.json` (survives reboots;
  completed tasks purge after the retention window)
- Settings: dconf under `/org/gnome/shell/extensions/done-wise/`

## Uninstall

```sh
make uninstall                       # or: gnome-extensions uninstall done-wise@blackeyedhatman.com
rm -rf ~/.local/state/done-wise      # optional: remove board data
```

## Run the test suites

```sh
make test           # extension pure-logic tests (gjs)
make test-adapter   # adapter tests (Go)
```
