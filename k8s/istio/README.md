# Istio service mesh (mTLS)

Istio is used to enforce **mTLS** between all workloads in the `observability` namespace: apps (order, inventory, frontend, payment, notification), **otel-collector**, postgres, Jaeger, Prometheus, Grafana, and Elasticsearch. Traffic between them is encrypted and mutually authenticated by Istio sidecars.

## Prerequisites

- Kind cluster running (`kind create cluster --config k8s/kind-config.yaml`)
- [istioctl](https://istio.io/latest/docs/setup/getting-started/#download) in your PATH

## Install Istio

From the repo root:

```bash
./scripts/install-istio-kind.sh
```

Or manually:

```bash
istioctl install -f k8s/istio/install-istio-operator.yaml -y
kubectl label namespace observability istio-injection=enabled --overwrite
kubectl apply -f k8s/istio/peer-authentication.yaml
kubectl apply -f k8s/istio/destination-rule.yaml
```

## Apply order with Istio

1. Create cluster and install Istio **before** deploying app workloads so pods get sidecars from the start:
   ```bash
   kubectl apply -f k8s/namespace.yaml
   ./scripts/install-istio-kind.sh
   ```
2. Then apply the rest in the usual order (configmaps, kind-postgres-storage, postgres secret, postgres, observability-stack, application-services).
3. If you added Istio **after** workloads were already running, restart them so they get injected:
   ```bash
   kubectl rollout restart deployment,statefulset -n observability --all
   ```

## Verify mTLS

- Pods should show **2/2** containers (app + `istio-proxy`):
  ```bash
  kubectl get pods -n observability
  ```
- Check that a pod is using mTLS:
  ```bash
  istioctl x describe pod <pod-name> -n observability
  ```
  You should see "mTLS" in the traffic policy.

## Optional: exclude Postgres from the mesh

If the Postgres StatefulSet has readiness issues (e.g. sidecar not ready), you can skip injection for it only. Edit `k8s/postgres.yaml` and add to the **pod template** `spec`:

```yaml
metadata:
  annotations:
    sidecar.istio.io/inject: "false"
```

Then other apps will talk to Postgres over plain TCP (still within the cluster); all other traffic (app ↔ collector, app ↔ app) remains mTLS.

## EKS

Use the same manifests. Install Istio (e.g. via `istioctl install` or Helm) in the cluster, label the namespace, and apply `peer-authentication.yaml` and `destination-rule.yaml`. The ingress gateway can stay as LoadBalancer on EKS.
