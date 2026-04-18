#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Lattice — Azure bootstrap
#
# Creates all Azure resources required by the GitHub Actions deploy workflow:
#   - Resource group
#   - Log Analytics workspace (Container Apps diagnostics)
#   - Azure Container Registry
#   - Azure Database for PostgreSQL Flexible Server + database
#   - Container Apps environment + app (placeholder image)
#   - App Registration + federated credential for GitHub OIDC
#   - All the role assignments needed to wire them together
#
# Run once. Re-running is broadly idempotent (skips things that exist).
#
# Requirements: az CLI (logged in via `az login`), openssl, jq.
#
# Usage:
#   GITHUB_REPO=owner/lattice ./scripts/bootstrap-azure.sh
#
# Override any of: PRODUCT, ENV_NAME, LOCATION, SUBSCRIPTION, ACR, DB_SERVER,
# GITHUB_BRANCH. ACR and DB_SERVER names must be globally unique across Azure.
# =============================================================================

# ---- Config ----------------------------------------------------------------
PRODUCT="${PRODUCT:-lattice}"
ENV_NAME="${ENV_NAME:-prod}"
LOCATION="${LOCATION:-uksouth}"
SUBSCRIPTION="${SUBSCRIPTION:-DCWD}"

GITHUB_REPO="${GITHUB_REPO:?GITHUB_REPO=owner/name is required}"
GITHUB_BRANCH="${GITHUB_BRANCH:-master}"

# GitHub presents the canonical owner/repo casing in the OIDC token, and
# Azure AD matches the federated-credential subject case-sensitively. If the
# repo is public, ask the API for the real casing so we don't trip over it.
CANONICAL_REPO=$(curl -sfS "https://api.github.com/repos/${GITHUB_REPO}" 2>/dev/null | jq -r '.full_name // empty' || true)
if [[ -n "$CANONICAL_REPO" && "$CANONICAL_REPO" != "$GITHUB_REPO" ]]; then
  printf '\033[1;33m!\033[0m Normalising GITHUB_REPO case: %s -> %s\n' "$GITHUB_REPO" "$CANONICAL_REPO"
  GITHUB_REPO="$CANONICAL_REPO"
fi

RG="${PRODUCT}-${ENV_NAME}-rg"
LAW="${PRODUCT}-${ENV_NAME}-law"
# ACR: globally unique, alphanumeric only (no hyphens allowed).
ACR="${ACR:-${PRODUCT}${ENV_NAME}acr}"
DB_SERVER="${DB_SERVER:-${PRODUCT}-${ENV_NAME}-db}"
DB_NAME="lattice"
DB_USER="lattice"
CAE="${PRODUCT}-${ENV_NAME}-env"
APP="${PRODUCT}-${ENV_NAME}-app"
APP_REG="${PRODUCT}-${ENV_NAME}-github"
IMAGE_NAME="${PRODUCT}"
DB_PASSWORD_FILE=".azure-db-password.${ENV_NAME}"

# ---- Helpers ---------------------------------------------------------------
log() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

for cmd in az openssl jq; do
  command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
done

# ---- Subscription ----------------------------------------------------------
az account set --subscription "$SUBSCRIPTION" >/dev/null
SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
log "Subscription: $SUBSCRIPTION ($SUB_ID)"

# ---- Register required resource providers ----------------------------------
# Fresh/unused subscriptions don't have these enabled. Idempotent.
REQUIRED_PROVIDERS=(
  Microsoft.OperationalInsights
  Microsoft.ContainerRegistry
  Microsoft.DBforPostgreSQL
  Microsoft.App
  Microsoft.Insights
)
for provider in "${REQUIRED_PROVIDERS[@]}"; do
  state=$(az provider show --namespace "$provider" --query registrationState -o tsv 2>/dev/null || echo "NotRegistered")
  if [[ "$state" != "Registered" ]]; then
    log "Registering provider $provider (one-time, can take a minute)..."
    az provider register --namespace "$provider" --wait >/dev/null
  fi
done
ok "Resource providers registered"

# ---- Resource group --------------------------------------------------------
if ! az group show -n "$RG" >/dev/null 2>&1; then
  log "Creating resource group $RG in $LOCATION..."
  az group create -n "$RG" -l "$LOCATION" >/dev/null
fi
ok "RG $RG"

# ---- Log Analytics workspace ----------------------------------------------
if ! az monitor log-analytics workspace show -g "$RG" -n "$LAW" >/dev/null 2>&1; then
  log "Creating Log Analytics workspace $LAW..."
  az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOCATION" >/dev/null
fi
LAW_CUST_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)
LAW_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)
ok "Log Analytics $LAW"

# ---- ACR -------------------------------------------------------------------
if ! az acr show -n "$ACR" >/dev/null 2>&1; then
  log "Creating ACR $ACR (globally unique)..."
  az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled false >/dev/null \
    || die "ACR create failed — see error above. If it says 'already in use', set ACR=<unique name> and rerun."
