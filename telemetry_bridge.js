const WebSocket = require('ws');
const { spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let QRCode = null;
try { QRCode = require('qrcode'); }
catch (e) { console.warn('[QR] qrcode module not installed — /api/qr is disabled.'); }
const sqlite3 = require('sqlite3').verbose();
const net = require('net');
const tls = require('tls');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const FormData = require('form-data');
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

const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
const usersFile = path.join(configDir, 'users.json');
if (!fs.existsSync(usersFile)) {
  const defaultUsers = [
    { username: 'admin', password: 'password', role: 'admin' },
    { username: 'ares', password: 'ares', role: 'operator' }
  ];
  fs.writeFileSync(usersFile, JSON.stringify(defaultUsers, null, 2));
}
let usersDB = JSON.parse(fs.readFileSync(usersFile));
function saveUsers() { fs.writeFileSync(usersFile, JSON.stringify(usersDB, null, 2)); }

// Per-user "Save to ARES COP (LOCAL)" cache — keyed by username so it follows a user
// across sessions/devices instead of living only in that browser tab's memory.
const savedObjectsFile = path.join(configDir, 'saved_objects.json');
if (!fs.existsSync(savedObjectsFile)) {
  fs.writeFileSync(savedObjectsFile, JSON.stringify({}, null, 2));
}
let savedObjectsDB = JSON.parse(fs.readFileSync(savedObjectsFile));
function saveSavedObjects() { fs.writeFileSync(savedObjectsFile, JSON.stringify(savedObjectsDB, null, 2)); }

// A per-user package contains that user's client private key, so /user-zips/ cannot be
// a guessable public URL. A download link is an HMAC over (username, expiry, serial).
// Regenerating a user's package bumps their serial, which revokes every link already
// handed out for them — that is the revoke path.
const createZipTokenStore = require('./lib/zip-tokens.js');
const { issueZipToken, revokeZipTokens, verifyZipToken } = createZipTokenStore(configDir);

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

  if (req.url === '/api/cop/saved-objects') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(savedObjectsDB[session.username] || []));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const obj = JSON.parse(body);
          if (!obj || !obj.id || !obj.kind) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing id or kind' })); return; }
          obj.savedAt = new Date().toISOString();
          const list = savedObjectsDB[session.username] = savedObjectsDB[session.username] || [];
          const idx = list.findIndex(o => o.id === obj.id);
          if (idx >= 0) list[idx] = obj; else list.push(obj);
          saveSavedObjects();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    if (req.method === 'DELETE') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const list = savedObjectsDB[session.username] || [];
          savedObjectsDB[session.username] = list.filter(o => o.id !== id);
          saveSavedObjects();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
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

  if (req.url.startsWith('/api/recordings/delete/') && req.method === 'DELETE') {
    const filename = path.basename(req.url.replace('/api/recordings/delete/', ''));
    const filepath = path.join(recordingsDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
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

  // ── TAK DATA SYNC MISSION PACKAGE API (.ZIP & REST) ──
  if (req.url === '/api/datasync/export' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { name, items } = JSON.parse(body || '{}');
        const missionName = name || `ARES_Mission_${Date.now()}`;
        const missionUid = `mission-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex')}`;
        
        const zip = new AdmZip();
        
        // Build manifest.xml adhering to TAK Mission Package Spec v2
        let manifestXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MissionPackageManifest version="2">\n  <Configuration>\n    <Parameter name="name" value="${missionName}"/>\n    <Parameter name="uid" value="${missionUid}"/>\n    <Parameter name="onReceiveDelete" value="false"/>\n  </Configuration>\n  <Contents>\n`;
        
        if (Array.isArray(items)) {
          items.forEach((item, idx) => {
            const itemUid = item.id || item.uid || `item-${idx}-${Date.now()}`;
            const itemCallsign = item.callsign || item.name || itemUid;
            const cotType = item.type || 'b-m-p-s-m';
            const lat = item.lat || 0;
            const lon = item.lon || 0;
            const now = new Date().toISOString();
            const stale = new Date(Date.now() + 86400000).toISOString();
            
            let cotXml = item.xml;
            if (!cotXml) {
              if (cotType.startsWith('u-d-') || item.shapeType) {
                const st = item.shapeType || 'polyline';
                const color = item.color || '#00ff5e';
                const weight = item.weight || 2.5;
                const opacity = item.fillOpacity || 0.35;
                let shapeDetail = `<link uid="${itemUid}" type="${st}" color="${color}" weight="${weight}" fillOpacity="${opacity}"/>`;
                if (item.vertices && Array.isArray(item.vertices)) {
                  item.vertices.forEach(v => { shapeDetail += `<link point="${v.lat},${v.lon}"/>`; });
                }
                cotXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="${itemUid}" type="${cotType}" time="${now}" start="${now}" stale="${stale}" how="h-g-i-g-o"><point lat="${lat}" lon="${lon}" hae="0" ce="10" le="10"/><detail><contact callsign="${itemCallsign}"/>${shapeDetail}<remarks>ARES COP Shape</remarks></detail></event>`;
              } else {
                cotXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="${itemUid}" type="${cotType}" time="${now}" start="${now}" stale="${stale}" how="h-g-i-g-o"><point lat="${lat}" lon="${lon}" hae="0" ce="10" le="10"/><detail><contact callsign="${itemCallsign}"/><remarks>ARES COP Marker</remarks></detail></event>`;
              }
            }
            
            const zipPath = `items/${itemCallsign.replace(/[^a-zA-Z0-9_-]/g, '_')}_${idx}.cot`;
            zip.addFile(zipPath, Buffer.from(cotXml, 'utf8'));
            manifestXml += `    <Content ignore="false" zipEntry="${zipPath}">\n      <Parameter name="uid" value="${itemUid}"/>\n    </Content>\n`;
          });
        }
        
        manifestXml += `  </Contents>\n</MissionPackageManifest>`;
        zip.addFile('manifest.xml', Buffer.from(manifestXml, 'utf8'));
        
        const zipBuffer = zip.toBuffer();
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zipBuffer.length,
          'Content-Disposition': `attachment; filename="${missionName.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip"`
        });
        res.end(zipBuffer);
        console.log(`[DataSync] Generated .zip package for mission: ${missionName} (${zipBuffer.length} bytes)`);
      } catch (e) {
        console.error('[DataSync Export Error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/datasync/import' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();
        
        let manifestEntry = zipEntries.find(e => e.entryName === 'manifest.xml' || e.entryName.endsWith('/manifest.xml'));
        let missionName = 'Imported_TAK_Package';
        if (manifestEntry) {
          const mText = zip.readAsText(manifestEntry);
          const nameMatch = mText.match(/<Parameter[^>]*name=['"]name['"][^>]*value=['"]([^'"]+)['"]/i) || mText.match(/value=['"]([^'"]+)['"][^>]*name=['"]name['"]/i);
          if (nameMatch) missionName = nameMatch[1].trim();
        }
        
        const cotEntries = zipEntries.filter(e => e.entryName.endsWith('.cot') || e.entryName.endsWith('.xml') && !e.entryName.includes('manifest.xml'));
        const importedItems = [];
        
        cotEntries.forEach(entry => {
          const xml = zip.readAsText(entry);
          if (xml && xml.includes('<event')) {
            const uidMatch = xml.match(/uid=['"]([^'"]+)['"]/);
            const typeMatch = xml.match(/type=['"]([^'"]+)['"]/);
            const latMatch = xml.match(/lat=['"]([^'"]+)['"]/);
            const lonMatch = xml.match(/lon=['"]([^'"]+)['"]/);
            const csMatch = xml.match(/callsign=['"]([^'"]+)['"]/);
            
            if (uidMatch && typeMatch && latMatch && lonMatch) {
              const item = {
                uid: uidMatch[1],
                type: typeMatch[1],
                lat: parseFloat(latMatch[1]),
                lon: parseFloat(lonMatch[1]),
                callsign: csMatch ? csMatch[1] : uidMatch[1],
                xml: xml
              };
              importedItems.push(item);
              
              if (takClient && !takClient.destroyed) {
                takClient.write(xml);
              }
            }
          }
        });
        
        if (importedItems.length > 0) {
          broadcast(importedItems);
        }
        
        console.log(`[DataSync] Successfully imported package "${missionName}" with ${importedItems.length} items`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, missionName, count: importedItems.length, items: importedItems }));
      } catch (e) {
        console.error('[DataSync Import Error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse TAK .zip package: ' + e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/datasync/remote/list' && req.method === 'GET') {
    const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
    const useTls = process.env.TAK_USE_TLS === 'true';
    const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
    
    if (!useTls) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ missions: [] }));
      return;
    }
    
    const tlsOptions = {
      hostname: takHost,
      port: restPort,
      path: '/Marti/sync/search',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      rejectUnauthorized: false
    };
    if (process.env.TAK_CLIENT_CERT && fs.existsSync(process.env.TAK_CLIENT_CERT)) tlsOptions.cert = fs.readFileSync(process.env.TAK_CLIENT_CERT);
    if (process.env.TAK_CLIENT_KEY && fs.existsSync(process.env.TAK_CLIENT_KEY)) tlsOptions.key = fs.readFileSync(process.env.TAK_CLIENT_KEY);
    
    const proxyReq = https.request(tlsOptions, (proxyRes) => {
      let data = '';
      proxyRes.on('data', c => { data += c; });
      proxyRes.on('end', () => {
        let missions = [];
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed.results)) missions = parsed.results;
          else if (Array.isArray(parsed.missions)) missions = parsed.missions;
          else if (Array.isArray(parsed)) missions = parsed;
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ missions }));
      });
    });
    proxyReq.on('error', (e) => {
      console.warn('[TAK REST Error]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ missions: [] }));
    });
    proxyReq.end();
    return;
  }

  if (req.url === '/api/tak/clients' && req.method === 'GET') {
    const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
    const useTls = process.env.TAK_USE_TLS === 'true';
    const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
    
    if (!useTls) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    
    const tlsOptions = {
      hostname: takHost,
      port: restPort,
      path: '/Marti/api/contacts/all',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      rejectUnauthorized: false
    };
    if (process.env.TAK_CLIENT_CERT && fs.existsSync(process.env.TAK_CLIENT_CERT)) tlsOptions.cert = fs.readFileSync(process.env.TAK_CLIENT_CERT);
    if (process.env.TAK_CLIENT_KEY && fs.existsSync(process.env.TAK_CLIENT_KEY)) tlsOptions.key = fs.readFileSync(process.env.TAK_CLIENT_KEY);
    
    const proxyReq = https.request(tlsOptions, (proxyRes) => {
      let data = '';
      proxyRes.on('data', c => { data += c; });
      proxyRes.on('end', () => {
        let clients = [];
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed.data)) clients = parsed.data;
          else if (Array.isArray(parsed)) clients = parsed;
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clients));
      });
    });
    proxyReq.on('error', (e) => {
      console.warn('[TAK REST Error]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    });
    proxyReq.end();
    return;
  }

  if (req.url.startsWith('/api/datasync/remote/content') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const hash = urlObj.searchParams.get('hash');
    const hashPath = urlObj.searchParams.get('path') || (hash ? `/Marti/sync/content?hash=${encodeURIComponent(hash)}` : '/Marti/sync/content');
    
    const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
    const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
    
    const tlsOptions = {
      hostname: takHost,
      port: restPort,
      path: hashPath.startsWith('/Marti') ? hashPath : `/Marti/sync/content?${urlObj.searchParams.toString()}`,
      method: 'GET',
      rejectUnauthorized: false
    };
    if (process.env.TAK_CLIENT_CERT && fs.existsSync(process.env.TAK_CLIENT_CERT)) tlsOptions.cert = fs.readFileSync(process.env.TAK_CLIENT_CERT);
    if (process.env.TAK_CLIENT_KEY && fs.existsSync(process.env.TAK_CLIENT_KEY)) tlsOptions.key = fs.readFileSync(process.env.TAK_CLIENT_KEY);
    
    const proxyReq = https.request(tlsOptions, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      console.warn('[TAK Content Proxy Error]', e.message);
      res.writeHead(404);
      res.end('Attachment content not found');
    });
    proxyReq.end();
    return;
  }

  // ── USER ZIP GENERATION & SERVING ──
  const userZipsDir = path.join(__dirname, 'user-zips');
  if (!fs.existsSync(userZipsDir)) fs.mkdirSync(userZipsDir, { recursive: true });

  if (req.url === '/api/user-zips' && req.method === 'GET') {
    const session = getSession(req);
    if (!session || session.role !== 'admin') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    fs.readdir(userZipsDir, (err, files) => {
      if (err) { res.writeHead(500); res.end(); return; }
      const zipFiles = files.filter(f => f.endsWith('.zip')).map(f => {
        const stats = fs.statSync(path.join(userZipsDir, f));
        return { name: f, size: stats.size, mtime: stats.mtime };
      });
      zipFiles.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(zipFiles));
    });
    return;
  }

  if (req.url === '/api/generate-user-zip' && req.method === 'POST') {
    const session = getSession(req);
    if (!session || session.role !== 'admin') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let username, callsign;
      try {
        ({ username, callsign } = JSON.parse(body));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid username' }));
        return;
      }
      const safeCallsign = callsign || username;
      const publicHost = process.env.PUBLIC_HOST || 'ares-werx.com';

      // Certificate + package generation lives in one place — bin/generate-user-zip.sh —
      // so the Admin Hub and fix-certs.sh --reissue-all can't drift out of sync with
      // each other. They used to duplicate this pipeline independently.
      const scriptPath = path.join(__dirname, 'bin', 'generate-user-zip.sh');
      execFile('bash', [scriptPath, username, safeCallsign], {
        env: { ...process.env, PUBLIC_HOST: publicHost },
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024
      }, (err, stdout, stderr) => {
        if (err) {
          console.error('[User ZIP Error]', stderr || err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Package generation failed — see server logs' }));
          return;
        }
        console.log(stdout.trim());

        // Any link handed out for this user's previous package is now void.
        revokeZipTokens(username);
        const zipUrl = `https://${publicHost}/user-zips/${username}.zip?t=${issueZipToken(username)}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, file: `${username}.zip`, url: zipUrl }));
      });
    });
    return;
  }

  if (req.url.startsWith('/api/qr') && req.method === 'GET') {
    const session = getSession(req);
    if (!session || session.role !== 'admin') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    if (!QRCode) { res.writeHead(503); res.end(JSON.stringify({ error: 'qrcode module not installed' })); return; }
    const parsed = new URL(req.url, 'http://localhost');
    const data = parsed.searchParams.get('data');
    if (!data) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing data' })); return; }
    const size = Math.min(parseInt(parsed.searchParams.get('size'), 10) || 160, 512);
    QRCode.toBuffer(data, { type: 'png', width: size, margin: 1 }, (err, buf) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (req.url === '/api/chat_upload' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.filename || !payload.data) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Missing filename or data' }));
          return;
        }
        
        const attachDir = path.join(userZipsDir, 'chat-attachments');
        if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });
        
        const fileId = crypto.randomUUID ? crypto.randomUUID().substring(0,8) : Date.now().toString();
        const safeFilename = payload.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const finalFilename = `${fileId}-${safeFilename}`;
        const filePath = path.join(attachDir, finalFilename);
        
        // Data format: "data:image/png;base64,iVBORw0KGgo..."
        const base64Data = payload.data.replace(/^data:([A-Za-z-+/]+);base64,/, '');
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        
        const host = req.headers.host || 'localhost';
        const protocol = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const publicUrl = `${protocol}://${host}/chat-attachments/${finalFilename}`;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: publicUrl }));
      } catch (e) {
        console.error('[Chat Upload Error]', e);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/chat-attachments/') && req.method === 'GET') {
    const filename = path.basename(req.url);
    const attachDir = path.join(userZipsDir, 'chat-attachments');
    const filepath = path.join(attachDir, filename);
    if (fs.existsSync(filepath)) {
      const ext = path.extname(filename).toLowerCase();
      let mime = 'application/octet-stream';
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.txt') mime = 'text/plain';
      else if (ext === '.pdf') mime = 'application/pdf';
      
      const stats = fs.statSync(filepath);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stats.size });
      const readStream = fs.createReadStream(filepath);
      readStream.pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  if (req.url.startsWith('/user-zips/') && req.method === 'GET') {
    // path.basename(req.url) would keep the query string attached to the filename,
    // so split the URL properly before touching the filesystem.
    const parsed = new URL(req.url, 'http://localhost');
    const filename = path.basename(decodeURIComponent(parsed.pathname));
    if (!filename.endsWith('.zip')) { res.writeHead(404); res.end('Not found'); return; }
    const zipOwner = filename.slice(0, -4);

    // A signed link, or an admin session (so the Hub's own download button works).
    const session = getSession(req);
    const isAdmin = !!(session && session.role === 'admin');
    if (!isAdmin && !verifyZipToken(zipOwner, parsed.searchParams.get('t'))) {
      console.warn(`[User ZIP] Denied ${filename} from ${req.socket.remoteAddress}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired download link' }));
      return;
    }

    const filepath = path.join(userZipsDir, filename);
    if (fs.existsSync(filepath)) {
      const stats = fs.statSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
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
let allowAlphaTargets = false;

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
let lastKlvCotPush = 0; // Throttle KLV→CoT pushes to TAK Server

// ── BER-length decoder for KLV TLV framing ──────────────────────────────────
// Returns { payloadLength, headerBytes } or null if buffer is too short.
// ASN.1 BER: if first byte < 0x80 → length IS that byte (short form).
//            if first byte = 0x81 → next 1 byte is length (1-byte long form).
//            if first byte = 0x82 → next 2 bytes are length (2-byte long form).
function decodeBerLength(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first < 0x80) {
    return { payloadLength: first, headerBytes: 1 };
  } else if (first === 0x81) {
    if (offset + 1 >= buf.length) return null;
    return { payloadLength: buf[offset + 1], headerBytes: 2 };
  } else if (first === 0x82) {
    if (offset + 2 >= buf.length) return null;
    return { payloadLength: (buf[offset + 1] << 8) | buf[offset + 2], headerBytes: 3 };
  }
  // Unsupported BER long form (>2-byte length) — skip this sync key
  return null;
}

klvSocket.on('message', (msg) => {
  klvBuffer = Buffer.concat([klvBuffer, msg]);

  // ── BER-length framing: extract each KLV packet precisely ──────────────────
  // Discard any leading bytes before the first SYNC_KEY.
  let syncPos = klvBuffer.indexOf(SYNC_KEY);
  while (syncPos !== -1) {
    // Drop any garbage before the SYNC_KEY.
    if (syncPos > 0) klvBuffer = klvBuffer.subarray(syncPos);

    const KEY_LEN = 16; // SYNC_KEY is always 16 bytes (MISB UL key)

    // Try to read the BER length that immediately follows the 16-byte key.
    const berResult = decodeBerLength(klvBuffer, KEY_LEN);
    if (!berResult) break; // Not enough data yet — wait for more UDP packets.

    const { payloadLength, headerBytes } = berResult;
    const totalPacketLen = KEY_LEN + headerBytes + payloadLength;

    // Wait until the full packet has arrived in the buffer.
    if (klvBuffer.length < totalPacketLen) break;

    // Extract exactly the right number of bytes — zero trailing garbage.
    const packet = klvBuffer.subarray(0, totalPacketLen);
    klvBuffer = klvBuffer.subarray(totalPacketLen);

    try {
      const parsed = misb.st0601.parse(packet, { debug: false, value: true });
      let lat, lon, alt, hdg, pitch, roll;
      let hFov, sensorRelAz, slantRange; // Tag 16, 18, 21

      parsed.forEach(p => {
        if (p.key === 13) lat = p.value;
        if (p.key === 14) lon = p.value;
        if (p.key === 15) alt = p.value;
        if (p.key === 5)  hdg = p.value;
        if (p.key === 6)  pitch = p.value;
        if (p.key === 7)  roll = p.value;
        if (p.key === 16) hFov = p.value;        // Horizontal FOV (degrees)
        if (p.key === 18) sensorRelAz = p.value; // Sensor Relative Azimuth (degrees)
        if (p.key === 21) slantRange = p.value;  // Slant Range (meters)
      });

      // Compute true sensor azimuth: platform heading + gimbal relative azimuth
      const sensorAz = (hdg != null && sensorRelAz != null)
        ? ((hdg + sensorRelAz) % 360 + 360) % 360
        : (hdg || 0);
      const liveFov   = hFov       ? parseFloat(hFov.toFixed(1))       : 60;
      const liveRange = slantRange ? parseFloat(slantRange.toFixed(0))  : 500;

      if (lat !== undefined && lon !== undefined) {
         const streamId = 'demo'; // TODO: make dynamic per source
         broadcast({
           stream_id: streamId,
           lat: parseFloat(lat.toFixed(6)),
           lon: parseFloat(lon.toFixed(6)),
           alt: alt ? parseFloat(alt.toFixed(1)) : 0,
           hdg: hdg ? parseFloat(hdg.toFixed(1)) : 0,
           pitch: pitch ? parseFloat(pitch.toFixed(1)) : 0,
           roll: roll ? parseFloat(roll.toFixed(1)) : 0,
           sensor_azimuth: parseFloat(sensorAz.toFixed(1)), // real gimbal azimuth
           fov: liveFov,                                     // real horizontal FOV
           range: liveRange                                  // real slant range
         });

         // ── KLV → CoT: Forward drone position to TAK Server (throttled) ──
         const now = Date.now();
         if (takClient && !takClient.destroyed && (now - lastKlvCotPush > 3000)) {
           lastKlvCotPush = now;
           const cotNow = new Date();
           const cotStale = new Date(cotNow.getTime() + 180000); // 180s stale
           const cotUid = `mtx-uas-${streamId}`;
           const cotCallsign = `MTX-${streamId.toUpperCase()}`;
           const cotLat = parseFloat(lat.toFixed(6));
           const cotLon = parseFloat(lon.toFixed(6));
           const cotAlt = alt ? parseFloat(alt.toFixed(1)) : 0;
           const cotHdg = hdg ? parseFloat(hdg.toFixed(1)) : 0;
           const cotSpeed = 0;

           const publicHost = process.env.PUBLIC_HOST || 'ares-werx.com';
           const rtspPort = process.env.PUBLIC_RTSP_PORT || '8554';
           const videoUrl = `rtsp://${publicHost}:${rtspPort}/${streamId}`;
           // Use real sensor azimuth (Tag5+Tag18), live FOV (Tag16), live range (Tag21)
           const cotXml = `<event version="2.0" uid="${cotUid}" type="a-f-A-M-F-Q" time="${cotNow.toISOString()}" start="${cotNow.toISOString()}" stale="${cotStale.toISOString()}" how="h-e"><point lat="${cotLat}" lon="${cotLon}" hae="${cotAlt}" ce="10" le="10"/><detail><uid Droid="${cotCallsign}"/><contact callsign="${cotCallsign}"/><track course="${cotHdg}" speed="${cotSpeed}"/><__video url="${videoUrl}" uid="${cotUid}" urlAlias="${cotCallsign}"><ConnectionEntry networkTimeout="12000" uid="${cotUid}" path="/${streamId}" protocol="rtsp" address="${publicHost}" port="${rtspPort}" roverPort="-1" rtspReliable="0" ignoreEmbeddedKlv="false" alias="${cotCallsign}"/></__video><sensor azimuth="${parseFloat(sensorAz.toFixed(1))}" fov="${liveFov}" range="${liveRange}" vfov="45" model="MediaMTX-KLV"/><remarks>ARES MediaMTX Video Feed (${streamId})</remarks><precisionlocation altsrc="DTED0"/></detail></event>`;

           if (takClient && !takClient.destroyed) {
             takClient.write(cotXml);
             console.log(`[KLV→CoT] ${cotCallsign} lat=${cotLat} lon=${cotLon} alt=${cotAlt} hdg=${cotHdg} sensor_az=${parseFloat(sensorAz.toFixed(1))} fov=${liveFov} range=${liveRange} → TAK Server`);
           }
         }

         // Save to cotCache so video-alias marker pulls drone location (Canada) instead of falling back to Camp Lejeune
         // We do this OUTSIDE the takClient check so it works even if TAK Server disconnects.
         const cotUid = `mtx-uas-${streamId}`;
         const cotCallsign = `MTX-${streamId.toUpperCase()}`;
          cotCache.set(cotUid, {
           uid: cotUid,
           type: 'a-f-A-M-F-Q',
           lat: parseFloat(lat.toFixed(6)),
           lon: parseFloat(lon.toFixed(6)),
           alt: alt ? parseFloat(alt.toFixed(1)) : 0,
           hdg: hdg ? parseFloat(hdg.toFixed(1)) : 0,
           callsign: cotCallsign,
           stale: new Date(Date.now() + 60000).toISOString(),
           sensor: {
             azimuth: parseFloat(sensorAz.toFixed(1)),
             fov: liveFov,
             range: liveRange
           }
         });
      }
    } catch(e) { console.warn('[KLV Parse Error]', e.message); }

    // Re-scan: after consuming a packet, klvBuffer now starts at the next byte.
    // Search for the next SYNC_KEY to continue draining.
    syncPos = klvBuffer.indexOf(SYNC_KEY);
  }
});

