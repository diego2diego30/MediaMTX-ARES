// ─────────────────────────────────────────────────────────────────
//  ARES COP — Map Controller
//  Features: Satellite layers, full CoT type support, TAK shapes,
//            shape rendering, TAK OBJECTS sidebar, GeoChat panel.
// ─────────────────────────────────────────────────────────────────

let copMap;
let markers = {};        // point markers keyed by uid
let shapeOverlays = {};  // polygon/circle/polyline layers keyed by uid
window.trackData = {};
let wsTelemetry;
let wsReconnectTimer;
let chatUnread = 0;
let chatOpen = false;

// ── Icons ─────────────────────────────────────────────────────────
const UAS_ICON = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});

const EMERGENCY_ICON = L.divIcon({
  className: 'emergency-icon',
  html: '<div class="emer-pulse">🚨</div>',
  iconSize: [30, 30], iconAnchor: [15, 15]
});

// ── Color helper: signed 32-bit ARGB int → CSS rgba ───────────────
function argbToCss(argbInt, alphaOverride) {
  const u = (argbInt >>> 0);
  const a = alphaOverride !== undefined ? alphaOverride : ((u >> 24) & 0xff) / 255;
  const r = (u >> 16) & 0xff;
  const g = (u >> 8)  & 0xff;
  const b = u & 0xff;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

// ── Default shape style ────────────────────────────────────────────
function shapeStyle(cot) {
  const stroke = cot.strokeColor !== undefined ? argbToCss(cot.strokeColor) : '#00ff5e';
  const fill   = cot.fillColor   !== undefined ? argbToCss(cot.fillColor, 0.15) : 'rgba(0,255,94,0.10)';
  const weight = cot.strokeWeight || 2;
  return { color: stroke, fillColor: fill, fillOpacity: 0.15, weight, opacity: 0.85, className: 'tak-shape' };
}

// ── Popup builder ──────────────────────────────────────────────────
function buildPopup(title, rows) {
  const inner = rows.map(([k, v]) => `<strong style="color:#fff">${k}:</strong> ${v}`).join('<br>');
  return `<div style="background:rgba(0,0,0,0.85);padding:6px 8px;border-radius:4px;line-height:1.6;border:1px solid var(--green-bright)">
    <strong style="color:var(--green-bright);font-size:13px;text-shadow:0 0 5px var(--green-bright)">${title}</strong><br>${inner}
  </div>`;
}

// ── Map Init ──────────────────────────────────────────────────────
function initCopMap() {
  copMap = L.map('cop-map-container', { zoomControl: false }).setView([34.665, -77.55], 13);
  L.control.zoom({ position: 'bottomleft' }).addTo(copMap);

  // Base layers
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB', subdomains: 'abcd', maxZoom: 20
  });

  const esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '&copy; Esri, USDA, USGS, AEX, GeoEye' }
  );

  const esriLabels = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, opacity: 0.85 }
  );
  const esriHybrid = L.layerGroup([esriSat, esriLabels]).addTo(copMap);

  // Offline MBTiles overlay
  const localTiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    minNativeZoom: 10, maxNativeZoom: 19, minZoom: 1, maxZoom: 22,
    bounds: [[34.4982408, -77.6072062], [34.7483673, -77.1803647]],
    attribution: 'Camp Lejeune MBTiles'
  }).addTo(copMap);

  const baseMaps = {
    'Satellite + Labels': esriHybrid,
    'Satellite (Pure)': esriSat,
    'Carto Dark': cartoDark
  };
  const overlayMaps = { 'Camp Lejeune MBTiles': localTiles };
  L.control.layers(baseMaps, overlayMaps, { position: 'bottomleft' }).addTo(copMap);

  // Leaflet Draw (COP-created shapes)
  const drawnItems = new L.FeatureGroup();
  copMap.addLayer(drawnItems);
  const drawControl = new L.Control.Draw({
    position: 'topleft',
    edit: { featureGroup: drawnItems },
    draw: {
      polygon:  { shapeOptions: { color: '#00ff5e' } },
      polyline: { shapeOptions: { color: '#00ff5e' } },
      rectangle:{ shapeOptions: { color: '#00ff5e' } },
      circle:   { shapeOptions: { color: '#00ff5e' } },
      marker: true
    }
  });
  copMap.addControl(drawControl);
  copMap.on(L.Draw.Event.CREATED, e => {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    
    layer._copId = `COP-Shape-${Date.now()}`;
    window.drawnShapes = window.drawnShapes || {};
    window.drawnShapes[layer._copId] = { layer, type: e.layerType };
    
    const popupContent = `
      <div style="font-family: var(--font-main);">
        <strong style="color:var(--green-bright)">Drawn ${e.layerType.toUpperCase()}</strong><br>
        <button onclick="window.broadcastShape('${layer._copId}')" style="margin-top:5px; background:var(--green-mid); color:#000; border:none; padding:4px 8px; cursor:pointer; font-weight:bold; border-radius:2px; width:100%;">BROADCAST TO TAK</button>
      </div>
    `;
    layer.bindPopup(popupContent).openPopup();
  });

  window.broadcastShape = function(id) {
    if (!window.drawnShapes || !window.drawnShapes[id]) return;
    const item = window.drawnShapes[id];
    const layer = item.layer;
    
    let payload = { cmd: 'push_shape_cot', uid: id, callsign: id };
    
    if (item.type === 'marker') {
      const ll = layer.getLatLng();
      payload.cmd = 'push_marker_cot';
      payload.lat = ll.lat;
      payload.lon = ll.lng;
    } else if (item.type === 'circle') {
      const ll = layer.getLatLng();
      payload.shapeType = 'circle';
      payload.lat = ll.lat;
      payload.lon = ll.lng;
      payload.radius = layer.getRadius();
    } else if (item.type === 'polygon' || item.type === 'rectangle' || item.type === 'polyline') {
      const latlngs = layer.getLatLngs();
      // Handle nested arrays for polygons vs polylines
      const points = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
      payload.shapeType = item.type;
      // Use the first point as the anchor lat/lon for the CoT
      payload.lat = points[0].lat;
      payload.lon = points[0].lng;
      payload.vertices = points.map(p => ({ lat: p.lat, lon: p.lng }));
    }
    
    if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
      wsTelemetry.send(JSON.stringify(payload));
      alert('Broadcasted to TAK Server!');
    } else {
      alert('Cannot broadcast: Telemetry disconnected.');
    }
  };

  // Stale shape cleanup every 30s
  setInterval(pruneStaleShapes, 30000);
}

