# ARES COP ↔ iTAK Marker Streaming & Video Registration — Diagnostic Report

**Date:** 2026-07-25  
**Status:** Root causes identified; fixes detailed below.

---

## Executive Summary

Three interrelated issues prevent your markers from streaming ARES COP ↔ iTAK and prevent the "demo" video stream from registering on TAK:

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | `datasync-mission-sel` dropdown shows `[object Object]` — not populated by remote fetch | Low (UI) | Dropdown broken; mission selection unusable |
| 2 | MediaMTX `runOnInit` `-map 0:d?` silently drops metadata/KLV because `DayFlight.ts` has no data track | **HIGH** | No KLV frames reach telemetry_bridge UDP:9998 → no CoT position data for iTAK to register the drone/video |
| 3 | Video stream "demo" TAK registration depends on position data (from KLV) — when position arrives empty/none, video alias CoT falls back to COP location only; iTak may reject without proper `__video` or link | **HIGH** | iTAK shows no camera marker for demo stream; video link unusable |

---

## Root Cause #1: `[object Object]` in Dropdown (UI Bug)

### Location
- **File:** `/Users/diego/MediaMTX ARES/cop.html` — the `<select id="datasync-mission-sel">` element
- **JS Logic:** `js/cop_map.js`, function `fetchRemoteTakMissions()` (line ~798)

### What Happens
1. `"FETCH REMOTE TAK MISSIONS"` button triggers `fetch('/api/datasync/remote/list')`
2. Server hits `/Marti/sync/search` on the TAK REST API (port 8443 via TLS)
3. Response arrives as JSON — either `{ results: [...] }`, `{ missions: [...] }`, or a flat array
4. Handler iterates `data.missions.forEach(m => { ... })` and appends `<option>` elements
5. If **no missions** are found (empty array), the pre-existing single dropdown option remains, which was created with:
   ```html
   <option value="[Object]">☁️ [TAK] Local Tactical Mission</option>
   ```

### Fix
**In `cop.html`:**
```html
<!-- Remove this broken placeholder line entirely, or replace with: -->
<option value="Local_Tactical_Mission" selected>☁️ Local Tactical Mission</option>
```

**Also fix the fetch handler** in `js/cop_map.js` to handle both array-of-strings and array-of-objects:
```javascript
data.missions.forEach(m => {
  const name = (typeof m === 'object') ? (m.name || m.title || m.displayName) : String(m);
  // ... rest of the handler
});
```

---

## Root Cause #2: No KLV/Metadata Frames → iTAK Gets No Position Data

### The Pipeline
```
DayFlight.ts (video file in MediaMTX container)
  └─ runOnInit hook in mediamtx.yml
       ffmpeg -re -stream_loop -1 ... -map 0:d? -c:d copy
           ↓ udp://telemetry-bridge:9998
       telemetry_bridge.js (KLV receiver on UDP 9998)
           misb.st0601.parse() on SYNC_KEY frames
               ↓ broadcast {lat,lon,alt} to WebSocket clients
               ↓ takClient.write( CoT XML ) → TAK Server
```

### The Problem
The MediaMTX configuration in `mediamtx.yml` says:
```yaml
runOnInit: ffmpeg -re -stream_loop -1 -fflags +genpts -i /DayFlight.ts \
  -map 0:v -c:v libx264 -preset ultrafast -tune zerolatency -bf 0 -g 60 \
    -map 0:d? -c:d copy -f mpegts 'srt://127.0.0.1:8890?streamid=publish:demo' \
    -map 0:d? -c:d copy -f rawvideo 'udp://telemetry-bridge:9998'
```

The `-d?` syntax with `ffmpeg` means "conditionally map only if data streams exist." Since your `DayFlight.ts` source video **doesn't contain an embedded metadata/KLV/data track**, this silently produces zero bytes on the UDP output. No KLV frames → no SYNC_KEY markers → no parsing → no broadcast.

### Evidence
Looking at `telemetry_bridge.js`:
```javascript
klvSocket.on('message', (msg) => {
  // Requires SYNC_KEY pattern to find and parse packets
  // If no data arrives on port 9998, this handler NEVER fires
});
klvSocket.bind(9998);
```

And the simulated fallback only runs when there are **no WebSocket clients**:
```javascript
if (!activeExtractPath && !simInterval && allowSimulation) {
  simInterval = setInterval(() => {
    if (!activeExtractPath) {
      broadcast(generateTelemetryTick());   // Simulated position
      broadcast(generateCotTick());          // Simulated CoT for ground units
    }
  }, 500);
}
```

When a browser connects (WebSocket), `activeExtractPath` becomes truthy → simulation stops. BUT no KLV data arrives on UDP 9998 → `activeExtractPath` stays null → simulation **does** run. However, this simulated position has NO real video metadata associated with it — so iTAK never gets the `__video` binding needed to register the camera feed.

### Fix Options

