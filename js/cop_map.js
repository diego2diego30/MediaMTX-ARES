let copMap;
let markers = {};
window.trackData = {};
let wsTelemetry;
let wsReconnectTimer;

const UAS_ICON = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const COT_ICON = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

function initCopMap() {
  copMap = L.map('cop-map-container', { zoomControl: false }).setView([34.665, -77.55], 13);
  
  L.control.zoom({ position: 'bottomleft' }).addTo(copMap);

  // CartoDB Dark Base (World background)
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(copMap);
  
  // Local MBTiles (High-res overlay that scales down dynamically when zoomed out)
  const localTiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    minNativeZoom: 10,
    maxNativeZoom: 19,
    minZoom: 1,
    maxZoom: 22,
    bounds: [
      [34.4982408, -77.6072062],
      [34.7483673, -77.1803647]
    ],
    attribution: 'Camp Lejeune MBTiles'
  }).addTo(copMap);

  const baseMaps = {
    "Carto Dark": cartoDark
  };

  const overlayMaps = {
    "Camp Lejeune MBTiles": localTiles
  };

  L.control.layers(baseMaps, overlayMaps, { position: 'bottomleft' }).addTo(copMap);

  // Initialize Leaflet Draw
  const drawnItems = new L.FeatureGroup();
  copMap.addLayer(drawnItems);
  const drawControl = new L.Control.Draw({
    position: 'topleft',
    edit: {
      featureGroup: drawnItems
    },
    draw: {
      polygon: { shapeOptions: { color: '#00ff5e' } },
      polyline: { shapeOptions: { color: '#00ff5e' } },
      rectangle: { shapeOptions: { color: '#00ff5e' } },
      circle: { shapeOptions: { color: '#00ff5e' } },
      marker: true
    }
  });
  copMap.addControl(drawControl);

  copMap.on(L.Draw.Event.CREATED, function (event) {
    const layer = event.layer;
    drawnItems.addLayer(layer);
  });
}

function connectTelemetry() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${proto}//${window.location.host}/ws/`;
  
  if (window.location.protocol === 'file:' || window.location.port === '5500') {
    wsUrl = `ws://localhost:8081`;
  }

  try {
    wsTelemetry = new WebSocket(wsUrl);
  } catch(e) {
    wsTelemetry = new WebSocket(`ws://localhost:8081`);
  }

  wsTelemetry.onopen = () => {
    console.log('Connected to Telemetry Bridge.');
    const statusText = document.getElementById('telemetry-status-text');
    const statusContainer = document.getElementById('telemetry-status');
    statusText.textContent = 'RX CONNECTED';
    statusContainer.classList.remove('disconnected');
  };

  wsTelemetry.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Data can be a single KLV point or an array of CoT markers
      if (Array.isArray(data)) {
        processCotData(data);
      } else if (data.lat && data.lon) {
        processKlvData(data);
      }
    } catch(e) {
      console.error("Failed to parse telemetry frame", e);
    }
  };

  wsTelemetry.onclose = () => {
    console.log('Disconnected from Telemetry Bridge.');
    const statusText = document.getElementById('telemetry-status-text');
    const statusContainer = document.getElementById('telemetry-status');
    statusText.textContent = 'DISCONNECTED';
    statusContainer.classList.add('disconnected');
    
    wsTelemetry = null;
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectTelemetry, 2000);
  };
}

function processKlvData(data) {
  // If a video is playing and this KLV data is from a different stream, ignore it and remove its marker
  if (window.activePipStream && data.stream_id && data.stream_id !== window.activePipStream) {
    if (markers['klv-drone-' + data.stream_id]) {
      copMap.removeLayer(markers['klv-drone-' + data.stream_id]);
      delete markers['klv-drone-' + data.stream_id];
    }
    return;
  }

  const id = 'klv-drone-' + (data.stream_id || '1');
  const latlng = [parseFloat(data.lat), parseFloat(data.lon)];
  
  if (!markers[id]) {
    markers[id] = L.marker(latlng, { icon: UAS_ICON }).addTo(copMap);
    
    // Add legible permanent map label
    const callsign = data.stream_id === 'demo' ? 'DEMO DRONE' : (data.stream_id || 'KLV DRONE').toUpperCase();
    markers[id].bindTooltip(callsign, {
      permanent: true,
      direction: 'bottom',
      offset: [0, 10],
      className: 'tactical-map-label'
    });

    // Bind click event to open PiP Video
    markers[id].on('click', () => {
      openPip(callsign, data.stream_id || 'demo');
    });
  } else {
    markers[id].setLatLng(latlng);
  }
  
  const popupHtml = `
    <div style="background: rgba(0,0,0,0.8); padding: 5px; border-radius: 4px; line-height: 1.5; letter-spacing: 0.5px; border: 1px solid var(--green-bright);">
      <strong style="color:var(--green-bright); font-size: 14px; text-shadow: 0 0 5px var(--green-bright);">${(data.stream_id === 'demo' ? 'DEMO DRONE' : (data.stream_id || 'KLV DRONE').toUpperCase())}</strong><br>
      <strong style="color:#fff;">LAT:</strong> ${data.lat}<br>
      <strong style="color:#fff;">LON:</strong> ${data.lon}<br>
      <strong style="color:#fff;">ALT:</strong> ${data.alt} m
    </div>
  `;
  markers[id].bindPopup(popupHtml);
  
  // Only pan if it's the only marker
  if (Object.keys(markers).length === 1) {
    copMap.panTo(latlng, { animate: true, duration: 0.5 });
  }

  // Update track data for sidebar
  window.trackData[id] = { id, callsign, lat: data.lat, lon: data.lon, type: 'UAS FEED' };
}

