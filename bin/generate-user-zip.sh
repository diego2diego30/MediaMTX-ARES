#!/usr/bin/env bash
set -euo pipefail

# generate-user-zip.sh — Generate a unique TAK data package ZIP for a given user
# Usage: ./bin/generate-user-zip.sh <username> [callsign]
#
# This script runs on the VPS where Docker containers are running.
# It:
#   1. Generates a client certificate via makeCert.sh in the takserver container
#   2. Copies the .p12 files out of the container
#   3. Builds a self-contained ZIP (pref + manifest + cert + CA)
#   4. Saves to ./user-zips/<username>.zip
#   5. Registers the fingerprint in UserAuthenticationFile.xml
#
# Requirements:
#   - Docker access to takserver container
#   - openssl installed locally
#   - zip installed locally

if [ $# -lt 1 ]; then
  echo "Usage: $0 <username> [callsign]"
  exit 1
fi

USERNAME="$1"
CALLSIGN="${2:-$USERNAME}"
USER_ZIPS_DIR="$(cd "$(dirname "$0")/.." && pwd)/user-zips"
TAK_CONTAINER="takserver"
CERT_DIR="/opt/tak/certs"
CERT_FILES_DIR="${CERT_DIR}/files"

echo "[User ZIP] Generating package for: $USERNAME (callsign: $CALLSIGN)"

# Step 1: Generate client certificate (must cd to cert dir first so cert-metadata.sh sources correctly)
echo "[User ZIP] Step 1: Generating client certificate..."
docker exec -e STATE=MD -e CITY=ANNAPOLIS -e ORGANIZATIONAL_UNIT=ARES "$TAK_CONTAINER" bash -c "cd $CERT_DIR && ./makeCert.sh client $USERNAME" || {
  echo "[User ZIP] Cert generation failed. It may already exist — continuing."
}

# Step 2: Copy .p12 files out
echo "[User ZIP] Step 2: Copying cert files..."
docker cp "$TAK_CONTAINER:${CERT_FILES_DIR}/${USERNAME}.p12" "/tmp/${USERNAME}.p12"
docker cp "$TAK_CONTAINER:${CERT_FILES_DIR}/truststore-root.p12" "/tmp/truststore-root.p12"

# Step 3: Create pref XML
echo "[User ZIP] Step 3: Building pref file..."
cat > "/tmp/${USERNAME}.pref" <<PREFEOF
<?xml version='1.0' encoding='utf-8'?>
<preferences>
  <preference version="1" name="cot_streams">
    <entry key="count" class="class java.lang.Integer">1</entry>
    <entry key="description0" class="class java.lang.String">ARES-WERX TLS Connection</entry>
    <entry key="enabled0" class="class java.lang.Boolean">true</entry>
    <entry key="connectString0" class="class java.lang.String">ares-werx.com:8089:ssl</entry>
  </preference>
  <preference version="1" name="com.atakmap.app_preferences">
    <entry key="displayServerConnectionWidget" class="class java.lang.Boolean">true</entry>
    <entry key="locationCallsign" class="class java.lang.String">${CALLSIGN}</entry>
    <entry key="caLocation" class="class java.lang.String">truststore-root.p12</entry>
    <entry key="caPassword" class="class java.lang.String">atakatak</entry>
    <entry key="certificateLocation" class="class java.lang.String">${USERNAME}.p12</entry>
    <entry key="clientPassword" class="class java.lang.String">atakatak</entry>
  </preference>
</preferences>
PREFEOF

# Step 4: Create manifest XML
echo "[User ZIP] Step 4: Building manifest..."
cat > "/tmp/manifest.xml" <<MANEOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<MissionPackageManifest version="2">
  <Configuration>
    <Parameter name="uid" value="${USERNAME}-$(date +%s)"/>
    <Parameter name="name" value="ARES-WERX ${USERNAME}"/>
    <Parameter name="onReceiveDelete" value="true"/>
  </Configuration>
  <Contents>
    <Content ignore="false" zipEntry="${USERNAME}.p12">
      <Parameter name="uid" value="${USERNAME}-p12"/>
    </Content>
    <Content ignore="false" zipEntry="truststore-root.p12">
      <Parameter name="uid" value="truststore-root-p12"/>
    </Content>
    <Content ignore="false" zipEntry="${USERNAME}.pref">
      <Parameter name="uid" value="${USERNAME}-pref"/>
      <Parameter name="mimeType" value="application/x-tak-config"/>
    </Content>
  </Contents>
</MissionPackageManifest>
MANEOF

# Step 5: Build the ZIP
echo "[User ZIP] Step 5: Building ZIP package..."
mkdir -p "$USER_ZIPS_DIR"
cd /tmp
zip -j "${USER_ZIPS_DIR}/${USERNAME}.zip" \
  "${USERNAME}.p12" \
  "truststore-root.p12" \
  "${USERNAME}.pref"
# Add manifest into MANIFEST/ subdirectory
zip "${USER_ZIPS_DIR}/${USERNAME}.zip" manifest.xml
# Move manifest entry to MANIFEST/ subdir
# (zip doesn't support renaming, so we recreate with correct structure)
cd /tmp
mkdir -p ziptmp/MANIFEST
cp manifest.xml ziptmp/MANIFEST/
cp "${USERNAME}.p12" ziptmp/
cp truststore-root.p12 ziptmp/
cp "${USERNAME}.pref" ziptmp/
cd ziptmp
rm -f "${USER_ZIPS_DIR}/${USERNAME}.zip"
zip -r "${USER_ZIPS_DIR}/${USERNAME}.zip" .
rm -rf /tmp/ziptmp

# Step 6: Register fingerprint in UserAuthenticationFile.xml
echo "[User ZIP] Step 6: Registering user fingerprint..."
# Extract the user cert fingerprint from the takserver container
FINGERPRINT=$(docker exec "$TAK_CONTAINER" openssl x509 -in "${CERT_FILES_DIR}/${USERNAME}.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d ':')
if [ -n "$FINGERPRINT" ]; then
  echo "[User ZIP] Fingerprint: $FINGERPRINT"
  docker exec "$TAK_CONTAINER" bash -c "
    sed -i '/identifier=\"${USERNAME}\" fingerprint=/d' /opt/tak/UserAuthenticationFile.xml
    sed -i '/<\\/UserAuthenticationFile>/i\\  <User identifier=\"${USERNAME}\" fingerprint=\"${FINGERPRINT}\"\\/>' /opt/tak/UserAuthenticationFile.xml
    echo 'Fingerprint registered in UserAuthenticationFile.xml'
  " || echo "[User ZIP] Warning: Could not update UserAuthenticationFile.xml"
else
  echo "[User ZIP] Warning: Could not extract fingerprint"
fi

echo "[User ZIP] Done! Package saved to: ${USER_ZIPS_DIR}/${USERNAME}.zip"
ls -lh "${USER_ZIPS_DIR}/${USERNAME}.zip"
