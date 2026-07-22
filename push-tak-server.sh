#!/usr/bin/env bash
# ==============================================================================
# TAK Server Setup Sync & Deploy Script (Folder-based)
# Uploads your entire local TAK docker setup, MBTiles, & Plugins to the VPS.
# ==============================================================================
set -e

VPS_USER="root"
VPS_IP="5.161.45.97"
VPS_DIR="~/takserver"
LOCAL_DIR="/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/"

echo "=================================================================="
echo " 🚀 Pushing TAK Server Docker Setup, MBTiles & Plugins to $VPS_IP"
echo "=================================================================="

# 1. Sync the entire directory via rsync (including camp_lejeune.mbtiles & plugins)
echo "=== [1/2] Syncing directory, MBTiles & Plugins via Rsync ==="
rsync -avz --progress "${LOCAL_DIR}" "${VPS_USER}@${VPS_IP}:${VPS_DIR}"

# 2. SSH into the VPS and start the compose stack
echo "=== [2/2] Setting Permissions, Building & Starting TAK Server ==="
ssh "${VPS_USER}@${VPS_IP}" << EOF
    cd ${VPS_DIR}
    
    # Ensure correct permissions for container user
    chmod -R 777 ./tak
    
    echo "Starting TAK Docker Compose stack..."
    docker compose up -d --build
    
    echo "=================================================================="
    echo " 🎉 SUCCESS! TAK Server Setup Deployed with Tactical Assets."
    echo " 🗺️  MBTiles Dataset: Camp Lejeune (5.37 GB)"
    echo " 🧩 TAK Plugins:    Staged in /opt/tak/plugins"
    echo " 🛰️ TAK Server Admin: https://ares-werx.com:8443"
    echo " 📱 ATAK CoT (TLS):   ares-werx.com:8089"
    echo "=================================================================="
EOF
