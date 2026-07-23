const WebSocket = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const net = require('net');
const misb = require('@vidterra/misb.js');
const SYNC_KEY = Buffer.from([0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00]);

let db = null;

function connectTilesDb(filename) {
  if (db) {
    db.close();
    db = null;
  }
  const dir = path.join(__dirname, 'mbtiles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const targetPath = path.join(dir, filename);
  if (fs.existsSync(targetPath)) {
    db = new sqlite3.Database(targetPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) console.error("MBTiles DB Error:", err.message);
      else console.log("Connected to MBTiles database:", targetPath);
    });
  } else {
    console.log("No MBTiles file found at:", targetPath);
  }
}

connectTilesDb('camp_lejeune.mbtiles');

const usersFile = path.join(__dirname, 'users.json');
if (!fs.existsSync(usersFile)) {
  const defaultUsers = [
    { username: 'admin', password: 'password', role: 'admin' },
    { username: 'ares', password: 'ares', role: 'operator' }
  ];
  fs.writeFileSync(usersFile, JSON.stringify(defaultUsers, null, 2));
}
let usersDB = JSON.parse(fs.readFileSync(usersFile));
function saveUsers() { fs.writeFileSync(usersFile, JSON.stringify(usersDB, null, 2)); }

const sessions = {};
function getSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/ares_session_id=([^;]+)/);
  if (match) {
    const sid = match[1];
    const session = sessions[sid];
    if (session && session.expires > Date.now()) return session;
    if (session) delete sessions[sid];
  }
  return null;
}