// ── Telemetry WebSocket ───────────────────────────────────────────
function connectTelemetry() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${proto}//${window.location.host}/ws/`;
  if (window.location.protocol === 'file:' || window.location.port === '5500') wsUrl = 'ws://localhost:8081';
  try { wsTelemetry = new WebSocket(wsUrl); }
  catch(e) { wsTelemetry = new WebSocket('ws://localhost:8081'); }

  wsTelemetry.onopen = () => {
    document.getElementById('telemetry-status-text').textContent = 'RX CONNECTED';
    document.getElementById('telemetry-status').classList.remove('disconnected');
  };

  wsTelemetry.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (Array.isArray(data)) {
        processCotData(data);
      } else if (data.type === 'tak_status') {
        const statusEl = document.getElementById('tak-status-text');
        const hostEl = document.getElementById('tak-server-host');
        const versionEl = document.getElementById('tak-server-version');
        if (statusEl && hostEl && versionEl) {
          if (data.connected) {
            statusEl.textContent = 'CONNECTED';
            statusEl.style.color = 'var(--green-bright)';
            hostEl.textContent = `Host: ${data.host}`;
            versionEl.textContent = `Version: ${data.version}`;
          } else {
            statusEl.textContent = 'DISCONNECTED';
            statusEl.style.color = 'var(--red-bright)';
            hostEl.textContent = 'Waiting for connection...';
            versionEl.textContent = '';
          }
        }
      } else if (data.type === 'chat') {
        appendChatMessage(data.sender, data.message, data.timestamp, false);
      } else if (data.lat && data.lon) {
        processKlvData(data);
      }
    } catch(e) {
      console.error('Failed to parse telemetry frame', e);
    }
  };

  wsTelemetry.onclose = () => {
    document.getElementById('telemetry-status-text').textContent = 'DISCONNECTED';
    document.getElementById('telemetry-status').classList.add('disconnected');
    wsTelemetry = null;
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectTelemetry, 2000);
  };
}

