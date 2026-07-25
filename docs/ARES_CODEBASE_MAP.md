# ARES / MediaMTX — Codebase Architecture Map

Repository root (absolute): `/Users/diego/MediaMTX ARES`
Live site: https://ares-werx.com  (VPS `root@5.161.45.97`, deploy dir `~/MediaMTX-ARES`)
Generated: 2026-07-25 — read-only reconnaissance, no source files were modified.

## Top-level layout (what each file is)

- `/Users/diego/MediaMTX ARES/telemetry_bridge.js` (878 lines) — **the entire backend**. Node.js process that is simultaneously: HTTP API server (auth, users, recordings, mbtiles upload, tile server) on :8081, WebSocket hub for both GUIs, KLV UDP receiver on :9998, TAK Server TLS/TCP CoT client, and CoT simulator.
- `/Users/diego/MediaMTX ARES/cop.html` (145 lines) — ARES-COP page shell (header, map div, sidebar, chat panel, toast container).
- `/Users/diego/MediaMTX ARES/js/cop_map.js` (629 lines) — ARES-COP map/CoT/chat controller (all client logic).
- `/Users/diego/MediaMTX ARES/js/cop_video.js` (112 lines) — ARES-COP picture-in-picture HLS video player.
- `/Users/diego/MediaMTX ARES/css/cop.css` (508 lines) — ARES-COP styling incl. chat panel, toast, emergency pulse.
- `/Users/diego/MediaMTX ARES/mtx.html` (3493 lines) — MediaMTX Server GUI (single-file app: CSS + markup + JS; video wall, HUD, map, recordings).
- `/Users/diego/MediaMTX ARES/index.html`, `login.html`, `admin_hub.html` — portal landing, login form, admin user-management hub.
- `/Users/diego/MediaMTX ARES/mediamtx.yml` — MediaMTX server config + `paths:` stream registration.
- `/Users/diego/MediaMTX ARES/nginx.conf` / `nginx.prod.conf` — reverse proxy (dev / production).
- `/Users/diego/MediaMTX ARES/docker-compose.yml` / `docker-compose.prod.yml`, `Dockerfile`, `Dockerfile.telemetry` — container definitions.
- `/Users/diego/MediaMTX ARES/deploy-production.sh`, `sync-to-git.sh`, `push-tak-server.sh`, `fix-certs.sh` — deployment automation.

---

## (a) CoT (Cursor-on-Target) message parsing / ingestion from the TAK Server

All CoT ingestion happens in the telemetry bridge; there is **no XML library** — parsing is regex-based on a raw TCP/TLS byte stream.

- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:506-511` — module state: `takClient`, `cotBuffer`, `takServerConnected`, `takServerHostAddress`, `takServerVersion`.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:516-561` — `connectTAK()`: builds TLS options from env (`TAK_SERVER_HOST`, `TAK_SERVER_PORT`, `TAK_USE_TLS`, `TAK_CLIENT_CERT`, `TAK_CLIENT_KEY`, `TAK_CA_CERT`, `TAK_TLS_SERVERNAME`, `TAK_REJECT_UNAUTHORIZED`), connects via `tls.connect()` (line 543) or plain `net.Socket` (line 553), starts the 30 s ping interval.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:563-651` — **the CoT parser**: `takClient.on('data')` accumulates into `cotBuffer`, slices out `<event ...>...</event>` frames, then regex-extracts:
  - `uid`, `type`, `lat`, `lon`, `callsign` (lines 575-587)
  - shape vertices from `<link point="lat,lon,hae"/>` → `cotObj.vertices` (lines 590-597)
  - `<ellipse major/minor/angle>` → `cotObj.ellipse` (lines 599-608) — used for circles and rectangles
  - `<strokeColor>`, `<fillColor>`, `<strokeWeight>` signed-ARGB ints (lines 610-617)
  - `<remarks>` (lines 619-620) and `stale` attribute (lines 622-623)
  - caches into `cotCache` and `broadcast([cotObj])` to all browser WS clients (lines 626-628)
  - **Note / known gap**: no extraction of `<usericon iconsetpath=...>`, `<attachment>`/`<fileshare>` or `<image>` detail elements — this is why iTAK points that carry an attached image + custom (bicycle) icon do not render (see section b).
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:631-636` — GeoChat ingest: `type === 'b-t-f'` + `<remarks>` → `broadcast({type:'chat', sender, message, timestamp})`. Sender taken from `senderCallsign` only; **no recipient/chatroom extraction**, which is why COP cannot filter per-contact conversations.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:638-645` — TAK server version handshake (`t-x-takp-v`).
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:653-668` — `sendPing()`: self-presence CoT with hard-coded `uid="ARES-WERX-COP"` and `callsign="ARES COP"`, `lat=0/lon=0` (relevant to requirement (e)).
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:671-683` — reconnect on close (5 s) and error logging; `connectTAK()` invoked at line 684.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:728-736` — `cotCache` Map + 30 s stale sweeper (only prunes the server-side cache; it does not tell clients to remove a layer → contributes to lingering emergency beacons).
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:738-748` — on new browser WS connection, replays `tak_status` and the whole `cotCache`.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:342-407` — simulator (`rebuildCotUnits`, `generateTelemetryTick`, `generateCotTick`) that injects synthetic CoT/telemetry when no real stream is present.
- `/Users/diego/MediaMTX ARES/telemetry_bridge.js:408-414` — `broadcast(data)` fan-out helper to all WS clients.
- Outbound CoT (COP → TAK) command handlers: `/Users/diego/MediaMTX ARES/telemetry_bridge.js:759-870` (`push_target_cot` 781, `push_marker_cot` 796, `push_shape_cot` 810, `push_geochat` 845, `push_cot_raw` 864).
- Client-side entry point of the same pipeline: `/Users/diego/MediaMTX ARES/js/cop_map.js:165-217` (`connectTelemetry()`), dispatch at `js/cop_map.js:177-208` (`Array` → CoT, `tak_status`, `chat`, else KLV).
- CoT relay UDP port `4242/udp` is published for federation ingest — `docker-compose.yml:41` and `docker-compose.prod.yml:24`.

