#!/usr/bin/env bash
# Deploy stealth-browser to the k3s cluster. Requires kubectl, jq, openssl.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=stealth-browser

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# Reuse the working pull secret from ai-listings on every run.
kubectl get secret ghcr-credentials -n ai-listings -o json \
  | jq 'del(.metadata.namespace,.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.ownerReferences,.metadata.managedFields,.metadata.annotations)' \
  | kubectl apply -n "$NS" -f -

# Generate secrets once; never rotate on redeploy.
if ! kubectl get secret stealth-browser-secrets -n "$NS" >/dev/null 2>&1; then
  kubectl create secret generic stealth-browser-secrets -n "$NS" \
    --from-literal=gatewayToken="$(openssl rand -hex 24)" \
    --from-literal=wsPath="$(openssl rand -hex 24)"
fi

# The fingerprint lives outside deploy/k8s, so kustomize needs its load restrictor off.
kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s | kubectl apply -f -
kubectl -n "$NS" rollout status deploy/camoufox --timeout=300s
kubectl -n "$NS" rollout status deploy/gateway --timeout=300s

echo "Read the token with:"
echo "  kubectl get secret stealth-browser-secrets -n $NS -o jsonpath='{.data.gatewayToken}' | base64 -d"