fi
ACR_ID=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
ACR_SERVER=$(az acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)
ok "ACR $ACR ($ACR_SERVER)"

# ---- Postgres Flexible Server ---------------------------------------------
DB_HOST="${DB_SERVER}.postgres.database.azure.com"
if ! az postgres flexible-server show -g "$RG" -n "$DB_SERVER" >/dev/null 2>&1; then
  DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=\n' | cut -c1-28)
  log "Creating Postgres Flexible Server $DB_SERVER (Burstable B1ms, Postgres 16)..."
  az postgres flexible-server create \
    -g "$RG" -n "$DB_SERVER" -l "$LOCATION" \
    --admin-user "$DB_USER" --admin-password "$DB_PASSWORD" \
    --sku-name Standard_B1ms --tier Burstable \
    --storage-size 32 --version 16 \
    --public-access 0.0.0.0 \
    --yes >/dev/null \
    || die "Postgres create failed — see error above. If the name is taken, set DB_SERVER=<unique name> and rerun."
  umask 077
  printf '%s' "$DB_PASSWORD" > "$DB_PASSWORD_FILE"
  log "Saved DB password to $DB_PASSWORD_FILE (gitignored; keep safe)."
else
  if [[ -f "$DB_PASSWORD_FILE" ]]; then
    DB_PASSWORD=$(cat "$DB_PASSWORD_FILE")
  elif [[ -n "${DB_PASSWORD:-}" ]]; then
    :  # accepted from env
  else
    die "Postgres $DB_SERVER exists but $DB_PASSWORD_FILE not found. Set DB_PASSWORD=<...> and rerun."
  fi
fi

# Create database separately — works across az CLI versions (newer ones accept
# --database-name on server create; older ones don't).
if ! az postgres flexible-server db show -g "$RG" -s "$DB_SERVER" -d "$DB_NAME" >/dev/null 2>&1; then
  log "Creating database $DB_NAME on $DB_SERVER..."
  az postgres flexible-server db create -g "$RG" -s "$DB_SERVER" -d "$DB_NAME" >/dev/null
fi

DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"
ok "Postgres $DB_SERVER ($DB_HOST)"

# ---- Container Apps environment -------------------------------------------
if ! az containerapp env show -g "$RG" -n "$CAE" >/dev/null 2>&1; then
  log "Creating Container Apps environment $CAE..."
  az containerapp env create \
    -g "$RG" -n "$CAE" -l "$LOCATION" \
    --logs-workspace-id "$LAW_CUST_ID" \
    --logs-workspace-key "$LAW_KEY" >/dev/null
fi
ok "Container Apps Environment $CAE"

# ---- Container App (placeholder image; pipeline rolls in the real one) ----
if ! az containerapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  log "Creating Container App $APP with placeholder image..."
  az containerapp create \
    -g "$RG" -n "$APP" \
    --environment "$CAE" \
    --image "mcr.microsoft.com/k8se/quickstart:latest" \
    --target-port 3000 --ingress external \
    --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1.0Gi >/dev/null
fi

log "Setting secrets + env vars on $APP..."
az containerapp secret set \
  -g "$RG" -n "$APP" \
  --secrets \
    database-url="$DATABASE_URL" \
    database-ssl=true >/dev/null
az containerapp update \
  -g "$RG" -n "$APP" \
  --set-env-vars \
    DATABASE_URL=secretref:database-url \
    DATABASE_SSL=secretref:database-ssl \
    PORT=3000 >/dev/null

log "Assigning system-managed identity to $APP and granting AcrPull..."
APP_PRINCIPAL=$(az containerapp identity assign -g "$RG" -n "$APP" --system-assigned --query principalId -o tsv)
# Azure AD propagation can lag; retry up to ~30s
for i in 1 2 3 4 5 6; do
  if az role assignment create --assignee-object-id "$APP_PRINCIPAL" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
az containerapp registry set -g "$RG" -n "$APP" --server "$ACR_SERVER" --identity system >/dev/null

APP_FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
CAE_STATIC_IP=$(az containerapp env show -g "$RG" -n "$CAE" --query properties.staticIp -o tsv)
ok "Container App $APP (https://$APP_FQDN)"

# ---- App Registration + federated credential for GitHub OIDC --------------
APP_REG_ID=$(az ad app list --display-name "$APP_REG" --query "[0].appId" -o tsv)
if [[ -z "$APP_REG_ID" || "$APP_REG_ID" == "null" ]]; then
  log "Creating App Registration $APP_REG..."
  APP_REG_ID=$(az ad app create --display-name "$APP_REG" --query appId -o tsv)
  az ad sp create --id "$APP_REG_ID" >/dev/null
fi
ok "App Registration $APP_REG ($APP_REG_ID)"