function cotToSidc(cotType) {
  if (!cotType) return 'SFG-UCI----'; 
  
  if (cotType.startsWith('b-m')) {
    return 'GUGPGPRP--****X'; // Reference Point Marker
  }
  
  const parts = cotType.split('-');
  if (parts.length < 3) return 'SFG-UCI----';
  
  let affiliation = 'U'; 
  if (parts[1] === 'f') affiliation = 'F';
  if (parts[1] === 'h') affiliation = 'H';
  if (parts[1] === 'n') affiliation = 'N';
  
  let dimension = 'Z';
  if (parts[2] === 'G') dimension = 'G'; 
  if (parts[2] === 'A') dimension = 'A'; 
  if (parts[2] === 'S') dimension = 'S'; 
  if (parts[2] === 'U') dimension = 'U'; 
  
  if (dimension === 'A' && parts.length > 3 && parts[3] === 'U') {
    return `S${affiliation}APMFQ--------`; // UAV
  }
  
  return `S${affiliation}${dimension}P-------`; 
}

function processCotData(cotArray) {
  cotArray.forEach(cot => {
    const id = cot.uid;
    const latlng = [cot.lat, cot.lon];
    
    const sidc = cotToSidc(cot.type);

    // Omit uniqueDesignation so the dark embedded text is removed
    const sym = new ms.Symbol(sidc, { size: 25 });
    const symIcon = L.divIcon({
      className: '',
      html: sym.asSVG(),
      iconAnchor: [sym.getAnchor().x, sym.getAnchor().y],
      popupAnchor: [0, -sym.getAnchor().y]
    });
    
    if (!markers[id]) {
      markers[id] = L.marker(latlng, { icon: symIcon }).addTo(copMap);
      
      markers[id].bindTooltip(cot.callsign, {
        permanent: true,
        direction: 'bottom',
        offset: [0, 10],
        className: 'tactical-map-label'
      });
    } else {
      markers[id].setLatLng(latlng);
      markers[id].setIcon(symIcon);
    }
    
    const popupHtml = `
      <div style="background: rgba(0,0,0,0.8); padding: 5px; border-radius: 4px; line-height: 1.5; letter-spacing: 0.5px; border: 1px solid var(--green-bright);">
        <strong style="color:var(--green-bright); font-size: 14px; text-shadow: 0 0 5px var(--green-bright);">${cot.callsign}</strong><br>
        <strong style="color:#fff;">TYPE:</strong> ${cot.type}<br>
        <strong style="color:#fff;">LAT:</strong> ${cot.lat.toFixed(5)}<br>
        <strong style="color:#fff;">LON:</strong> ${cot.lon.toFixed(5)}
      </div>
    `;
    markers[id].bindPopup(popupHtml);

    let trackType = 'GROUND UNIT';
    if (cot.type && cot.type.includes('-A-')) trackType = 'AIRCRAFT/UAS';
    if (cot.type && cot.type.startsWith('b-m')) trackType = 'MARKER';
    
    // Update track data for sidebar
    window.trackData[id] = { id, callsign: cot.callsign, lat: cot.lat, lon: cot.lon, type: trackType };
  });
}

