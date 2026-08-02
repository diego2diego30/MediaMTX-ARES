// ─────────────────────────────────────────────────────────────────
//  ARES COP — Map Controller
//  Features: Satellite layers, full CoT type support, TAK shapes,
//            shape rendering, TAK OBJECTS sidebar, GeoChat panel.
// ─────────────────────────────────────────────────────────────────

let copMap;
let markers = {};        // point markers keyed by uid
let shapeOverlays = {};  // polygon/circle/polyline layers keyed by uid
let fovOverlays   = {};  // FOV sector polygons keyed by same marker ID

function removeFovOverlay(id) {
  if (fovOverlays[id]) {
    copMap.removeLayer(fovOverlays[id]);
    delete fovOverlays[id];
  }
}
window.trackData = {};
window.telemetryMode = localStorage.getItem('ares_telemetry_mode') || 'DIRECT';

window.setTelemetryMode = function(mode) {
  window.telemetryMode = mode;
  localStorage.setItem('ares_telemetry_mode', mode);
  
  const btnDirect = document.getElementById('mode-btn-direct');
  const btnTak = document.getElementById('mode-btn-tak');
  if (btnDirect && btnTak) {
    if (mode === 'DIRECT') {
      btnDirect.style.background = '#00ff5e';
      btnDirect.style.color = '#000';
      btnTak.style.background = 'transparent';
      btnTak.style.color = '#00ff5e';
    } else {
      btnTak.style.background = '#00ff5e';
      btnTak.style.color = '#000';
      btnDirect.style.background = 'transparent';
      btnDirect.style.color = '#00ff5e';
    }
  }

  // Purge non-active markers on mode switch
  if (window.copMap) {
    Object.keys(markers).forEach(id => {
      if (mode === 'TAK' && id.startsWith('klv-drone-')) {
        copMap.removeLayer(markers[id]);
        delete markers[id];
        removeFovOverlay(id);
        delete window.trackData[id];
      } else if (mode === 'DIRECT' && id.startsWith('mtx-uas-')) {
        copMap.removeLayer(markers[id]);
        delete markers[id];
        removeFovOverlay(id);
        delete window.trackData[id];
      }
    });
  }

  if (window.showTacticalBanner) {
    showTacticalBanner(`TELEMETRY INGEST: ${mode === 'DIRECT' ? '⚡ 30Hz DIRECT WEBSOCKET' : '🛰️ TAK SERVER COT'}`);
  }
};

// ── Lock-On Target ────────────────────────────────────────────────
let lockTarget = null; // marker ID currently locked

window.lockOnMarker = function(id) {
  lockTarget = id;
  const td = window.trackData[id];
  const label = td ? td.callsign : id;
  if (td) copMap.panTo([td.lat, td.lon], { animate: true });
  showTacticalBanner('🔒 LOCKED ON: ' + label);
  // Update all open popup lock buttons to reflect new state
  document.querySelectorAll('.lock-on-btn').forEach(btn => {
    if (btn.dataset.id === id) {
      btn.textContent = '🔓 UNLOCK';
      btn.style.background = '#ff9900';
      btn.onclick = () => window.unlockTarget();
    } else {
      btn.textContent = '🔒 LOCK ON';
      btn.style.background = 'var(--green-dim)';
      btn.onclick = () => window.lockOnMarker(btn.dataset.id);
    }
  });
};

window.unlockTarget = function() {
  const label = lockTarget && window.trackData[lockTarget] ? window.trackData[lockTarget].callsign : lockTarget;
  lockTarget = null;
  showTacticalBanner('🔓 UNLOCKED — free camera');
  document.querySelectorAll('.lock-on-btn').forEach(btn => {
    btn.textContent = '🔒 LOCK ON';
    btn.style.background = 'var(--green-dim)';
    btn.onclick = () => window.lockOnMarker(btn.dataset.id);
  });
};
let wsTelemetry;
let wsReconnectTimer;
let chatUnread = 0;
let chatOpen = false;
window.allChatMessages = []; // Task 3 master array
const chatLogs = {};
window.localMissionItems = [];


// ── Icons ─────────────────────────────────────────────────────────
const UAS_ICON = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});

// ── Camera Icon (asymmetric SVG so rotation is visually meaningful) ──
function createCameraIcon() {
  return L.divIcon({
    className: 'ares-uas-icon',
    html: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="10" fill="rgba(100,60,180,0.85)" stroke="#fff" stroke-width="1.5"/>
      <polygon points="16,4 13,12 19,12" fill="#00ff5e"/>
      <rect x="11" y="13" width="10" height="7" rx="2" fill="#fff" opacity="0.9"/>
      <circle cx="16" cy="16.5" r="2.5" fill="rgba(100,60,180,1)"/>
    </svg>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
}

// ── Geodesic FOV wedge ────────────────────────────────────────────
function destPoint(lat, lon, bearingDeg, distMeters) {
  const R = 6371000;
  const δ = distMeters / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
}

function computeFovWedge(lat, lon, azimuthDeg, fovDeg, rangeMeters) {
  const steps = 18;
  const halfFov = fovDeg / 2;
  const start = azimuthDeg - halfFov;
  const end   = azimuthDeg + halfFov;
  const coords = [[lat, lon]];
  for (let i = 0; i <= steps; i++) {
    const bearing = start + (end - start) * (i / steps);
    coords.push(destPoint(lat, lon, bearing, rangeMeters));
  }
  coords.push([lat, lon]);
  return coords;
}

const EMERGENCY_ICON = L.divIcon({
  className: 'emergency-icon',
  html: '<div class="emer-pulse">🚨</div>',
  iconSize: [30, 30], iconAnchor: [15, 15]
});

// ── Color helper: signed 32-bit ARGB int → CSS rgba ───────────────
function argbToCss(argbInt, alphaOverride, isFill = false) {
  const u = (argbInt >>> 0);
  let extractedAlpha = ((u >> 24) & 0xff) / 255;
  let a = alphaOverride !== undefined ? alphaOverride : extractedAlpha;
  if (isFill && extractedAlpha < 0.1) {
    a = 0.35;
  }
  const r = (u >> 16) & 0xff;
  const g = (u >> 8)  & 0xff;
  const b = u & 0xff;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

// ── Default shape style ────────────────────────────────────────────
function shapeStyle(cot) {
  const stroke = cot.strokeColor !== undefined ? argbToCss(cot.strokeColor) : '#00ff5e';
  const fill   = cot.fillColor   !== undefined ? argbToCss(cot.fillColor, undefined, true) : 'rgba(0,255,94,0.35)';
  let weight = cot.strokeWeight !== undefined ? cot.strokeWeight : 2.5;
  if (weight < 2.5) weight = 2.5;
  return { color: stroke, fillColor: fill, fillOpacity: 0.35, weight, opacity: 0.85, className: 'tak-shape' };
}

// ── Popup builder ──────────────────────────────────────────────────
function buildPopup(title, rows, markerId) {
  const inner = rows.map(([k, v]) => `<strong style="color:#fff">${k}:</strong> ${v}`).join('<br>');
  const isLocked = markerId && lockTarget === markerId;
  const lockBtn = markerId ? `
    <button
      class="lock-on-btn"
      data-id="${markerId}"
      onclick="${isLocked ? 'window.unlockTarget()' : `window.lockOnMarker('${markerId}')`}"
      style="margin-top:6px;width:100%;padding:5px 8px;border:none;border-radius:2px;cursor:pointer;font-weight:bold;font-family:var(--font-mono);background:${isLocked ? '#ff9900' : 'var(--green-dim)'};color:#fff;">
      ${isLocked ? '🔓 UNLOCK' : '🔒 LOCK ON'}
    </button>` : '';
  return `<div style="background:rgba(0,0,0,0.85);padding:6px 8px;border-radius:4px;line-height:1.6;border:1px solid var(--green-bright)">
    <strong style="color:var(--green-bright);font-size:13px;text-shadow:0 0 5px var(--green-bright)">${title}</strong><br>${inner}
    ${lockBtn}
  </div>`;
}

// ── Tactical Banner Notification ───────────────────────────────────
function showTacticalBanner(text, duration = 6000) {
  let container = document.getElementById('tactical-banner-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'tactical-banner-container';
    container.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none;';
    document.body.appendChild(container);
  }
  const banner = document.createElement('div');
  banner.style.cssText = 'background:rgba(5,5,5,0.92);border:1px solid var(--green-bright,#00ff5e);color:var(--green-bright,#00ff5e);padding:12px 24px;font-family:var(--font-mono,monospace);font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 0 20px rgba(0,255,94,0.4);animation:slideUp 0.3s ease forwards;pointer-events:auto;';
  banner.textContent = text;
  container.appendChild(banner);
  setTimeout(() => {
    banner.style.opacity = '0';
    banner.style.transition = 'opacity 0.5s ease';
    setTimeout(() => { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 500);
  }, duration);
}

// ── Broadcast Helpers ─────────────────────────────────────────────
window.broadcastDroneToTak = function(id, callsign, lat, lon, alt) {
  if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
    wsTelemetry.send(JSON.stringify({ cmd: 'push_drone_cot', id, callsign, lat, lon, alt }));
    showTacticalBanner('📡 BROADCASTED ' + callsign + ' TO TAK SERVER');
  }
};

window.broadcastMarkerToTak = function(id) {
  const td = window.trackData[id];
  if (!td) return;
  if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
    wsTelemetry.send(JSON.stringify({ cmd: 'push_marker_cot', uid: id, callsign: td.callsign || id, lat: td.lat, lon: td.lon }));
    showTacticalBanner('📡 RE-BROADCAST TO TAK');
  }
};

window.sendMarkerToUser = function(id) {
  const td = window.trackData[id];
  const destSelect = document.getElementById(`dest-user-${id}`);
  if (!td || !destSelect || !destSelect.value) return;
  const destCallsign = destSelect.value;
  
  if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
    wsTelemetry.send(JSON.stringify({ 
      cmd: 'push_marker_cot', 
      uid: id, 
      callsign: td.callsign || id, 
      lat: td.lat, 
      lon: td.lon,
      destCallsign: destCallsign
    }));
    showTacticalBanner(`📤 SENT TO ${destCallsign}`);
  }
};

window.sendShapeToUser = function(id) {
  const td = window.trackData[id];
  const destSelect = document.getElementById(`dest-user-${id}`);
  if (!td || !destSelect || !destSelect.value) return;
  const destCallsign = destSelect.value;
  
  // Re-push the same shape data but with destCallsign attached
  // We need the original shape parameters from window.drawnShapes
  const shapeInfo = window.drawnShapes && window.drawnShapes[id];
  if (!shapeInfo) return;
  
  if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
    const payload = {
      cmd: 'push_shape_cot',
      uid: id,
      callsign: td.callsign || id,
      lat: td.lat,
      lon: td.lon,
      shapeType: shapeInfo.shapeType,
      destCallsign: destCallsign
    };
    if (shapeInfo.radius) payload.radius = shapeInfo.radius;
    if (shapeInfo.vertices) payload.vertices = shapeInfo.vertices;
    if (shapeInfo.layer && shapeInfo.layer.options) {
      payload.color = shapeInfo.layer.options.color;
      payload.opacity = shapeInfo.layer.options.fillOpacity;
      payload.weight = shapeInfo.layer.options.weight;
    }
    wsTelemetry.send(JSON.stringify(payload));
    showTacticalBanner(`📤 SENT TO ${destCallsign}`);
  }
};