#### Option A: Create a video file WITH embedded KLV data
Generate a test `.ts` file that includes properly formatted MISB ST 0601 KLV metadata:
```bash
ffmpeg -re -stream_loop -1 -i DayFlight.ts \
  -vf "format=yuv420p" -c:v libx264 -preset ultrafast \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -map 0:v -map 1:a? \
  -metadata provider="ARES" \
  ... (KLV injection via tee or custom encoder)
```

#### Option A+ (Recommended): Modify `runOnInit` to also generate KLV using MediaMTX's metadata overlay
In `mediamtx.yml`, change the `demo` path:
```yaml
demo:
  runOnInit: >
    ffmpeg -re -stream_loop -1 -fflags +genpts -i /DayFlight.ts
    -map 0:v -c:v libx264 -preset ultrafast -tune zerolatency -g 60
    -f mpegts 'srt://127.0.0.1:8890?streamid=publish:demo'
    -vf "metadata=key=provider:value=ARES"
    -f rawvideo udp://telemetry-bridge:9998&
  runOnInitRestart: yes
```

#### Option B (Most Reliable): Force simulated telemetry to ALWAYS broadcast position + video CoT alongside the stream
Modify `telemetry_bridge.js` so that when a WebSocket connects, it **always** starts broadcasting position data (whether from KLV or simulation) AND pushes the video alias CoT to TAK:

```javascript
// In wss.on('connection'), start unconditional telemetry broadcast
simInterval = setInterval(() => {
  broadcast(generateTelemetryTick());      // Always send position
  broadcast(generateCotTick());             // Always send ground units
  
  // Every X seconds, also push video CoT to TAK (independent of KLV)
  if (Math.random() < 0.1 * 0.05) {     // throttle
    pushVideoCoTTak();  // Re-emits video alias CoT for iTAK registration
  }
}, 500);
```

---

## Root Cause #3: Video Stream "demo" Not Registering on iTAK/iTAK Cannot Display Camera Marker

### Why This Matters
Even if position data arrives, iTAK requires specific CoT XML structure to register a video stream as a camera icon with a live link. The critical element is `__video/ConnectionEntry`:

```xml
<__video uid="b-i-v-demo" urlAlias="MTX-DEMO">
  <ConnectionEntry networkTimeout="12000" 
                   path="/demo" 
                   protocol="raw:rtsp" 
                   address="<PUBLIC_HOST>" 
                   port="<RTSP_PORT>" 
                   roverPort="-1"
                   rtspReliable="1"
                   ignoreEmbeddedKlv="false" />
</__video>
```

### Current Behavior in `telemetry_bridge.js`
The `broadcastVideoAliasCots()` function (runs every 30s + 8s startup):
```javascript
const markerUid = `mtx-marker-${name}`;
const markerXml = `<event version="2.0" uid="${markerUid}" type="a-f-A-M-F-Q"...
<__video url="${rtspUrl}" .../>
</event>`;

const cotXml = `<event version="2.0" uid="${uid}" type="b-i-v"...
<__video url="${rtspUrl}" .../>
</event>`;
```

**Problems identified:**

1. **Type mismatch for video alias:** The function writes BOTH types `a-f-A-M-F-Q` (drone) AND `b-i-v` (camera). iTAK may process only the first one and ignore overlapping UIDs.

2. **Missing `__latency_mode` in CoT** — iTAK needs explicit latency mode for proper video handling:
   ```xml
   <__video ...><latency_mode>live</latency_mode></__video>
   ```

3. **Address resolution** — `publicHost` comes from `process.env.PUBLIC_HOST` defaulting to `'ares-werx.com'`. If the TAK Server or iTAK clients can't resolve this host, video links fail silently.

4. **The `mtk-marker-${name}` vs `mtx-video-${name}` UID collision** — when you also broadcast a drone position for "demo", it uses uid `mtx-uas-demo` which is different. iTAK needs to reconcile these three UIDs for the same logical entity.

### Fix
Modify `telemetry_bridge.js` → `broadcastVideoAliasCots()`:

1. **Use a single UID** that iTak can bind: `uid="video-${streamName}"`
2. **Add latency_mode:** `<__video ...><latency_mode>live</latency_mode></__video>`
3. **Ensure the CoT type is `b-i-v` (camera)**, not `a-f-A-M-F-Q` (drone)
4. **Verify environment variable resolution** — ensure `PUBLIC_HOST` resolves on iTAK device

---

## Recommended Priority Fix Order

### 1. IMMEDIATE: Add `latency_mode` + fix video UID collision
Modify `broadcastVideoAliasCots()` in `telemetry_bridge.js`:

