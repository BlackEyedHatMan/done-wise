# Deploying the adapter to the octal cluster

The adapter deploys with the same GitOps loop as expense-tracker (the
"plot-forge pattern"):

```
push to main (adapter/** changed)
  → GitHub Actions builds linux/arm64 image → pushes ghcr.io/blackeyedhatman/done-wise-adapter:sha-<short>
  → CI seds the tag into deploy/k8s/app.yaml and bot-commits
  → ArgoCD (auto-sync, selfHeal, prune on deploy/k8s) rolls the cluster
```

- Manifests: plain YAML in [`deploy/k8s/`](../deploy/k8s/) (namespace, NFS PV/PVC,
  Deployment+Service, contour Ingress `done-wise.octal.castlenet.local`).
- ArgoCD `AppProject` + `Application`: [`argo-cd/`](../argo-cd/), applied by hand once.
  Unlike expense-tracker, the `repoURL` is **HTTPS**: done-wise is public, so no
  SSH deploy-key credential is needed in the `argocd` namespace.
- Secrets: manual, documented in [`deploy/secret.example.yaml`](../deploy/secret.example.yaml).
- The kustomize tree in [`adapter/deploy/kustomize/`](../adapter/deploy/kustomize/)
  is **not** used by this cluster — it is the generic example for third-party
  adopters of the provider contract.

## First rollout (one-time, in order)

1. **GHCR PAT** — GitHub → repo *Settings → Secrets and variables → Actions* →
   new secret `GHCR_PAT` (a PAT with `write:packages`; deliberately not
   `GITHUB_TOKEN` — first-push package ownership). Then push (or re-run the
   `build-deploy` workflow) so the image exists and the manifest tag is bumped.
2. **NFS directory** (cluster master) — run the one-shot pod from the header
   comment of [`deploy/k8s/pv.yaml`](../deploy/k8s/pv.yaml) to create
   `/srv/nfs/k8s/done-wise/data` (root is owned 2000:3000; no operator SSH needed).
3. `kubectl apply -f argo-cd/project.yml`
4. **Secrets** — the two `kubectl create secret` commands in
   [`deploy/secret.example.yaml`](../deploy/secret.example.yaml)
   (`ghcr-pull` + `done-wise-secrets`; generate tokens with `openssl rand -hex 32`).
5. `kubectl apply -f argo-cd/application.yml` — ArgoCD syncs everything.
6. **LAN wiring** — bind9 A record (covered by the existing `*.octal` wildcard)
   and an nginx-proxy-manager proxy host for `done-wise.octal.castlenet.local`
   → worker NodePort `:30080` (same shape as the other octal apps). Without the
   NPM host entry the name lands on NPM's default page.
7. **Smoke it**:
   `BASE=https://done-wise.octal.castlenet.local APP_TOKEN=… AGENT_TOKEN=… adapter/hack/smoke.sh`
8. **Point the app at it** — DoneWise popup → ⚙: Provider URL
   `https://done-wise.octal.castlenet.local`, App token from step 4.

## Day-2

- Adapter code change → merge to main → CI + ArgoCD do the rest.
- Manifest-only change (`deploy/k8s/**`) → just push; ArgoCD syncs it
  (CI does not rebuild — the workflow only triggers on `adapter/**`).
- Board data lives on the NFS export (`done-wise/data/board.json`, atomic
  writes + `.bak`); it is covered by whatever backs up `/srv/nfs/k8s`.
