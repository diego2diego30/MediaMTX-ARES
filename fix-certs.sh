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

# ── 6. Rebuild all .p12 with AES-256-CBC (makeCert.sh uses RC2-40-CBC which Java 17+ can't read) ──
echo "-> [5/9] Rebuilding all .p12 with AES-256-CBC..."
cd files
for p12name in takserver admin truststore-root; do
  # Find the key file (root CA uses ca.key, others use <name>.key)
  keyfile="${p12name}.key"
  [ "$p12name" = "truststore-root" ] && keyfile="ca.key"
  pemfile="${p12name}.pem"
  [ "$p12name" = "truststore-root" ] && pemfile="ca.pem"
  [ "$p12name" = "admin" ] && pemfile="admin.pem"
  [ "$p12name" = "admin" ] && keyfile="admin.key"
  # Extract password
  pass="atakatak"
  if [ -f "$pemfile" ] && [ -f "$keyfile" ]; then
    echo "   → $p12name.p12 → AES-256-CBC"
    openssl pkcs12 -export -in "$pemfile" -inkey "$keyfile" -out "$p12name.p12" -name "$p12name" -passin pass:$pass -passout pass:$pass -keypbe AES-256-CBC -certpbe AES-256-CBC
  else
    echo "   ⚠️  Skipping $p12name (missing pem or key)"
  fi
done
cd "$TAK_CERT_DIR"

# Export admin client PEM and key for telemetry bridge (from rebuilt p12)
echo " → Exporting admin client PEM and key for bridge"
openssl pkcs12 -in files/admin.p12 -nokeys -clcerts -passin pass:atakatak -out files/admin.pem
openssl pkcs12 -in files/admin.p12 -nocerts -nodes -passin pass:atakatak -out files/admin-key.pem
chmod 600 files/admin-key.pem
chmod 644 files/admin.pem

# ── 7. Export Root CA as PEM (for iOS + bridge) ──
echo "-> [6/9] Exporting Root CA as PEM..."
openssl pkcs12 -in files/truststore-root.p12 -nokeys \
  -out "$ARES_DIR/ares-root.crt" -passin pass:atakatak

openssl pkcs12 -in files/truststore-root.p12 -nokeys \
  -out "$ARES_DIR/cert/truststore-root.pem" -passin pass:atakatak

# ── 8. Copy client cert + key for the telemetry bridge ──
echo "-> [7/9] Copying client cert + key for telemetry bridge..."
cp files/admin.pem     "$ARES_DIR/cert/tak-client.pem"
cp files/admin-key.pem "$ARES_DIR/cert/tak-client.key"
cp files/admin.pem     "$ARES_DIR/cert/admin.pem"
cp files/admin-key.pem "$ARES_DIR/cert/admin.key"
cp files/admin.p12     "$ARES_DIR/cert/admin.p12"
cp files/truststore-root.p12 "$ARES_DIR/cert/truststore-root.p12"

# ── 9. Build iTAK/ATAK data package ──
echo "-> [8/9] Building iTAK/ATAK data package (ARES_Secure_Connection.zip)..."

# Use the cert/ARES_Secure_Connection directory as staging
ITAK_DIR="$ARES_DIR/cert/ARES_Secure_Connection"
mkdir -p "$ITAK_DIR/MANIFEST"

# Copy fresh certs into the package directory
cp "$TAK_CERT_DIR/files/admin.p12"              "$ITAK_DIR/admin.p12"
cp "$TAK_CERT_DIR/files/truststore-root.p12"    "$ITAK_DIR/truststore-root.p12"

# Build the zip with correct certs/ subdirectory structure
rm -f "$ARES_DIR/ARES_Secure_Connection.zip"
rm -f "$ARES_DIR/cert/ARES_Secure_Connection.zip"
mkdir -p "$ITAK_DIR/certs"
cp "$ITAK_DIR/ARES_Secure_Connection.pref" "$ITAK_DIR/certs/"
cp "$ITAK_DIR/admin.p12" "$ITAK_DIR/certs/"
cp "$ITAK_DIR/truststore-root.p12" "$ITAK_DIR/certs/"
cd "$ITAK_DIR"
zip -q -r "$ARES_DIR/ARES_Secure_Connection.zip" \
  MANIFEST/manifest.xml \
  certs/ARES_Secure_Connection.pref \
  certs/admin.p12 \
  certs/truststore-root.p12
rm -rf "$ITAK_DIR/certs"
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

# ── 10. Register Nginx Admin Certificate with TAK Server ──
echo "-> [9/12] Registering admin certificate with TAK Server (Nginx Proxy mTLS)..."
# We must register the admin.pem generated in step 5 with TAK's UserManager
# so that the WebTAK proxy (port 8444) has __ADMIN__ access.
if docker exec takserver sh -c 'cd /opt/tak && java -jar utils/UserManager.jar certmod -A certs/files/admin.pem' 2>/dev/null; then
  echo "   ✅ admin.pem registered with __ADMIN__ group successfully."