const activeRecordings = {};

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // ── AUTH & API ENDPOINTS ──
  if (req.url === '/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { user, pass } = JSON.parse(body);
        const validUser = usersDB.find(u => u.username === user && u.password === pass);
        if (validUser) {
          const sid = crypto.randomBytes(32).toString('hex');
          sessions[sid] = { username: validUser.username, role: validUser.role, expires: Date.now() + 86400000 };
          res.setHeader('Set-Cookie', `ares_session_id=${sid}; Path=/; HttpOnly; Max-Age=86400`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, role: validUser.role }));
        } else {
          res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
      } catch (e) { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/auth/logout') {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/ares_session_id=([^;]+)/);
    if (match) {
      delete sessions[match[1]];
    }
    res.setHeader('Set-Cookie', 'ares_session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.url === '/auth/verify') {
    if (getSession(req)) { res.writeHead(200); res.end('OK'); }
    else { res.writeHead(401); res.end('Unauthorized'); }
    return;
  }

  if (req.url === '/auth/verify_admin') {
    const session = getSession(req);
    if (session && session.role === 'admin') { res.writeHead(200); res.end('OK'); }
    else if (session) { res.writeHead(403); res.end('Forbidden'); }
    else { res.writeHead(401); res.end('Unauthorized'); }
    return;
  }

  if (req.url === '/api/me') {
    const session = getSession(req);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ role: session.role, username: session.username }));
    } else {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    return;
  }

  if (req.url === '/api/users') {
    const session = getSession(req);
    if (!session || session.role !== 'admin') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usersDB.map(u => ({ username: u.username, role: u.role }))));
      return;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { username, password, role } = JSON.parse(body);
          if (usersDB.find(u => u.username === username)) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'User exists' })); return;
          }
          usersDB.push({ username, password, role }); saveUsers();
          res.writeHead(200); res.end(JSON.stringify({ success: true }));
        } catch (e) { res.writeHead(400); res.end(); }
      });
      return;
    }
    
    if (req.method === 'DELETE') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { username } = JSON.parse(body);
          if (username === 'admin') { res.writeHead(400); res.end(JSON.stringify({ error: 'Cannot delete admin' })); return; }
          usersDB = usersDB.filter(u => u.username !== username); saveUsers();
          res.writeHead(200); res.end(JSON.stringify({ success: true }));
        } catch (e) { res.writeHead(400); res.end(); }
      });
      return;
    }
  }

  // ── RECORDING API ──
  const recordingsDir = path.join(__dirname, 'recordings');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
  
  if (req.url === '/api/record/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { streamId } = JSON.parse(body);
        if (activeRecordings[streamId]) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Already recording' })); return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${streamId}-${timestamp}.mp4`;
        const filepath = path.join(recordingsDir, filename);
        
        const mtxRtspUrl = process.env.MTX_RTSP_URL || 'rtsp://mediamtx:8554';
        const streamUrl = `${mtxRtspUrl}/${streamId}`;
        
        const ffmpeg = spawn('ffmpeg', [
          '-i', streamUrl,
          '-c', 'copy',
          '-f', 'mp4',
          filepath
        ]);
        
        activeRecordings[streamId] = ffmpeg;
        
        ffmpeg.on('close', () => {
          delete activeRecordings[streamId];
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (req.url === '/api/record/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { streamId } = JSON.parse(body);
        const ffmpeg = activeRecordings[streamId];
        if (ffmpeg) {
          ffmpeg.kill('SIGINT');
          delete activeRecordings[streamId];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Not recording' }));
        }
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (req.url === '/api/recordings' && req.method === 'GET') {
    fs.readdir(recordingsDir, (err, files) => {
      if (err) { res.writeHead(500); res.end(); return; }
      const fileStats = files.filter(f => f.endsWith('.mp4')).map(f => {
        const stats = fs.statSync(path.join(recordingsDir, f));
        return { name: f, size: stats.size, mtime: stats.mtime };
      });
      // Sort by modification time descending
      fileStats.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fileStats));
    });
    return;
  }

  if (req.url.startsWith('/api/recordings/download/')) {
    const filename = path.basename(req.url); // prevent directory traversal
    const filepath = path.join(recordingsDir, filename);
    if (fs.existsSync(filepath)) {
      const stats = fs.statSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      const readStream = fs.createReadStream(filepath);
      readStream.pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  if (req.url.startsWith('/api/upload_map') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const filename = urlObj.searchParams.get('filename') || 'map.mbtiles';
    const safeFilename = path.basename(filename);
    const mbtilesDir = path.join(__dirname, 'mbtiles');
    if (!fs.existsSync(mbtilesDir)) fs.mkdirSync(mbtilesDir, { recursive: true });
    const targetPath = path.join(mbtilesDir, safeFilename);
    const writeStream = fs.createWriteStream(targetPath);
    req.pipe(writeStream);
    
    req.on('end', () => {
      console.log('Map uploaded:', targetPath);
      connectTilesDb(safeFilename);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, file: safeFilename }));
    });
    
    req.on('error', () => {
      res.writeHead(500); res.end('Upload error');
    });
    return;
  }

  // ── MBTILES TILE SERVER ──
  const match = req.url.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (match) {
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    const tmsY = (1 << z) - 1 - y;
    
    if (!db) {
      res.writeHead(404);
      res.end('Map database not loaded');
      return;
    }
    
    db.get('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, tmsY], (err, row) => {
      if (err) {
        res.writeHead(500);
        res.end(err.message);
      } else if (row && row.tile_data) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(row.tile_data);
      } else {
        res.writeHead(404);
        res.end('Tile not found');
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: httpServer });
httpServer.listen(8081, () => {
  console.log('UAS Telemetry Bridge & Tile Server started on port 8081');
});

let ffmpegProcess = null;
let activeExtractPath = null;
let pollInterval = null;
let simInterval = null;
let allowSimulation = true;

let simDensity = 5;
let simPattern = 'orbit';
let simCenter = { lat: 34.665, lon: -77.55 };
let simStep = 0;

// Simulated Flight Dynamics State (Fallback)
let flightState = { lat: 34.665, lon: -77.55, alt: 120.0, hdg: 45.0, pitch: 0.0, roll: 0.0 };

// Simulated CoT State
let cotUnits = [];
function rebuildCotUnits(density) {
  cotUnits = [];
  for (let i = 0; i < density; i++) {
    cotUnits.push({
      uid: `unit-${i}`,
      callsign: `ALPHA-${i + 1}`,
      type: 'a-f-G-U-C', // Ground Friendlies standard
      lat: simCenter.lat + (Math.random() - 0.5) * 0.02,
      lon: simCenter.lon + (Math.random() - 0.5) * 0.02
    });
  }
}
rebuildCotUnits(simDensity);

function generateTelemetryTick(stream_id = 'demo') {
  simStep += 0.05;
  if (simPattern === 'orbit') {
    const radius = 0.005; // orbit radius in degrees approx
    flightState.lat = simCenter.lat + Math.sin(simStep) * radius;
    flightState.lon = simCenter.lon + Math.cos(simStep) * radius;
    flightState.hdg = ((simStep * 180 / Math.PI) + 90) % 360;
    flightState.pitch = 2.0;
    flightState.roll = -15.0;
  } else if (simPattern === 'grid') {
    // Lawnmower pattern
    const rows = 4;
    const rowStep = Math.floor(simStep / 4) % (rows * 2);
    const direction = (rowStep % 2 === 0) ? 1 : -1;
    const progress = (simStep % 4) / 4;
    
    flightState.lat = simCenter.lat - 0.005 + (Math.floor(rowStep / 2) * 0.003);
    flightState.lon = simCenter.lon - 0.008 + (progress * 0.016 * direction);
    flightState.hdg = direction > 0 ? 90 : 270;
    flightState.pitch = 0.0;
    flightState.roll = 0.0;
  } else {
    // Drift
    flightState.lat += (Math.random() - 0.5) * 0.0002;
    flightState.lon += (Math.random() - 0.5) * 0.0002;
    flightState.alt = 120 + Math.random() * 5;
    flightState.hdg = Math.random() * 360;
    flightState.pitch = (Math.random() - 0.5) * 10;
    flightState.roll = (Math.random() - 0.5) * 20;
  }

  return {
    stream_id: stream_id,
    lat: parseFloat(flightState.lat.toFixed(6)),
    lon: parseFloat(flightState.lon.toFixed(6)),
    alt: parseFloat((120 + Math.sin(simStep) * 20).toFixed(1)),
    hdg: parseFloat(flightState.hdg.toFixed(1)),
    pitch: parseFloat(flightState.pitch.toFixed(1)),
    roll: parseFloat(flightState.roll.toFixed(1))
  };
}

function generateCotTick() {
  cotUnits.forEach(u => {
    // Let units drift slightly
    u.lat += (Math.random() - 0.5) * 0.00008;
    u.lon += (Math.random() - 0.5) * 0.00008;
  });
  return cotUnits;
}

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

const dgram = require('dgram');
const klvSocket = dgram.createSocket('udp4');
let klvBuffer = Buffer.alloc(0);

klvSocket.on('message', (msg) => {
  klvBuffer = Buffer.concat([klvBuffer, msg]);

  let index;
  while ((index = klvBuffer.indexOf(SYNC_KEY)) !== -1) {
    let nextIndex = klvBuffer.indexOf(SYNC_KEY, index + 16);
    let packet;
    
    if (nextIndex !== -1) {
      packet = klvBuffer.subarray(index, nextIndex);
      klvBuffer = klvBuffer.subarray(nextIndex);
    } else {
      if (klvBuffer.length - index > 4096) {
         klvBuffer = klvBuffer.subarray(index + 16);
      }
      break;
    }
    
    try {
      const parsed = misb.st0601.parse(packet, { debug: false, value: true });
      let lat, lon, alt, hdg, pitch, roll;
      
      parsed.forEach(p => {
        if (p.key === 13) lat = p.value;
        if (p.key === 14) lon = p.value;
        if (p.key === 15) alt = p.value;
        if (p.key === 5) hdg = p.value;
        if (p.key === 6) pitch = p.value;
        if (p.key === 7) roll = p.value;
      });
      
      if (lat !== undefined && lon !== undefined) {
         broadcast({
           stream_id: 'demo',
           lat: parseFloat(lat.toFixed(6)),
           lon: parseFloat(lon.toFixed(6)),
           alt: alt ? parseFloat(alt.toFixed(1)) : 0,
           hdg: hdg ? parseFloat(hdg.toFixed(1)) : 0,
           pitch: pitch ? parseFloat(pitch.toFixed(1)) : 0,
           roll: roll ? parseFloat(roll.toFixed(1)) : 0
         });
      }
    } catch(e) {}
  }
});

klvSocket.bind(9998, () => {
  console.log('KLV UDP Receiver listening on port 9998');
});

// Periodically broadcast CoT
setInterval(() => {
  if (Math.random() > 0.5) broadcast(generateCotTick());
}, 2000);

function startFfmpegExtraction(pathName) {
  // Now handled by UDP push from MediaMTX's runOnInit hook!
  console.log(`Expecting KLV stream for ${pathName} on UDP 9998...`);
}

// ------------------------------------------------------------------
// TAK Server TCP CoT Ingestion
// ------------------------------------------------------------------
let takClient = null;
let cotBuffer = '';

function connectTAK() {
  if (takClient) {
    takClient.removeAllListeners();
    takClient.destroy();
  }
  takClient = new net.Socket();
  
  const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
  const takPort = parseInt(process.env.TAK_SERVER_PORT, 10) || 8087;

  takClient.on('data', (data) => {
    cotBuffer += data.toString();
    
    let startIndex = cotBuffer.indexOf('<event');
    while (startIndex !== -1) {
      let endIndex = cotBuffer.indexOf('</event>', startIndex);
      if (endIndex !== -1) {
        let eventXml = cotBuffer.substring(startIndex, endIndex + 8);
        cotBuffer = cotBuffer.substring(endIndex + 8);
        
        let uidMatch = eventXml.match(/uid=['"]([^'"]+)['"]/);
        let typeMatch = eventXml.match(/type=['"]([^'"]+)['"]/);
        let latMatch = eventXml.match(/lat=['"]([^'"]+)['"]/);
        let lonMatch = eventXml.match(/lon=['"]([^'"]+)['"]/);
        let callsignMatch = eventXml.match(/callsign=['"]([^'"]+)['"]/);
        
        if (uidMatch && typeMatch && latMatch && lonMatch) {
          let cotObj = {
            uid: uidMatch[1],
            type: typeMatch[1],
            lat: parseFloat(latMatch[1]),
            lon: parseFloat(lonMatch[1]),
            callsign: callsignMatch ? callsignMatch[1] : uidMatch[1]
          };
          
          broadcast([cotObj]);
        }
        
        startIndex = cotBuffer.indexOf('<event');
      } else {
        break;
      }
    }
  });

  takClient.on('close', () => {
    console.log('TAK Server connection closed, reconnecting in 5s...');
    setTimeout(connectTAK, 5000);
  });

  takClient.on('error', (err) => {
    console.error('TAK Server connection error:', err.message);
  });

  takClient.connect(takPort, takHost, () => {
    console.log(`Connected to TAK Server on ${takHost}:${takPort}`);
  });
}
connectTAK();

function stopFfmpegExtraction() {
  if (ffmpegProcess) {
    console.log('Stopping FFmpeg extraction...');
    ffmpegProcess.kill();
    ffmpegProcess = null;
    activeExtractPath = null;
  }
}

function pollMediaMtxForKlv() {
  const apiUrl = process.env.MTX_API_URL || 'http://127.0.0.1:9997';
  http.get(`${apiUrl}/v3/paths/list`, (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(rawData);
        const paths = parsed.items || [];
        
        let klvPath = null;
        for (const p of paths) {
          if (!p.ready) continue;
          const hasKlv = (p.tracks || []).some(t => /klv|meta|data|async|sync/i.test(t));
          if (hasKlv) {
            klvPath = p.name;
            break;
          }
        }

        if (klvPath && klvPath !== activeExtractPath) {
          stopFfmpegExtraction();
          startFfmpegExtraction(klvPath);
        } else if (!klvPath && activeExtractPath) {
          stopFfmpegExtraction();
        }

      } catch (e) {}
    });
  }).on('error', () => {});
}