window.updateShapeStyle = function(id) {
  const colorEl = document.getElementById(`edit-color-${id}`);
  const opacityEl = document.getElementById(`edit-opacity-${id}`);
  const weightEl = document.getElementById(`edit-weight-${id}`);
  if (!colorEl || !opacityEl || !weightEl) return;
  const color = colorEl.value;
  const opacity = parseFloat(opacityEl.value);
  const weight = parseFloat(weightEl.value);
  
  if (shapeOverlays[id]) {
    shapeOverlays[id].setStyle({ color, fillColor: color, fillOpacity: opacity, weight });
  } else if (window.drawnShapes && window.drawnShapes[id]) {
    window.drawnShapes[id].layer.setStyle({ color, fillColor: color, fillOpacity: opacity, weight });
  }
  
  window.trackData = window.trackData || {};
  if (!window.trackData[id]) window.trackData[id] = {};
  window.trackData[id].customStyle = { color, opacity, weight };
};

// ── Map Init ──────────────────────────────────────────────────────
function initCopMap() {
  copMap = L.map('cop-map-container', { zoomControl: false }).setView([34.665, -77.55], 13);
  L.control.zoom({ position: 'bottomleft' }).addTo(copMap);

  // Base layers
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB', subdomains: 'abcd', maxZoom: 20
  });

  const esriSatPure = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '&copy; Esri, USDA, USGS, AEX, GeoEye' }
  );
  
  const esriSatHybrid = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '&copy; Esri, USDA, USGS, AEX, GeoEye' }
  );

  const esriLabels = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, opacity: 0.85 }
  );
  const esriHybrid = L.layerGroup([esriSatHybrid, esriLabels]).addTo(copMap);

  // Offline MBTiles overlay
  const localTiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    minNativeZoom: 10, maxNativeZoom: 19, minZoom: 1, maxZoom: 22,
    bounds: [[34.4982408, -77.6072062], [34.7483673, -77.1803647]],
    attribution: 'Camp Lejeune MBTiles'
  }).addTo(copMap);

  const baseMaps = {
    'Satellite + Labels': esriHybrid,
    'Satellite (Pure)': esriSatPure,
    'Carto Dark': cartoDark
  };
  const overlayMaps = { 'Camp Lejeune MBTiles': localTiles };
  L.control.layers(baseMaps, overlayMaps, { position: 'bottomleft' }).addTo(copMap);

  // Floating Location Quick-Control Button on Map (Top-Left Toolbar)
  const LocationControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control tactical-location-control');
      const btn = L.DomUtil.create('a', 'leaflet-control-location-btn', container);
      btn.href = '#';
      btn.title = 'Center Map on Current Location';
      btn.innerHTML = '🎯';
      btn.style.cssText = 'display:flex; align-items:center; justify-content:center; width:34px; height:34px; background:#050f08; color:var(--green-bright); border:1px solid var(--green-mid); border-radius:4px; font-size:18px; text-decoration:none; cursor:pointer; box-shadow:0 0 10px rgba(0,255,94,0.3);';

      L.DomEvent.on(btn, 'click', function(e) {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);
        window.centerOnCurrentLocation();
      });

      return container;
    }
  });
  copMap.addControl(new LocationControl());

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
    
    if (e.layerType === 'marker') {
      const defaultName = `Target-${Date.now().toString().slice(-4)}`;
      
      // Inject the visual picker template
      const popupContent = `
        <div style="font-family: var(--font-main); min-width: 320px; max-width: 380px;">
          <strong style="color:var(--green-bright); display:block; text-align:center; margin-bottom: 8px;">NEW TACTICAL MARKER</strong>
          
          <!-- Name Input & Live Preview Row -->
          <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px; padding: 8px; background: rgba(0, 255, 94, 0.05); border: 1px solid var(--green-dim);">
            <div id="icon-live-preview-${layer._copId}" style="width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: #000; border: 1px solid var(--green-dim); border-radius: 4px;">
              <!-- Preview SVG injected here -->
            </div>
            <div style="flex-grow: 1;">
              <label style="color:var(--green-bright);font-size:10px; display:block; margin-bottom:2px;">CALLSIGN:</label>
              <input type="text" id="edit-marker-name-${layer._copId}" value="${defaultName}" oninput="window.updateMarkerPreview('${layer._copId}')" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:12px;width:100%;padding:4px; box-sizing:border-box;">
              <!-- Hidden input for selected type -->
              <input type="hidden" id="edit-marker-type-${layer._copId}" value="a-u-G">
            </div>
          </div>

          <!-- Affiliation Toggle -->
          <div style="margin-bottom: 10px; display: flex; justify-content: space-between; gap: 4px;">
            <button onclick="window.setMarkerAffiliation('${layer._copId}', 'f')" id="affil-btn-f-${layer._copId}" style="flex:1; padding: 4px; font-size: 10px; background: #000; color: #3498db; border: 1px solid #3498db; cursor: pointer;">FRIENDLY</button>
            <button onclick="window.setMarkerAffiliation('${layer._copId}', 'h')" id="affil-btn-h-${layer._copId}" style="flex:1; padding: 4px; font-size: 10px; background: #000; color: #e74c3c; border: 1px solid var(--green-dim); cursor: pointer;">HOSTILE</button>
            <button onclick="window.setMarkerAffiliation('${layer._copId}', 'n')" id="affil-btn-n-${layer._copId}" style="flex:1; padding: 4px; font-size: 10px; background: #000; color: #2ecc71; border: 1px solid var(--green-dim); cursor: pointer;">NEUTRAL</button>
            <button onclick="window.setMarkerAffiliation('${layer._copId}', 'u')" id="affil-btn-u-${layer._copId}" style="flex:1; padding: 4px; font-size: 10px; background: rgba(241, 196, 15, 0.2); color: #f1c40f; border: 1px solid #f1c40f; cursor: pointer;">UNKNOWN</button>
          </div>

          <!-- Category Selector -->
          <select id="icon-category-sel-${layer._copId}" onchange="window.renderIconGrid('${layer._copId}')" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;width:100%;padding:4px;margin-bottom:8px;box-sizing:border-box;">
            <option value="ground">Ground Units</option>
            <option value="air">Air & Aviation</option>
            <option value="sea">Sea & Subsurface</option>
            <option value="installation">Structures / Installations</option>
            <option value="tactical">Tactical & Emergency (Custom)</option>
          </select>

          <!-- Icon Grid Container -->
          <div id="icon-grid-${layer._copId}" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; max-height: 160px; overflow-y: auto; padding: 4px; border: 1px solid var(--green-dim); background: #000; margin-bottom: 10px;">
            <!-- Icons injected here via JS -->
          </div>

          <button onclick="window.broadcastCustomMarker('${layer._copId}')" style="background:var(--green-bright);color:#000;border:none;padding:8px;width:100%;font-weight:bold;cursor:pointer; font-size: 12px; box-shadow: 0 0 10px rgba(0,255,94,0.3);">📡 BROADCAST TO TAK</button>
          <button onclick="window.deleteCopMarker('${layer._copId}')" style="background:#ff4444;color:#fff;border:none;padding:8px;margin-top:8px;width:100%;font-weight:bold;cursor:pointer; font-size: 12px;">🗑️ DELETE MARKER</button>
        </div>
      `;
      layer.bindPopup(popupContent, { maxWidth: 400 }).openPopup();
      
      // Initialize state for this marker popup
      window._markerStates = window._markerStates || {};
      window._markerStates[layer._copId] = { affiliation: 'u', category: 'ground' };
      
      // We need a short timeout to let the popup HTML render into the DOM before we manipulate it
      setTimeout(() => {
        window.renderIconGrid(layer._copId);
        window.selectMarkerIcon(layer._copId, 'a-u-G'); // Default unknown ground
      }, 50);
    } else {
      const popupContent = `
        <div style="font-family: var(--font-main);">
          <strong style="color:var(--green-bright)">Drawn ${e.layerType.toUpperCase()}</strong><br>
          <div style="margin-top:10px;border-top:1px solid var(--green-dim);padding-top:8px;">
            <label style="color:var(--green-bright);font-size:11px;">NAME: <input type="text" id="edit-name-${layer._copId}" value="${layer._copId}" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;width:120px;padding:2px;"></label><br>
            <label style="color:var(--green-bright);font-size:11px;">COLOR: <select id="edit-color-${layer._copId}" onchange="window.updateShapeStyle('${layer._copId}')" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;"><option value="#00ff5e">Green</option><option value="#ff4444">Red</option><option value="#00ccff">Cyan</option><option value="#ffcc00">Yellow</option><option value="#ff00ff">Magenta</option><option value="#ffffff">White</option></select></label><br>
            <label style="color:var(--green-bright);font-size:11px;">OPACITY: <select id="edit-opacity-${layer._copId}" onchange="window.updateShapeStyle('${layer._copId}')" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;"><option value="0.35">35% (TAK Std)</option><option value="0.15">15%</option><option value="0.60">60%</option><option value="0.85">85%</option></select></label><br>
            <label style="color:var(--green-bright);font-size:11px;">BORDER: <select id="edit-weight-${layer._copId}" onchange="window.updateShapeStyle('${layer._copId}')" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;"><option value="2.5">2.5px</option><option value="4">4px</option><option value="6">6px</option><option value="1">1px</option></select></label><br>
            <button onclick="window.broadcastShape('${layer._copId}')" style="margin-top:8px;background:var(--green-bright);color:#000;border:none;padding:6px;width:100%;font-weight:bold;cursor:pointer;">📡 SAVE & BROADCAST TO TAK</button>
            <button onclick="window.deleteCopMarker('${layer._copId}')" style="margin-top:8px;background:#ff4444;color:#fff;border:none;padding:6px;width:100%;font-weight:bold;cursor:pointer;">🗑️ DELETE SHAPE</button>
          </div>
        </div>
      `;
      layer.bindPopup(popupContent).openPopup();
    }
  });

  window.broadcastCustomMarker = function(id) {
    if (!window.drawnShapes || !window.drawnShapes[id]) return;
    const item = window.drawnShapes[id];
    const layer = item.layer;
    
    const nameInput = document.getElementById('edit-marker-name-' + id);
    const typeInput = document.getElementById('edit-marker-type-' + id);
    if (!nameInput || !typeInput) return;
    
    const name = nameInput.value;
    let cotType = typeInput.value;
    
    // We need to inject the affiliation into the atom type if it's an a-* type
    if (cotType.startsWith('a-?-')) {
      const state = window._markerStates[id] || { affiliation: 'u' };
      cotType = cotType.replace('a-?-', `a-${state.affiliation}-`);
    }

    // Determine the icon to display locally immediately
    // For custom icons, getTakIcon will handle them, but we need to pass a mock cot object
    let iconObj;
    const mockCot = { type: cotType, callsign: name, remarks: '' };
    
    // Check if it's a 2525 atom
    if (typeof cotToSidc === 'function' && cotType.startsWith('a-')) {
      const sidc = cotToSidc(cotType);
      if (sidc) {
        const sym = new ms.Symbol(sidc, { size: 25 });
        iconObj = L.divIcon({
          className: 'tak-marker-icon',
          html: sym.asSVG(),
          iconSize: [sym.getSize().width, sym.getSize().height],
          iconAnchor: [sym.getAnchor().x, sym.getAnchor().y]
        });
      }
    }
    
    // Fallback to getTakIcon for custom types (b-m-p-s-m, b-i-v, etc.) or if sidc failed
    if (!iconObj && typeof getTakIcon === 'function') {
      iconObj = getTakIcon(mockCot);
    }
    
    if (iconObj) layer.setIcon(iconObj);
    
    layer.bindTooltip(name, { direction: 'top', className: 'tak-marker-tooltip', permanent: true });
    layer.closePopup();
    
    window.trackData = window.trackData || {};
    window.trackData[id] = window.trackData[id] || {};
    window.trackData[id].callsign = name;
    window.trackData[id].type = cotType;
    
    if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
      wsTelemetry.send(JSON.stringify({ 
        cmd: 'push_marker_cot', 
        uid: id, 
        callsign: name, 
        lat: layer.getLatLng().lat, 
        lon: layer.getLatLng().lng, 
        type: cotType 
      }));
      if (typeof showTacticalBanner === 'function') {
        showTacticalBanner('📡 BROADCASTED ' + name + ' TO TAK');
      } else {
        showCopAlert('📡 BROADCASTED ' + name + ' TO TAK');
      }
    } else {
      showCopAlert('Cannot broadcast: WebSocket disconnected.', 'error');
    }
  };

  // --- Visual Marker Picker Implementation ---
  
  const ICON_CATALOG = {
    ground: [
      { type: 'a-?-G', label: 'Ground (Generic)' },
      { type: 'a-?-G-U-C-I', label: 'Infantry' },
      { type: 'a-?-G-U-C-A', label: 'Armor / Mech' },
      { type: 'a-?-G-U-C-M', label: 'Medical' },
      { type: 'a-?-G-U-C-HQ', label: 'HQ / Command' },
      { type: 'a-?-G-U-C-S', label: 'Supply' },
      { type: 'a-?-G-U-C-ES', label: 'Engineer' }
    ],
    air: [
      { type: 'a-?-A', label: 'Air (Generic)' },
      { type: 'a-?-A-M-H', label: 'Rotary Wing' },
      { type: 'a-?-A-M-F', label: 'Fixed Wing' },
      { type: 'a-?-A-M-F-Q', label: 'Drone / UAS' }
    ],
    sea: [
      { type: 'a-?-S', label: 'Sea Surface' },
      { type: 'a-?-U', label: 'Subsurface' }
    ],
    installation: [
      { type: 'a-?-G-I', label: 'Installation' }
    ],
    tactical: [
      { type: 'b-m-p-s-m', label: 'Standard Pin', customEmoji: '📍', color: '#f1c40f' },
      { type: 'b-i-v', label: 'Camera / Video', customEmoji: '🎥', color: '#9b59b6' },
      { type: 'b-a-f', label: 'Emergency', customEmoji: '🚨', color: '#e74c3c' },
      { type: 'b-m-p-f', label: 'Bicycle / Bike', remarks: 'bicycle', customEmoji: '🚲', color: '#16a085' },
      { type: 'a-?-G-E-V-C-U', label: 'Vehicle / Car', remarks: 'vehicle', customEmoji: '🚗', color: '#e67e22' },
      { type: 'b-m-p-c', label: 'Checkpoint', remarks: 'checkpoint', customEmoji: '👁️', color: '#2ecc71' }
    ]
  };

  window.setMarkerAffiliation = function(id, affil) {
    if (!window._markerStates || !window._markerStates[id]) return;
    window._markerStates[id].affiliation = affil;
    
    // Update button styles
    const colors = { f: '#3498db', h: '#e74c3c', n: '#2ecc71', u: '#f1c40f' };
    ['f', 'h', 'n', 'u'].forEach(a => {
      const btn = document.getElementById(`affil-btn-${a}-${id}`);
      if (btn) {
        if (a === affil) {
          btn.style.background = `rgba(${hexToRgb(colors[a])}, 0.2)`;
          btn.style.border = `1px solid ${colors[a]}`;
        } else {
          btn.style.background = '#000';
          btn.style.border = '1px solid var(--green-dim)';
        }
      }
    });

    // Re-render grid and preview
    window.renderIconGrid(id);
    window.updateMarkerPreview(id);
  };

  // Helper for hex to rgb for button backgrounds
  function hexToRgb(hex) {
    const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
    return result ? `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}` : '255,255,255';
  }

  window.renderIconGrid = function(id) {
    const gridContainer = document.getElementById(`icon-grid-${id}`);
    const categorySel = document.getElementById(`icon-category-sel-${id}`);
    if (!gridContainer || !categorySel || !window._markerStates[id]) return;

    const category = categorySel.value;
    window._markerStates[id].category = category;
    const icons = ICON_CATALOG[category] || [];
    const affil = window._markerStates[id].affiliation;
    const selectedType = document.getElementById(`edit-marker-type-${id}`)?.value;

    let html = '';
    icons.forEach(item => {
      // Resolve affiliation in type string
      let resolvedType = item.type;
      if (resolvedType.startsWith('a-?-')) {
        resolvedType = resolvedType.replace('a-?-', `a-${affil}-`);
      }

      let iconHtml = '';
      if (item.customEmoji) {
        iconHtml = `<div style="background:${item.color};color:#fff;border:1px solid #fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;margin:auto;">${item.customEmoji}</div>`;
      } else if (typeof cotToSidc === 'function') {
        const sidc = cotToSidc(resolvedType);
        if (sidc) {
          const sym = new ms.Symbol(sidc, { size: 20 });
          iconHtml = sym.asSVG();
        }
      }

      const isSelected = selectedType === resolvedType || (item.type.includes('?') && selectedType.replace(/a-[a-z]-/, 'a-?-') === item.type);
      const bg = isSelected ? 'rgba(0, 255, 94, 0.2)' : 'transparent';
      const border = isSelected ? '1px solid var(--green-bright)' : '1px solid transparent';

      html += `
        <div onclick="window.selectMarkerIcon('${id}', '${resolvedType}')" title="${item.label}" style="cursor:pointer; padding: 4px; border-radius: 4px; background: ${bg}; border: ${border}; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          ${iconHtml}
          <div style="font-size: 8px; text-align: center; color: var(--green-dim); margin-top: 4px; line-height: 1;">${item.label.split(' ')[0]}</div>
        </div>
      `;
    });

    gridContainer.innerHTML = html;
  };

  window.selectMarkerIcon = function(id, cotType) {
    const typeInput = document.getElementById(`edit-marker-type-${id}`);
    if (typeInput) typeInput.value = cotType;
    
    window.renderIconGrid(id); // Re-render to update selection highlight
    window.updateMarkerPreview(id);
  };

  window.updateMarkerPreview = function(id) {
    const previewContainer = document.getElementById(`icon-live-preview-${id}`);
    const typeInput = document.getElementById(`edit-marker-type-${id}`);
    const nameInput = document.getElementById(`edit-marker-name-${id}`);
    if (!previewContainer || !typeInput) return;

    let cotType = typeInput.value;
    const name = nameInput ? nameInput.value : '';

    // If it's a template type with '?', replace with current affiliation
    if (cotType.startsWith('a-?-')) {
      const affil = window._markerStates[id] ? window._markerStates[id].affiliation : 'u';
      cotType = cotType.replace('a-?-', `a-${affil}-`);
      typeInput.value = cotType;
    }

    // Find custom emoji config if exists
    let customEmojiConfig = null;
    for (const cat of Object.values(ICON_CATALOG)) {
      const match = cat.find(i => i.type.replace('a-?-', `a-${window._markerStates[id]?.affiliation || 'u'}-`) === cotType || i.type === cotType);
      if (match && match.customEmoji) {
        customEmojiConfig = match;
        break;
      }
    }

    let iconHtml = '';
    if (customEmojiConfig) {
       iconHtml = `<div style="background:${customEmojiConfig.color};color:#fff;border:1px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow: 0 0 8px ${customEmojiConfig.color};">${customEmojiConfig.customEmoji}</div>`;
    } else if (typeof cotToSidc === 'function' && cotType.startsWith('a-')) {
      const sidc = cotToSidc(cotType);
      if (sidc) {
        const sym = new ms.Symbol(sidc, { size: 25 });
        iconHtml = sym.asSVG();
      }
    } else {
      // Fallback
      iconHtml = `<div style="background:#f1c40f;color:#000;border:1px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:14px;">📍</div>`;
    }

    previewContainer.innerHTML = iconHtml;

    // Update actual marker layer icon on the map
    if (window.drawnShapes && window.drawnShapes[id] && window.drawnShapes[id].layer) {
      window.drawnShapes[id].layer.setIcon(L.divIcon({
        className: 'custom-tak-icon',
        html: iconHtml,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      }));
    }
  };


  window.broadcastShape = function(id) {
    if (!window.drawnShapes || !window.drawnShapes[id]) return;
    const item = window.drawnShapes[id];
    const layer = item.layer;
    
    const nameInput = document.getElementById('edit-name-' + id);
    const customName = nameInput ? nameInput.value : id;
    
    if (layer.bindTooltip && item.type !== 'marker') {
      layer.bindTooltip(customName, { permanent: true, direction: 'center', className: 'tak-shape-tooltip' });
    }
    
    window.trackData = window.trackData || {};
    window.trackData[id] = window.trackData[id] || {};
    window.trackData[id].callsign = customName;
    
    let payload = { cmd: 'push_shape_cot', uid: id, callsign: customName };
    
    const td = window.trackData && window.trackData[id];
    if (td && td.customStyle) {
      payload.color = td.customStyle.color;
      payload.fillOpacity = td.customStyle.opacity;
      payload.weight = td.customStyle.weight;
    }
    
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
      showCopAlert('Broadcasted to TAK Server!');
    } else {
      showCopAlert('Cannot broadcast: WebSocket disconnected.', 'error');
    }
  };

  // Stale shape cleanup every 30s
  setInterval(() => {
    pruneStaleShapes();
    pruneStaleMarkers();
  }, 30000);
}