klvSocket.bind(9998, () => {
  console.log('KLV UDP Receiver listening on port 9998');
});

// Periodically broadcast CoT
setInterval(() => {
  if (allowAlphaTargets && Math.random() > 0.5) broadcast(generateCotTick());
}, 2000);

function startFfmpegExtraction(pathName) {
  // Now handled by UDP push from MediaMTX's runOnInit hook!
  activeExtractPath = pathName;
  console.log(`Expecting KLV stream for ${pathName} on UDP 9998...`);
}

// ------------------------------------------------------------------
// Mission Package Generator & Uploader
// ------------------------------------------------------------------
async function createAndUploadMissionPackage(cotXml, missionName, attachmentPath, attachmentName) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha256').update(cotXml + Date.now().toString()).digest('hex');
      const zipName = `${missionName.replace(/[^a-zA-Z0-9]/g, '_')}-${hash.substring(0,8)}.zip`;
      
      const archive = archiver('zip', { zlib: { level: 9 } });
      const buffers = [];
      archive.on('data', data => buffers.push(data));
      archive.on('error', err => reject(err));
      archive.on('end', async () => {
        const zipBuffer = Buffer.concat(buffers);
        try {
          const uploadHash = await uploadMissionPackageToTakServer(zipBuffer, zipName);
          resolve({ hash: uploadHash, filename: zipName });
        } catch(e) {
          reject(e);
        }
      });
      
      const manifestXml = `
<MissionPackageManifest version="2">
  <Configuration>
    <Parameter name="uid" value="${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}"/>
    <Parameter name="name" value="${missionName}"/>
    <Parameter name="onReceiveDelete" value="false"/>
  </Configuration>
  <Contents>
    <Content zipEntry="temp.cot" ignore="false"/>
  </Contents>
</MissionPackageManifest>`.trim();

      archive.append(manifestXml, { name: 'MANIFEST/manifest.xml' });
      archive.append(cotXml, { name: 'temp.cot' });
      
      if (attachmentPath && fs.existsSync(attachmentPath)) {
        archive.append(fs.createReadStream(attachmentPath), { name: attachmentName || path.basename(attachmentPath) });
      }
      
      archive.finalize();
    } catch(err) {
      reject(err);
    }
  });
}

