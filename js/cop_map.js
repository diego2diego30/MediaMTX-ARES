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
window.allChatMessages = []; // Task 3 master array
const chatLogs = {};
window.localMissionItems = [];


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
function buildPopup(title, rows) {
  const inner = rows.map(([k, v]) => `<strong style="color:#fff">${k}:</strong> ${v}`).join('<br>');
  return `<div style="background:rgba(0,0,0,0.85);padding:6px 8px;border-radius:4px;line-height:1.6;border:1px solid var(--green-bright)">
    <strong style="color:var(--green-bright);font-size:13px;text-shadow:0 0 5px var(--green-bright)">${title}</strong><br>${inner}
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
      const popupContent = `
        <div style="font-family: var(--font-main); min-width: 220px;">
          <strong style="color:var(--green-bright)">NEW TACTICAL MARKER</strong><br>
          <div style="margin-top:10px;border-top:1px solid var(--green-dim);padding-top:8px;">
            <label style="color:var(--green-bright);font-size:11px;">NAME / CALLSIGN: 
              <input type="text" id="edit-marker-name-${layer._copId}" value="${defaultName}" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;width:100%;padding:2px;margin-top:2px;margin-bottom:6px;">
            </label><br>
            <label style="color:var(--green-bright);font-size:11px;">TAK SUPPORTED MARKER TYPE: 
              <select id="edit-marker-type-${layer._copId}" style="background:#000;color:#fff;border:1px solid var(--green-dim);font-size:11px;width:100%;padding:2px;margin-top:2px;margin-bottom:6px;">
                <option value="a-f-G-U-C-I">Friendly Infantry</option>
                <option value="a-f-G-U-C-A">Friendly Armor / Mech</option>
                <option value="a-f-G-U-C-M">Friendly Medical</option>
                <option value="a-f-G-U-C-HQ">Friendly HQ / Command</option>
                <option value="a-f-A-M-H">Friendly Rotary Wing / Helicopter</option>
                <option value="a-f-A-M-F">Friendly Fixed Wing / Plane</option>
                <option value="a-h-G-U-C">Hostile Ground Unit</option>
                <option value="a-h-G-U-C-A">Hostile Armor</option>
                <option value="a-n-G-U-C-M">Neutral Medical / Civ</option>
                <option value="a-u-A-M-F-Q">Unknown Drone / UAS</option>
                <option value="b-m-p-s-m">Standard Point Marker</option>
              </select>
            </label><br>
            <button onclick="window.broadcastCustomMarker('${layer._copId}')" style="margin-top:8px;background:var(--green-bright);color:#000;border:none;padding:6px;width:100%;font-weight:bold;cursor:pointer;">📡 BROADCAST MARKER TO TAK</button>
          </div>
        </div>
      `;
      layer.bindPopup(popupContent).openPopup();
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
    const typeSelect = document.getElementById('edit-marker-type-' + id);
    if (!nameInput || !typeSelect) return;
    
    const name = nameInput.value;
    const cotType = typeSelect.value;
    
    if (typeof cotToSidc === 'function') {
      const sidc = cotToSidc(cotType);
      const sym = new ms.Symbol(sidc, { size: 25 });
      const iconObj = L.divIcon({
        className: 'tak-marker-icon',
        html: sym.asSVG(),
        iconSize: [sym.getSize().width, sym.getSize().height],
        iconAnchor: [sym.getAnchor().x, sym.getAnchor().y]
      });
      layer.setIcon(iconObj);
    }
    
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
    if (data && data.error) {
      showTacticalBanner('⚠️ TAK SERVER REST API: ' + data.error);
    } else if (data && data.missions && data.missions.length > 0) {
      showTacticalBanner('📡 FOUND ' + data.missions.length + ' REMOTE MISSIONS ON TAK SERVER');
      const sel = document.getElementById('datasync-mission-sel');
      const listDiv = document.getElementById('datasync-items-list');
      
      if (sel) {
        data.missions.forEach((m, idx) => {
          const name = (typeof m === 'object') ? (m.name || m.title || m.displayName) : String(m);
          if (!name) return;
          
          // Add to select dropdown
          let exists = false;
          for (let i=0; i<sel.options.length; i++) {
            if (sel.options[i].value === name) exists = true;
          }
          if (!exists) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = '☁️ REMOTE MISSION ON TAK SERVER: ' + name;
            sel.appendChild(opt);
          }
          
          // Add to the list UI
          if (listDiv) {
            if (listDiv.innerHTML.includes('No local mission items yet')) {
              listDiv.innerHTML = '';
            }
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
  markers[id].bindPopup(buildPopup(callsign, [['LAT', data.lat], ['LON', data.lon], ['ALT', `${data.alt} m`]]) + 
  `<button onclick="window.broadcastDroneToTak('${id}', '${callsign}', ${data.lat}, ${data.lon}, ${data.alt || 0})" style="margin-top:8px;background:var(--green-mid);color:#000;border:none;padding:6px 10px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📡 BROADCAST DRONE FEED TO TAK</button>`);
  if (Object.keys(markers).length === 1) copMap.panTo(latlng, { animate: true });
  window.trackData[id] = { id, callsign, lat: data.lat, lon: data.lon, type: 'UAS FEED' };
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
  if (cot.remarks) popupRows.push(['NOTE', cot.remarks]);
  if (cot.imageUrl) {
    popupRows.push(['PHOTO', `<a href="${cot.imageUrl}" target="_blank"><img src="${cot.imageUrl}" style="max-width:180px;max-height:120px;border:1px solid var(--green-bright);border-radius:4px;margin-top:4px;display:block;" /></a>`]);
  }
  if (cot.attachmentUrl || cot.attachmentName) {
    const name = cot.attachmentName || 'Download Attachment';
    const url = cot.attachmentUrl || '#';
    popupRows.push(['ATTACHMENT', `<a href="${url}" target="_blank" style="color:var(--green-bright);font-weight:bold;text-decoration:underline;">📎 ${name}</a>`]);
  }
  
  let popupHtml = buildPopup(cot.callsign, popupRows);
  popupHtml += `
    <div style="margin-top:8px; border-top:1px solid var(--green-dim); padding-top:6px; display:flex; flex-direction:column; gap:4px;">
      <button onclick="window.broadcastMarkerToTak('${id}')" style="background:var(--green-mid);color:#000;border:none;padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">📡 RE-BROADCAST TO TAK</button>
      <button onclick="window.deleteCopMarker('${id}')" style="background:#ff4444;color:#fff;border:none;padding:5px 8px;cursor:pointer;font-weight:bold;border-radius:2px;width:100%;">🗑️ DELETE MARKER</button>
    </div>
  `;
  
  markers[id].bindPopup(popupHtml);
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
  }
  markers[id].bindPopup(buildPopup('⚠ EMERGENCY', [['CALLSIGN', baseCallsign], ['STATUS', cot.callsign], ['LAT', cot.lat.toFixed(5)], ['LON', cot.lon.toFixed(5)]]));
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
  if (window.drawnShapes && window.drawnShapes[id]) {
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