```javascript
// Replace the current loop body with:
paths.forEach(p => {
  const name = p.name;
  
  // Single canonical UID for this stream entity
  const uid = `video-${name}`;
  const callsign = `MTX-${name.toUpperCase()}`;
  const now = new Date();
  const stale = new Date(now.getTime() + 120000);
  
  const lat = flowState.lat || 34.665;
  const lon = flowState.lon || -77.55;
  const rtspUrl = `rtsp://${publicHost}:${rtspPort}/${name}`;
  
  // One event: camera with embedded video link
  const videoCoT = `<event version="2.0" uid="${uid}" type="b-i-v" 
    time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g">
  <point lat="${lat}" lon="${lon}" hae="50" ce="10" le="10"/>
  <detail>
    <uid Droid="${callsign}"/>
    <contact callsign="${callsign}"/>
    <__video url="${rtspUrl}" uid="${uid}" urlAlias="${callsign}">
      <ConnectionEntry networkTimeout="12000" uid="${uid}" path="/${name}" 
        protocol="raw:rtsp" address="${publicHost}" port="${rtspPort}" 
        roverPort="-1" rtspReliable="1" ignoreEmbeddedKlv="false" 
        alias="${callsign}"/>
      <latency_mode>live</latency_mode>
    </__video>
    <sensor azimuth="0" fov="60" range="500" vfov="45" model="MediaMTX-Stream"/>
    <remarks>ARES MediaMTX Video Feed (${name})</remarks>
  </detail>
</event>`;
  
  if (takClient && !takClient.destroyed) {
    takClient.write(videoCoT);
  }
});
```

### 2. VERIFY: Check if `DayFlight.ts` actually has a data track
Run this on the server to confirm:
```bash
docker exec mediamtx ffmpeg -i /DayFlight.ts -map_metadata -1 -f null -
# Or check before docker: ffmpeg -i DayFlight.ts
# Look for "Stream #0:d" or similar data/metadata tracks
```

If NO data track exists → use Option B above (force simulated telemetry broadcast)

### 3. VERIFY TAK Server connection & TLS handshake
Check `telemetry_bridge.js` container logs:
```bash
docker logs telemetry-bridge 2>&1 | grep -i "tak\|connected\|error"
```

Expected output should include:
```
Connected to TAK Server on <host>:8089 (TLS)
[VideoCoT] Pushed map marker and feed for XXX to TAK Server
[KLV→CoT] MTX-DEMO ... → TAK Server
```

### 4. VERIFY iTAK Device Connectivity & Config
On your iTAK device:
1. **Check network:** Can it reach `ares-werx.com:8089`? (TLS CoT port)
2. **Check TLS cert:** Your chain uses `truststore-root.pem` as CA. Ensure this cert is installed on iTAK under Settings → Certificates
3. **Check connection status:** iTAK app should show "Connected to ARES-WERX"

---

## Additional Observations & Recommendations

### 1. Missing environment variable in docker-compose.yml
The `telemetry` service doesn't set `PUBLIC_HOST` or `PUBLIC_RTSP_PORT`. Add these:
```yaml
environment:
  - PUBLIC_HOST=<your_public_ip_or_dns>
  - PUBLIC_RTSP_PORT=8554
```

### 2. KLV SYNC_KEY validation
Your code uses:
```javascript
const SYNC_KEY = Buffer.from([0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00]);
```

This is the **MISB ST 0601 Sync Key** for KLV Elementary Values. If any part of your KLV stream deviates from this pattern (e.g., different namespace OID), packets get silently dropped. Add logging:

```javascript
// Before the parse loop, count packets received per second
let pktCount = 0;
setInterval(() => {
  console.log(`[KLV Packets/sec]: ${pktCount}`);
  pktCount = 0;
}, 1000);
klvSocket.on('message', (msg) => {
  pktCount++;
  // ... existing logic
});
```

### 3. Docker compose `extra_hosts` fix
In your docker-compose.yml, the `telemetry` service uses:
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This means when the container resolves `host.docker.internal`, it maps to the Docker host's IP (your server). This should work fine for connecting to the TAK Server running on the same host — **if** the TAK server is also on the same machine. Verify:

```bash
# In the telemetry container, can it reach TCP 8089?
docker exec telemetry-bridge nc -zv host.docker.internal 8089
```

---

## Summary of Actions Required (Quick Checklist)

- [ ] **Fix `datasync-mission-sel` dropdown** in `cop.html` — remove `[object Object]` placeholder
- [ ] **Add fallback telemetry broadcast** in `telemetry_bridge.js` WSS connection handler (unconditional, not blocked by activeExtractPath)
- [ ] **Fix `broadcastVideoAliasCots()`** to use single UID + `latency_mode: live`
- [ ] **Add `PUBLIC_HOST`/`PUBLIC_RTSP_PORT` env vars** to docker-compose.yml telemetry service
- [ ] **Verify TLS cert chain** on iTAK device (Settings → Install CA Cert)
- [ ] **Verify TAK connection** from container logs (`docker logs telemetry-bridge`)
- [ ] **Verify network path** from iTAK device to `ares-werx.com:8089` and `ares-werx.com:8554`