// ── KLV / Drone feed ─────────────────────────────────────────────
function processKlvData(data) {
  if (window.activePipStream && data.stream_id && data.stream_id !== window.activePipStream) {
    if (markers['klv-drone-' + data.stream_id]) {
      copMap.removeLayer(markers['klv-drone-' + data.stream_id]);
      delete markers['klv-drone-' + data.stream_id];
    }
    return;
  }
  const id = 'klv-drone-' + (data.stream_id || '1');
  const latlng = [parseFloat(data.lat), parseFloat(data.lon)];
  const callsign = data.stream_id === 'demo' ? 'DEMO DRONE' : (data.stream_id || 'KLV DRONE').toUpperCase();
  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: UAS_ICON }).addTo(copMap);
    markers[id].bindTooltip(callsign, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'tactical-map-label' });
    markers[id].on('click', () => openPip(callsign, data.stream_id || 'demo'));
  } else {
    markers[id].setLatLng(latlng);
  }
  markers[id].bindPopup(buildPopup(callsign, [['LAT', data.lat], ['LON', data.lon], ['ALT', `${data.alt} m`]]));
  if (Object.keys(markers).length === 1) copMap.panTo(latlng, { animate: true });
  window.trackData[id] = { id, callsign, lat: data.lat, lon: data.lon, type: 'UAS FEED' };
}

// ── SIDC mapper ───────────────────────────────────────────────────
function cotToSidc(cotType) {
  if (!cotType) return 'SFG-UCI----';
  if (cotType.startsWith('b-m')) return 'GUGPGPRP--****X';
  const parts = cotType.split('-');
  if (parts.length < 3) return 'SFG-UCI----';
  const af = { f:'F', h:'H', n:'N', a:'A' }[parts[1]] || 'U';
  const dm = { G:'G', A:'A', S:'S', U:'U' }[parts[2]] || 'Z';
  if (dm === 'A' && parts.length > 3 && parts[3] === 'U') return `S${af}APMFQ--------`;
  return `S${af}${dm}P-------`;
}

// ── Main CoT dispatcher ───────────────────────────────────────────
function processCotData(cotArray) {
  cotArray.forEach(cot => {
    if (!cot.type) return;
    if (cot.type.startsWith('u-d-'))      processShapeCot(cot);
    else if (cot.type === 'b-m-r')        processRouteCot(cot);
    else if (cot.type.startsWith('b-a-')) processEmergencyCot(cot);
    else                                   processPointCot(cot);
  });
}