window.broadcastDataSyncMission = function() {
  if (!window.localMissionItems || window.localMissionItems.length === 0) return;
  window.localMissionItems.forEach(item => {
    if (window.broadcastShape) {
      window.broadcastShape(item.id);
    }
  });
  showTacticalBanner('📡 BROADCASTED ' + window.localMissionItems.length + ' MISSION ITEMS TO TAK');
};

window.exportMissionZip = function() {
  const missionSel = document.getElementById('datasync-mission-sel');
  const missionName = (missionSel && missionSel.value) ? missionSel.value : 'Local_Tactical_Mission';
  const items = window.localMissionItems || [];
  
  if (items.length === 0 && Object.keys(markers).length === 0 && drawnItems && drawnItems.getLayers().length === 0) {
    alert('No items on map to export! Add markers or shapes first.');
    return;
  }
  
  const exportItems = [];
  items.forEach(it => exportItems.push(it));
  
  if (exportItems.length === 0) {
    for (let k in markers) {
      if (markers[k] && markers[k].cotData) {
        exportItems.push(markers[k].cotData);
      }
    }
  }
  
  showTacticalBanner('📦 PACKAGING TAK MISSION: ' + missionName.toUpperCase());
  
  fetch('/api/datasync/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: missionName, items: exportItems })
  })
  .then(res => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  })
  .then(blob => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = missionName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    showTacticalBanner('✅ EXPORTED MISSION PACKAGE (.ZIP)');
  })
  .catch(err => {
    console.error('Export error:', err);
    alert('Failed to export mission package: ' + err.message);
  });
};

