#!/usr/bin/env bash
set -e

echo "=================================================================="
echo " 🔐 Rebuilding TAK Server PKI (ARES-WERX Root CA)..."
echo "=================================================================="

ARES_DIR="/Users/diego/MediaMTX ARES"
TAK_CERT_DIR="/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/tak/certs"

cd "$TAK_CERT_DIR"

# 1. Wipe Old Certificates
echo "-> [1/6] Wiping old certificates..."
rm -f files/* || true

# 2. Generate New Root CA
echo "-> [2/6] Generating new Root CA ('ARES-WERX Root CA')..."
# Use yes '' to automatically answer any prompts if needed (though we supply vars)
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeRootCa.sh --ca-name "ARES-WERX Root CA"

# 3. Generate New Server Certificate
echo "-> [3/6] Generating new Server Certificate (ares-werx.com)..."
# Ignore keytool failure (exit code 1) due to no Java
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh server ares-werx.com || true

# Rename to takserver
cd files
mv ares-werx.com.p12 takserver.p12
mv ares-werx.com.pem takserver.pem
cd ..

# 4. Generate Admin Certificate
echo "-> [4/6] Generating new Admin Client Certificate..."
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh client admin || true

# 5. Export iOS Root Certificate
echo "-> [5/6] Exporting iOS-friendly Root Certificate..."
openssl pkcs12 -legacy -in files/truststore-root.p12 -nokeys -out "$ARES_DIR/ares-root.crt" -passin pass:atakatak

# 6. Rebuild ARES_Secure_Connection.zip
echo "-> [6/6] Rebuilding ARES_Secure_Connection.zip..."
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
echo "=================================================================="
