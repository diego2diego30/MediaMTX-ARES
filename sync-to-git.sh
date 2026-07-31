#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX One-Click Git Sync & Auto-Deploy (Mac -> GitHub -> VPS)
# Pushes local changes to GitHub AND automatically updates the live VPS.
# After pushing, waits 15s then checks GitHub Actions CI/CD pipeline status.
# ==============================================================================
set -e

VPS_USER="root"
VPS_IP="5.161.45.97"
VPS_DIR="~/MediaMTX-ARES"
COMMIT_MSG="${1:-Update ARES stack & web portal}"

echo "=================================================================="
echo " 🚀 Syncing ARES-WERX to GitHub & Auto-Deploying to Live VPS"
echo "=================================================================="

# Ensure Git repository exists
if [ ! -d ".git" ]; then
    echo "Initializing Git repository..."
    git init
    git branch -M main
fi

# 1. Stage & Commit
echo "=== [1/3] Staging and Committing local changes ==="
git add .
git commit -m "$COMMIT_MSG" || echo "No changes to commit."

# 2. Push to GitHub (triggers CI/CD pipeline automatically)
echo "=== [2/3] Pushing to GitHub ==="
git push origin main || git push -u origin main

# 3. Auto-pull & reload on VPS (direct SSH fallback alongside CI/CD)
echo "=== [3/3] Auto-Deploying to Live VPS ($VPS_IP) ==="
ssh "${VPS_USER}@${VPS_IP}" <<EOF
    cd ${VPS_DIR}
    echo "Pulling latest code from GitHub..."
    git pull
    
    echo "Applying docker-compose updates and restarting services..."
    docker compose -f docker-compose.prod.yml up -d --build
    
    echo "Reloading Nginx to refresh single-file bind mounts..."
    docker restart mediamtx-gui
    
    echo "=================================================================="
    echo " 🎉 SUCCESS! Live server updated seamlessly!"
    echo " 🌐 https://ares-werx.com"
    echo "=================================================================="
EOF

# 4. Check GitHub Actions CI/CD pipeline status
echo ""
echo "=== [+] Checking GitHub Actions CI/CD Pipeline Status ==="
echo "   (Waiting 20s for GitHub to register the run...)"
sleep 20

if [ -f "./check-cicd-status.sh" ]; then
  bash ./check-cicd-status.sh
else
  echo "   ℹ️  check-cicd-status.sh not found. View pipeline at:"
  echo "   https://github.com/diego2diego30/MediaMTX-ARES/actions"
fi