window.importMissionZip = function(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  
  showTacticalBanner('📥 IMPORTING & UNPACKING TAK PACKAGE: ' + file.name.toUpperCase());
  
  fetch('/api/datasync/import', {
    method: 'POST',
    body: file
  })
  .then(res => res.json())
  .then(data => {
    if (data && data.success) {
      showTacticalBanner('✅ UNPACKED ' + data.count + ' ITEMS FROM MISSION: ' + (data.missionName || file.name).toUpperCase());
      if (data.items && Array.isArray(data.items)) {
        processCotData(data.items);
      }
    } else {
      alert('Import failed: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(err => {
    console.error('Import error:', err);
    alert('Failed to import TAK .zip package: ' + err.message);
  });
  
  event.target.value = '';
};

window.fetchRemoteTakMissions = function() {
  showTacticalBanner('🌐 QUERYING TAK SERVER FOR REMOTE MISSIONS...');
  fetch('/api/datasync/remote/list')
  .then(res => res.json())
  .then(data => {
    const sel = document.getElementById('datasync-mission-sel');
    const listDiv = document.getElementById('datasync-items-list');
      
    if (data && data.error) {
      showTacticalBanner('⚠️ TAK SERVER REST API: ' + data.error);
      if (listDiv) {
        listDiv.innerHTML = `<div style="font-style:italic; text-align:center; margin-top:40px; color:var(--red-bright);">API Error: ${data.error}</div>`;
      }
    } else if (data && data.missions && data.missions.length > 0) {
      showTacticalBanner('📡 FOUND ' + data.missions.length + ' REMOTE MISSIONS ON TAK SERVER');
      
      if (listDiv && data.missions.length > 0) {
        listDiv.innerHTML = '';
      }

      if (sel) {
        data.missions.forEach((m, idx) => {
          const name = (typeof m === 'object') ? (m.Name || m.name || m.title || m.displayName) : String(m);
          if (!name) return;
          
          // Add to select dropdown
          let exists = false;
          for (let i=0; i<sel.options.length; i++) {
            if (sel.options[i].value === name) exists = true;
          }
          if (!exists) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = '☁️ ' + name;
            sel.appendChild(opt);
          }
          
          // Add to the list UI
          if (listDiv) {
            const itemEl = document.createElement('div');
            itemEl.style.padding = '4px';
            itemEl.style.borderBottom = '1px solid rgba(0,255,94,0.2)';
            itemEl.style.color = '#fff';
            itemEl.innerHTML = `<span style="color:var(--green-bright);">☁️ [REMOTE TAK MISSION]</span> ${name}`;
            listDiv.appendChild(itemEl);
          }
        });
        
        // Auto-select the first TAK mission if available and not currently selected
        if (sel.options.length > 1 && sel.value === 'Local_Tactical_Mission') {
          sel.selectedIndex = 1;
          showTacticalBanner('🔄 AUTO-SYNCED DATA MISSION TO: ' + sel.options[1].value);
        }
      }
    } else {
      showTacticalBanner('🌐 NO REMOTE MISSIONS FOUND ON TAK SERVER');
      const listDiv = document.getElementById('datasync-items-list');
      if (listDiv) {
        listDiv.innerHTML = '<div style="font-style:italic; text-align:center; margin-top:40px;">No remote missions found.</div>';
      }
    }
  })
  .catch(err => {
    console.error('Remote fetch error:', err);
    showTacticalBanner('⚠️ FAILED TO QUERY TAK SERVER REST API');
  });
};
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
        appendChatMessage(data.sender, data.message, data.timestamp, false, data.chatroom || 'All Chat Rooms');
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
  if (window.telemetryMode === 'TAK') return;

  if (window.activePipStream && data.stream_id && data.stream_id !== window.activePipStream) {
    removeFovOverlay('klv-drone-' + data.stream_id);
    if (markers['klv-drone-' + data.stream_id]) {
      copMap.removeLayer(markers['klv-drone-' + data.stream_id]);
      delete markers['klv-drone-' + data.stream_id];
    }
    return;
  }
  const id = 'klv-drone-' + (data.stream_id || '1');
  const streamName = data.stream_id || 'demo';

  // Actively remove any pre-existing TAK server CoT marker or FOV cone for this stream
  if (markers[`mtx-uas-${streamName}`]) {
    copMap.removeLayer(markers[`mtx-uas-${streamName}`]);
    delete markers[`mtx-uas-${streamName}`];
    removeFovOverlay(`mtx-uas-${streamName}`);
    delete window.trackData[`mtx-uas-${streamName}`];
  }
  if (markers[`video-${streamName}`]) {
    copMap.removeLayer(markers[`video-${streamName}`]);
    delete markers[`video-${streamName}`];
    removeFovOverlay(`video-${streamName}`);
    delete window.trackData[`video-${streamName}`];
  }

  const latlng = [parseFloat(data.lat), parseFloat(data.lon)];
  const callsign = data.stream_id === 'demo' ? 'DEMO DRONE' : (data.stream_id || 'KLV DRONE').toUpperCase();
  const az  = data.sensor_azimuth ?? data.hdg ?? 0;
  const fov = data.fov   ?? 60;
  const rng = data.range ?? 500;

  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: createCameraIcon() }).addTo(copMap);
    markers[id].bindTooltip(callsign, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'tactical-map-label' });
    markers[id].on('click', () => openPip(callsign, data.stream_id || 'demo'));
  } else {
    markers[id].setLatLng(latlng);
  }

  // Rotate icon by mutating DOM — avoids recreating icon object every frame
  const markerEl = markers[id].getElement();
  if (markerEl) {
    const svg = markerEl.querySelector('svg');
    if (svg) { svg.style.transform = `rotate(${az}deg)`; svg.style.transformOrigin = 'center center'; }
  }

  // Create or update the FOV cone polygon
  const wedge = computeFovWedge(parseFloat(data.lat), parseFloat(data.lon), az, fov, rng);
  if (!fovOverlays[id]) {
    fovOverlays[id] = L.polygon(wedge, {
      color: '#00ff5e', weight: 1.5,
      fillColor: '#00ff5e', fillOpacity: 0.12,
      dashArray: '5, 4', interactive: true
    }).addTo(copMap);
    fovOverlays[id].on('click', () => openPip(callsign, data.stream_id || 'demo'));
  } else {
    fovOverlays[id].setLatLngs(wedge);
  }

  markers[id].bindPopup(buildPopup(callsign, [['LAT', data.lat], ['LON', data.lon], ['ALT', `${data.alt} m`], ['AZ', `${az}°`], ['FOV', `${fov}°`], ['RANGE', `${rng} m`]], id) +
  `<button onclick="window.broadcastDroneToTak('${id}', '${callsign}', ${data.lat}, ${data.lon}, ${data.alt || 0})" style="margin-top:8px;background:var(--green-mid);color:#000;border:none;padding:6px 10px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📡 BROADCAST DRONE FEED TO TAK</button>`);
  // Pan map if this drone is the locked target
  if (lockTarget === id) copMap.panTo(latlng, { animate: false });
  if (Object.keys(markers).length === 1) copMap.panTo(latlng, { animate: true });
  window.trackData[id] = { id, callsign, lat: data.lat, lon: data.lon, type: 'AIRCRAFT/UAS' };
}