// ── Point entity (a-*, b-m-p-*, etc.) ────────────────────────────
function processPointCot(cot) {
  if (cot.type === 'b-t-f') return; // Ignore chat markers
  const id = cot.uid;
  const latlng = [cot.lat, cot.lon];
  const sidc = cotToSidc(cot.type);
  const sym = new ms.Symbol(sidc, { size: 25 });
  const symIcon = L.divIcon({
    className: '',
    html: sym.asSVG(),
    iconAnchor: [sym.getAnchor().x, sym.getAnchor().y],
    popupAnchor: [0, -sym.getAnchor().y]
  });
  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: symIcon }).addTo(copMap);
    markers[id].bindTooltip(cot.callsign, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'tactical-map-label' });
  } else {
    markers[id].setLatLng(latlng);
    markers[id].setIcon(symIcon);
  }
  markers[id].bindPopup(buildPopup(cot.callsign, [
    ['TYPE', cot.type],
    ['LAT',  cot.lat.toFixed(5)],
    ['LON',  cot.lon.toFixed(5)],
    ...(cot.remarks ? [['NOTE', cot.remarks]] : [])
  ]));
  if (Object.keys(markers).length === 1 && Object.keys(shapeOverlays).length === 0) {
    copMap.panTo(latlng, { animate: true });
  }
  let trackType = 'GROUND UNIT';
  if (cot.type.includes('-A-')) trackType = 'AIRCRAFT/UAS';
  if (cot.type.startsWith('b-m')) trackType = 'MARKER';
  window.trackData[id] = { id, callsign: cot.callsign, lat: cot.lat, lon: cot.lon, type: trackType, stale: cot.stale };
}