else
  echo "   ⚠️  Could not run UserManager.jar in takserver container (is it running?). Nginx WebTAK may return 403."
fi

# ── 11. Restart TAK Server to load new keystores ──
# This step is load-bearing for cert trust: until TAK Server actually reloads,
# it keeps serving its OLD keystore on :8089 while every package generated from
# here on bundles the NEW Root CA — a guaranteed "certificate not trusted" on
# ATAK/iTAK. So unlike the other steps in this script, failures here are fatal
# instead of a soft warning.
echo "-> [10/12] Restarting TAK Server to load new keystores and auth config..."
TAK_COMPOSE_DIR=""
for candidate in "/root/takserver" "/opt/tak"; do
  if [ -f "$candidate/docker-compose.yml" ]; then
    TAK_COMPOSE_DIR="$candidate"
    break
  fi
done

if [ -z "$TAK_COMPOSE_DIR" ]; then
  echo ""
  echo "=================================================================="
  echo "❌ FATAL: Could not find TAK Server's docker-compose.yml"
  echo "   (looked in /root/takserver, /opt/tak)."
  echo ""
  echo "   TAK Server is STILL RUNNING with its OLD keystore. The certs just"
  echo "   written to disk (including truststore-root.p12) do NOT match what"
  echo "   TAK Server is currently presenting on :8089."
  echo ""
  echo "   DO NOT generate or hand out any user packages until TAK Server has"
  echo "   been restarted. Restart it manually, then rerun this script from"
  echo "   the correct location, or set the compose dir and restart yourself:"
  echo "      cd /path/to/takserver && docker compose restart"
  echo "=================================================================="
  exit 1
fi

cd "$TAK_COMPOSE_DIR"
if ! docker compose restart 2>/dev/null && ! docker-compose restart 2>/dev/null; then
  echo ""
  echo "=================================================================="
  echo "❌ FATAL: 'docker compose restart' failed in $TAK_COMPOSE_DIR."
  echo ""
  echo "   TAK Server may still be serving its OLD keystore. DO NOT generate"
  echo "   or hand out any user packages until this is resolved — check:"
  echo "      cd $TAK_COMPOSE_DIR && docker compose logs --tail 50"
  echo "=================================================================="
  exit 1
fi
echo "   TAK Server restarted from $TAK_COMPOSE_DIR"
cd "$ARES_DIR"

# ── 12. Rebuild telemetry bridge ──
echo "-> [11/12] Rebuilding telemetry bridge with new certs..."
cd "$ARES_DIR"
docker compose -f docker-compose.prod.yml up -d --build telemetry 2>/dev/null || true

# ── 13. Verify the live TLS cert on :8089 actually chains to the new Root CA ──
# This is the check that would have caught the original bug: the restart
# "succeeding" doesn't guarantee TAK Server picked up the NEW keystore. Confirm
# it directly by doing a real TLS handshake against the new CA before we ever
# tell the operator it's safe to hand out packages.
echo "-> [12/12] Verifying TAK Server's live certificate matches the new Root CA..."
echo "   ── waiting for TAK Server to come back up (20s)... ──"
sleep 20

CHAIN_OK=0
if [ -f "$ARES_DIR/cert/truststore-root.pem" ]; then
  if openssl s_client -connect localhost:8089 -CAfile "$ARES_DIR/cert/truststore-root.pem" </dev/null 2>&1 \
      | grep -q "Verify return code: 0"; then
    CHAIN_OK=1
  fi
fi

if [ "$CHAIN_OK" = "1" ]; then
  echo "   ✅ VERIFIED: TAK Server's live cert on :8089 chains to the new Root CA."
else
  echo ""
  echo "=================================================================="
  echo "❌ WARNING: Could not verify that TAK Server's live cert on :8089"
  echo "   chains to the new Root CA. Packages generated now may fail with"
  echo "   'certificate not trusted' on ATAK/iTAK."
  echo ""
  echo "   Check manually:"
  echo "      openssl s_client -connect ares-werx.com:8089 -CAfile cert/truststore-root.pem"
  echo "=================================================================="
fi

# ── Done ──
echo ""
echo "=================================================================="
if [ "$CHAIN_OK" = "1" ]; then
  echo " 🎉 SUCCESS — PKI Rebuild Complete & Verified"
else
  echo " ⚠️  PKI Rebuild Complete — VERIFICATION FAILED (see warning above)"
fi
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
echo " ── Auto-verifying bridge connection... ──"
echo "=================================================================="

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