async function uploadMissionPackageToTakServer(zipBuffer, filename) {
  return new Promise((resolve, reject) => {
    const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
    const useTls = process.env.TAK_USE_TLS === 'true';
    if (!useTls) return reject(new Error("TAK Server TLS is required for Mission Package Upload"));
    const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
    
    const tlsOptions = {
      hostname: takHost,
      port: restPort,
      path: '/Marti/sync/missionupload',
      method: 'POST',
      rejectUnauthorized: process.env.TAK_REJECT_UNAUTHORIZED === 'true'
    };
    if (process.env.TAK_CLIENT_CERT) tlsOptions.cert = fs.readFileSync(process.env.TAK_CLIENT_CERT);
    if (process.env.TAK_CLIENT_KEY) tlsOptions.key = fs.readFileSync(process.env.TAK_CLIENT_KEY);
    if (process.env.TAK_CA_CERT && fs.existsSync(process.env.TAK_CA_CERT)) tlsOptions.ca = fs.readFileSync(process.env.TAK_CA_CERT);
    if (process.env.TAK_TLS_SERVERNAME) tlsOptions.servername = process.env.TAK_TLS_SERVERNAME;

    const form = new FormData();
    form.append('assetfile', zipBuffer, { filename, contentType: 'application/zip' });
    
    Object.assign(tlsOptions, { headers: form.getHeaders() });
    
    const req = https.request(tlsOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const hashMatch = data.match(/Hash>([^<]+)<\/Hash/i);
            const hash = hashMatch ? hashMatch[1] : null;
            if (hash) resolve(hash);
            else resolve(filename);
          } catch(e) { resolve(filename); }
        } else {
          reject(new Error(`TAK REST API returned ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', err => reject(err));
    form.pipe(req);
  });
}

// ------------------------------------------------------------------
// TAK Server TCP CoT Ingestion
// ------------------------------------------------------------------
let takClient = null;
let cotBuffer = '';
let takServerConnected = false;
let takServerHostAddress = '';
let takServerVersion = 'Unknown';

let copLocation = { lat: 0.0, lon: 0.0, hasRealLocation: false };
let copCallsign = 'ARES COP';

function broadcastTakStatus() {
  broadcast({ type: 'tak_status', connected: takServerConnected, host: takServerHostAddress, version: takServerVersion });
}

function connectTAK() {
  if (takClient) {
    takClient.removeAllListeners();
    takClient.destroy();
  }
  
  const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
  const useTls = process.env.TAK_USE_TLS === 'true';
  const takPort = parseInt(process.env.TAK_SERVER_PORT, 10) || (useTls ? 8089 : 8087);

  let pingInterval = null;

  if (useTls) {
    const tlsOptions = {};
    if (process.env.TAK_CLIENT_CERT) tlsOptions.cert = fs.readFileSync(process.env.TAK_CLIENT_CERT);
    if (process.env.TAK_CLIENT_KEY) tlsOptions.key = fs.readFileSync(process.env.TAK_CLIENT_KEY);
    if (process.env.TAK_CA_CERT && fs.existsSync(process.env.TAK_CA_CERT)) {
      tlsOptions.ca = fs.readFileSync(process.env.TAK_CA_CERT);
    }
    // Default to false for self-signed TAK Server certificates unless explicitly set to true
    tlsOptions.rejectUnauthorized = process.env.TAK_REJECT_UNAUTHORIZED === 'true';
    // Allow overriding the TLS servername for hostname verification.
    // Needed when connecting via Docker hostname (host.docker.internal)
    // but the server cert CN is a different name (e.g. ares-werx.com).
    if (process.env.TAK_TLS_SERVERNAME) {
      tlsOptions.servername = process.env.TAK_TLS_SERVERNAME;
    }
    takClient = tls.connect(takPort, takHost, tlsOptions, () => {
      console.log(`Connected to TAK Server on ${takHost}:${takPort} (TLS)`);
      takServerConnected = true;
      takServerHostAddress = `${takHost}:${takPort}`;
      broadcastTakStatus();
      sendPing();
      pingInterval = setInterval(sendPing, 30000);
    });
  } else {
    takClient = new net.Socket();
    takClient.connect(takPort, takHost, () => {
      console.log(`Connected to TAK Server on ${takHost}:${takPort} (TCP)`);
      takServerConnected = true;
      takServerHostAddress = `${takHost}:${takPort}`;
      broadcastTakStatus();
      sendPing();
      pingInterval = setInterval(sendPing, 30000);
    });
  }

  takClient.on('data', (data) => {
    cotBuffer += data.toString();
    
    let startIndex = cotBuffer.indexOf('<event');
    while (startIndex !== -1) {
      let endIndex = cotBuffer.indexOf('</event>', startIndex);
      if (endIndex !== -1) {
        let eventXml = cotBuffer.substring(startIndex, endIndex + 8);
        cotBuffer = cotBuffer.substring(endIndex + 8);
        
        console.log(`[RAW CoT] ${eventXml}`);
        
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
          
          // ── Extract shape geometry for u-d-* and b-m-r types ──
          let linkVertices = [];
          const linkPointRegex = /point="([^"]+)"/g;
          let lm;
          while ((lm = linkPointRegex.exec(eventXml)) !== null) {
            const parts = lm[1].split(',');
            if (parts.length >= 2) linkVertices.push({ lat: parseFloat(parts[0]), lon: parseFloat(parts[1]), hae: parseFloat(parts[2] || 0) });
          }
          if (linkVertices.length > 0) cotObj.vertices = linkVertices;

          // ── Extract ellipse (circle / rectangle dimensions) ──
          const ellipseMajor = eventXml.match(/major=["']([^"']+)["']/);
          const ellipseMinor = eventXml.match(/minor=["']([^"']+)["']/);
          const ellipseAngle = eventXml.match(/angle=["']([^"']+)["']/);
          if (ellipseMajor || ellipseMinor || ellipseAngle) {
            cotObj.ellipse = {
              major: ellipseMajor ? parseFloat(ellipseMajor[1]) : 0,
              minor: ellipseMinor ? parseFloat(ellipseMinor[1]) : 0,
              angle: ellipseAngle ? parseFloat(ellipseAngle[1]) : 0
            };
          }

          // ── Extract stroke/fill colors (signed 32-bit ARGB) ──
          const strokeColorMatch = eventXml.match(/strokeColor[^>]*value="([^"]+)"/);
          const fillColorMatch   = eventXml.match(/fillColor[^>]*value="([^"]+)"/);
          const strokeWeightMatch = eventXml.match(/strokeWeight[^>]*value="([^"]+)"/);
          if (strokeColorMatch) cotObj.strokeColor  = parseInt(strokeColorMatch[1]);
          if (fillColorMatch)   cotObj.fillColor    = parseInt(fillColorMatch[1]);
          if (strokeWeightMatch) cotObj.strokeWeight = parseFloat(strokeWeightMatch[1]);

          // ── Extract remarks ──
          const remarksRaw = eventXml.match(/<remarks[^>]*>([^<]*)<\/remarks>/);
          if (remarksRaw && remarksRaw[1].trim()) cotObj.remarks = remarksRaw[1].trim();

          const imageMatch = eventXml.match(/<image[^>]*src=["']([^"']+)["']/i) || 
                             eventXml.match(/<image[^>]*url=["']([^"']+)["']/i) || 
                             eventXml.match(/<image[^>]*>([^<]+)<\/image>/i);
          if (imageMatch && imageMatch[1].trim()) {
            let imgUrl = imageMatch[1].trim();
            if (imgUrl.includes('/Marti/sync/content') || imgUrl.includes('/Marti/api/sync/content')) {
              const hashMatch = imgUrl.match(/hash=([^&"']+)/);
              if (hashMatch) imgUrl = `/api/datasync/remote/content?hash=${hashMatch[1]}`;
            }
            cotObj.imageUrl = imgUrl;
          }

          const attachMatch = eventXml.match(/<attachment[^>]*url=["']([^"']+)["']/i) ||
                              eventXml.match(/<fileshare[^>]*senderUrl=["']([^"']+)["']/i) ||
                              eventXml.match(/<fileshare[^>]*url=["']([^"']+)["']/i) ||
                              eventXml.match(/senderUrl=["']([^"']+)["']/i);
          if (attachMatch && attachMatch[1].trim()) {
            let attUrl = attachMatch[1].trim();
            if (attUrl.includes('/Marti/sync/content') || attUrl.includes('/Marti/api/sync/content')) {
              const hashMatch = attUrl.match(/hash=([^&"']+)/);
              if (hashMatch) attUrl = `/api/datasync/remote/content?hash=${hashMatch[1]}`;
            }
            cotObj.attachmentUrl = attUrl;
          }

          const attachNameMatch = eventXml.match(/filename=["']([^"']+)["']/i) ||
                                  eventXml.match(/<attachment[^>]*name=["']([^"']+)["']/i);
          if (attachNameMatch) cotObj.attachmentName = attachNameMatch[1].trim();

          const linkUidMatch = eventXml.match(/<link[^>]*uid=["']([^"']+)["']/i) ||
                               eventXml.match(/parent_uid=["']([^"']+)["']/i) ||
                               eventXml.match(/uid0=["']([^"']+)["']/i);
          if (linkUidMatch) cotObj.parentUid = linkUidMatch[1].trim();

          const usericonMatch = eventXml.match(/iconsetpath=["']([^"']+)["']/i) || eventXml.match(/<usericon[^>]*>([^<]*)<\/usericon>/i);
          if (usericonMatch) cotObj.iconsetPath = usericonMatch[1].trim();

          const staleMatch = eventXml.match(/stale=['"]([^'"]+)['"]/);
          if (staleMatch) cotObj.stale = staleMatch[1];

          // ── Extract sensor geometry (camera/UAS FOV cone data) ──
          const sensorAzMatch    = eventXml.match(/<sensor[^>]*\bazimuth=["']([^"']+)["']/i);
          const sensorFovMatch   = eventXml.match(/<sensor[^>]*\bfov=["']([^"']+)["']/i);
          const sensorRangeMatch = eventXml.match(/<sensor[^>]*\brange=["']([^"']+)["']/i);
          if (sensorAzMatch || sensorFovMatch) {
            cotObj.sensor = {
              azimuth: sensorAzMatch    ? parseFloat(sensorAzMatch[1])    : null,
              fov:     sensorFovMatch   ? parseFloat(sensorFovMatch[1])   : null,
              range:   sensorRangeMatch ? parseFloat(sensorRangeMatch[1]) : null
            };
          }

          // ── Extract track heading ──
          const trackCourseMatch = eventXml.match(/<track[^>]*\bcourse=["']([^"']+)["']/i);
          if (trackCourseMatch) cotObj.heading = parseFloat(trackCourseMatch[1]);

          // ── Extract __video URL for PiP click ──
          const videoUrlMatch = eventXml.match(/<__video[^>]*\burl=["']([^"']+)["']/i);
          if (videoUrlMatch) cotObj.videoUrl = videoUrlMatch[1].trim();
          
          if ((cotObj.type.startsWith('u-d-') || cotObj.type === 'b-m-r') && cotObj.stale && new Date(cotObj.stale).getTime() < Date.now() + 300000) {
            cotObj.stale = new Date(Date.now() + 3600000).toISOString();
          }

          if (cotObj.type.startsWith('t-x-m') || cotObj.type.startsWith('t-x-d')) {
            const missionMatch = eventXml.match(/<mission[^>]*name=['"]([^'"]+)['"]/i) || eventXml.match(/mission=['"]([^'"]+)['"]/i);
            if (missionMatch) cotObj.missionName = missionMatch[1].trim();
            console.log(`[DataSync CoT] Mission event ${cotObj.type}: ${cotObj.missionName || cotObj.callsign}`);
          }

          console.log(`[CoT Received] ${cotObj.callsign} (${cotObj.type}) at ${cotObj.lat}, ${cotObj.lon}`);
          cotCache.set(cotObj.uid, cotObj);
          broadcast([cotObj]);
        }
        
        let remarksMatch = eventXml.match(/<remarks[^>]*>([^<]*)<\/remarks>/);
        let chatSenderMatch = eventXml.match(/senderCallsign=['"]([^'"]+)['"]/);
        let chatroomMatch = eventXml.match(/chatroom=['"]([^'"]+)['"]/);
        let remarkToMatch = eventXml.match(/to=['"]([^'"]+)['"]/);
        let uid0Match = eventXml.match(/uid0=['"]([^'"]+)['"]/);
        let uid1Match = eventXml.match(/uid1=['"]([^'"]+)['"]/);
        if (typeMatch && typeMatch[1] === 'b-t-f' && remarksMatch) {
          broadcast({
            type: 'chat',
            sender: chatSenderMatch ? chatSenderMatch[1] : 'TAK',
            message: remarksMatch[1],
            timestamp: new Date().toISOString(),
            chatroom: chatroomMatch ? chatroomMatch[1] : 'All Chat Rooms',
            to: remarkToMatch ? remarkToMatch[1] : null,
            senderUid: uid0Match ? uid0Match[1] : null,
            destUid: uid1Match ? uid1Match[1] : null
          });
        }
        
        if (typeMatch && typeMatch[1] === 't-x-takp-v') {
          const versionMatch = eventXml.match(/serverVersion=['"]([^'"]+)['"]/);
          if (versionMatch) {
            takServerVersion = versionMatch[1];
            broadcastTakStatus();
          }
        }
        
        startIndex = cotBuffer.indexOf('<event');
      } else {
        break;
      }
    }
  });

  function sendPing() {
    if (!takClient || takClient.destroyed) return;
    const now = new Date();
    const stale = new Date(now.getTime() + 60000);
    const pingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<event version="2.0" uid="ARES-WERX-COP" type="a-f-G-U-C" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o">
  <point lat="${copLocation.lat}" lon="${copLocation.lon}" hae="0.0" ce="${copLocation.hasRealLocation ? 10 : 9999999.0}" le="${copLocation.hasRealLocation ? 10 : 9999999.0}"/>
  <detail>
    <uid Droid="${copCallsign}"/>
    <contact callsign="${copCallsign}" endpoint="*:-1:stcp"/>
    <takv device="Web App" platform="ARES COP" os="Linux" version="1.0"/>
    <__group name="Cyan" role="Team Member"/>
    <status battery="100"/>
  </detail>
</event>`;
    takClient.write(pingXml);
  }

  takClient.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
    takServerConnected = false;
    broadcastTakStatus();
    console.log('TAK Server connection closed, reconnecting in 5s...');
    setTimeout(connectTAK, 5000);
  });

  takClient.on('error', (err) => {
    console.error('TAK Server connection error:', err.message);
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

function stopSimBroadcast() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

function ensureSimBroadcast() {
  if (simInterval || !allowSimulation || wss.clients.size === 0) return;
  simInterval = setInterval(() => {
    if (!activeExtractPath && wss.clients.size > 0) {
      broadcast(generateTelemetryTick());
      if (allowAlphaTargets) broadcast(generateCotTick());
    }
  }, 500);
}

function broadcastVideoAliasCots() {
  const apiUrl = process.env.MTX_API_URL || 'http://mediamtx:9997';
  const publicHost = process.env.PUBLIC_HOST || 'ares-werx.com';
  const rtspPort = process.env.PUBLIC_RTSP_PORT || '8554';
  
  http.get(`${apiUrl}/v3/paths/list`, (res) => {
    let rawData = '';
    res.on('data', chunk => { rawData += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(rawData);
        let paths = parsed.items || [];
        if (!paths.some(p => p.name === 'demo')) {
          paths.push({ name: 'demo', ready: true });
        }
        
        paths.forEach(p => {
          const name = p.name;
          const uid = `video-${name}`;
          const callsign = `MTX-${name.toUpperCase()}`;
          const now = new Date();
          const stale = new Date(now.getTime() + 120000);

          const rtspUrl = `rtsp://${publicHost}:${rtspPort}/${name}`;

          // Position must come from real telemetry only. Never fall back to the
          // simulator's flightState — it orbits a fixed default unrelated to this
          // feed, and that fabricated position used to be cached and replayed to
          // every COP client on connect, plotting live feeds in the wrong place.
          let lat, lon;
          let sensorAz = 0, sensorFov = 60, sensorRange = 500;

          const uasCot = cotCache.get(`mtx-uas-${name}`);
          if (uasCot && uasCot.lat !== undefined) {
            lat = uasCot.lat;
            lon = uasCot.lon;
            if (uasCot.sensor) {
              sensorAz = uasCot.sensor.azimuth ?? 0;
              sensorFov = uasCot.sensor.fov ?? 60;
              sensorRange = uasCot.sensor.range ?? 500;
            }
          } else if (copLocation && copLocation.hasRealLocation) {
            lat = copLocation.lat;
            lon = copLocation.lon;
          }

          // No KLV telemetry and no operator location yet — skip this feed rather
          // than guessing. COP renders drones directly from the live KLV stream,
          // and the KLV→CoT push already registers the feed with TAK every 3s.
          if (lat === undefined || lon === undefined) return;

          const videoCoT = `<event version="2.0" uid="${uid}" type="b-i-v" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g">
<point lat="${lat}" lon="${lon}" hae="50" ce="10" le="10"/>
<detail>
  <uid Droid="${callsign}"/>
  <contact callsign="${callsign}"/>
  <__video url="${rtspUrl}" uid="${uid}" urlAlias="${callsign}">
    <ConnectionEntry networkTimeout="12000" uid="${uid}" path="/${name}" protocol="rtsp" address="${publicHost}" port="${rtspPort}" roverPort="-1" rtspReliable="0" ignoreEmbeddedKlv="false" alias="${callsign}"/>
    <latency_mode>live</latency_mode>
  </__video>
  <sensor azimuth="${sensorAz}" fov="${sensorFov}" range="${sensorRange}" vfov="45" model="MediaMTX-Stream"/>
  <remarks>ARES MediaMTX Video Feed (${name})</remarks>
</detail>
</event>`;

          if (takClient && !takClient.destroyed) {
            takClient.write(videoCoT);
            console.log(`[VideoCoT] Pushed map marker and feed for ${callsign} to TAK Server`);
          }

          // ── Only cache it. Do NOT broadcast to ARES COP WebSockets, ARES COP renders the drone directly from KLV ──
          const cotObj = { uid, type: 'b-i-v', lat, lon, callsign, videoUrl: rtspUrl,
            sensor: { azimuth: 0, fov: 60, range: 500 },
            stale: stale.toISOString() };
          cotCache.set(uid, cotObj);
        });
      } catch(e) { console.error('VideoAlias CoT error:', e); }
    });
  }).on('error', () => {});
}

setInterval(broadcastVideoAliasCots, 30000);
// Also call immediately after a brief delay to let TAK connect first
setTimeout(broadcastVideoAliasCots, 8000);

function hexToArgbInt(hex, opacity = 0.35) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 255;
  const b = parseInt(c.substring(4, 6), 16) || 94;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return ((a << 24) | (r << 16) | (g << 8) | b) >> 0;
}

const cotCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [uid, cot] of cotCache.entries()) {
    if (cot.stale && new Date(cot.stale).getTime() < now) {
      cotCache.delete(uid);
    }
  }
}, 30000);