## (b) ARES-COP map rendering: shapes, markers/icons, attachments, emergency beacons

Single file: `/Users/diego/MediaMTX ARES/js/cop_map.js` (loaded by `cop.html:133`).

- **Map bootstrap** — `initCopMap()` `js/cop_map.js:56-163`: Leaflet map on `#cop-map-container`, Esri satellite/hybrid + Carto Dark base layers (61-89), offline MBTiles overlay `/tiles/{z}/{x}/{y}.png` (77-82), `L.Control.Draw` toolbar (94-105), draw-created handler (106-122), `window.broadcastShape()` (124-158, uses `alert()` — see section c), and `setInterval(pruneStaleShapes, 30000)` at line 161.
- **CoT dispatcher** — `processCotData()` `js/cop_map.js:255-263`: `u-d-*` → shapes, `b-m-r` → route, `b-a-*` → emergency, everything else → point.
- **Markers / icons**:
  - `processPointCot()` `js/cop_map.js:266-299` — converts CoT type to a MIL-STD-2525 SIDC and renders a `milsymbol` SVG `L.divIcon`; binds a permanent tooltip and popup; writes `window.trackData[id]`.
  - `cotToSidc()` `js/cop_map.js:243-253` — crude type→SIDC mapper (`b-m*` → generic point graphic). Any CoT whose SIDC produces an invalid symbol will fail to render — the likely cause of the missing bicycle-icon point.
  - `UAS_ICON` `js/cop_map.js:17-21`, `EMERGENCY_ICON` (pulsing 🚨 divIcon) `js/cop_map.js:23-27`.
  - KLV drone markers: `processKlvData()` `js/cop_map.js:219-241`.
- **Attachments (images) — NOT IMPLEMENTED**: there is no code path anywhere in `js/cop_map.js`, `cop.html` or `telemetry_bridge.js` that reads CoT `<attachment>`, `<fileshare>`, `<image>` or `<usericon>` details. The only `attachment` occurrence in the repo is the HTTP `Content-Disposition` header for recording downloads (`telemetry_bridge.js:253`). This is a gap to fill for item 2 of the parent task.
- **Shapes (rectangles / polygons / circles / lines)**:
  - `shapeStyle()` `js/cop_map.js:40-46` — stroke from `cot.strokeColor`, fill from `cot.fillColor` with a **hard-coded `fillOpacity: 0.15`** and `weight = cot.strokeWeight || 2` (thin-line / no-fill complaint originates here).
  - `argbToCss()` `js/cop_map.js:30-38` — signed 32-bit ARGB → `rgba()`.
  - `processShapeCot()` `js/cop_map.js:301-341` — circle `u-d-c` (line 311), rectangle `u-d-r` from center+ellipse via `rectCorners()` (line 317), polygon `u-d-p`/`u-d-r` from vertices (line 324), line `u-d-f` (line 330); layers stored in `shapeOverlays[uid]`.
  - `rectCorners()` `js/cop_map.js:404-423` — great-circle corner solver for center/major/minor/angle rectangles.
  - `processRouteCot()` `js/cop_map.js:343-368` — `b-m-r` route polyline + waypoint circle markers.
  - `pruneStaleShapes()` `js/cop_map.js:425-436` — runs every 30 s and deletes any shape whose `trackData.stale` is in the past. **Rectangles vanishing after ~5 s** trace to this function combined with the short `stale` value iTAK sends and the fact that a re-broadcast recreates the layer from scratch (`processShapeCot` line 304 removes then re-adds).
  - `buildPopup()` `js/cop_map.js:48-54`.
