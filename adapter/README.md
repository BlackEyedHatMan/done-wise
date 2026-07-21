# DoneWise reference adapter

A tiny always-on service implementing the [DoneWise provider
contract](../docs/provider-contract.md). It holds the shared board; the
[DoneWise GNOME extension](../README.md) polls it, and an AI agent reorganises
it with a handful of `curl` calls (see the [agent integration
guide](../docs/agent-integration-guide.md)).

Go stdlib only — a single static binary. Storage is one JSON file
(`board.json`, written atomically, previous copy kept as `board.json.bak`).

## Configuration (env vars)

| Variable | Default | |
|---|---|---|
| `DONEWISE_APP_TOKEN` | — | **required**; bearer token for the desktop app |
| `DONEWISE_AGENT_TOKEN` | *(unset)* | bearer token for the agent; gates `PUT /v1/board`. Unset ⇒ the app token has full access |
| `DONEWISE_DATA_DIR` | `/data` | where `board.json` lives |
| `DONEWISE_LISTEN_ADDR` | `:8080` | |
| `DONEWISE_DONE_RETENTION_DAYS` | `0` (never) | agentless tidy-up of old done tasks |

## Run locally

```sh
DONEWISE_APP_TOKEN=app DONEWISE_AGENT_TOKEN=agent \
DONEWISE_DATA_DIR=/tmp/done-wise DONEWISE_LISTEN_ADDR=:8080 \
go run .
```

Smoke-test it (also works as a conformance check for *any* provider
implementation):

```sh
BASE=http://localhost:8080 APP_TOKEN=app AGENT_TOKEN=agent ./hack/smoke.sh
```

Tests: `go test ./...`

## Container

```sh
docker build -t done-wise-adapter .
docker run -p 8080:8080 -v done-wise-data:/data \
  -e DONEWISE_APP_TOKEN=… -e DONEWISE_AGENT_TOKEN=… done-wise-adapter
```

## Kubernetes

`deploy/kustomize/base/` is a generic Deployment + Service + PVC;
`deploy/kustomize/example-overlay/` shows an ingress and image pin. Tokens
come from a manually created Secret (never in git):

```sh
kubectl -n <namespace> create secret generic done-wise-secrets \
  --from-literal=DONEWISE_APP_TOKEN=… \
  --from-literal=DONEWISE_AGENT_TOKEN=…
```

Consume the base remotely from your own repo:

```yaml
resources:
  - github.com/BlackEyedHatMan/done-wise//adapter/deploy/kustomize/base?ref=main
```
