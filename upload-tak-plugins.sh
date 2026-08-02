#!/usr/bin/env bash
# ==============================================================================
# One-Click TAK Server Plugin Deployer (UAS Tool & TAK ICU)
# Automatically scans, stages, and deploys TAK plugins to live TAK Server VPS.
# ==============================================================================
set -e

VPS_USER="root"
VPS_IP="5.161.45.97"
REMOTE_PLUGINS_DIR="/root/takserver/tak/plugins"
LOCAL_PLUGINS_DIR="/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/tak/plugins"
SEARCH_DIRS=("$HOME/Downloads" "$HOME/Desktop" "$HOME/Documents")

echo "=================================================================="
echo " 🛸 One-Click TAK Server Plugin Deployer (UAS Tool & TAK ICU)"
echo "=================================================================="

# Ensure local plugins directory exists
mkdir -p "${LOCAL_PLUGINS_DIR}"

echo "🔍 Scanning Downloads, Desktop, and Documents for TAK Plugins (*UAS*, *ICU*, *sync*, *.apk*, *.jar)..."

FOUND=0
for search_dir in "${SEARCH_DIRS[@]}"; do
    if [ -d "$search_dir" ]; then
        # Find matching APK, JAR, or ZIP plugin files
        while IFS= read -r -d '' file; do
            echo "   📦 Found plugin: $(basename "$file")"
            cp "$file" "${LOCAL_PLUGINS_DIR}/"
            FOUND=$((FOUND + 1))
        done < <(find "$search_dir" -maxdepth 2 -type f \( -iname "*uas*" -o -iname "*icu*" -o -iname "*sync*" \) \( -name "*.apk" -o -name "*.jar" -o -name "*.zip" \) -print0 2>/dev/null)
    fi
done

if [ "$FOUND" -eq 0 ]; then
    echo "ℹ️  No new UAS/ICU plugin files auto-discovered in Downloads."
    echo "ℹ️  Will proceed syncing existing staged files in ${LOCAL_PLUGINS_DIR}:"
    ls -la "${LOCAL_PLUGINS_DIR}"
else
    echo "✅ Staged $FOUND new plugin file(s) into ${LOCAL_PLUGINS_DIR}"
fi

echo ""
echo "=== [1/2] Syncing plugins folder to TAK Server VPS ($VPS_IP) ==="
rsync -avz --progress "${LOCAL_PLUGINS_DIR}/" "${VPS_USER}@${VPS_IP}:${REMOTE_PLUGINS_DIR}/"

echo ""
echo "=== [2/2] Updating Remote Permissions & Restarting TAK Server ==="
ssh "${VPS_USER}@${VPS_IP}" << EOF
    echo "Setting permissions on ${REMOTE_PLUGINS_DIR}..."
    chmod -R 777 "${REMOTE_PLUGINS_DIR}"
    
    cd ~/takserver
    echo "Restarting TAK Server Docker Stack..."
    docker compose restart takserver || docker compose up -d --build
EOF

echo ""
echo "=================================================================="
echo " 🎉 SUCCESS! TAK Plugins Deployed to Server."
echo " 🛰️ TAK Server Admin UI: https://ares-werx.com:8443"
echo " 📱 Connected ATAK clients can now access plugins via Plugin Manager"
echo "=================================================================="