- **Emergency beacons**:
  - `processEmergencyCot()` `js/cop_map.js:370-402` — normalises the uid (strips `-9-1-1`, `-Alert`, `-Cancel` suffixes, lines 371-374), detects cancellation via `type` ending `-k`, `b-a-o-c`, or a callsign containing "cancel" (line 381), and removes the marker (lines 383-390). Otherwise creates/moves the `EMERGENCY_ICON` marker with `zIndexOffset: 1000` and pans the map (392-400).
  - **Gap for item 6**: emergency markers live in `markers{}`, and `pruneStaleShapes()` (line 425) only iterates `shapeOverlays{}` — an emergency marker is therefore never removed by stale expiry, only by an explicit cancel CoT that matches the heuristics at line 381.
- **Sidebar / TAK OBJECTS list & click-to-center** — `js/cop_map.js:518-602`: `panToTrack()` (551-560), `TYPE_ICON` map (562), `updateTrackSidebar()` (563-578), 2 s refresh loop (596-602).
- **Emergency CSS** — `/Users/diego/MediaMTX ARES/css/cop.css:464-472` (`@keyframes pulse-red`, `.emergency-label`).

## (c) ARES-COP alert / notification UI components

- **Toast component (target styling to standardise on)**:
  - Container element: `/Users/diego/MediaMTX ARES/cop.html:121` — `<div id="toast-container" class="toast-container">`.
  - `showToast(sender, message)` — `/Users/diego/MediaMTX ARES/js/cop_map.js:500-511`: builds `.toast-msg` with `.toast-sender` / `.toast-text`, auto-dismiss after 5000 ms, reverse `slideDown` animation on exit.
  - Styles: `/Users/diego/MediaMTX ARES/css/cop.css:474-483` (`.toast-container`), `485-498` (`.toast-msg`, `animation: slideDown 0.3s ease forwards`), `499-504` (`.toast-sender`), `505-508` (`@keyframes slideDown`).
  - Currently `showToast` is only invoked from `appendChatMessage()` (`js/cop_map.js:495`) when the chat panel is closed.
- **Native `alert()` calls that must be replaced by the sliding toast (parent task item 3)**:
  - `/Users/diego/MediaMTX ARES/js/cop_map.js:154` — `alert('Broadcasted to TAK Server!')` after a successful shape/marker broadcast.
  - `/Users/diego/MediaMTX ARES/js/cop_map.js:156` — `alert('Cannot broadcast: Telemetry disconnected.')`.
  - `/Users/diego/MediaMTX ARES/js/cop_map.js:620` — `alert('Map uploaded successfully!')`, `:622` `alert('Failed to upload map.')`, `:623` `alert('Map upload error.')` inside `window.handleMapUpload`.
- **Reference implementation in the MediaMTX GUI (the "sliding popup" the user likes)**:
  - `toast(msg)` function — `/Users/diego/MediaMTX ARES/mtx.html:2365-2371` (adds/removes `.show`, 2800 ms timer).
  - Element — `/Users/diego/MediaMTX ARES/mtx.html:2284` (`<div class="toast" id="toast">`).
  - CSS — `/Users/diego/MediaMTX ARES/mtx.html:1303-1324` (`.toast` fixed bottom-right, `transform: translateX(160%)` → `.toast.show { transform: translateX(0) }`), mobile override at `mtx.html:1551`.
  - Secondary warning bar — `showWarn()` / `hideWarn()` at `mtx.html:2376-2382`.
- **Connection-status indicator** — `cop.html:25-28` (`#telemetry-status`, `#telemetry-status-text`) driven by `js/cop_map.js:172-175` and `209-217`; TAK status panel `cop.html:56-64` driven by `js/cop_map.js:181-201`.
- **Chat unread badge** — `cop.html:117` `#chat-badge`, updated in `js/cop_map.js:490-494`.

## (d) ARES-COP chat / messaging UI and contact list

