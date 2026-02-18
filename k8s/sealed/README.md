# Sealed Secrets for Postgres

Credentials must **not** be stored in plain YAML in Git. Use [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) so only encrypted values are committed.

## Prerequisites

1. Install the Sealed Secrets controller in the cluster:
   ```bash
   kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.24.5/controller.yaml
   ```
2. Install `kubeseal` locally:
   - macOS: `brew install kubeseal`
   - Or see https://github.com/bitnami-labs/sealed-secrets/releases

## Create and seal the Postgres secret

### Option A: From environment variables (recommended)

```bash
# Set these in your environment (or .env file - never commit .env)
export POSTGRES_USER=app
export POSTGRES_PASSWORD=your-secure-password
export POSTGRES_DB=observability_demo

./scripts/create-sealed-postgres-secret.sh
```

This writes `k8s/sealed/postgres-credentials.sealed.yaml`. Commit that file (it is encrypted).

### Option B: From the template file

1. Copy the template and fill in real values (only on your machine, never commit):
   ```bash
   cp k8s/secrets/postgres-credentials.template.yaml k8s/secrets/postgres-credentials.yaml
   # Edit k8s/secrets/postgres-credentials.yaml (this file is gitignored)
   ```
2. Seal it:
   ```bash
   kubeseal -f k8s/secrets/postgres-credentials.yaml -w k8s/sealed/postgres-credentials.sealed.yaml
   ```
3. Apply the sealed secret, then the rest of the stack:
   ```bash
   kubectl apply -f k8s/sealed/postgres-credentials.sealed.yaml
   kubectl apply -f k8s/postgres.yaml
   # ... rest of apply order
   ```

## Local Kind without Sealed Secrets

For a quick local Kind run without installing Sealed Secrets, create the secret once from env (do not commit):

```bash
kubectl create secret generic postgres-credentials -n observability \
  --from-literal=POSTGRES_USER=app \
  --from-literal=POSTGRES_PASSWORD=appsecret \
  --from-literal=POSTGRES_DB=observability_demo \
  --from-literal=DATABASE_URL='postgresql://app:appsecret@postgres:5432/observability_demo'
```

Then apply `k8s/postgres.yaml` as usual. Pre-commit will still block any YAML in the repo that contains real secrets.