wss.on('connection', (ws) => {
  console.log('HUD Client connected.');
  
  // Send immediate TAK status
  ws.send(JSON.stringify({ type: 'tak_status', connected: takServerConnected, host: takServerHostAddress, version: takServerVersion }));

  // Send all cached CoTs to the new client immediately
  const cached = Array.from(cotCache.values());
  if (cached.length > 0) {
    ws.send(JSON.stringify(cached));
  }
  
  ensureSimBroadcast();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.cmd === 'toggle_demo') {
        allowSimulation = data.state;
        if (!allowSimulation) {
          stopSimBroadcast();
        } else if (wss.clients.size > 0) {
          ensureSimBroadcast();
        }
      } else if (data.cmd === 'toggle_alpha_targets') {
        allowAlphaTargets = data.state;
        console.log(`[Demo] Alpha targets active: ${allowAlphaTargets}`);
      } else if (data.cmd === 'update_cop_location') {
        copLocation.lat = data.lat || 0;
        copLocation.lon = data.lon || 0;
        copLocation.hasRealLocation = true;
        console.log(`[COP Location] Updated to ${copLocation.lat}, ${copLocation.lon}`);
      } else if (data.cmd === 'set_cop_callsign') {
        copCallsign = data.callsign || 'ARES COP';
        console.log(`[COP Callsign] Updated to ${copCallsign}`);
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
      } else if (data.cmd === 'push_drone_cot') {
        const uid = data.id || `drone-${Date.now()}`;
        const callsign = data.callsign || 'ARES-DRONE';
        const lat = data.lat || 38.9871;
        const lon = data.lon || -76.4739;
        const alt = data.alt || 100;
        const now = new Date();
        const stale = new Date(now.getTime() + 10 * 60 * 1000);
        const streamName = (data.stream_id || callsign.replace(/^MTX-/i, '').toLowerCase());
        const publicHost = process.env.PUBLIC_HOST || 'ares-werx.com';
        const rtspPort = process.env.PUBLIC_RTSP_PORT || '8554';
        const rtspUrl = `rtsp://${publicHost}:${rtspPort}/${streamName}`;
        
        const cotXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="${uid}" type="a-f-A-M-F-Q" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g"><point lat="${lat}" lon="${lon}" hae="${alt}" ce="10" le="10"/><detail><uid Droid="${callsign}"/><contact callsign="${callsign}"/><__video url="${rtspUrl}" uid="${uid}" urlAlias="${callsign}"><ConnectionEntry networkTimeout="12000" uid="${uid}" path="/${streamName}" protocol="rtsp" address="${publicHost}" port="${rtspPort}" roverPort="-1" rtspReliable="0" ignoreEmbeddedKlv="false" alias="${callsign}"/></__video><remarks>ARES MediaMTX Live Drone (${callsign})</remarks></detail></event>`;
        
        const videoAliasXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<event version="2.0" uid="b-i-v-${uid}" type="b-i-v" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g"><point lat="${lat}" lon="${lon}" hae="0" ce="9999999" le="9999999"/><detail><uid Droid="${callsign}"/><contact callsign="${callsign}"/><__video url="${rtspUrl}" uid="b-i-v-${uid}" urlAlias="${callsign}"><ConnectionEntry networkTimeout="12000" uid="b-i-v-${uid}" path="/${streamName}" protocol="rtsp" address="${publicHost}" port="${rtspPort}" roverPort="-1" rtspReliable="0" ignoreEmbeddedKlv="false" alias="${callsign}"/></__video><remarks>ARES MediaMTX Live Drone (${callsign})</remarks></detail></event>`;
        
        if (takClient && !takClient.destroyed) {
          takClient.write(cotXml);
          takClient.write(videoAliasXml);
          console.log(`[Drone Broadcast] ${callsign} (${uid}) sent to TAK Server at ${lat}, ${lon}`);
        }
      } else if (data.cmd === 'push_marker_cot') {
        const uid = data.uid || `marker-${Date.now()}`;
        const lat = data.lat;
        const lon = data.lon;
        const callsign = data.callsign || 'COP-MARKER';
        const cotType = data.type || 'b-m-p-s-m';
        const now = new Date();
        const stale = new Date(now.getTime() + 30 * 60 * 1000);
        
        let detailTags = `<contact callsign="${callsign}"/><remarks>Created from ARES COP</remarks>`;
        if (data.color) {
          const colorVal = hexToArgbInt(data.color, 1.0);
          detailTags += `<color value="${colorVal}"/>`;
        }
        if (data.destCallsign) {
          if (!data.sendAsMissionPackage) {
            detailTags += `<marti><dest callsign="${data.destCallsign}"/></marti>`;
          }
        }
        if (data.attachmentUrl) {
          const name = data.attachmentName || 'Attachment';
          detailTags += `<attachment url="${data.attachmentUrl}" name="${name}"/>`;
        }
        
        const cotXml = `<event version="2.0" uid="${uid}" type="${cotType}" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o"><point lat="${lat}" lon="${lon}" hae="0" ce="10" le="10"/><detail>${detailTags}</detail></event>`;
        
        if (data.destCallsign && data.sendAsMissionPackage) {
          createAndUploadMissionPackage(cotXml, data.callsign || 'COP-MARKER', null, null)
            .then(({ hash, filename }) => {
              const msgId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
              const chatUid = `GeoChat.ARES-WERX-COP.${data.destCallsign}.${msgId}`;
              const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
              const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
              const dpChatXml = `<event version="2.0" uid="${chatUid}" type="b-t-f" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o"><point lat="0" lon="0" hae="0" ce="9999999" le="9999999"/><detail><__chat parent="RootContactGroup" groupOwner="false" messageId="${msgId}" chatroom="${data.destCallsign}" id="${data.destCallsign}" senderCallsign="ARES COP"><chatgrp uid0="ARES-WERX-COP" uid1="${data.destCallsign}" id="${data.destCallsign}"/></__chat><link uid="ARES-WERX-COP" type="a-f-G-U-C" relation="p-p"/><remarks source="BAO.F.ATAK.ARES-WERX-COP" to="${data.destCallsign}" time="${now.toISOString()}">Mission Package from ARES COP</remarks><fileshare name="${filename}" filename="${filename}" senderUrl="https://${takHost}:${restPort}/Marti/api/sync/metadata/${hash}/tool" sizeInBytes="0" sha256="${hash}"/></detail></event>`;
              if (takClient && !takClient.destroyed) {
                takClient.write(dpChatXml);
                console.log(`[Mission Package] Marker sent via GeoChat to ${data.destCallsign}`);
              }
            })
            .catch(err => console.error('[Mission Package Error]', err));
        } else {
          if (takClient && !takClient.destroyed) {
            takClient.write(cotXml);
            console.log(`[CoT PUSH] Marker ${callsign} (${uid}) sent to TAK Server${data.destCallsign ? ' for ' + data.destCallsign : ''}.`);
          }
        }
        broadcast([{ uid, type: cotType, lat, lon, callsign }]);
      } else if (data.cmd === 'push_shape_cot') {
        const uid = data.uid || `shape-${Date.now()}`;
        const lat = data.lat;
        const lon = data.lon;
        const callsign = data.callsign || 'COP-SHAPE';
        const now = new Date();
        const stale = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour stale
        
        let cotType = 'u-d-f'; // Default to freehand/polygon
        let detailTags = '';
        
        if (data.shapeType === 'circle' && data.radius) {
          cotType = 'u-d-c';
          detailTags += `<ellipse major="${data.radius}" minor="${data.radius}" angle="0.0"/>`;
          detailTags += `<link point="${lat},${lon}"/>`; // iTAK requires a link point for circles
        } else if (data.vertices && data.vertices.length > 0) {
          // Polygon, rectangle, or polyline
          const links = data.vertices.map(v => `<link point="${v.lat},${v.lon}"/>`);
          if (data.shapeType === 'polygon' || data.shapeType === 'rectangle') {
            links.push(`<link point="${data.vertices[0].lat},${data.vertices[0].lon}"/>`); // Close the loop
          }
          detailTags += links.join('');
        }
        
        // Add styling
        let strokeColorVal = hexToArgbInt(data.color || '#00ff00', 1.0);
        let fillColorVal = hexToArgbInt(data.color || '#00ff00', data.opacity !== undefined ? data.opacity : 0.35);
        let strokeWeightVal = data.weight || 3.0;
        
        detailTags += `<strokeColor value="${strokeColorVal}"/><fillColor value="${fillColorVal}"/><strokeWeight value="${strokeWeightVal}"/>`;
        
        if (data.destCallsign) {
          if (!data.sendAsMissionPackage) {
            detailTags += `<marti><dest callsign="${data.destCallsign}"/></marti>`;
          }
        }
        if (data.attachmentUrl) {
          const name = data.attachmentName || 'Attachment';
          detailTags += `<attachment url="${data.attachmentUrl}" name="${name}"/>`;
        }
        
        const cotXml = `<event version="2.0" uid="${uid}" type="${cotType}" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o"><point lat="${lat}" lon="${lon}" hae="0" ce="10" le="10"/><detail><contact callsign="${callsign}"/><remarks>Drawn from ARES COP</remarks>${detailTags}</detail></event>`;
        
        if (data.destCallsign && data.sendAsMissionPackage) {
          createAndUploadMissionPackage(cotXml, data.callsign || 'COP-SHAPE', null, null)
            .then(({ hash, filename }) => {
              const msgId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
              const chatUid = `GeoChat.ARES-WERX-COP.${data.destCallsign}.${msgId}`;
              const takHost = process.env.TAK_SERVER_HOST || 'host.docker.internal';
              const restPort = parseInt(process.env.TAK_REST_PORT, 10) || 8443;
              const dpChatXml = `<event version="2.0" uid="${chatUid}" type="b-t-f" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o"><point lat="0" lon="0" hae="0" ce="9999999" le="9999999"/><detail><__chat parent="RootContactGroup" groupOwner="false" messageId="${msgId}" chatroom="${data.destCallsign}" id="${data.destCallsign}" senderCallsign="ARES COP"><chatgrp uid0="ARES-WERX-COP" uid1="${data.destCallsign}" id="${data.destCallsign}"/></__chat><link uid="ARES-WERX-COP" type="a-f-G-U-C" relation="p-p"/><remarks source="BAO.F.ATAK.ARES-WERX-COP" to="${data.destCallsign}" time="${now.toISOString()}">Mission Package from ARES COP</remarks><fileshare name="${filename}" filename="${filename}" senderUrl="https://${takHost}:${restPort}/Marti/api/sync/metadata/${hash}/tool" sizeInBytes="0" sha256="${hash}"/></detail></event>`;
              if (takClient && !takClient.destroyed) {
                takClient.write(dpChatXml);
                console.log(`[Mission Package] Shape sent via GeoChat to ${data.destCallsign}`);
              }
            })
            .catch(err => console.error('[Mission Package Error]', err));
        } else {
          if (takClient && !takClient.destroyed) {
            takClient.write(cotXml);
            console.log(`[CoT PUSH] Shape ${callsign} (${uid}) sent to TAK Server${data.destCallsign ? ' for ' + data.destCallsign : ''}.`);
          }
        }
        // Broadcast back to clients so they know it was sent successfully. Must carry the
        // full geometry/style (not just uid/type/lat/lon/callsign) — processShapeCot on the
        // client only replaces what's already rendered for this uid once it can rebuild a
        // layer from the CoT; a geometry-less echo used to make it delete the existing shape
        // and render nothing, so the shape would vanish the moment anyone re-broadcast it.
        const echoShape = {
          uid, type: cotType, lat, lon, callsign, stale: stale.toISOString(),
          strokeColor: strokeColorVal, fillColor: fillColorVal, strokeWeight: strokeWeightVal
        };
        if (cotType === 'u-d-c') {
          echoShape.ellipse = { major: data.radius, minor: data.radius, angle: 0 };
        } else if (data.vertices && data.vertices.length > 0) {
          echoShape.vertices = data.vertices;
        }
        if (data.attachmentUrl) {
          echoShape.attachmentUrl = data.attachmentUrl;
          echoShape.attachmentName = data.attachmentName || 'Attachment';
        }
        broadcast([echoShape]);
      } else if (data.cmd === 'push_geochat') {
        const sender = data.senderCallsign || 'ARES COP';
        const message = data.message || '';
        const recipientUid = data.recipientUid || 'All Chat Rooms';
        const recipientCallsign = data.recipientCallsign || 'All Chat Rooms';
        const senderUid = 'ARES-WERX-COP';
        const msgId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
        const uid = `GeoChat.${senderUid}.${recipientUid}.${msgId}`;
        const now = new Date();
        const stale = new Date(now.getTime() + 120 * 60 * 1000);
        const cotXml = `<event version="2.0" uid="${uid}" type="b-t-f" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="h-g-i-g-o"><point lat="0" lon="0" hae="0" ce="9999999" le="9999999"/><detail><__chat parent="RootContactGroup" groupOwner="false" messageId="${msgId}" chatroom="${recipientCallsign}" id="${recipientUid}" senderCallsign="${sender}"><chatgrp uid0="${senderUid}" uid1="${recipientUid}" id="${recipientUid}"/></__chat><link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/><remarks source="BAO.F.ATAK.${senderUid}" to="${recipientUid}" time="${now.toISOString()}">${message}</remarks></detail></event>`;
        if (takClient && !takClient.destroyed) {
          takClient.write(cotXml);
          console.log(`[GeoChat PUSH] "${message}" from ${sender} to ${recipientCallsign} sent to TAK.`);
        }
        broadcast({
          type: 'chat',
          sender: sender,
          message: message,
          timestamp: now.toISOString(),
          chatroom: recipientCallsign || 'All Chat Rooms',
          to: recipientUid || null,
          senderUid: 'ARES-WERX-COP',
          destUid: recipientUid || null
        });
      } else if (data.cmd === 'push_cot_raw') {
        if (data.xml && takClient && !takClient.destroyed) {
          takClient.write(data.xml);
          console.log(`[CoT RAW PUSH] Raw CoT forwarded to TAK Server.`);
        }
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log('HUD Client disconnected.');
    if (wss.clients.size === 0) {
      stopSimBroadcast();
    }
  });
});