// ── Shape: u-d-* ─────────────────────────────────────────────────
function processShapeCot(cot) {
  const id = cot.uid;
  // Remove existing layer if present
  if (shapeOverlays[id]) { copMap.removeLayer(shapeOverlays[id]); delete shapeOverlays[id]; }

  const style = shapeStyle(cot);
  const label = cot.callsign || cot.remarks || id;
  let layer = null;
  let trackType = 'SHAPE';

  if (cot.type === 'u-d-c' && cot.ellipse) {
    // Circle — ellipse.major = radius in meters
    layer = L.circle([cot.lat, cot.lon], { ...style, radius: cot.ellipse.major });
    trackType = 'CIRCLE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Circle'], ['RADIUS', `${cot.ellipse.major.toFixed(0)} m`], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if (cot.type === 'u-d-r' && cot.ellipse) {
    // Rectangle — compute corners from center + half-dimensions + bearing
    const corners = rectCorners(cot.lat, cot.lon, cot.ellipse.major, cot.ellipse.minor, cot.ellipse.angle);
    layer = L.polygon(corners, style);
    trackType = 'RECTANGLE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Rectangle'], ['LENGTH', `${cot.ellipse.major.toFixed(0)} m`], ['WIDTH', `${cot.ellipse.minor.toFixed(0)} m`], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if ((cot.type === 'u-d-p' || cot.type === 'u-d-r') && cot.vertices && cot.vertices.length >= 3) {
    layer = L.polygon(cot.vertices.map(v => [v.lat, v.lon]), style);
    trackType = cot.type === 'u-d-r' ? 'RECTANGLE' : 'POLYGON';
    layer.bindPopup(buildPopup(label, [['TYPE', trackType === 'RECTANGLE' ? 'Rectangle' : 'Polygon'], ['POINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if (cot.type === 'u-d-f' && cot.vertices && cot.vertices.length >= 2) {
    layer = L.polyline(cot.vertices.map(v => [v.lat, v.lon]), style);
    trackType = 'LINE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Line'], ['POINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));
  }

  if (layer) {
    layer.addTo(copMap);
    shapeOverlays[id] = layer;
    window.trackData[id] = { id, callsign: label, lat: cot.lat, lon: cot.lon, type: trackType, stale: cot.stale, isShape: true };
  }
}

// ── Route: b-m-r ─────────────────────────────────────────────────
function processRouteCot(cot) {
  const id = cot.uid;
  if (shapeOverlays[id]) { copMap.removeLayer(shapeOverlays[id]); delete shapeOverlays[id]; }
  if (!cot.vertices || cot.vertices.length < 2) return;

  const style = shapeStyle(cot);
  const latlngs = cot.vertices.map(v => [v.lat, v.lon]);
  const group = L.featureGroup();

  // Route line
  L.polyline(latlngs, { ...style, weight: style.weight + 1 }).addTo(group);

  // Waypoint markers
  latlngs.forEach((ll, i) => {
    L.circleMarker(ll, { radius: 5, color: style.color, fillColor: style.color, fillOpacity: 0.9, weight: 2 })
      .bindTooltip(`WP${i + 1}`, { permanent: false, className: 'tactical-map-label' })
      .addTo(group);
  });

  const label = cot.callsign || 'ROUTE';
  group.bindPopup(buildPopup(label, [['TYPE', 'Route'], ['WAYPOINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));
  group.addTo(copMap);
  shapeOverlays[id] = group;
  window.trackData[id] = { id, callsign: label, lat: cot.lat, lon: cot.lon, type: 'ROUTE', stale: cot.stale, isShape: true };
}

// ── Emergency: b-a-* ─────────────────────────────────────────────
function processEmergencyCot(cot) {
  let baseId = cot.uid;
  if (baseId.includes('-9-1-1')) baseId = baseId.split('-9-1-1')[0];
  if (baseId.includes('-Alert')) baseId = baseId.split('-Alert')[0];
  if (baseId.includes('-Cancel')) baseId = baseId.split('-Cancel')[0];
  
  let baseCallsign = cot.callsign || 'EMERGENCY';
  if (baseCallsign.includes('.')) baseCallsign = baseCallsign.split('.')[0];
  
  const id = 'EMG-' + baseId;
  const isCancel = cot.type.endsWith('-k') || cot.type === 'b-a-o-c' || (cot.callsign || '').toLowerCase().includes('cancel');

  if (isCancel) {
    if (markers[id]) {
      copMap.removeLayer(markers[id]);
      delete markers[id];
      delete window.trackData[id];
    }
    return;
  }

  const latlng = [cot.lat, cot.lon];
  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: EMERGENCY_ICON, zIndexOffset: 1000 }).addTo(copMap);
    markers[id].bindTooltip(baseCallsign, { permanent: true, direction: 'top', className: 'tactical-map-label emergency-label' });
    copMap.panTo(latlng, { animate: true }); // Only pan on first detection
  } else {
    markers[id].setLatLng(latlng);
  }
  markers[id].bindPopup(buildPopup('⚠ EMERGENCY', [['CALLSIGN', baseCallsign], ['STATUS', cot.callsign], ['LAT', cot.lat.toFixed(5)], ['LON', cot.lon.toFixed(5)]]));
  window.trackData[id] = { id, callsign: baseCallsign, lat: cot.lat, lon: cot.lon, type: 'EMERGENCY' };
}

// ── Rectangle corner calculator (great-circle) ────────────────────
function rectCorners(lat, lon, halfLen, halfWid, bearingDeg) {
  const R = 6371000;
  const latR = lat * Math.PI / 180;
  const lonR = lon * Math.PI / 180;
  const diag = Math.sqrt(halfLen * halfLen + halfWid * halfWid);
  const offsets = [
    bearingDeg + Math.atan2(halfWid, halfLen) * 180 / Math.PI,
    bearingDeg + 180 - Math.atan2(halfWid, halfLen) * 180 / Math.PI,
    bearingDeg + 180 + Math.atan2(halfWid, halfLen) * 180 / Math.PI,
    bearingDeg - Math.atan2(halfWid, halfLen) * 180 / Math.PI
  ];
  return offsets.map(b => {
    const br = b * Math.PI / 180;
    const dr = diag / R;
    const lat2 = Math.asin(Math.sin(latR) * Math.cos(dr) + Math.cos(latR) * Math.sin(dr) * Math.cos(br));
    const lon2 = lonR + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(latR), Math.cos(dr) - Math.sin(latR) * Math.sin(lat2));
    return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
  });
}

// ── Stale shape pruning ───────────────────────────────────────────
function pruneStaleShapes() {
  const now = Date.now();
  Object.entries(shapeOverlays).forEach(([id, layer]) => {
    const td = window.trackData[id];
    if (td && td.stale && new Date(td.stale).getTime() < now) {
      copMap.removeLayer(layer);
      delete shapeOverlays[id];
      delete window.trackData[id];
    }
  });
}

// ── Chat ──────────────────────────────────────────────────────────
function initChat() {
  const toggleBtn  = document.getElementById('chat-toggle-btn');
  const panel      = document.getElementById('chat-panel');
  const input      = document.getElementById('chat-input');
  const sendBtn    = document.getElementById('chat-send-btn');
  const badge      = document.getElementById('chat-badge');

  toggleBtn.addEventListener('click', () => {
    chatOpen = !chatOpen;
    panel.classList.toggle('open', chatOpen);
    if (chatOpen) {
      chatUnread = 0;
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });

  sendBtn.addEventListener('click', sendChatMessage);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const sel = document.getElementById('chat-recipient');
  const text = input.value.trim();
  if (!text) return;
  
  const recipientCallsign = sel ? sel.value : 'All Chat Rooms';
  const recipientUid = sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].getAttribute('data-uid') : 'All Chat Rooms';

  if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
    wsTelemetry.send(JSON.stringify({ 
      cmd: 'push_geochat', 
      senderCallsign: 'ARES-COP', 
      message: text,
      recipientCallsign: recipientCallsign,
      recipientUid: recipientUid
    }));
    appendChatMessage('ARES-COP', `[To: ${recipientCallsign}] ${text}`, new Date().toISOString(), true);
    input.value = '';
  }
}

function appendChatMessage(sender, message, timestamp, isSelf) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const ts = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const div = document.createElement('div');
  div.className = 'chat-message' + (isSelf ? ' chat-self' : '');
  div.innerHTML = `<span class="chat-sender">${sender}</span><span class="chat-time">${ts}</span><div class="chat-text">${escapeHtml(message)}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;

  // Badge when panel is closed
  if (!chatOpen) {
    chatUnread++;
    const badge = document.getElementById('chat-badge');
    if (badge) { badge.textContent = chatUnread; badge.style.display = 'inline-flex'; }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Sidebar & Demo Controls ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Sidebar toggle
  const sidebar   = document.getElementById('cop-sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  toggleBtn.addEventListener('click', () => {
    const c = sidebar.classList.toggle('collapsed');
    toggleBtn.textContent = c ? '◀ MENU' : 'MENU ▶';
  });

  // MediaMTX streams
  function pollMediaMtxStreams() {
    const apiHost = (window.location.protocol === 'file:' || window.location.port === '5500') ? 'http://localhost:8080' : '';
    fetch(`${apiHost}/api/v3/paths/list`)
      .then(r => r.json())
      .then(data => {
        const list = document.getElementById('sidebar-streams-list');
        const active = (data.items || []).filter(i => i.ready);
        if (!active.length) { list.innerHTML = '<div class="stream-item empty">No active streams found</div>'; return; }
        list.innerHTML = '';
        active.forEach(s => {
          const el = document.createElement('div');
          el.className = 'stream-item';
          el.innerHTML = `🎥 <strong>${s.name}</strong><br><small style="color:var(--grey-mid)">Tracks: ${(s.tracks||[]).join(', ')}</small>`;
          el.addEventListener('click', () => openPip(s.name === 'demo' ? 'DEMO DRONE' : s.name.toUpperCase(), s.name));
          list.appendChild(el);
        });
      })
      .catch(() => { document.getElementById('sidebar-streams-list').innerHTML = '<div class="stream-item empty">Failed to query MediaMTX API</div>'; });
  }
  setInterval(pollMediaMtxStreams, 3000);
  pollMediaMtxStreams();

  // TAK Objects sidebar + click-to-center
  window.panToTrack = function(id) {
    if (markers[id]) {
      copMap.setView(markers[id].getLatLng(), 15, { animate: true });
      markers[id].openPopup();
    } else if (shapeOverlays[id]) {
      try { copMap.fitBounds(shapeOverlays[id].getBounds(), { padding: [40, 40], animate: true }); }
      catch(e) { /* some groups may not have bounds */ }
    }
  };

  const TYPE_ICON = { 'GROUND UNIT':'🪖','AIRCRAFT/UAS':'✈','MARKER':'📍','ROUTE':'🗺','CIRCLE':'⭕','RECTANGLE':'⬜','POLYGON':'🔷','LINE':'📏','EMERGENCY':'🚨','UAS FEED':'🎥', 'SHAPE':'◾' };

  function updateTrackSidebar() {
    const container = document.getElementById('sidebar-tracks-list');
    if (!container) return;
    const tracks = Object.values(window.trackData || {});
    if (!tracks.length) { container.innerHTML = '<div class="stream-item empty">Awaiting telemetry...</div>'; return; }
    tracks.sort((a,b) => (a.callsign||'').localeCompare(b.callsign||''));
    const html = tracks.map(t => {
      const icon = TYPE_ICON[t.type] || '•';
      return `<div class="stream-item tak-obj-item" onclick="panToTrack('${t.id}')" style="cursor:pointer">
        <strong style="color:var(--green-bright)">${icon} ${t.callsign}</strong>
        <br><small style="color:var(--grey-mid)">${t.type} · ${parseFloat(t.lat).toFixed(4)}, ${parseFloat(t.lon).toFixed(4)}</small>
      </div>`;
    }).join('');
    if (container.innerHTML !== html) container.innerHTML = html;
  }
  
  function updateChatRecipients() {
    const sel = document.getElementById('chat-recipient');
    if (!sel) return;
    const currentVal = sel.value;
    const tracks = Object.values(window.trackData || {}).filter(t => t.type === 'GROUND UNIT' || t.type.includes('USER'));
    
    let html = `<option value="All Chat Rooms" data-uid="All Chat Rooms">All Chat Rooms (Broadcast)</option>`;
    tracks.sort((a,b) => (a.callsign||'').localeCompare(b.callsign||'')).forEach(t => {
      html += `<option value="${t.callsign}" data-uid="${t.id}">${t.callsign}</option>`;
    });
    
    if (sel.innerHTML !== html) {
      sel.innerHTML = html;
      if (Array.from(sel.options).some(o => o.value === currentVal)) sel.value = currentVal;
    }
  }

  setInterval(() => {
    updateTrackSidebar();
    updateChatRecipients();
  }, 2000);
  updateTrackSidebar();
  updateChatRecipients();

  // Demo controls
  function sendDemoControl(payload) {
    if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) wsTelemetry.send(JSON.stringify(payload));
  }
  document.getElementById('demo-active-toggle').addEventListener('change', e => sendDemoControl({ cmd:'toggle_demo', state:e.target.checked }));
  document.getElementById('demo-density-slider').addEventListener('input',  e => sendDemoControl({ cmd:'set_density', density:parseInt(e.target.value,10) }));
  document.getElementById('demo-pattern-select').addEventListener('change', e => sendDemoControl({ cmd:'set_pattern', pattern:e.target.value }));

  // Chat
  initChat();
});

// ── Map Upload ────────────────────────────────────────────────────
window.handleMapUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  const btn = document.getElementById('tool-upload');
  btn.innerHTML = '⏳'; btn.disabled = true;
  try {
    const res = await fetch(`/api/upload_map?filename=${encodeURIComponent(file.name)}`, { method:'POST', body:file });
    if (res.ok) {
      alert('Map uploaded successfully!');
      copMap.eachLayer(l => { if (l._url && l._url.includes('/tiles/')) l.redraw(); });
    } else { alert('Failed to upload map.'); }
  } catch(e) { console.error(e); alert('Map upload error.'); }
  finally { btn.innerHTML = '📁 UPLOAD MBTILES'; btn.disabled = false; event.target.value = ''; }
};