pollInterval = setInterval(pollMediaMtxForKlv, 2000);

wss.on('connection', (ws) => {
  console.log('HUD Client connected.');
  
  if (!activeExtractPath && !simInterval && allowSimulation) {
    simInterval = setInterval(() => {
      if (!activeExtractPath) {
        broadcast(generateTelemetryTick());
        broadcast(generateCotTick());
      }
    }, 500);
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.cmd === 'toggle_demo') {
        allowSimulation = data.state;
        if (!allowSimulation && simInterval) {
          clearInterval(simInterval);
          simInterval = null;
        } else if (allowSimulation && !activeExtractPath && !simInterval) {
          simInterval = setInterval(() => {
            if (!activeExtractPath) {
              broadcast(generateTelemetryTick());
              broadcast(generateCotTick());
            }
          }, 500);
        }
      } else if (data.cmd === 'set_density') {
        simDensity = data.density;
        rebuildCotUnits(simDensity);
        console.log(`Simulation density updated to ${simDensity}`);
      } else if (data.cmd === 'set_pattern') {
        simPattern = data.pattern;
        console.log(`Simulation flight pattern updated to ${simPattern}`);
      } else if (data.cmd === 'push_target_cot') {
        const uid = data.uid || `target-${Date.now()}`;
        const lat = data.lat;
        const lon = data.lon;
        const callsign = data.callsign || 'HOSTILE-TARGET';
        const status = data.status || 'DETECTED';
        const now = new Date();
        const stale = new Date(now.getTime() + 10 * 60 * 1000);
        
        const cotXml = `<event version="2.0" uid="${uid}" type="a-h-G" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g"><point lat="${lat}" lon="${lon}" hae="0" ce="10" le="10"/><detail><contact callsign="${callsign}"/><remarks>ARES Target Status: ${status}</remarks></detail></event>`;
        
        if (takClient && !takClient.destroyed) {
          takClient.write(cotXml);
          console.log(`[CoT PUSH] Target ${callsign} (${uid}) broadcast to TAK Server.`);
        }
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log('HUD Client disconnected.');
    if (wss.clients.size === 0 && simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }
  });
});
