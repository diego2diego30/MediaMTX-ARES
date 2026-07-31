#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX CI/CD Pipeline Setup Script
# ==============================================================================
# Sets up GitHub Actions automated deployment for ARES-WERX.
# Generates deployment SSH key, installs it on VPS, and prints GitHub Secrets.
# ==============================================================================
set -e

echo "=================================================================="
echo " 🛠️ Setting up ARES-WERX CI/CD Pipeline"
echo "=================================================================="

VPS_HOST="5.161.45.97"
VPS_USER="root"
KEY_PATH="$HOME/.ssh/ares_cicd_deploy_key"

# 1. Generate SSH Deploy Key if it doesn't exist
if [ ! -f "$KEY_PATH" ]; then
  echo "🔑 Generating dedicated CI/CD deployment SSH key..."
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "ares-werx-cicd-deploy"
  echo "   ✅ SSH Key generated at: $KEY_PATH"
else
  echo "ℹ️ Existing CI/CD SSH key found at: $KEY_PATH"
fi

PUB_KEY=$(cat "${KEY_PATH}.pub")
PRIV_KEY=$(cat "${KEY_PATH}")

# 2. Add public key to VPS authorized_keys
echo "🚀 Installing public key on live VPS ($VPS_HOST)..."
ssh -o StrictHostKeyChecking=no "${VPS_USER}@${VPS_HOST}" "
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  if ! grep -q \"$PUB_KEY\" ~/.ssh/authorized_keys 2>/dev/null; then
    echo \"$PUB_KEY\" >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    echo '   ✅ Installed public key in ~/.ssh/authorized_keys on VPS'
  else
    echo '   ℹ️ Key already authorized on VPS'
  fi
"

echo "=================================================================="
echo " 📋 NEXT STEPS: Add the following Secrets to your GitHub Repository"
echo "=================================================================="
echo " Go to: GitHub Repo -> Settings -> Secrets and variables -> Actions -> New repository secret"
echo ""
echo " 1. Secret Name: VPS_HOST"
echo "    Value: $VPS_HOST"
echo ""
echo " 2. Secret Name: VPS_USER"
echo "    Value: $VPS_USER"
echo ""
echo " 3. Secret Name: VPS_SSH_KEY"
echo "    Value (copy everything below including BEGIN/END lines):"
echo "------------------------------------------------------------------"
echo "$PRIV_KEY"
echo "------------------------------------------------------------------"
echo ""
echo "✅ Workflow file created at .github/workflows/deploy.yml"
echo "Commit and push this workflow to GitHub to activate automated deployments!"