// ── SIDC mapper ───────────────────────────────────────────────────
function cotToSidc(cotType) {
  if (!cotType || !cotType.startsWith('a-')) return null;
  const parts = cotType.split('-');
  if (parts.length < 3) return null;
  const af = { f:'F', h:'H', n:'N', u:'U', a:'A', p:'P', j:'J', k:'K' }[parts[1]];
  const dm = { G:'G', A:'A', S:'S', U:'U', F:'F', X:'X' }[parts[2]];
  if (!af || !dm) return null;
  
  if (dm === 'A' && parts.length > 3 && parts[3] === 'U') return `S${af}APMFQ--------`;
  
  if (parts.length > 3) {
    const fn = parts[3].toUpperCase();
    if (fn === 'I') return `S${af}${dm}PUCI-------`;
    if (fn === 'A') return `S${af}${dm}PUCA-------`;
    if (fn === 'M') return `S${af}${dm}PUCM-------`;
    if (fn === 'MH' || fn === 'CH') return `S${af}${dm}PMH--------`;
    if (fn === 'MF') return `S${af}${dm}PMF--------`;
    if (fn === 'HQ') return `S${af}${dm}PHQ--------`;
    if (fn === 'S') return `S${af}${dm}PUCS-------`;
    if (fn === 'ES') return `S${af}${dm}PES--------`;
  }
  
  return `S${af}${dm}P-------`;
}

