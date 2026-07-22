#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX One-Click Production Deployment Script
# Deploys: MediaMTX, Telemetry Bridge, Nginx GUI (Auth/SSL), & TAK Server
# ==============================================================================
set -e

DOMAIN="ares-werx.com"
EMAIL="admin@ares-werx.com"

echo "=================================================================="
echo "   🚀 Starting ARES-WERX One-Click Full Stack Deployment Script"
echo "=================================================================="

# 1. Update system packages & Install Docker + Certbot
echo "=== [1/5] Updating Packages & Installing System Dependencies ==="
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release certbot

if ! command -v docker &> /dev/null; then
    echo "Installing Docker Engine..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER || true
fi

# 2. Ensure directory structure exists
echo "=== [2/5] Initializing Directory Structure ==="
mkdir -p tak_data/certs tak_data/data

# 3. Stop running containers to free Port 80 for Certbot
echo "=== [3/5] Stopping Existing Containers (Freeing Port 80 for SSL) ==="
docker compose -f docker-compose.prod.yml down || true

# 4. Issue/Renew Let's Encrypt SSL Certificate
echo "=== [4/5] Issuing Let's Encrypt TLS Certificate for $DOMAIN ==="
echo "NOTE: Ensure DNS A-records for $DOMAIN and www.$DOMAIN point to this server."
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "SSL Certificate already exists. Checking renewal..."
    sudo certbot renew --quiet || true
else
    echo "Requesting new certificate from Let's Encrypt..."
    sudo certbot certonly --standalone \
      -d $DOMAIN -d www.$DOMAIN \
      --non-interactive --agree-tos -m $EMAIL \
      --keep-until-expiring
fi

# 5. Launch full production stack
echo "=== [5/5] Building & Launching Production Stack ==="
docker compose -f docker-compose.prod.yml up -d --build

echo "=== Verifying Running Services ==="
docker compose -f docker-compose.prod.yml ps

echo "=================================================================="
echo " 🎉 SUCCESS! ARES-WERX Full Production Stack is Live!"
echo "------------------------------------------------------------------"
echo " 🌐 Web Portal (COP):       https://$DOMAIN (Auth: ares / ares)"
echo " 🎯 Delta COP GUI:          https://$DOMAIN/copDelta.html"
echo " 🛰️ TAK Server Admin:       https://$DOMAIN:8443"
echo " 📱 ATAK CoT (TLS):         $DOMAIN:8089"
echo " 📹 RTSP Stream Ingest:     rtsp://ares_pilot:ares_secure@$DOMAIN:8554/live"
echo " ⚡ SRT Stream Ingest:      srt://$DOMAIN:8890?streamid=publish:live"
echo "=================================================================="