FEDCRED_NAME="${GITHUB_REPO//\//-}-${GITHUB_BRANCH}"
if ! az ad app federated-credential list --id "$APP_REG_ID" --query "[?name=='$FEDCRED_NAME']" -o tsv | grep -q .; then
  log "Creating federated credential for ${GITHUB_REPO}@${GITHUB_BRANCH}..."
  az ad app federated-credential create --id "$APP_REG_ID" --parameters "$(cat <<EOF
{
  "name": "$FEDCRED_NAME",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${GITHUB_REPO}:ref:refs/heads/${GITHUB_BRANCH}",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
)" >/dev/null
fi

log "Granting GitHub app AcrPush on $ACR + Contributor on $RG..."
az role assignment create --assignee "$APP_REG_ID" --role AcrPush --scope "$ACR_ID" >/dev/null 2>&1 || true
az role assignment create --assignee "$APP_REG_ID" --role Contributor --scope "/subscriptions/${SUB_ID}/resourceGroups/${RG}" >/dev/null 2>&1 || true
ok "Role assignments done"

# ---- Optional: alerts ------------------------------------------------------
# Set ALERT_EMAIL=you@example.com when running the script to wire up basic
# health alerts. Skipped otherwise (you can add them later via az CLI).
if [[ -n "${ALERT_EMAIL:-}" ]]; then
  ACTION_GROUP="${PRODUCT}-${ENV_NAME}-ag"
  log "Creating action group $ACTION_GROUP (email: $ALERT_EMAIL)..."
  if ! az monitor action-group show -g "$RG" -n "$ACTION_GROUP" >/dev/null 2>&1; then
    az monitor action-group create \
      -g "$RG" -n "$ACTION_GROUP" \
      --short-name "${PRODUCT:0:12}" \
      --action email primary "$ALERT_EMAIL" >/dev/null
  fi
  ACTION_GROUP_ID=$(az monitor action-group show -g "$RG" -n "$ACTION_GROUP" --query id -o tsv)

  APP_ID=$(az containerapp show -g "$RG" -n "$APP" --query id -o tsv)
  DB_ID=$(az postgres flexible-server show -g "$RG" -n "$DB_SERVER" --query id -o tsv)

  log "Creating alert: Container App has no running replicas..."
  az monitor metrics alert create \
    -g "$RG" -n "${APP}-no-replicas" \
    --scopes "$APP_ID" \
    --condition "avg Replicas < 1" \
    --description "Lattice container app has no running replicas" \
    --window-size 5m --evaluation-frequency 1m \
    --severity 2 \
    --action "$ACTION_GROUP_ID" >/dev/null 2>&1 || true

  log "Creating alert: Postgres CPU > 80%..."
  az monitor metrics alert create \
    -g "$RG" -n "${DB_SERVER}-cpu-high" \
    --scopes "$DB_ID" \
    --condition "avg cpu_percent > 80" \
    --description "Postgres CPU sustained above 80%" \
    --window-size 10m --evaluation-frequency 5m \
    --severity 3 \
    --action "$ACTION_GROUP_ID" >/dev/null 2>&1 || true

  ok "Alerts wired (email: $ALERT_EMAIL)"
fi

# ---- Summary --------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m%s\033[0m' "═══════════════════════════════════════════════════════════════════════")
  Bootstrap complete.
$(printf '\033[1;32m%s\033[0m' "═══════════════════════════════════════════════════════════════════════")

  App URL            https://$APP_FQDN
  ACR login server   $ACR_SERVER
  Postgres host      $DB_HOST
  Postgres user      $DB_USER
  Postgres database  $DB_NAME
  Env static IP      $CAE_STATIC_IP

GitHub → repo → Settings → Secrets and variables → Actions

  Secrets:
    AZURE_CLIENT_ID        $APP_REG_ID
    AZURE_TENANT_ID        $TENANT_ID
    AZURE_SUBSCRIPTION_ID  $SUB_ID

  Variables:
    AZURE_RESOURCE_GROUP   $RG
    ACR_NAME               $ACR
    CONTAINER_APP_NAME     $APP
    IMAGE_NAME             $IMAGE_NAME

Next steps:
  1. Add the GitHub secrets/variables above.
  2. Push to '$GITHUB_BRANCH' → the workflow builds + rolls the image.
  3. Custom domain (readlattice.co):
       a) DNS: CNAME www.readlattice.co -> $APP_FQDN
          Apex (readlattice.co): A record -> $CAE_STATIC_IP
             or ALIAS/ANAME -> $APP_FQDN if your DNS supports it.
       b) az containerapp hostname add  -g $RG -n $APP --hostname readlattice.co
       c) az containerapp hostname bind -g $RG -n $APP --hostname readlattice.co \\
            --environment $CAE --validation-method CNAME
  4. Optional: enable AI features
       az containerapp secret set    -g $RG -n $APP --secrets anthropic-api-key=<key>
       az containerapp update        -g $RG -n $APP --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-api-key

EOF