function getTakIcon(cot) {
  const iconsetPath = (cot.iconsetPath || '').toLowerCase();
  const cotType = (cot.type || '').toLowerCase();
  const callsign = (cot.callsign || '').toLowerCase();
  const remarks = (cot.remarks || '').toLowerCase();
  const combinedText = `${iconsetPath} ${cotType} ${callsign} ${remarks}`;
  
  // 1. Bicycle / Bike
  if (combinedText.includes('bicycle') || combinedText.includes('bike')) {
    return L.divIcon({
      className: 'tak-custom-icon bike-icon',
      html: `<div style="background:#16a085;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(22,160,133,0.9);font-weight:bold;">🚲</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 2. Emergency / FEMA / Incident / Medical
  if (combinedText.includes('fema') || combinedText.includes('incident') || combinedText.includes('medic') || combinedText.includes('hospital') || cotType.startsWith('b-a-')) {
    return L.divIcon({
      className: 'tak-custom-icon emergency-custom-icon',
      html: `<div style="background:#e74c3c;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(231,76,60,0.9);font-weight:bold;">🚨</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 3. Camera / Video / Feed
  if (combinedText.includes('camera') || combinedText.includes('feed') || combinedText.includes('video') || cotType.includes('b-i-v')) {
    return L.divIcon({
      className: 'tak-custom-icon camera-icon',
      html: `<div style="background:#9b59b6;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(155,89,182,0.9);font-weight:bold;">🎥</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 4. Vehicle / Car / Truck
  if (combinedText.includes('vehicle') || combinedText.includes('car') || combinedText.includes('truck')) {
    return L.divIcon({
      className: 'tak-custom-icon vehicle-icon',
      html: `<div style="background:#e67e22;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(230,126,34,0.9);font-weight:bold;">🚗</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 5. Aircraft / Drone / Aviation
  if (combinedText.includes('drone') || combinedText.includes('air') || cotType.includes('a-f-a') || cotType.includes('u-a')) {
    return L.divIcon({
      className: 'tak-custom-icon aviation-icon',
      html: `<div style="background:#3498db;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(52,152,219,0.9);font-weight:bold;">✈️</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 6. Observation / Checkpoint / POI
  if (combinedText.includes('checkpoint') || combinedText.includes('observation') || combinedText.includes('op') || combinedText.includes('guard')) {
    return L.divIcon({
      className: 'tak-custom-icon op-icon',
      html: `<div style="background:#2ecc71;color:#fff;border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 10px rgba(46,204,113,0.9);font-weight:bold;">👁️</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
    });
  }

  // 7. Check if it's a valid 2525 Military Track
  const sidc = cotToSidc(cot.type);
  if (sidc) {
    try {
      const sym = new ms.Symbol(sidc, { size: 25 });
      const svgHtml = sym.asSVG();
      if (svgHtml) {
        return L.divIcon({
          className: '',
          html: svgHtml,
          iconAnchor: [sym.getAnchor().x, sym.getAnchor().y],
          popupAnchor: [0, -sym.getAnchor().y]
        });
      }
    } catch (e) {}
  }

  // 8. Custom / Non-standard Marker fallback (Distinct Custom Yellow/Green Pin instead of Cyan Friendly Ground Box)
  return L.divIcon({
    className: 'tak-custom-icon generic-custom-icon',
    html: `<div style="background:#f1c40f;color:#000;border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 0 10px rgba(241,196,15,0.9);font-weight:bold;">📍</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13]
  });
}

// ── Main CoT dispatcher ───────────────────────────────────────────
function processCotData(cotArray) {
  cotArray.forEach(cot => {
    if (!cot.type) return;
    if (cot.type.startsWith('t-x-')) { showTacticalBanner('DATA SYNC / SYSTEM EVENT — ' + (cot.missionName || cot.callsign || cot.type.toUpperCase())); return; }
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

  // Handle linked attachment / photo events from iTAK
  if (cot.parentUid && markers[cot.parentUid]) {
    const targetMarker = markers[cot.parentUid];
    targetMarker.cotData = targetMarker.cotData || {};
    if (cot.imageUrl) targetMarker.cotData.imageUrl = cot.imageUrl;
    if (cot.attachmentUrl) targetMarker.cotData.attachmentUrl = cot.attachmentUrl;
    if (cot.attachmentName) targetMarker.cotData.attachmentName = cot.attachmentName;
    
    let tooltipLabel = targetMarker.cotData.callsign || cot.parentUid;
    if (targetMarker.cotData.imageUrl) tooltipLabel = '📷 ' + tooltipLabel;
    else if (targetMarker.cotData.attachmentUrl || targetMarker.cotData.attachmentName) tooltipLabel = '📎 ' + tooltipLabel;
    targetMarker.bindTooltip(tooltipLabel, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'tactical-map-label' });
    return;
  }

  // Immediately remove emergency beacon on normal point received
  if (markers['EMG-' + id]) {
    copMap.removeLayer(markers['EMG-' + id]);
    delete markers['EMG-' + id];
    delete window.trackData['EMG-' + id];
  }

  const latlng = [cot.lat, cot.lon];
  const symIcon = getTakIcon(cot);

  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: symIcon }).addTo(copMap);
    markers[id].cotData = cot;
    let tooltipLabel = cot.callsign;
    if (cot.imageUrl) tooltipLabel = '📷 ' + cot.callsign;
    else if (cot.attachmentUrl || cot.attachmentName) tooltipLabel = '📎 ' + cot.callsign;
    markers[id].bindTooltip(tooltipLabel, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'tactical-map-label' });
  } else {
    markers[id].setLatLng(latlng);
    markers[id].setIcon(symIcon);
  }
  let popupRows = [
    ['TYPE', cot.type],
    ['LAT',  cot.lat.toFixed(5)],
    ['LON',  cot.lon.toFixed(5)]
  ];
  if (cot.sensor) {
    if (cot.sensor.azimuth != null) popupRows.push(['AZ', `${cot.sensor.azimuth}°`]);
    if (cot.sensor.fov != null) popupRows.push(['FOV', `${cot.sensor.fov}°`]);
    if (cot.sensor.range != null) popupRows.push(['RANGE', `${cot.sensor.range} m`]);
  }
  if (cot.remarks) popupRows.push(['NOTE', cot.remarks]);
  if (cot.imageUrl) {
    popupRows.push(['PHOTO', `<a href="${cot.imageUrl}" target="_blank"><img src="${cot.imageUrl}" style="max-width:180px;max-height:120px;border:1px solid var(--green-bright);border-radius:4px;margin-top:4px;display:block;" /></a>`]);
  }
  if (cot.attachmentUrl || cot.attachmentName) {
    const name = cot.attachmentName || 'Download Attachment';
    const url = cot.attachmentUrl || '#';
    popupRows.push(['ATTACHMENT', `<a href="${url}" target="_blank" style="color:var(--green-bright);font-weight:bold;text-decoration:underline;">📎 ${name}</a>`]);
  }
  
  let popupHtml = buildPopup(cot.callsign, popupRows, id);
  let opts = '<option value="">-- SELECT RECIPIENT --</option>';
  (window.takApiClients || []).forEach(callsign => {
    opts += `<option value="${callsign}">${callsign}</option>`;
  });

  popupHtml += `
    <div style="margin-top:8px; border-top:1px solid var(--green-dim); padding-top:6px; display:flex; flex-direction:column; gap:4px;">
      <button onclick="window.broadcastMarkerToTak('${id}')" style="background:var(--green-mid);color:#000;border:none;padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📡 RE-BROADCAST TO TAK</button>
      <select id="dest-user-${id}" style="width:100%; padding:4px; background:#000; color:var(--green-bright); border:1px solid var(--green-mid);">${opts}</select>
      <button onclick="window.sendMarkerToUser('${id}')" style="background:#0f2a18;color:var(--green-bright);border:1px solid var(--green-mid);padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📤 SEND TO USER</button>
      <button onclick="window.deleteCopMarker('${id}')" style="background:#ff4444;color:#fff;border:none;padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">🗑️ DELETE MARKER</button>
    </div>
  `;
  
  markers[id].bindPopup(popupHtml);
  // Pan map if this marker is the locked target
  if (lockTarget === id) {
    copMap.panTo(latlng, { animate: false });
  } else if (Object.keys(markers).length === 1 && Object.keys(shapeOverlays).length === 0) {
    copMap.panTo(latlng, { animate: true });
  }
  // Suppress duplicate video alias CoT (video-demo) if a drone marker (mtx-uas-demo or klv-drone-demo) is active
  if (id.startsWith('video-')) {
    const streamName = id.replace('video-', '');
    if (markers[`mtx-uas-${streamName}`] || markers[`klv-drone-${streamName}`]) {
      if (markers[id]) {
        copMap.removeLayer(markers[id]);
        delete markers[id];
      }
      removeFovOverlay(id);
      delete window.trackData[id];
      return;
    }
  }

  // If a drone marker arrives, remove any duplicate legacy video alias marker
  if (id.startsWith('mtx-uas-') || id.startsWith('klv-drone-')) {
    const streamName = id.replace('mtx-uas-', '').replace('klv-drone-', '');
    if (markers[`video-${streamName}`]) {
      copMap.removeLayer(markers[`video-${streamName}`]);
      delete markers[`video-${streamName}`];
      delete window.trackData[`video-${streamName}`];
    }
    removeFovOverlay(`video-${streamName}`);
  }

  // Handling for mtx-uas- TAK server drone markers depending on active ingest mode
  if (id.startsWith('mtx-uas-')) {
    const streamName = id.replace('mtx-uas-', '');
    if (window.telemetryMode === 'DIRECT' && markers[`klv-drone-${streamName}`]) {
      if (markers[id]) {
        copMap.removeLayer(markers[id]);
        delete markers[id];
      }
      removeFovOverlay(id);
      delete window.trackData[id];
      return;
    } else if (window.telemetryMode === 'TAK' && markers[`klv-drone-${streamName}`]) {
      copMap.removeLayer(markers[`klv-drone-${streamName}`]);
      delete markers[`klv-drone-${streamName}`];
      removeFovOverlay(`klv-drone-${streamName}`);
      delete window.trackData[`klv-drone-${streamName}`];
    }
  }

  let trackType = 'GROUND UNIT';
  if (cot.type.includes('-A-') || id.startsWith('mtx-uas-') || id.startsWith('klv-drone-')) trackType = 'AIRCRAFT/UAS';
  else if (cot.type.startsWith('b-m')) trackType = 'MARKER';
  else if (cot.type.startsWith('b-i-v') || id.startsWith('video-')) trackType = 'UAS FEED';

  window.trackData[id] = { id, callsign: cot.callsign, lat: cot.lat, lon: cot.lon, type: trackType, stale: cot.stale };

  // ── FOV cone for CoT events carrying <sensor> geometry (Phase 2e) ──
  if (cot.sensor && cot.sensor.azimuth != null) {
    const az  = cot.sensor.azimuth;
    const fov = cot.sensor.fov   ?? 60;
    const rng = cot.sensor.range ?? 500;

    // Rotate the marker icon to match sensor azimuth
    const markerEl = markers[id] ? markers[id].getElement() : null;
    if (markerEl) {
      const svg = markerEl.querySelector('svg');
      if (svg) { svg.style.transform = `rotate(${az}deg)`; svg.style.transformOrigin = 'center center'; }
    }

    // Create or update FOV cone
    const wedge = computeFovWedge(cot.lat, cot.lon, az, fov, rng);
    if (!fovOverlays[id]) {
      fovOverlays[id] = L.polygon(wedge, {
        color: '#00ff5e', weight: 1.5,
        fillColor: '#00ff5e', fillOpacity: 0.12,
        dashArray: '5, 4', interactive: !!cot.videoUrl
      }).addTo(copMap);
      if (cot.videoUrl) {
        fovOverlays[id].on('click', () => openPip(cot.callsign, cot.videoUrl));
      }
    } else {
      fovOverlays[id].setLatLngs(wedge);
    }
  }
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

  } else if (cot.type === 'u-d-r' && cot.vertices && cot.vertices.length >= 3) {
    layer = L.polygon(cot.vertices.map(v => [v.lat, v.lon]), style);
    trackType = 'RECTANGLE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Rectangle'], ['POINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if (cot.type === 'u-d-r' && cot.ellipse) {
    // Rectangle — compute corners from center + half-dimensions + bearing
    const corners = rectCorners(cot.lat, cot.lon, cot.ellipse.major, cot.ellipse.minor, cot.ellipse.angle);
    layer = L.polygon(corners, style);
    trackType = 'RECTANGLE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Rectangle'], ['LENGTH', `${cot.ellipse.major.toFixed(0)} m`], ['WIDTH', `${cot.ellipse.minor.toFixed(0)} m`], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if (cot.type === 'u-d-p' && cot.vertices && cot.vertices.length >= 3) {
    layer = L.polygon(cot.vertices.map(v => [v.lat, v.lon]), style);
    trackType = 'POLYGON';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Polygon'], ['POINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));

  } else if (cot.type === 'u-d-f' && cot.vertices && cot.vertices.length >= 2) {
    layer = L.polyline(cot.vertices.map(v => [v.lat, v.lon]), style);
    trackType = 'LINE';
    layer.bindPopup(buildPopup(label, [['TYPE', 'Line'], ['POINTS', cot.vertices.length], ...(cot.remarks ? [['NOTE', cot.remarks]] : [])]));
  }

  if (layer) {
    let opts = '<option value="">-- SELECT RECIPIENT --</option>';
    (window.takApiClients || []).forEach(callsign => {
      opts += `<option value="${callsign}">${callsign}</option>`;
    });

    const existingPopupHtml = layer.getPopup().getContent();
    const newPopupHtml = existingPopupHtml + `
      <div style="margin-top:8px; border-top:1px solid var(--green-dim); padding-top:6px; display:flex; flex-direction:column; gap:4px;">
        <select id="dest-user-${id}" style="width:100%; padding:4px; background:#000; color:var(--green-bright); border:1px solid var(--green-mid);">${opts}</select>
        <button onclick="window.sendShapeToUser('${id}')" style="background:#0f2a18;color:var(--green-bright);border:1px solid var(--green-mid);padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📤 SEND TO USER</button>
      </div>
    `;
    layer.bindPopup(newPopupHtml);

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
  const isCancel = cot.type.endsWith('-k') || cot.type === 'b-a-o-c' || cot.type.includes('-c') || cot.type.toLowerCase().includes('can') || (cot.callsign || '').toLowerCase().includes('cancel') || cot.type.toLowerCase().endsWith('-cancel') || (cot.remarks || '').toLowerCase().includes('cancel') || (cot.remarks || '').toLowerCase().includes('false');

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
    if (lockTarget === id) copMap.panTo(latlng, { animate: false });
  }
  markers[id].bindPopup(buildPopup('⚠ EMERGENCY', [['CALLSIGN', baseCallsign], ['STATUS', cot.callsign], ['LAT', cot.lat.toFixed(5)], ['LON', cot.lon.toFixed(5)]], id));
  window.trackData[id] = { id, callsign: baseCallsign, lat: cot.lat, lon: cot.lon, type: 'EMERGENCY', stale: cot.stale };
  pruneStaleMarkers();
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
    if (td && td.stale && new Date(td.stale).getTime() < now - 300000) {
      copMap.removeLayer(layer);
      delete shapeOverlays[id];
      delete window.trackData[id];
    }
  });
}

function pruneStaleMarkers() {
  const now = Date.now();
  Object.entries(markers).forEach(([id, marker]) => {
    const td = window.trackData[id];
    if (td && td.stale && new Date(td.stale).getTime() < now - 5000) {
      // Give 5 second grace for very recent stales
      if (id.startsWith('EMG-')) {
        copMap.removeLayer(marker);
        delete markers[id];
        delete window.trackData[id];
      }
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
  const sel        = document.getElementById('chat-recipient');

  toggleBtn.addEventListener('click', () => {
    chatOpen = !chatOpen;
    panel.classList.toggle('open', chatOpen);
    if (chatOpen) {
      chatUnread = 0;
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });

  if (sel) {
    sel.addEventListener('change', () => {
      renderChatLog(sel.value);
    });
  }

  sendBtn.addEventListener('click', sendChatMessage);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });
}

window.deleteCopMarker = function(id) {
  if (!confirm('Are you sure you want to delete this marker?')) return;
  
  if (markers[id]) {
    copMap.removeLayer(markers[id]);
    delete markers[id];
  }
  if (shapeOverlays[id]) {
    copMap.removeLayer(shapeOverlays[id]);
    delete shapeOverlays[id];
  }
  removeFovOverlay(id);
  if (window.drawnShapes && window.drawnShapes[id]) {
    if (window.drawnShapes[id].layer) {
      copMap.removeLayer(window.drawnShapes[id].layer);
    }
    delete window.drawnShapes[id];
  }
  if (window.trackData) delete window.trackData[id];
  
  if (wsTelemetry && wsTelemetry.readyState === 1) {
    const cancelXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<event version="2.0" uid="${id}" type="b-m-p-s-m-k" time="${new Date().toISOString()}" start="${new Date().toISOString()}" stale="${new Date().toISOString()}" how="h-g-i-g-o">
  <point lat="0" lon="0" hae="0" ce="9999999" le="9999999"/>
  <detail><contact callsign="CANCELLED"/><remarks>Deleted from ARES COP</remarks></detail>
</event>`;
    wsTelemetry.send(JSON.stringify({ cmd: 'push_cot_raw', xml: cancelXml }));
  }
  
  if (typeof showTacticalBanner === 'function') {
    showTacticalBanner('🗑️ MARKER DELETED & CANCELLED ON TAK');
  }
};

function renderChatLog(selectedView) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  log.innerHTML = '';
  
  const msgs = window.allChatMessages.filter(msg => {
    if (selectedView === 'All Chat Rooms' || selectedView === 'All Chat Rooms (Broadcast)') {
      return msg.chatroom === 'All Chat Rooms' || !msg.to;
    }
    const isRelated = msg.sender === selectedView || msg.to === selectedView || msg.chatroom === selectedView;
    return isRelated;
  });

  msgs.forEach(({sender, message, timestamp, isSelf}) => {
    const ts = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const div = document.createElement('div');
    div.className = 'chat-message' + (isSelf ? ' chat-self' : '');
    div.innerHTML = `<span class="chat-sender">${sender}</span><span class="chat-time">${ts}</span><div class="chat-text">${escapeHtml(message)}</div>`;
    log.appendChild(div);
  });
  log.scrollTop = log.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const sel = document.getElementById('chat-recipient');
  const text = input.value.trim();
  if (!text) return;
  
  const recipientCallsign = sel ? sel.value : 'All Chat Rooms';
  const recipientUid = sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].getAttribute('data-uid') : 'All Chat Rooms';

  if (wsTelemetry && wsTelemetry.readyState === 1) {
    wsTelemetry.send(JSON.stringify({ 
      cmd: 'push_geochat', 
      senderCallsign: 'ARES-COP', 
      message: text,
      recipientCallsign: recipientCallsign,
      recipientUid: recipientUid
    }));
    appendChatMessage('ARES-COP', text, new Date().toISOString(), true, recipientCallsign);
    input.value = '';
  }
}

function appendChatMessage(sender, message, timestamp, isSelf, chatroom = 'All Chat Rooms', to = null, senderUid = null, destUid = null) {
  window.allChatMessages.push({ sender, message, timestamp, isSelf, chatroom: chatroom || 'All Chat Rooms', to: to || null, senderUid, destUid });

  if (!isSelf) {
    showTacticalBanner('💬 ' + sender + ': ' + message, 5000);
  }

  const sel = document.getElementById('chat-recipient');
  const currentView = sel ? sel.value : 'All Chat Rooms';
  
  renderChatLog(currentView);

  // Badge and Toast when panel is closed
  if (!chatOpen && !isSelf) {
    chatUnread++;
    const badge = document.getElementById('chat-badge');
    if (badge) { badge.textContent = chatUnread; badge.style.display = 'inline-flex'; }
    showToast(sender, message);
  }
}

function showCopAlert(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) { console.warn(msg); return; }
  const toast = document.createElement('div');
  const colors = { success: 'var(--green-bright)', error: '#ff4444', warn: '#ffcc00', info: '#00ccff' };
  const borderColor = colors[type] || colors.success;
  toast.style.cssText = `background:rgba(5,5,5,0.95);border:1px solid ${borderColor};border-left:4px solid ${borderColor};color:${borderColor};padding:10px 20px;border-radius:4px;font-family:var(--font-mono);font-size:13px;box-shadow:0 4px 15px rgba(0,255,94,0.3);animation:slideDown 0.3s ease forwards;max-width:320px;pointer-events:auto;`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideDown 0.3s ease reverse forwards';
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 4000);
}

function showToast(sender, message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.innerHTML = `<div class="toast-sender">💬 ${escapeHtml(sender)}</div><div class="toast-text">${escapeHtml(message)}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideDown 0.3s ease reverse forwards';
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 5000);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Sidebar & Demo Controls ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Sync UI state for telemetry mode switch
  window.setTelemetryMode(window.telemetryMode);

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

  window.takApiClients = [];
  function pollTakClients() {
    fetch('/api/tak/clients')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          window.takApiClients = data.filter(c => c && c.callsign).map(c => c.callsign);
        }
      })
      .catch(() => {});
  }
  setInterval(pollTakClients, 5000);
  pollTakClients();

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
    const tracks = Object.values(window.trackData || {}).filter(t => 
      (t.type === 'GROUND UNIT' || t.type === 'AIRCRAFT/UAS') &&
      !t.id.startsWith('klv-drone') &&
      !t.id.startsWith('EMG-') &&
      !t.id.startsWith('COP-Shape') &&
      !t.id.startsWith('unit-') &&
      t.callsign !== window.copCallsign &&
      t.callsign !== 'ARES-WERX-COP' &&
      t.callsign !== 'ARES COP' &&
      t.callsign !== 'TAK-Server' &&
      !t.callsign.includes('-') && // Exclude UUID strings that got assigned as callsigns
      t.callsign !== t.id
    );
    
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
  document.getElementById('demo-alpha-toggle').addEventListener('change', e => sendDemoControl({ cmd:'toggle_alpha_targets', state:e.target.checked }));
  document.getElementById('demo-density-slider').addEventListener('input',  e => sendDemoControl({ cmd:'set_density', density:parseInt(e.target.value,10) }));
  document.getElementById('demo-pattern-select').addEventListener('change', e => sendDemoControl({ cmd:'set_pattern', pattern:e.target.value }));

  // Chat
  initChat();
  window.fetchRemoteTakMissions();
});

// ── User Location & Dynamic Callsign ──────────────────────────────
function initCopUserLocation() {
  // Fetch current username and set callsign
  fetch('/api/me').then(r => r.json()).then(data => {
    if (data.username) {
      const callsign = `ARES COP [${data.username}]`;
      if (wsTelemetry && wsTelemetry.readyState === 1) {
        wsTelemetry.send(JSON.stringify({ cmd: 'set_cop_callsign', callsign }));
      } else {
        // Retry once connected
        const origOnOpen = wsTelemetry ? wsTelemetry.onopen : null;
        const setCallsign = () => {
          if (wsTelemetry) wsTelemetry.send(JSON.stringify({ cmd: 'set_cop_callsign', callsign }));
        };
        setTimeout(setCallsign, 2000);
      }
    }
  }).catch(() => {});

  // Request geolocation and watch for updates
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (wsTelemetry && wsTelemetry.readyState === 1) {
          wsTelemetry.send(JSON.stringify({ cmd: 'update_cop_location', lat: latitude, lon: longitude }));
        }
        // Place a self-marker on the map
        if (copMap) {
          const selfIcon = L.divIcon({
            className: '',
            html: '<div style="width:14px;height:14px;background:#00ccff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 10px #00ccff;"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
          });
          if (!markers['_self']) {
            markers['_self'] = L.marker([latitude, longitude], { icon: selfIcon }).addTo(copMap);
            markers['_self'].bindTooltip('ARES COP (YOU)', { permanent: true, direction: 'top', className: 'tactical-map-label' });
          } else {
            markers['_self'].setLatLng([latitude, longitude]);
          }
        }
      },
      (err) => { console.warn('Geolocation error:', err.message); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }
}

// ── Center Map on Current Geolocation ─────────────────────────────
window.centerOnCurrentLocation = function() {
  if (markers['_self']) {
    const latlng = markers['_self'].getLatLng();
    copMap.flyTo(latlng, 16, { animate: true, duration: 1.2 });
    showTacticalBanner('🎯 CENTERED ON CURRENT LOCATION (' + latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4) + ')');
    if (typeof markers['_self'].openTooltip === 'function') markers['_self'].openTooltip();
    return;
  }
  
  if (navigator.geolocation) {
    showTacticalBanner('🛰️ ACQUIRING GPS LOCATION...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const latlng = [latitude, longitude];
        const selfIcon = L.divIcon({
          className: '',
          html: '<div style="width:14px;height:14px;background:#00ccff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 10px #00ccff;"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });
        if (!markers['_self']) {
          markers['_self'] = L.marker(latlng, { icon: selfIcon }).addTo(copMap);
          markers['_self'].bindTooltip('ARES COP (YOU)', { permanent: true, direction: 'top', className: 'tactical-map-label' });
        } else {
          markers['_self'].setLatLng(latlng);
        }
        copMap.flyTo(latlng, 16, { animate: true, duration: 1.2 });
        showTacticalBanner('🎯 CENTERED ON CURRENT LOCATION (' + latitude.toFixed(4) + ', ' + longitude.toFixed(4) + ')');
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
        showTacticalBanner('⚠️ GEOLOCATION DENIED OR UNAVAILABLE');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } else {
    showTacticalBanner('⚠️ GEOLOCATION NOT SUPPORTED BY BROWSER');
  }
};

// ── Map Upload ────────────────────────────────────────────────────
window.handleMapUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  const btn = document.getElementById('tool-upload');
  btn.innerHTML = '⏳'; btn.disabled = true;
  try {
    const res = await fetch(`/api/upload_map?filename=${encodeURIComponent(file.name)}`, { method:'POST', body:file });
    if (res.ok) {
      showCopAlert('Map uploaded successfully!');
      copMap.eachLayer(l => { if (l._url && l._url.includes('/tiles/')) l.redraw(); });
    } else { showCopAlert('Failed to upload map.', 'error'); }
  } catch(e) { console.error(e); showCopAlert('Map upload error.', 'error'); }
  finally { btn.innerHTML = '📁 UPLOAD MBTILES'; btn.disabled = false; event.target.value = ''; }
};
