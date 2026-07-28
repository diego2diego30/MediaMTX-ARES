#!/usr/bin/env bash
# ==============================================================================
# ARES-WERX TAK PKI Rebuild Script
# Generates a fresh PKI chain (Root CA + Server Cert + Client Cert) where
# ALL certificates are signed by the same Root CA ("ARES-WERX Root CA").
#
# This script is designed to run on the Ubuntu VPS (root@ares-werx.com).
# Prerequisites: openjdk-11-jre-headless, zip, openssl
# ==============================================================================
set -e

echo "=================================================================="
echo " 🔐 ARES-WERX TAK PKI Rebuild"
echo "=================================================================="

# ── 0. Check & auto-install prerequisites ──
INSTALL_PKGS=""
command -v openssl >/dev/null 2>&1 || INSTALL_PKGS="$INSTALL_PKGS openssl"
command -v keytool >/dev/null 2>&1 || INSTALL_PKGS="$INSTALL_PKGS openjdk-11-jre-headless"
command -v zip     >/dev/null 2>&1 || INSTALL_PKGS="$INSTALL_PKGS zip"

if [ -n "$INSTALL_PKGS" ]; then
  echo "📦 Installing missing tools:$INSTALL_PKGS"
  apt-get update -qq && apt-get install -y -qq $INSTALL_PKGS
  echo "   ✅ Tools installed."
fi

# ── 1. Auto-detect paths ──
if [ -d "/root/MediaMTX-ARES" ]; then
  ARES_DIR="/root/MediaMTX-ARES"
elif [ -d "/Users/diego/MediaMTX ARES" ]; then
  ARES_DIR="/Users/diego/MediaMTX ARES"
else
  ARES_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

TAK_CERT_DIR=""
for candidate in \
  "/opt/tak/certs" \
  "/root/takserver/tak/certs" \
  "/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/tak/certs"; do
  if [ -d "$candidate" ]; then
    TAK_CERT_DIR="$candidate"
    break
  fi
done

if [ -z "$TAK_CERT_DIR" ]; then
  echo "ERROR: Could not find TAK cert directory."
  echo "  Looked in: /opt/tak/certs, /root/takserver/tak/certs"
  echo "  Set TAK_CERT_DIR env var manually and rerun."
  exit 1
fi

echo "  ARES_DIR:     $ARES_DIR"
echo "  TAK_CERT_DIR: $TAK_CERT_DIR"
echo ""

cd "$TAK_CERT_DIR"