// ------------------------------------------------------------------
// MediaMTX Sidebar & Demo Control Panel Interaction
// ------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  const sidebar = document.getElementById('cop-sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  
  toggleBtn.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed');
    toggleBtn.textContent = isCollapsed ? '◀ MENU' : 'MENU ▶';
  });

  // Poll MediaMTX Active Paths
  function pollMediaMtxStreams() {
    const apiHost = window.location.protocol === 'file:' || window.location.port === '5500' 
      ? 'http://localhost:8080' 
      : '';
    fetch(`${apiHost}/api/v3/paths/list`)
      .then(res => res.json())
      .then(data => {
        const streamList = document.getElementById('sidebar-streams-list');
        const items = data.items || [];
        
        const activeItems = items.filter(i => i.ready);
        if (activeItems.length === 0) {
          streamList.innerHTML = '<div class="stream-item empty">No active streams found</div>';
          return;
        }

        streamList.innerHTML = '';
        activeItems.forEach(stream => {
          const item = document.createElement('div');
          item.className = 'stream-item';
          item.innerHTML = `🎥 <strong>${stream.name}</strong><br><small style="color:var(--grey-mid)">Tracks: ${(stream.tracks || []).join(', ')}</small>`;
          item.addEventListener('click', () => {
            const sourceLabel = stream.name === 'demo' ? 'DEMO DRONE' : stream.name.toUpperCase();
            openPip(sourceLabel, stream.name);
          });
          streamList.appendChild(item);
        });
      })
      .catch(() => {
        const streamList = document.getElementById('sidebar-streams-list');
        streamList.innerHTML = '<div class="stream-item empty">Failed to query MediaMTX API</div>';
      });
  }

  setInterval(pollMediaMtxStreams, 3000);
  pollMediaMtxStreams();

  // ------------------------------------------------------------------
  // Object Tracks List Update
  // ------------------------------------------------------------------
  window.panToTrack = function(id) {
    if (markers[id]) {
      copMap.panTo(markers[id].getLatLng(), { animate: true, duration: 0.5 });
      markers[id].openPopup();
    }
  };

  function updateTrackSidebar() {
    const container = document.getElementById('sidebar-tracks-list');
    if (!container) return;
    const tracks = Object.values(window.trackData || {});
    if (tracks.length === 0) {
      container.innerHTML = '<div class="stream-item empty">Awaiting telemetry...</div>';
      return;
    }
    
    // Sort tracks alphabetically
    tracks.sort((a,b) => a.callsign.localeCompare(b.callsign));
    
    let html = '';
    tracks.forEach(t => {
      // Add hover styling or pointer in CSS, inline here for quick styling
      html += `
        <div class="stream-item" onclick="panToTrack('${t.id}')" style="cursor:pointer; position:relative;">
          <strong style="color:var(--green-bright);">${t.callsign}</strong>
          <br><small style="color:var(--grey-mid)">${t.type} · ${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}</small>
        </div>
      `;
    });
    
    if (container.innerHTML !== html) {
      container.innerHTML = html;
    }
  }

  setInterval(updateTrackSidebar, 2000);
  updateTrackSidebar();

  // Send Controls over WebSocket
  function sendDemoControl(payload) {
    if (wsTelemetry && wsTelemetry.readyState === WebSocket.OPEN) {
      wsTelemetry.send(JSON.stringify(payload));
    }
  }

  document.getElementById('demo-active-toggle').addEventListener('change', (e) => {
    sendDemoControl({ cmd: 'toggle_demo', state: e.target.checked });
  });

  document.getElementById('demo-density-slider').addEventListener('input', (e) => {
    sendDemoControl({ cmd: 'set_density', density: parseInt(e.target.value, 10) });
  });

  document.getElementById('demo-pattern-select').addEventListener('change', (e) => {
    sendDemoControl({ cmd: 'set_pattern', pattern: e.target.value });
  });
});

window.handleMapUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const uploadBtn = document.getElementById('tool-upload');
  const originalText = uploadBtn.innerHTML;
  uploadBtn.innerHTML = '⏳';
  uploadBtn.disabled = true;

  try {
    const apiHost = window.location.protocol + "//" + window.location.host;
    const response = await fetch(`${apiHost}/api/upload_map?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file
    });

    if (response.ok) {
      alert('Map uploaded and loaded successfully!');
      // Force map tile reload
      const mapContainer = document.getElementById('map');
      if (mapContainer && typeof L !== 'undefined') {
        // Find existing tile layers and redraw them
        map.eachLayer((layer) => {
          if (layer._url && layer._url.includes('/tiles/')) {
            layer.redraw();
          }
        });
      }
    } else {
      alert('Failed to upload map.');
    }
  } catch (error) {
    console.error('Map upload error:', error);
    alert('Map upload error.');
  } finally {
    uploadBtn.innerHTML = originalText;
    uploadBtn.disabled = false;
    event.target.value = ''; // Reset input
  }
};