- **Markup** — `/Users/diego/MediaMTX ARES/cop.html:102-118`: `#chat-panel`, header, recipient `<select id="chat-recipient">` (lines 105-109), `#chat-log` (110), input row `#chat-input` + `#chat-send-btn` (111-114), floating `#chat-toggle-btn` with `#chat-badge` (116-118).
- **Behaviour** — `/Users/diego/MediaMTX ARES/js/cop_map.js`:
  - `initChat()` lines 438-457 — panel open/close, unread reset, send bindings, Enter-to-send.
  - `sendChatMessage()` lines 459-479 — reads the selected recipient callsign and its `data-uid`, sends `{cmd:'push_geochat', senderCallsign:'ARES-COP', message, recipientCallsign, recipientUid}` (sender is **hard-coded** at line 471 — relevant to item 5), and locally echoes with a `[To: X]` prefix (line 476).
  - `appendChatMessage()` lines 481-498 — appends every inbound message into the single `#chat-log`. **There is no per-conversation store or filtering** — this is exactly why "all messages appear together" regardless of recipient (parent task item 4).
  - `showToast()` lines 500-511 and `escapeHtml()` lines 513-516.
  - **Contact list builder** — `updateChatRecipients()` lines 579-594: fills the `<select>` from `window.trackData` filtering `t.type === 'GROUND UNIT' || t.type.includes('USER')`. Because `processPointCot()` (`js/cop_map.js:294-297`) labels anything not `-A-` and not `b-m*` as `GROUND UNIT`, **map markers leak into the contact list** (parent task item 4). Refreshed every 2 s at lines 596-602.
- **Backend GeoChat send** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js:845-863` (`push_geochat`): constructs `GeoChat.<senderUid>.<recipientUid>.<msgId>` uid, `<__chat chatroom id senderCallsign>`, `<chatgrp uid0 uid1>`, `<remarks source="BAO.F.ATAK...">`, writes to `takClient`, then re-broadcasts to all COP clients **without recipient metadata** (line 862) — the second half of the chat-filtering bug.
- **Backend GeoChat receive** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js:631-636` (described in section a).
- **Chat CSS** — `/Users/diego/MediaMTX ARES/css/cop.css:328-356` (toggle button + badge), `357-393` (`.chat-panel`, `.chat-panel.open`, `.chat-header`, `.chat-log`), `394-426` (`.chat-message`, `.chat-self`, `.chat-sender`, `.chat-time`, `.chat-text`), `427-462` (input row + send button).

## (e) ARES-COP user authentication / "ARES WERX" user account context

- **User store & sessions (backend)** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js`:
  - `usersFile = path.join(__dirname,'users.json')` line 36; default seed + `usersDB` load lines 37-44; `saveUsers()` line 45. (Note: `users.json` is **not** present in the local working copy — it is created/kept on the server.)
  - `sessions` object line 47; `getSession(req)` lines 48-58 (parses the `ares_session_id` cookie, checks expiry).
  - `POST /auth/login` lines 67-88 — validates username/password, issues 32-byte hex session id, sets `Set-Cookie: ares_session_id=...; HttpOnly; Max-Age=86400`.
  - `/auth/logout` lines 90-101; `/auth/verify` lines 103-107; `/auth/verify_admin` lines 109-115 (role gate).
  - `GET /api/me` lines 117-127 — **returns `{role, username}`; this is the endpoint to use for the "ARES COP [admin]" callsign requirement (parent task item 5).**
  - `GET/POST/DELETE /api/users` lines 129-166 — admin-only user CRUD.
- **Login page** — `/Users/diego/MediaMTX ARES/login.html`: form markup lines 171-190, submit handler lines 197-240, auth URL selection lines 218-220, `fetch(authUrl, {credentials:'include'})` line 222.
- **Portal / role display** — `/Users/diego/MediaMTX ARES/index.html:292-299` (`fetch('/api/me')`, hides admin tiles when `role !== 'admin'`), logout at `index.html:302-305`.
- **Admin hub** — `/Users/diego/MediaMTX ARES/admin_hub.html:279-336`: `fetchUsers()` (279), add user (307-322), `deleteUser()` (325-334), role `<select id="new-role">` (245).
- **Nginx auth enforcement** — `/Users/diego/MediaMTX ARES/nginx.prod.conf`: `error_page 401/403 → /login` lines 41-42; internal `auth_request` targets `= /auth/verify` lines 50-56 and `= /auth/verify_admin` lines 59-65; public `= /auth/login` lines 68-70; `/api/me` line 73, `/api/users` line 76; public routes for `/`, `/index.html`, `/login`, `/ARESLogo.png` lines 92-110; admin-gated `admin_hub` lines 112-118; everything else (`location /`, line 127) behind `auth_request`. Dev equivalents: `nginx.conf:34-74`.
- **Callsign/identity gap for item 5**: the COP identity is hard-coded in three places and never consults `/api/me` —
  - `telemetry_bridge.js:657` `uid="ARES-WERX-COP"`, `:661` `<uid Droid="ARES COP"/>`, `:662` `callsign="ARES COP"`, with `lat="0.0" lon="0.0"` (line 659) so no real geolocation is published;
  - `telemetry_bridge.js:849` `senderUid = 'ARES-WERX-COP'`;
  - `js/cop_map.js:471` `senderCallsign: 'ARES-COP'`.
  There is currently **no `navigator.geolocation` usage anywhere in the repo**, so browser location must be added for the self-marker requirement.

## (f) MediaMTX stream registration, publishing and TAK video-feed integration

- **Stream/path registration (server side)** — `/Users/diego/MediaMTX ARES/mediamtx.yml`:
  - Protocol enablement: RTSP `:8554` lines 5-7, RTMP `:1935` lines 10-11, SRT `:8890` lines 14-15, HLS `:8888` lines 18-28 (`hlsAlwaysRemux`, lowLatency, `hlsAllowOrigins: ["*"]`), WebRTC `:8889` lines 31-33, Admin API `:9997` lines 36-38.
  - Publish/read credentials: `authInternalUsers` lines 42-56 (`ares_pilot` / `ares_secure`, plus an anonymous `any` user).
  - `paths:` block lines 59-63 — the `demo` path `runOnInit` (line 61) loops `/DayFlight.ts` through FFmpeg, republishes video over SRT to `publish:demo`, **and forks the KLV data track to `udp://telemetry-bridge:9998`**; `all:` (line 63) accepts arbitrary dynamic publish paths.
