#!/usr/bin/env bash
# One-shot deploy of SaathiCare to Google Cloud:
#   Cloud Run (app) + Firestore (data) + Secret Manager (secrets)
#   + Cloud Scheduler (reminders every 5 min, weekly digest) + Cloud Logging (automatic).
#
# Usage:
#   export PROJECT_ID=my-project REGION=asia-south1
#   export GEMINI_API_KEY=... SMTP_USER=you@gmail.com SMTP_PASS=app-password   # SMTP optional
#   ./scripts/deploy.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-saathicare}"
DEMO_SEED="${DEMO_SEED:-true}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ Enabling APIs"
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "▶ Firestore (Native mode)"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 ||
  gcloud firestore databases create --location="$REGION" --type=firestore-native

put_secret() { # name value
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic >/dev/null
  fi
}

echo "▶ Secrets"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 24)}"
put_secret saathicare-session-secret "${SESSION_SECRET:-$(openssl rand -hex 32)}"
put_secret saathicare-cron-secret "$CRON_SECRET"
put_secret saathicare-gemini-key "${GEMINI_API_KEY:-none}"
put_secret saathicare-smtp-pass "${SMTP_PASS:-none}"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/datastore.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUN_SA" --role="$role" \
    --condition=None >/dev/null
done

SMTP_ENV=""
if [[ -n "${SMTP_USER:-}" ]]; then
  SMTP_ENV=",SMTP_HOST=${SMTP_HOST:-smtp.gmail.com},SMTP_PORT=465,SMTP_USER=${SMTP_USER},MAIL_FROM=SaathiCare <${SMTP_USER}>"
fi
GEMINI_SECRET=""
[[ -n "${GEMINI_API_KEY:-}" ]] && GEMINI_SECRET=",GEMINI_API_KEY=saathicare-gemini-key:latest"
SMTP_SECRET=""
[[ -n "${SMTP_PASS:-}" ]] && SMTP_SECRET=",SMTP_PASS=saathicare-smtp-pass:latest"

echo "▶ Cloud Run"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --memory 256Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 80 \
  --set-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},DEMO_SEED=${DEMO_SEED}${SMTP_ENV}" \
  --set-secrets "SESSION_SECRET=saathicare-session-secret:latest,CRON_SECRET=saathicare-cron-secret:latest${GEMINI_SECRET}${SMTP_SECRET}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "APP_URL=${URL}" >/dev/null

echo "▶ Cloud Scheduler"
upsert_job() { # name schedule path
  local args=(--location="$REGION" --schedule="$2" --time-zone="Asia/Kolkata" --uri="${URL}$3"
    --http-method=POST --attempt-deadline=120s)
  if gcloud scheduler jobs describe "$1" --location="$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$1" "${args[@]}" --update-headers="X-Cron-Secret=${CRON_SECRET}" >/dev/null
  else
    gcloud scheduler jobs create http "$1" "${args[@]}" --headers="X-Cron-Secret=${CRON_SECRET}" >/dev/null
  fi
}
upsert_job saathicare-reminders "*/5 * * * *" /api/cron/reminders
upsert_job saathicare-weekly-digest "0 9 * * 0" /api/cron/digest

echo "✅ Deployed: $URL"
echo "   Demo circle: code DEMO42, passcode 246810"
