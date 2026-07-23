#!/usr/bin/env bash
set -e

echo "=================================================================="
echo " 🔐 Fixing TAK Server Certificate Hostname Mismatch..."
echo "=================================================================="

# Directories
ARES_DIR="/Users/diego/MediaMTX ARES"
TAK_CERT_DIR="/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/tak/certs"

cd "$TAK_CERT_DIR"

# Generate new certificate for ares-werx.com
echo "-> Generating new server certificate for ares-werx.com"
# Ignore keytool failure (exit code 1) since we only need the .p12 file, not .jks
STATE=MD CITY=ANNAPOLIS ORGANIZATIONAL_UNIT=ARES ./makeCert.sh server ares-werx.com || true

# Replace default takserver certificates
echo "-> Replacing default takserver.p12 with new certificates"
cd files
mv ares-werx.com.p12 takserver.p12
mv ares-werx.com.pem takserver.pem

# Extract and convert the Truststore to a .crt file for iOS compatibility
echo "-> Converting truststore to .crt for iOS"
# The truststore is in truststore-root.p12 with password 'atakatak'
# We extract the certificate and save it as ares-root.crt (using -legacy for OpenSSL 3 support)
openssl pkcs12 -legacy -in truststore-root.p12 -nokeys -out "$ARES_DIR/ares-root.crt" -passin pass:atakatak

echo "-> Copied ares-root.crt to $ARES_DIR"
echo "=================================================================="
echo " 🎉 SUCCESS! Certificates fixed and ready to be deployed."
echo "=================================================================="