- **Path discovery / KLV auto-attach** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js:694-725` `pollMediaMtxForKlv()` polls `${MTX_API_URL}/v3/paths/list` every 2 s (interval created line 726), picks the first ready path whose `tracks[]` matches `/klv|meta|data|async|sync/i` (lines 703-710) and calls `startFfmpegExtraction()` / `stopFfmpegExtraction()` (`:498-504`, `:685-693`).
- **TAK video-feed CoT (the mechanism that should make streams appear in iTAK/WebTAK)** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js:462-484`, inside the KLV UDP handler:
  - Throttle guard `lastKlvCotPush > 3000` line 464.
  - `cotUid = 'mtx-uas-' + streamId'` line 467, `cotCallsign = 'MTX-<STREAM>'` line 468.
  - `videoUrl = rtsp://ares-werx.com:8554/<streamId>` line 478.
  - CoT XML line 479 with `type="a-f-A-M-F-Q"`, `<__video url=... ConnectionEntry="ARES Video Server"/>`, `<sensor .../>`, `<remarks>ARES MediaMTX Video Feed</remarks>`, 60 s stale (line 466), written to `takClient` line 481.
  - **Root cause candidates for parent task item 7**: (1) this CoT is emitted *only* from inside the KLV branch (`if (lat!==undefined && lon!==undefined)`, line 452) so a stream **without KLV never gets registered with TAK at all**; (2) `streamId` is hard-coded to `'demo'` at line 453 (`// TODO: make dynamic per source`), so every feed is announced as `mtx-uas-demo`; (3) `__video` lacks the `<ConnectionEntry uid/protocol/address/port/path/>` child element iTAK expects for a selectable video alias.
- **Client-side stream lists**: COP sidebar `js/cop_map.js:528-547` (`pollMediaMtxStreams()` → `/api/v3/paths/list`, 3 s interval line 546); MediaMTX GUI `mtx.html:2520-2525` `fetchPaths()`, `:2526-2545` `refreshAll()`, `:2546-2598` `updatePaths()`, `:2599-2606` `playMtx()`, `:2607-2625` `addPathToGrid()`, `:2695-2713` `addCustomStream()`, defaults at `mtx.html:2324`.
- **Playback plumbing**: `makeHls()` `mtx.html:2431-2481`, `playMain()` `:2482-2509`, video wall `buildWall()` `:2626-2694`; COP PiP player `/Users/diego/MediaMTX ARES/js/cop_video.js` (`initPipDraggable()` line 4, `openPip()` / HLS attach later in file).
- **Proxy routes**: `/hls/` → `mediamtx:8888` (`nginx.prod.conf:136-152`, dev `nginx.conf:76-92`), `/api/` → `mediamtx:9997` (`nginx.prod.conf:154-166`, dev `nginx.conf:105-118`).
- **Manual publisher helper**: `/Users/diego/MediaMTX ARES/stream_camera.sh` (FFmpeg camera → MediaMTX).