# ── 2. Wipe old certificates ──
echo "-> [1/9] Wiping old certificates..."
rm -f files/* 2>/dev/null || true

# ── 3. Generate new Root CA ──
echo "-> [2/9] Generating new Root CA ('ARES-WERX Root CA')..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeRootCa.sh --ca-name "ARES-WERX Root CA"

# ── 4. Generate Server Certificate ──
# CoreConfig.xml references "takserver.p12" so we must generate with that name.
# Also copy as ares-werx.com.p12 for clarity.
echo "-> [3/9] Generating Server Certificate (takserver / ares-werx.com)..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh server takserver
cp files/takserver.p12 files/ares-werx.com.p12 2>/dev/null || true

# ── 5. Generate Admin Client Certificate ──
echo "-> [4/9] Generating Admin Client Certificate..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh client admin || true
# Export admin client PEM and key for telemetry bridge
echo " → Exporting admin client PEM and key for bridge"
openssl pkcs12 -legacy -in files/admin.p12 -nokeys -clcerts -passin pass:atakatak -out files/admin.pem
openssl pkcs12 -legacy -in files/admin.p12 -nocerts -nodes -passin pass:atakatak -out files/admin-key.pem
chmod 600 files/admin-key.pem
chmod 644 files/admin.pem

# ── 6. Export Root CA as PEM (for iOS + bridge) ──
echo "-> [5/9] Exporting Root CA as PEM..."
openssl pkcs12 -legacy -in files/truststore-root.p12 -nokeys \
  -out "$ARES_DIR/ares-root.crt" -passin pass:atakatak

openssl pkcs12 -legacy -in files/truststore-root.p12 -nokeys \
  -out "$ARES_DIR/cert/truststore-root.pem" -passin pass:atakatak

# ── 7. Copy client cert + key for the telemetry bridge ──
echo "-> [6/9] Copying client cert + key for telemetry bridge..."
cp files/admin.pem     "$ARES_DIR/cert/tak-client.pem"
cp files/admin-key.pem "$ARES_DIR/cert/tak-client.key"
cp files/admin.pem     "$ARES_DIR/cert/admin.pem"
cp files/admin-key.pem "$ARES_DIR/cert/admin.key"
cp files/admin.p12     "$ARES_DIR/cert/admin.p12"
cp files/truststore-root.p12 "$ARES_DIR/cert/truststore-root.p12"

# ── 8. Build iTAK/ATAK data package ──
echo "-> [7/9] Building iTAK/ATAK data package (ARES_Secure_Connection.zip)..."

# Use the cert/ARES_Secure_Connection directory as staging
ITAK_DIR="$ARES_DIR/cert/ARES_Secure_Connection"
mkdir -p "$ITAK_DIR/MANIFEST"

# Copy fresh certs into the package directory
cp "$TAK_CERT_DIR/files/admin.p12"              "$ITAK_DIR/admin.p12"
cp "$TAK_CERT_DIR/files/truststore-root.p12"    "$ITAK_DIR/truststore-root.p12"

# Build the zip in root and copy to cert folder
rm -f "$ARES_DIR/ARES_Secure_Connection.zip"
rm -f "$ARES_DIR/cert/ARES_Secure_Connection.zip"
cd "$ITAK_DIR"
zip -q -r "$ARES_DIR/ARES_Secure_Connection.zip" \
  MANIFEST/manifest.xml \
  ARES_Secure_Connection.pref \
  admin.p12 \
  truststore-root.p12
cd "$ARES_DIR"

# Copy to cert folder for backup/consistency
cp "$ARES_DIR/ARES_Secure_Connection.zip" "$ARES_DIR/cert/ARES_Secure_Connection.zip"

# Clean up p12 files from the git template folder
rm -f "$ITAK_DIR/admin.p12"
rm -f "$ITAK_DIR/truststore-root.p12"

# Also update the simpler ARES_Secure_Connection directory (with just certs)
mkdir -p "$ARES_DIR/ARES_Secure_Connection"
cp "$TAK_CERT_DIR/files/admin.p12"              "$ARES_DIR/ARES_Secure_Connection/"
cp "$TAK_CERT_DIR/files/truststore-root.p12"    "$ARES_DIR/ARES_Secure_Connection/"

# ── 9. Restart TAK Server to load new keystores ──
echo "-> [8/9] Restarting TAK Server to load new keystores..."
TAK_COMPOSE_DIR=""
for candidate in "/root/takserver" "/opt/tak"; do
  if [ -f "$candidate/docker-compose.yml" ]; then
    TAK_COMPOSE_DIR="$candidate"
    break
  fi
done

if [ -n "$TAK_COMPOSE_DIR" ]; then
  cd "$TAK_COMPOSE_DIR"
  docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || true
  echo "   TAK Server restarted from $TAK_COMPOSE_DIR"
else
  echo "   ⚠️  Could not find TAK docker-compose.yml — restart TAK Server manually:"
  echo "      cd /path/to/takserver && docker compose restart"
fi

# ── 10. Rebuild telemetry bridge ──
echo "-> [9/9] Rebuilding telemetry bridge with new certs..."
cd "$ARES_DIR"
docker compose -f docker-compose.prod.yml up -d --build telemetry 2>/dev/null || true

# ── Done ──
echo ""
echo "=================================================================="
echo " 🎉 SUCCESS — PKI Rebuild Complete"
echo "=================================================================="
echo ""
echo " All certs signed by: ARES-WERX Root CA"
echo ""
echo " Files:"
echo "   Root CA (PEM):        $ARES_DIR/ares-root.crt"
echo "   Root CA (PEM/bridge): $ARES_DIR/cert/truststore-root.pem"
echo "   Client cert (PEM):    $ARES_DIR/cert/tak-client.pem"
echo "   Client key:           $ARES_DIR/cert/tak-client.key"
echo "   Client cert (P12):    $ARES_DIR/cert/admin.p12"
echo "   iTAK/ATAK Bundle:     $ARES_DIR/ARES_Secure_Connection.zip"
echo ""
echo " ── Auto-verifying bridge connection (waiting 20s for TAK to start)... ──"
echo "=================================================================="

sleep 20

BRIDGE_LOG=$(docker logs --tail 20 telemetry-bridge 2>&1)
echo "$BRIDGE_LOG"
echo ""

if echo "$BRIDGE_LOG" | grep -q "Connected to TAK Server"; then
  echo "✅ VERIFIED: Bridge is connected to TAK Server via TLS!"
elif echo "$BRIDGE_LOG" | grep -q "connection error"; then
  echo "❌ Bridge connection error detected. Dumping full logs..."
  docker logs --tail 50 telemetry-bridge 2>&1
else
  echo "⚠️  Could not confirm bridge connection. Check: docker logs -f telemetry-bridge"
fi
