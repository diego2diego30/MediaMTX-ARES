#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX One-Click Git Sync & Auto-Deploy (Mac -> GitHub -> VPS)
# Pushes local changes to GitHub AND automatically updates the live VPS!
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

# 2. Push to GitHub
echo "=== [2/3] Pushing to GitHub ==="
git push origin main || git push -u origin main

# 3. Auto-pull & reload on VPS
echo "=== [3/3] Auto-Deploying to Live VPS ($VPS_IP) ==="
ssh "${VPS_USER}@${VPS_IP}" << EOF
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