## (g) MediaMTX Server GUI — recordings list/download UI and recording start/stop backend

- **Backend (all in `/Users/diego/MediaMTX ARES/telemetry_bridge.js`)**:
  - `activeRecordings` registry — line 60; recordings directory resolution + auto-create — lines 168-169 (`path.join(__dirname,'recordings')`; note the container mounts `./recordings:/app/recordings`, see compose).
  - `POST /api/record/start` — lines 171-209: filename `\`${streamId}-${ISO timestamp}.mp4\`` (lines 178-180), pulls `${MTX_RTSP_URL}/${streamId}` (lines 182-183), spawns `ffmpeg -i <url> -c copy -f mp4 <filepath>` (lines 185-190), stores the child process, cleans up on `close` (195-197). **Known fragility for parent task item 8**: `-c copy` into fragmented-less MP4 killed with SIGINT frequently yields an unfinalised/unplayable file, and there is no `-movflags +faststart`/`-f matroska` fallback.
  - `POST /api/record/stop` — lines 211-229 (`ffmpeg.kill('SIGINT')`).
  - `GET /api/recordings` — lines 230-243: lists `*.mp4` with `size`/`mtime`, sorted newest first.
  - `GET /api/recordings/download/<file>` — lines 245-260: `path.basename()` traversal guard (246), streams with `Content-Disposition: attachment` (253).
- **Frontend (all in `/Users/diego/MediaMTX ARES/mtx.html`)**:
  - Toolbar buttons: record `#record-main-btn` line 2124 (`onclick="toggleRecord()"`), open recordings `#view-recordings-btn` line 2130 (`onclick="openRecordingsModal()"`), recenter `#recenter-map-btn` line 2136 — currently a concentric-circles "crosshair" SVG (lines 2139-2140); **parent task item 8 asks for a location-arrow icon inside this same button**.
  - `toggleRecord()` — lines 3404-3452: POSTs to `/api/record/start` (3414) and `/api/record/stop` (3434), toggles button colour/state.
  - Recordings modal markup — lines 3377-3399: fixed table with columns FILENAME / SIZE / DATE / ACTION, `<tbody id="recordings-list">` line 3393. The modal is `width:75%; height:75vh` with a plain `<table>` and **no responsive/mobile rules**, which is the desktop+mobile UI defect in parent task item 8.
  - `openRecordingsModal()` — lines 3453-3487: `fetch('/api/recordings')` (3459), row rendering with size in MB and locale date (3466-3484), download anchor `\`/api/recordings/download/${encodeURIComponent(f.name)}\`` (3479).
  - `closeRecordingsModal()` — lines 3488-3490.
  - Mobile layout helpers that new responsive CSS should hook into: `initMobileTabs()` lines 2917-2960, `initSwipeFeeds()` 2961-3067, `initLandscapeOverlay()` 3068-3141, plus media-query blocks around `mtx.html:1551`.
- **Proxy routes**: `/api/record` and `/api/recordings` → `telemetry:8081` — `nginx.prod.conf:79-90`, dev `nginx.conf:93-103`.
- **Volume**: `./recordings:/app/recordings` — `docker-compose.yml:52`, `docker-compose.prod.yml:28`. The `recordings/` directory does not yet exist in the local checkout (created at runtime by `telemetry_bridge.js:169`).

## (h) MediaMTX GUI map and KLV telemetry parsing / association

- **KLV parsing (backend)** — `/Users/diego/MediaMTX ARES/telemetry_bridge.js`:
  - MISB ST0601 sync key constant line 11; `misb` import line 10 (`@vidterra/misb.js`).
  - UDP socket + buffer — lines 416-419; bind on `:9998` lines 489-491.
  - `klvSocket.on('message')` lines 421-487: SYNC_KEY framing (425-438), `misb.st0601.parse()` line 440, tag extraction — 13 lat / 14 lon / 15 alt / 5 heading / 6 pitch / 7 roll (lines 443-450).
  - **`const streamId = 'demo'; // TODO: make dynamic per source`** — line 453. **This single line is the root cause of parent task item 9**: every KLV packet, regardless of origin, is broadcast tagged `stream_id: 'demo'`.
  - Broadcast payload `{stream_id, lat, lon, alt, hdg, pitch, roll}` lines 454-461.
  - KLV → TAK CoT push lines 462-484 (see section f).
