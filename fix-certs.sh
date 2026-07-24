#!/usr/bin/env bash
set -e

echo "=================================================================="
echo " 🔐 Rebuilding TAK Server PKI (ARES-WERX Root CA)..."
echo "=================================================================="

# ── Auto-detect paths ──
# On VPS: /root/MediaMTX-ARES  |  On macOS: /Users/diego/MediaMTX ARES
if [ -d "/root/MediaMTX-ARES" ]; then
  ARES_DIR="/root/MediaMTX-ARES"
elif [ -d "/Users/diego/MediaMTX ARES" ]; then
  ARES_DIR="/Users/diego/MediaMTX ARES"
else
  ARES_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# Look for TAK cert scripts in common locations
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
  echo "ERROR: Could not find TAK cert directory. Set TAK_CERT_DIR manually."
  exit 1
fi

echo "  ARES_DIR:     $ARES_DIR"
echo "  TAK_CERT_DIR: $TAK_CERT_DIR"

cd "$TAK_CERT_DIR"

# 1. Wipe Old Certificates
echo "-> [1/7] Wiping old certificates..."
rm -f files/* || true

# 2. Generate New Root CA
echo "-> [2/7] Generating new Root CA ('ARES-WERX Root CA')..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeRootCa.sh --ca-name "ARES-WERX Root CA"

# 3. Generate New Server Certificate
echo "-> [3/7] Generating new Server Certificate (ares-werx.com)..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh server ares-werx.com || true

# Rename to takserver
cd files
mv ares-werx.com.p12 takserver.p12 2>/dev/null || true
mv ares-werx.com.pem takserver.pem 2>/dev/null || true
cd ..

# 4. Generate Admin Client Certificate
echo "-> [4/7] Generating new Admin Client Certificate..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh client admin || true

# 5. Export iOS Root Certificate (PEM)
echo "-> [5/7] Exporting iOS-friendly Root Certificate..."
openssl pkcs12 -legacy -in files/truststore-root.p12 -nokeys -out "$ARES_DIR/ares-root.crt" -passin pass:atakatak

# 6. Export Root CA PEM for TLS connections (used by telemetry bridge)
echo "-> [6/7] Exporting Root CA PEM for telemetry bridge TLS..."
openssl pkcs12 -legacy -in files/truststore-root.p12 -nokeys -out "$ARES_DIR/cert/truststore-root.pem" -passin pass:atakatak

# Copy the admin client cert + key into cert/ for the telemetry bridge
cp files/admin.pem "$ARES_DIR/cert/tak-client.pem" 2>/dev/null || true
cp files/admin-key.pem "$ARES_DIR/cert/tak-client.key" 2>/dev/null || true
# Also copy the PKCS12 files
cp files/admin.p12 "$ARES_DIR/cert/admin.p12" 2>/dev/null || true
cp files/truststore-root.p12 "$ARES_DIR/cert/truststore-root.p12" 2>/dev/null || true

# 7. Rebuild ARES_Secure_Connection.zip
echo "-> [7/7] Rebuilding ARES_Secure_Connection.zip..."
cd "$ARES_DIR"
mkdir -p ARES_Secure_Connection
cp "$TAK_CERT_DIR/files/admin.p12" ARES_Secure_Connection/
cp "$TAK_CERT_DIR/files/truststore-root.p12" ARES_Secure_Connection/
rm -f ARES_Secure_Connection.zip
cd ARES_Secure_Connection
zip -q -r "../ARES_Secure_Connection.zip" .
cd ..

echo "=================================================================="
echo " 🎉 SUCCESS! PKI Rebuild Complete."
echo "------------------------------------------------------------------"
echo " All certs now signed by the SAME CA (ARES-WERX Root CA)."
echo " Root cert (PEM):    $ARES_DIR/ares-root.crt"
echo " Truststore PEM:     $ARES_DIR/cert/truststore-root.pem"
echo " Client cert (PEM):  $ARES_DIR/cert/tak-client.pem"
echo " Client key:         $ARES_DIR/cert/tak-client.key"
echo " Admin P12:          $ARES_DIR/cert/admin.p12"
echo " iTAK Bundle:        $ARES_DIR/ARES_Secure_Connection.zip"
echo "=================================================================="
