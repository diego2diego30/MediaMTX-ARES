#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX CI/CD Status Checker
# ==============================================================================
# Polls GitHub Actions after a push and reports pass/fail with full diagnostics.
# Usage: ./check-cicd-status.sh [--wait]
#   --wait : wait for the latest in-progress run to finish before reporting
# ==============================================================================

REPO="diego2diego30/MediaMTX-ARES"
BRANCH="main"
API="https://api.github.com/repos/${REPO}"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── GitHub Token (optional but recommended to avoid rate limiting) ───────────
# Set GITHUB_TOKEN in your shell env:  export GITHUB_TOKEN=ghp_xxxx
AUTH_HEADER=""
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer $GITHUB_TOKEN\""
fi

gh_api() {
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$1"
  else
    curl -s -H "Accept: application/vnd.github+json" "$1"
  fi
}

echo -e "${BOLD}${CYAN}=================================================================="
echo " 🔍 ARES-WERX CI/CD Pipeline Status Reporter"
echo -e "==================================================================${NC}"
echo ""

# ── Get latest workflow run ──────────────────────────────────────────────────
echo -e "${CYAN}-> Fetching latest GitHub Actions run for branch: ${BRANCH}...${NC}"
RUNS=$(gh_api "${API}/actions/runs?branch=${BRANCH}&per_page=5")

if [ -z "$RUNS" ] || echo "$RUNS" | grep -q '"message"'; then
  echo -e "${RED}[ERROR] Could not fetch GitHub Actions runs.${NC}"
  echo "   Possible causes: Repo is private, GITHUB_TOKEN not set, or no runs exist yet."
  echo "   Set a token: export GITHUB_TOKEN=ghp_yourtoken"
  echo "   View directly: https://github.com/${REPO}/actions"
  exit 1
fi

# ── Wait for in-progress run to complete if --wait flag set ─────────────────
if [ "$1" = "--wait" ]; then
  echo -e "${YELLOW}-> Waiting for current run to complete (--wait mode)...${NC}"
  for i in $(seq 1 30); do
    STATUS=$(echo "$RUNS" | python3 -c "import sys,json; runs=json.load(sys.stdin)['workflow_runs']; print(runs[0]['status']) if runs else print('none')")
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "none" ]; then
      break
    fi
    echo "   Still running... ($((i * 10))s elapsed)"
    sleep 10
    RUNS=$(gh_api "${API}/actions/runs?branch=${BRANCH}&per_page=5")
  done
fi

# ── Parse the latest run ─────────────────────────────────────────────────────
LATEST=$(echo "$RUNS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
runs = data.get('workflow_runs', [])
if not runs:
    print('NO_RUNS')
    sys.exit(0)
r = runs[0]
print(r.get('id',''))
print(r.get('status',''))
print(r.get('conclusion','none'))
print(r.get('html_url',''))
print(r.get('head_sha','')[:8])
print(r.get('head_commit',{}).get('message','')[:80].replace('\n',' '))
print(r.get('created_at',''))
")

if [ "$LATEST" = "NO_RUNS" ]; then
  echo -e "${YELLOW}⚠️ No workflow runs found yet. Push a commit to trigger the pipeline.${NC}"
  exit 0
fi

RUN_ID=$(echo "$LATEST" | sed -n '1p')
STATUS=$(echo "$LATEST" | sed -n '2p')
CONCLUSION=$(echo "$LATEST" | sed -n '3p')
URL=$(echo "$LATEST" | sed -n '4p')
SHA=$(echo "$LATEST" | sed -n '5p')
MSG=$(echo "$LATEST" | sed -n '6p')
CREATED=$(echo "$LATEST" | sed -n '7p')

# ── Status Badge ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Latest Run:${NC}"
echo "  Commit : ${SHA}  \"${MSG}\""
echo "  Started: ${CREATED}"
echo "  URL    : ${URL}"
echo ""

case "$CONCLUSION" in
  "success")
    echo -e "  Status : ${GREEN}${BOLD}✅ PASSED — All stages green. Deployment succeeded.${NC}"
    ;;
  "failure")
    echo -e "  Status : ${RED}${BOLD}❌ FAILED${NC}"
    ;;
  "cancelled")
    echo -e "  Status : ${YELLOW}⚠️  CANCELLED${NC}"
    ;;
  "none"|"")
    echo -e "  Status : ${YELLOW}🔄 IN PROGRESS (status: ${STATUS})${NC}"
    echo "  Run ./check-cicd-status.sh --wait to wait for completion."
    ;;
  *)
    echo -e "  Status : ${YELLOW}${CONCLUSION}${NC}"
    ;;
esac

# ── If failed: drill into each job and step to report exact failure ───────────
if [ "$CONCLUSION" = "failure" ]; then
  echo ""
  echo -e "${RED}${BOLD}── Failure Diagnosis ──────────────────────────────────────────────${NC}"

  JOBS=$(gh_api "${API}/actions/runs/${RUN_ID}/jobs")

  echo "$JOBS" | python3 -c "
import sys, json

RED   = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW= '\033[1;33m'
BOLD  = '\033[1m'
NC    = '\033[0m'

data = json.load(sys.stdin)
jobs = data.get('jobs', [])

for job in jobs:
    name       = job.get('name','?')
    conclusion = job.get('conclusion','?')
    steps      = job.get('steps', [])

    if conclusion == 'success':
        icon = GREEN + '✅' + NC
    elif conclusion == 'failure':
        icon = RED + '❌' + NC
    elif conclusion == 'skipped':
        icon = YELLOW + '⏭ ' + NC
    else:
        icon = YELLOW + '🔄' + NC

    print(f'  {icon} {BOLD}Job: {name}{NC}  [{conclusion}]')

    for step in steps:
        sname   = step.get('name','?')
        sconc   = step.get('conclusion','?')
        if sconc == 'failure':
            print(f'      {RED}❌ FAILED STEP: {sname}{NC}')
        elif sconc == 'skipped':
            print(f'      ⏭  Skipped: {sname}')
        elif sconc == 'success':
            print(f'      ✅ {sname}')
        else:
            print(f'      🔄 {sname} [{sconc}]')
    print()
"

  echo -e "${RED}── Common Fixes ────────────────────────────────────────────────────${NC}"
  echo "  • If 'Deploy' job failed but 'Validate' passed:"
  echo "    → Check GitHub Secrets: VPS_HOST, VPS_USER, VPS_SSH_KEY"
  echo "    → Go to: https://github.com/${REPO}/settings/secrets/actions"
  echo ""
  echo "  • If 'Code Validation' failed:"
  echo "    → Run: node --check telemetry_bridge.js"
  echo "    → Run: bash -n fix-certs.sh"
  echo ""
  echo "  • Full logs:"
  echo "    → ${URL}"
fi

echo ""
echo -e "${CYAN}──────────────────────────────────────────────────────────────────${NC}"
echo -e "  All runs: https://github.com/${REPO}/actions"
echo -e "${CYAN}──────────────────────────────────────────────────────────────────${NC}"