- **GUI telemetry consumption** — `/Users/diego/MediaMTX ARES/mtx.html`:
  - `startTelemetryWs()` lines 3244-3349; WS URL `${proto}//${host}/ws/telemetry` line 3248 with direct `:8081` fallback line 3254.
  - `onmessage` lines 3263-3333 — filters non-telemetry frames (3267-3269) and performs **stream association** at lines 3272-3283: `dataStreamId = (data.stream_id || 'demo')`; if the id is `'demo'` the guard is skipped entirely, so demo-drone KLV is displayed on top of *any* selected feed (`if (dataStreamId !== 'demo' && ...)`, line 3278). Fixing item 9 means making this an exact `currentMainFeed` match and removing the `'demo'` exemption.
  - HUD field updates lines 3286-3300 (`hud-lat/lon/alt/hdg/pitch/roll`) and sidebar `sb-*` fields lines 3302-3333; telemetry badge lines 3259-3261 and 3337; `stopTelemetryWs()` 3350-3358; `resetTelemetryUI()` 3359-3376.
  - Sidebar telemetry markup `#telemetry-badge` line 2064, `#sidebar-telemetry` line 2066; HUD toggle `toggleHud()` line 3223.
- **GUI map** — `/Users/diego/MediaMTX ARES/mtx.html`:
  - Container `<div id="map-container">` line 2192; MAP toggle button `#btn-cop-toggle` line 2147.
  - `toggleCopMap()` lines 3149-3222 — creates the Leaflet map (3178), disables auto-pan on user drag/zoom (3183-3184), Carto Dark (3186) / Esri satellite (3189) / Esri labels (3192) / hybrid group (3195), layer control (3197-3203), and the feed marker.
  - `createAresCopMarker(latlng, callsign)` lines 3162-3181 — green divIcon with the feed label; initial marker + "AWAITING TELEMETRY" popup lines 3205-3213.
  - `recenterMap()` lines 3142-3147 — pans to `copMarker`; bound to `#recenter-map-btn` (line 2136).
  - Marker position/popup updates driven from the telemetry `onmessage` block (within lines 3286-3333) — this is where "metadata from a different stream" currently bleeds onto the map marker.
- **Offline tiles path (shared)** — MBTiles upload `POST /api/upload_map` `telemetry_bridge.js:262-284`, SQLite open `connectTilesDb()` `:15-34`, tile server `GET /tiles/{z}/{x}/{y}.png` `:287-319`; COP consumer `js/cop_map.js:77-82`; upload UI `js/cop_map.js:606-628` and `cop.html:73-79`.

## (i) Docker / Compose services, container build steps, git remote & branch

- **Development compose** — `/Users/diego/MediaMTX ARES/docker-compose.yml`:
  - service `mediamtx` → container `mediamtx`, image `bluenviron/mediamtx:latest-ffmpeg`, ports 8554/8000-8001 udp/1935/8888/8889/8890 udp/9997, mounts `./mediamtx.yml` and `./DayFlight.ts` (lines 3-20).
  - service `gui` → container `mediamtx-gui`, image `nginx:alpine`, `8080:80`, mounts repo root read-only as web root + `./nginx.conf` (lines 23-31).
  - service `telemetry` → container `telemetry-bridge`, **built** from `Dockerfile.telemetry` (context `.`), ports 8081, 9998/udp, 4242/udp, env `MTX_API_URL`, `MTX_RTSP_URL`, `TAK_SERVER_HOST/PORT`, `TAK_USE_TLS`, `TAK_CLIENT_CERT/KEY`, `TAK_CA_CERT`, `TAK_TLS_SERVERNAME=ares-werx.com`, `extra_hosts: host.docker.internal:host-gateway`, volumes `./recordings`, `./mbtiles`, `./cert:ro` (lines 34-61).
  - service `tunnel` → container `cloudflare-tunnel`, `cloudflare/cloudflared:latest`, `tunnel --url http://gui:80` (lines 64-70).
- **Production compose** — `/Users/diego/MediaMTX ARES/docker-compose.prod.yml`: same three services (`mediamtx` lines 2-17, `telemetry` lines 19-44, `gui` lines 46-63) but the GUI publishes `80`, `443`, `8444`, mounts `nginx.prod.conf`, `/etc/letsencrypt:ro` and `./cert:/etc/nginx/tak-cert:ro`, and joins the external network `takserver_default` (lines 60-63, declared lines 80-82). A commented-out `tak-server` service block sits at lines 65-78. No `tunnel` service in production.
- **Build steps**:
  - `/Users/diego/MediaMTX ARES/Dockerfile.telemetry` — `node:22-alpine` → `apk add ffmpeg` (line 4) → `npm install --production` (line 10) → copy `telemetry_bridge.js` (line 13) → copy `cert/` (line 16) → `EXPOSE 8081` (line 19) → `CMD ["node","telemetry_bridge.js"]` (line 22). **This is the only image actually built by the compose files.**
  - `/Users/diego/MediaMTX ARES/Dockerfile` — an unused two-stage Go build of MediaMTX from source (`ARG REPO_URL="<REPO_URL>"` line 12 is still a placeholder); neither compose file references it.
