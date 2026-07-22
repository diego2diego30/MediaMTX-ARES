#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX One-Click Git Sync & Server Update Helper (Mac -> Git)
# ==============================================================================
set -e

COMMIT_MSG="${1:-Update ARES stack & TAK Server configuration}"

echo "=================================================================="
echo "   🚀 Syncing ARES-WERX Stack & TAK Server Config to Git"
echo "=================================================================="

# Ensure Git repository exists
if [ ! -d ".git" ]; then
    echo "Initializing Git repository..."
    git init
    git branch -M main
fi

# Add all files including Docker configs & scripts
echo "=== [1/2] Staging files for Git ==="
git add .

# Commit changes
echo "=== [2/2] Committing & Pushing to Remote Repository ==="
git commit -m "$COMMIT_MSG" || echo "No changes to commit."

# Push to origin main
git push origin main || git push -u origin main

echo "=================================================================="
echo " 🎉 SUCCESS! Local changes & TAK server configs pushed to Git!"
echo "------------------------------------------------------------------"
echo " Next step on your Ubuntu server:"
echo "   cd ~/MediaMTX-ARES && git pull && ./deploy-production.sh"
echo "=================================================================="