- **Git** — remote `origin` = `https://github.com/diego2diego30/MediaMTX-ARES.git` (fetch and push), current/default branch `main`, `origin/HEAD → origin/main`. Latest commits: `787f907 man changes: label change`, `2a539da Fix map marker popup initial template and telemetry stream matching`, `f5295fe Fix marker popup anchor overlap and focus outline rectangle`.
- **Deployment scripts**:
  - `/Users/diego/MediaMTX ARES/sync-to-git.sh` — the canonical deploy path: `git add . && git commit` (26-27) → `git push origin main` (31) → SSH `root@5.161.45.97` (line 9), `cd ~/MediaMTX-ARES` (line 10/36), `git pull` (39), `docker compose -f docker-compose.prod.yml up -d --build` (41), `docker restart mediamtx-gui` (44, needed because single-file bind mounts do not hot-reload).
  - `/Users/diego/MediaMTX ARES/deploy-production.sh` — first-time VPS bootstrap: apt deps + Docker (17-24), `mkdir tak_data/...` (28), compose down (32), certbot issue/renew for `ares-werx.com` (37-46), `docker compose -f docker-compose.prod.yml up -d --build` (50), `ps` verification (53).
  - `/Users/diego/MediaMTX ARES/push-tak-server.sh` — rsyncs the separate official TAK Server docker bundle from `/Users/diego/official-tak/takserver-docker-5.6-RELEASE-57/` to `root@5.161.45.97:~/takserver` (11, 19) and runs `docker compose up -d --build` there (30).
  - `/Users/diego/MediaMTX ARES/fix-certs.sh` — TLS/cert repair helper for the TAK client certs in `cert/`.
- **TAK client certificates** (mounted read-only into `telemetry-bridge`): `/Users/diego/MediaMTX ARES/cert/admin.pem`, `admin.key`, `admin.p12`, `truststore-root.pem`, `truststore-root.p12`, `ares-root.crt`, `tak-client.pem`, `tak-client.key`, plus the iTAK data package `cert/ARES_Secure_Connection.zip`.

---

## Deployment Facts

- Git remote (origin, fetch & push): `https://github.com/diego2diego30/MediaMTX-ARES.git`
- Branch used for deployment: `main` (`origin/HEAD → origin/main`)
- Local repo path: `/Users/diego/MediaMTX ARES`
- Production compose file: `/Users/diego/MediaMTX ARES/docker-compose.prod.yml` (on the VPS: `~/MediaMTX-ARES/docker-compose.prod.yml`)
- Development compose file: `/Users/diego/MediaMTX ARES/docker-compose.yml`
- Compose service names: `mediamtx`, `gui`, `telemetry` (dev adds `tunnel`)
- Container names: `mediamtx`, `mediamtx-gui`, `telemetry-bridge` (dev adds `cloudflare-tunnel`)
- Only image built from source: `telemetry` via `/Users/diego/MediaMTX ARES/Dockerfile.telemetry` (node:22-alpine + ffmpeg)
- VPS: `root@5.161.45.97`, deploy directory `~/MediaMTX-ARES`, domain `ares-werx.com` (Let's Encrypt at `/etc/letsencrypt/live/ares-werx.com`)
- Deploy command sequence (from `sync-to-git.sh`): `git add . && git commit -m "..." && git push origin main` → ssh VPS → `cd ~/MediaMTX-ARES && git pull && docker compose -f docker-compose.prod.yml up -d --build && docker restart mediamtx-gui`
- Reverse proxy config in production: `/Users/diego/MediaMTX ARES/nginx.prod.conf` (mounted to `/etc/nginx/conf.d/default.conf` in `mediamtx-gui`)
- External docker network joined by `gui` in production: `takserver_default` (the separately deployed official TAK Server stack at `~/takserver`, admin UI `https://ares-werx.com:8443`, CoT TLS `ares-werx.com:8089`)
- Published ports (prod): 80/443/8444 (gui), 8554 tcp+udp, 8000-8001/udp, 1935, 8888, 8889, 8890/udp, 9997 (mediamtx), 8081, 9998/udp, 4242/udp (telemetry)
