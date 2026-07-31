    window.remoteLog = function(msg) {
      fetch('http://localhost:9999/log?msg=' + encodeURIComponent(msg)).catch(()=>window.originalConsoleLog("Log fetch failed"));
    };
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    window.originalConsoleLog = originalConsoleLog;
    console.log = function(...args) { originalConsoleLog(...args); window.remoteLog("[LOG] " + args.join(' ')); };
    console.error = function(...args) { originalConsoleError(...args); window.remoteLog("[ERR] " + args.join(' ')); };
    console.warn = function(...args) { originalConsoleWarn(...args); window.remoteLog("[WARN] " + args.join(' ')); };
    window.onerror = function(msg, src, lineno, colno, err) { window.remoteLog("[UNCAUGHT] " + msg + " at " + lineno + ":" + colno); };
  </script>
  <script>
    /* ══════════════════════════════════════════
       CONFIG & STATE
    ══════════════════════════════════════════ */
    // Auto-detect: use same-origin proxy paths (/api, /hls) when served via nginx
    // (port 8080 locally, or any http/https origin remotely e.g. Cloudflare tunnel).
    // Falls back to direct localhost only when opened from file:// or a local dev server (like port 5500).
    const IS_PROXIED = window.location.port === '' || window.location.port === '80' || window.location.port === '8080' || window.location.port === '443';
    const API = IS_PROXIED ? '/api' : 'http://localhost:9997';
    const HLS_BASE = IS_PROXIED ? '/hls' : 'http://localhost:8888';

    const DEFAULT_STREAMS = [
      {
        label: 'Maryland 24/7', source: 'US 50 E of SEV RIV · maryland.gov',
        url: 'https://strmr5.sha.maryland.gov/rtplive/a3000f3401a1000b005dd336c4235c0a/playlist.m3u8'
      },
      {
        label: 'Tears of Steel', source: 'unified-streaming.com · HLS/ABR',
        url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8'
      },
      {
        label: 'Mux Test Stream', source: 'test-streams.mux.dev · HLS/ABR',
        url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
      },
    ];

    // Wall entries: default + user-added. Each: { label, source, url }
    let wallEntries = [...DEFAULT_STREAMS];
    let wallHls = [];      // HLS.js instances indexed by wall slot
    let mainHls = null;
    let sparkData = Array(60).fill(0);
    let startTime = Date.now();
    let prevPaths = -1;

    /* ══════════════════════════════════════════
       CLOCK
    ══════════════════════════════════════════ */
    function tick() {
      const t = new Date().toTimeString().slice(0, 8);
      document.getElementById('clock').textContent = t;
      document.getElementById('footer-time').textContent = t;
      const vid = document.getElementById('main-video');
      if (vid.style.display !== 'none')
        document.getElementById('hud-tc').textContent = '● ' + t;
    }
    setInterval(tick, 1000);
    tick();

    /* ══════════════════════════════════════════
       TOAST
    ══════════════════════════════════════════ */
    let _toastTimer;
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
    }

    /* ══════════════════════════════════════════
       WARN BAR
    ══════════════════════════════════════════ */
    function showWarn(msg) {
      const b = document.getElementById('warn-bar');
      b.textContent = msg; b.classList.add('show');
    }
    function hideWarn() {
      document.getElementById('warn-bar').classList.remove('show');
    }

    /* ══════════════════════════════════════════
       SPARKLINE
    ══════════════════════════════════════════ */
    function drawSpark(val) {
      sparkData.push(val);
      if (sparkData.length > 60) sparkData.shift();
      const cv = document.getElementById('sparkline');
      if (!cv) return;
      cv.width = cv.offsetWidth || 248;
      cv.height = 40;
      const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
      const max = Math.max(...sparkData, 100);
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = 'rgba(0,200,70,.07)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke();
      }
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,200,70,.35)'); g.addColorStop(1, 'rgba(0,200,70,0)');
      ctx.beginPath(); ctx.moveTo(0, H);
      sparkData.forEach((v, i) => {
        const x = (i / (sparkData.length - 1)) * W, y = H - (v / max) * (H - 4);
        ctx.lineTo(x, y);
      });
      ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.beginPath();
      sparkData.forEach((v, i) => {
        const x = (i / (sparkData.length - 1)) * W, y = H - (v / max) * (H - 4);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#00cc4a'; ctx.lineWidth = 2; ctx.stroke();
    }

    /* ══════════════════════════════════════════
       UPTIME
    ══════════════════════════════════════════ */
    function fmtUp(ms) {
      const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
      if (h) return h + 'h ' + (m % 60) + 'm';
      if (m) return m + 'm ' + (s % 60) + 's';
      return s + 's';
    }

    /* ══════════════════════════════════════════
       HLS.js HELPER
    ══════════════════════════════════════════ */
    function makeHls(videoEl, url, onErr) {
      if (typeof Hls === 'undefined') {
        setTimeout(() => makeHls(videoEl, url, onErr), 800);
        return null;
      }
      if (Hls.isSupported()) {
        const hls = new Hls({ 
          lowLatencyMode: url.includes('/hls/'), 
          enableWorker: true,
          xhrSetup: function(xhr, targetUrl) {
            if (targetUrl && (targetUrl.startsWith('/') || targetUrl.includes(window.location.host))) {
              xhr.withCredentials = true;
            }
          }
        });
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.muted = true;
          const p = videoEl.play();
          if (p && p.catch) {
            p.catch(() => {
              videoEl.muted = true;
              videoEl.play().catch(() => {});
            });
          }
        });
        hls.on(Hls.Events.ERROR, (_, d) => { 
          if (window.remoteLog) window.remoteLog("[HLS ERROR] type: " + d.type + " details: " + d.details + " fatal: " + d.fatal);
          if (d.fatal && onErr) onErr(d); 
        });
        return hls;
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = url;
        videoEl.addEventListener('loadedmetadata', () => {
          if (window.remoteLog) window.remoteLog("[NATIVE HLS] loadedmetadata fired");
          videoEl.play().catch(e => {
            if (window.remoteLog) window.remoteLog("[NATIVE HLS PLAY ERROR] " + e.message);
          });
        }, { once: true });
        videoEl.addEventListener('error', (e) => {
          if (window.remoteLog) window.remoteLog("[NATIVE HLS VID ERROR] " + (e.target.error ? e.target.error.code : "unknown"));
        });
      }
      return null;
    }

    /* ══════════════════════════════════════════
       MAIN PLAYER
    ══════════════════════════════════════════ */
    let currentMainFeed = null;
    function playMain(url, label, source) {
      currentMainFeed = { url, label, source };
      if (mainHls) { mainHls.destroy(); mainHls = null; }
      const vid = document.getElementById('main-video');
      vid.muted = true;
      vid.style.display = 'block';
      document.getElementById('no-signal').style.display = 'none';
      document.getElementById('viewer-cs').textContent = '◉ ' + label;
      const srcEl = document.getElementById('viewer-src');
      if (srcEl) srcEl.textContent = source;
      document.getElementById('hud-top').textContent = label;
      document.getElementById('hud-rec').style.display = 'none'; // Only show when actually recording
      hideWarn();
      resetTelemetryUI(); // Clear old KLV data when switching streams
      window.mapAutoPan = true; // Re-enable map auto-pan for new feed
      
      vid.removeAttribute('src');
      vid.load();
      
      vid.addEventListener('playing', () => { if (window.remoteLog) window.remoteLog("[MAIN VID] playing"); }, {once:true});
      vid.addEventListener('waiting', () => { if (window.remoteLog) window.remoteLog("[MAIN VID] waiting"); }, {once:true});
      vid.addEventListener('stalled', () => { if (window.remoteLog) window.remoteLog("[MAIN VID] stalled"); }, {once:true});
      vid.addEventListener('error', (e) => { if (window.remoteLog) window.remoteLog("[MAIN VID ERROR] " + (e.target.error ? e.target.error.code : "unknown")); }, {once:true});

      mainHls = makeHls(vid, url, d => {
        showWarn('Stream error: ' + d.type + ' — verify the feed is live');
      });
    }

    function refreshMainVideo() {
      if (currentMainFeed) {
        playMain(currentMainFeed.url, currentMainFeed.label, currentMainFeed.source);
        toast('Refreshing main video stream...');
      }
    }

    /* ══════════════════════════════════════════
       API FETCH
    ══════════════════════════════════════════ */
    async function fetchPaths() {
      const r = await fetch(API + '/v3/paths/list');
      const j = await r.json();
      return j.items || [];
    }

    async function refreshAll() {
      try {
        const paths = await fetchPaths();
        document.getElementById('api-dot').className = 'dot';
        document.getElementById('api-status').textContent = 'ONLINE';
        document.getElementById('api-badge').textContent = 'LIVE';
        hideWarn();
        updatePaths(paths);
        document.getElementById('stat-uptime').textContent = fmtUp(Date.now() - startTime);
        document.getElementById('stat-version').textContent = 'v1.19';
      } catch (e) {
        document.getElementById('api-dot').className = 'dot red';
        document.getElementById('api-status').textContent = 'OFFLINE';
        document.getElementById('api-badge').textContent = 'ERR';
        showWarn('Cannot reach MediaMTX API at localhost:9997 — verify Docker is running');
        drawSpark(0);
        document.getElementById('bw-val').textContent = '0 kbps';
      }
    }

    function updatePaths(paths) {
      const body = document.getElementById('paths-body');
      const sel = document.getElementById('mtx-path-sel');
      const count = paths.length;
      document.getElementById('path-count').textContent = count;
      document.getElementById('stat-paths').textContent = count;
      sel.innerHTML = count
        ? '' : '<option value="">— No live paths available —</option>';

      let totalRx = 0;
      if (!count) {
        body.innerHTML = '<tr class="no-paths"><td colspan="4">No active paths</td></tr>';
      } else {
        body.innerHTML = '';
        paths.forEach(p => {
          const rx = (p.readers || []).length;
          totalRx += rx;
          const tracks = (p.tracks || []).map(t => {
            let label = t;
            let cls = 'a';
            if (/h264/i.test(t)) { label = 'H264'; cls = 'v'; }
            else if (/h265|hevc/i.test(t)) { label = 'H265'; cls = 'v'; }
            else if (/mpeg-4 audio|aac/i.test(t)) { label = 'AAC'; cls = 'a'; }
            else if (/opus/i.test(t)) { label = 'OPUS'; cls = 'a'; }
            else if (/klv|meta|data|async|sync/i.test(t)) { label = 'KLV'; cls = 'k'; }
            else if (/video|av1/i.test(t)) { cls = 'v'; }
            return `<span class="pill ${cls}">${label}</span>`;
          }).join('');
          const tr = document.createElement('tr');
          tr.innerHTML =
            `<td title="${p.name}"><span class="path-name">${p.name}</span>
              <div class="path-actions-cell">
                <div class="path-actions-wrap">
                  <button class="btn btn-path" onclick="playMtx('${p.name}')" title="Play in Main Viewer">▶ Play</button>
                  <button class="btn btn-path" onclick="addPathToGrid('${p.name}')" title="Add to Feed Array">+ Feed Array</button>
                </div>
              </div>
            </td>` +
            `<td>${tracks || '—'}</td>` +
            `<td style="font-family:var(--font-mono);font-size:11px;color:var(--green-mid);text-align:center;">${rx}</td>`;
          body.appendChild(tr);
          const opt = document.createElement('option');
          opt.value = p.name; opt.textContent = p.name;
          sel.appendChild(opt);
        });
      }
      document.getElementById('stat-readers').textContent = totalRx;
      const bw = paths.reduce((a, p) => (p.readers || []).length > 0 ? a + 2048 : a, 0);
      drawSpark(bw);
      document.getElementById('bw-val').textContent = Math.round(bw) + ' kbps';
      if (count !== prevPaths) prevPaths = count;
    }

    function playMtx(name) {
      playMain(
        `${HLS_BASE}/${name}/index.m3u8`,
        name.toUpperCase(),
        IS_PROXIED ? 'MediaMTX via nginx proxy' : 'MediaMTX · localhost:8888'
      );
    }

    function addPathToGrid(name) {
      const label = name.toUpperCase();
      const url = `${HLS_BASE}/${name}/index.m3u8`;
      const source = 'MediaMTX · Local Stream';

      if (wallEntries.some(w => w.url === url)) {
        toast(`Path ${label} is already on Feed Array`);
        return;
      }

      wallEntries.push({ label, source, url });
      buildWall();
      loadAllWall();
      toast(`Added ${label} to Feed Array`);
    }

    /* ══════════════════════════════════════════
       VIDEO WALL
    ══════════════════════════════════════════ */
    function buildWall() {
      const grid = document.getElementById('wall-grid');
      grid.innerHTML = '';

      wallEntries.forEach((s, idx) => {
        const cell = document.createElement('div');
        cell.className = 'wall-cell';
        cell.id = 'wc-' + idx;
        cell.onclick = () => selectWall(idx);
        cell.innerHTML =
          `<video class="wall-video" id="wv-${idx}" muted playsinline></video>` +
          `<div class="wall-live-dot" id="wd-${idx}"></div>` +
          `<div class="wall-label">` +
          `<div class="wall-cs">${s.label}</div>` +
          `<div class="wall-src">${s.source}</div>` +
          `</div>` +
          `<button class="wall-remove" onclick="removeWall(event,${idx})">✕</button>`;
        grid.appendChild(cell);
      });

      // "+ Add" tile
      const add = document.createElement('div');
      add.className = 'wall-cell add-cell';
      add.onclick = openAddModal;
      add.innerHTML =
        `<div class="add-icon">＋</div>` +
        `<div class="add-text">Add Stream</div>`;
      grid.appendChild(add);
    }

    function loadWallCell(idx) {
      if (!wallEntries[idx]) return;
      const vid = document.getElementById('wv-' + idx);
      const dot = document.getElementById('wd-' + idx);
      if (!vid) return;
      if (wallHls[idx]) { wallHls[idx].destroy(); wallHls[idx] = null; }
      dot.className = 'wall-live-dot';
      wallHls[idx] = makeHls(vid, wallEntries[idx].url, () => {
        dot.className = 'wall-live-dot err';
      });
    }

    function loadAllWall() {
      wallEntries.forEach((_, i) => loadWallCell(i));
    }

    function selectWall(idx) {
      document.querySelectorAll('.wall-cell').forEach((c, i) => {
        c.classList.toggle('active', i === idx);
      });
      const s = wallEntries[idx];
      if (s) {
        playMain(s.url, s.label, s.source);
        if (window.innerWidth <= 768) {
          toast('Feed selected. Tap LIVE to view.');
        }
      }
    }

    function removeWall(e, idx) {
      e.stopPropagation();
      if (wallHls[idx]) { wallHls[idx].destroy(); wallHls[idx] = null; }
      wallEntries.splice(idx, 1);
      wallHls.splice(idx, 1);
      buildWall();
      loadAllWall();
      toast('Stream removed');
    }

    function addCustomStream() {
      const label = document.getElementById('add-label').value.trim().toUpperCase();
      const source = document.getElementById('add-source').value.trim();
      const url = document.getElementById('add-url').value.trim();
      if (!label) { toast('Enter a call sign'); return; }
      if (!url) { toast('Enter a stream URL'); return; }
      wallEntries.push({ label, source: source || url, url });
      buildWall();
      loadAllWall();
      closeModal('add-modal');
      document.getElementById('add-label').value = '';
      document.getElementById('add-source').value = '';
      document.getElementById('add-url').value = '';
      toast('Stream added: ' + label);
    }

    /* ══════════════════════════════════════════
       MODALS
    ══════════════════════════════════════════ */
    function openSelectModal() { document.getElementById('select-modal').classList.add('open'); }
    function openAddModal() { document.getElementById('add-modal').classList.add('open'); }
    function closeModal(id) { document.getElementById(id).classList.remove('open'); }

    function viewSelectedPath() {
      const v = document.getElementById('mtx-path-sel').value;
      if (!v) { toast('No path selected'); return; }
      playMtx(v);
      closeModal('select-modal');
    }

    /* ══════════════════════════════════════════
       INIT
    ══════════════════════════════════════════ */
    // Load HLS.js
    const _s = document.createElement('script');
    _s.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
    _s.onload = () => { buildWall(); loadAllWall(); };
    _s.onerror = () => showWarn('HLS.js failed to load — check network connection');
    document.head.appendChild(_s);

    /* ══════════════════════════════════════════
       HEADER OVERLAP → COMPACT MODE
       Caches the full-size logo width once, then
       uses pure arithmetic on resize — no class
       toggling during measurement. 40px hysteresis
       prevents thrashing at the boundary.
    ══════════════════════════════════════════ */
    (function initHeaderCompact() {
      const header = document.querySelector('.header');
      const logo = document.querySelector('.hdr-logo');
      const left = document.querySelector('.hdr-left');
      const right = document.querySelector('.hdr-right');
      if (!header || !logo || !left || !right) return;

      const GAP = 16;          // min px clearance on each side
      const HYSTERESIS = 40;   // extra px needed to re-expand (prevents flicker)
      let logoFullWidth = 0;   // cached natural width of logo + text
      let isCompact = false;
      let rafId = 0;

      // Measure the logo's natural width exactly once (before compact is ever applied)
      function cacheLogoWidth() {
        header.classList.remove('hdr-compact');
        // Read synchronously — only happens once
        logoFullWidth = logo.getBoundingClientRect().width;
      }

      function evaluate() {
        const leftW = left.getBoundingClientRect().width;
        const rightW = right.getBoundingClientRect().width;
        const headerW = header.clientWidth;
        const pad = parseFloat(getComputedStyle(header).paddingLeft) +
          parseFloat(getComputedStyle(header).paddingRight);

        // Available space for the centered logo (between left and right elements)
        const available = headerW - pad - leftW - rightW;
        // The logo needs its full width plus clearance on both sides
        const needed = logoFullWidth + (GAP * 2);

        if (!isCompact && available < needed) {
          // Not enough room → go compact
          isCompact = true;
          header.classList.add('hdr-compact');
        } else if (isCompact && available > needed + HYSTERESIS) {
          // Enough room again (with hysteresis buffer) → expand
          isCompact = false;
          header.classList.remove('hdr-compact');
        }
      }

      // Debounced evaluation — collapses rapid ResizeObserver calls into one rAF
      function scheduleCheck() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          evaluate();
        });
      }

      // Boot: cache width after fonts/images, then start observing
      function boot() {
        cacheLogoWidth();
        evaluate();

        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(scheduleCheck).observe(header);
        }
        window.addEventListener('resize', scheduleCheck);
      }

      // Wait for fonts and images so measurement is accurate
      if (document.readyState === 'complete') {
        requestAnimationFrame(boot);
      } else {
        window.addEventListener('load', () => requestAnimationFrame(boot));
      }
    })();

    // Initial API poll + interval
    setTimeout(refreshAll, 500);
    setInterval(refreshAll, 5000);

    // Resize sidebar handler
    const resizer = document.getElementById('resizer');
    const sidebar = document.querySelector('.sidebar');
    let isResizing = false;

    if (resizer && sidebar) {
      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(220, Math.min(650, e.clientX));
        sidebar.style.width = newWidth + 'px';
        drawSpark(0);
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Feed Array Height Resizer (Row Drag)
    const rowResizer = document.getElementById('row-resizer');
    const videoWall = document.querySelector('.video-wall');
    let isRowResizing = false;

    if (rowResizer && videoWall) {
      rowResizer.addEventListener('mousedown', (e) => {
        isRowResizing = true;
        rowResizer.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isRowResizing) return;
        const videoArea = document.querySelector('.video-area');
        const areaRect = videoArea.getBoundingClientRect();
        const newHeight = Math.max(38, Math.min(480, areaRect.bottom - e.clientY));
        videoWall.style.height = newHeight + 'px';
        videoWall.classList.remove('collapsed');
      });

      document.addEventListener('mouseup', () => {
        if (isRowResizing) {
          isRowResizing = false;
          rowResizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    function toggleWall() {
      const wall = document.querySelector('.video-wall');
      const btn = document.getElementById('btn-toggle-wall');
      if (wall.classList.contains('collapsed')) {
        wall.classList.remove('collapsed');
        btn.textContent = '▾ Collapse';
        toast('Feed Array expanded');
      } else {
        wall.classList.add('collapsed');
        btn.textContent = '▴ Expand';
        toast('Feed Array collapsed');
      }
    }

    let videoFitMode = 'contain';
    function toggleVideoFit() {
      const vid = document.getElementById('main-video');
      const btn = document.getElementById('btn-fit-toggle');
      if (videoFitMode === 'contain') {
        videoFitMode = 'cover';
        vid.style.objectFit = 'cover';
        btn.textContent = '🗖 Fit: Cover';
        toast('Camera Fit Mode: Cover (Fill Stage)');
      } else {
        videoFitMode = 'contain';
        vid.style.objectFit = 'contain';
        btn.textContent = '🗖 Fit: Contain';
        toast('Camera Fit Mode: Contain (Full Frame)');
      }
    }

    // Resize
    window.addEventListener('resize', () => drawSpark(0));


    /* ══════════════════════════════════════════
       MOBILE TAB SWITCHING
    ══════════════════════════════════════════ */
    (function initMobileTabs() {
      const tabs = document.querySelectorAll('.mob-tab');
      const sidebar = document.querySelector('.sidebar');
      const videoArea = document.querySelector('.video-area');
      const videoWall = document.querySelector('.video-wall');
      if (!tabs.length || !sidebar || !videoArea || !videoWall) return;

      function switchTab(tabName) {
        // Remove active from all tabs
        tabs.forEach(t => t.classList.remove('active'));
        // Remove mob-active from all panels
        sidebar.classList.remove('mob-active');
        videoArea.classList.remove('mob-active-live', 'mob-active-grid');

        // Activate selected
        const activeTab = document.querySelector(`.mob-tab[data-tab="${tabName}"]`);
        if (activeTab) activeTab.classList.add('active');

        switch (tabName) {
          case 'live':
            videoArea.classList.add('mob-active-live');
            break;
          case 'grid':
            videoArea.classList.add('mob-active-grid');
            break;
          case 'stats':
            sidebar.classList.add('mob-active');
            break;
        }
      }

      tabs.forEach(t => {
        t.addEventListener('click', () => switchTab(t.dataset.tab));
      });

      // Default to live tab
      switchTab('live');
    })();

    /* ══════════════════════════════════════════
       SWIPE TO SWITCH FEEDS
       Touch gesture on main video stage to
       cycle through available MTX paths.
    ══════════════════════════════════════════ */
    (function initSwipeFeeds() {
      const stage = document.getElementById('video-wrapper') || document.querySelector('.main-stage');
      if (!stage) return;

      // Add swipe hint arrows to the stage
      const leftHint = document.createElement('div');
      leftHint.className = 'swipe-hint left';
      leftHint.textContent = '‹';
      stage.appendChild(leftHint);

      const rightHint = document.createElement('div');
      rightHint.className = 'swipe-hint right';
      rightHint.textContent = '›';
      stage.appendChild(rightHint);

      let startX = 0;
      let startY = 0;
      let tracking = false;
      const THRESHOLD = 60; // min px for a swipe

      // Collect current feed list from the paths table + wall entries
      function getFeedList() {
        const feeds = [];
        // MTX paths from the table
        document.querySelectorAll('#paths-body .path-name').forEach(el => {
          feeds.push({ type: 'mtx', name: el.textContent.trim() });
        });
        // Wall entries (HLS URLs)
        wallEntries.forEach(e => {
          feeds.push({ type: 'hls', name: e.label, url: e.url, source: e.source });
        });
        return feeds;
      }

      // Find current feed index
      function getCurrentIndex(feeds) {
        const cs = document.getElementById('viewer-cs');
        if (!cs) return -1;
        const current = cs.textContent.replace(/^◉\s*/, '').trim();
        return feeds.findIndex(f => f.name === current);
      }

      function switchToFeed(feed) {
        if (feed.type === 'mtx') {
          playMtx(feed.name);
        } else {
          playMain(feed.url, feed.name, feed.source || '');
        }
      }

      stage.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
      }, { passive: true });

      stage.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = Math.abs(e.touches[0].clientY - startY);
        // Show directional hint if horizontal drag
        if (Math.abs(dx) > 20 && dy < Math.abs(dx)) {
          if (dx < 0) {
            rightHint.classList.add('show');
            leftHint.classList.remove('show');
          } else {
            leftHint.classList.add('show');
            rightHint.classList.remove('show');
          }
        }
      }, { passive: true });

      stage.addEventListener('touchend', (e) => {
        leftHint.classList.remove('show');
        rightHint.classList.remove('show');
        if (!tracking) return;
        tracking = false;

        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const dx = endX - startX;
        const dy = Math.abs(endY - startY);

        // Must be mostly horizontal and exceed threshold
        if (Math.abs(dx) < THRESHOLD || dy > Math.abs(dx)) return;

        const feeds = getFeedList();
        if (feeds.length === 0) return;

        let idx = getCurrentIndex(feeds);
        if (dx < 0) {
          // Swipe left → next feed
          idx = (idx + 1) % feeds.length;
        } else {
          // Swipe right → previous feed
          idx = idx <= 0 ? feeds.length - 1 : idx - 1;
        }

        switchToFeed(feeds[idx]);
        toast(`Feed: ${feeds[idx].name}`);
      }, { passive: true });
    })();

    /* ══════════════════════════════════════════
       LANDSCAPE HAMBURGER OVERLAY
    ══════════════════════════════════════════ */
    (function initLandscapeOverlay() {
      const hamburger = document.getElementById('mob-hamburger');
      const overlay = document.getElementById('mob-landscape-overlay');
      const closeBtn = document.getElementById('mob-ov-close');
      if (!hamburger || !overlay) return;

      function toggleOverlay() {
        overlay.classList.toggle('open');
      }

      hamburger.addEventListener('click', toggleOverlay);
      if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.remove('open'));

      // Close on outside tap
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
      });

      // Populate feeds in overlay whenever paths refresh
      const origRefreshAll = window.refreshAll;
      if (typeof origRefreshAll === 'function') {
        // We'll update the overlay feed list after each API poll
        const feedsContainer = document.getElementById('mob-ov-feeds');
        function updateOverlayFeeds() {
          if (!feedsContainer) return;
          feedsContainer.innerHTML = '';

          // MTX paths
          document.querySelectorAll('#paths-body .path-name').forEach(el => {
            const name = el.textContent.trim();
            const btn = document.createElement('button');
            btn.className = 'mob-ov-feed-btn';
            btn.textContent = '▶ ' + name;
            btn.addEventListener('click', () => {
              playMtx(name);
              overlay.classList.remove('open');
              toast('Feed: ' + name);
            });
            feedsContainer.appendChild(btn);
          });

          // Wall entries
          wallEntries.forEach(e => {
            const btn = document.createElement('button');
            btn.className = 'mob-ov-feed-btn';
            btn.textContent = '▶ ' + e.label;
            btn.addEventListener('click', () => {
              playMain(e.url, e.label, e.source || '');
              overlay.classList.remove('open');
              toast('Feed: ' + e.label);
            });
            feedsContainer.appendChild(btn);
          });
        }

        // Hook into the refresh cycle
        const observer = new MutationObserver(updateOverlayFeeds);
        const pathsBody = document.getElementById('paths-body');
        if (pathsBody) observer.observe(pathsBody, { childList: true });

        // Initial population
        updateOverlayFeeds();
      }
    })();

    /* ══════════════════════════════════════════
       TELEMETRY HUD LOGIC
    ══════════════════════════════════════════ */
    let hudActive = false;

    let copMapActive = false;
    let copMap = null;
    let copMarker = null;

    function recenterMap() {
      window.mapAutoPan = true;
      if (copMap && copMarker) {
        copMap.panTo(copMarker.getLatLng(), { animate: true, duration: 0.5 });
      }
    }

    function toggleCopMap() {
      copMapActive = !copMapActive;
      const btn = document.getElementById('btn-cop-toggle');
      const stage = document.querySelector('.main-stage');
      const mapDiv = document.getElementById('map-container');

      if (copMapActive) {
        btn.innerHTML = '🗺️ MAP: ON';
        btn.classList.add('btn-g');
        btn.classList.remove('btn-w');
        stage.classList.add('split-view');
        
        // Helper for ARES-COP Tactical Marker
        function createAresCopMarker(latlng, callsign) {
          const label = (callsign || 'UAS FEED').toUpperCase();
          const icon = L.divIcon({
            className: 'ares-map-marker-wrap',
            html: `<div style="position:relative; display:flex; flex-direction:column; align-items:center;">
                     <div style="background:#00ff5e; color:#000; font-family:monospace; font-size:10px; font-weight:bold; padding:2px 6px; border-radius:3px; border:1px solid #000; white-space:nowrap; box-shadow:0 0 8px rgba(0,255,94,0.8); margin-bottom:3px; text-shadow:none;">
                       ✈ ${label}
                     </div>
                     <div style="width:14px; height:14px; background:#00ff5e; border:2px solid #001a00; border-radius:50%; box-shadow:0 0 10px #00ff5e;"></div>
                   </div>`,
            iconSize: [120, 36],
            iconAnchor: [60, 36],
            popupAnchor: [0, -38]
          });
          return L.marker(latlng, { icon });
        }

        // Initialize map if not already done
        if (!copMap) {
          copMap = L.map('map-container', { zoomControl: true }).setView([39.8283, -98.5795], 4);
          
          copMap.on('dragstart', () => { window.mapAutoPan = false; });
          copMap.on('zoomstart', () => { window.mapAutoPan = false; });

          const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CartoDB', subdomains: 'abcd', maxZoom: 20
          });
          const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri World Imagery', maxZoom: 19
          });
          const esriLabels = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19, opacity: 0.85
          });
          const esriHybrid = L.layerGroup([esriSat, esriLabels]).addTo(copMap);

          const baseMaps = {
            'Satellite + Labels': esriHybrid,
            'Satellite (Pure)': esriSat,
            'Carto Dark': cartoDark
          };
          L.control.layers(baseMaps, null, { position: 'bottomleft' }).addTo(copMap);

          const initialCallsign = (currentMainFeed && currentMainFeed.label) ? currentMainFeed.label : 'DEMO';
          const initialPopup = `
            <div style="line-height: 1.5; letter-spacing: 0.5px;">
              <strong style="color:#fff;">FEED:</strong> ${initialCallsign}<br>
              <strong style="color:#fff;">STATUS:</strong> <span style="color:#ffcc00; font-weight:bold;">AWAITING TELEMETRY...</span>
            </div>
          `;
          copMarker = createAresCopMarker([38.9871, -76.4739], initialCallsign).addTo(copMap).bindPopup(initialPopup);
        }
        
        // Trigger a resize so Leaflet knows its new container size
        setTimeout(() => { copMap.invalidateSize(); }, 100);
      } else {
        btn.innerHTML = '🗺️ MAP';
        btn.classList.remove('btn-g');
        btn.classList.add('btn-w');
        stage.classList.remove('split-view');
      }
    }
    function toggleHud() {
      hudActive = !hudActive;
      const btn = document.getElementById('btn-hud-toggle');
      const overlay = document.getElementById('hud-overlay');

      if (hudActive) {
        btn.innerHTML = '⌖ HUD: ON';
        btn.classList.add('btn-g');
        btn.classList.remove('btn-w');
        overlay.classList.add('active');
      } else {
        btn.innerHTML = '⌖ HUD: OFF';
        btn.classList.remove('btn-g');
        btn.classList.add('btn-w');
        overlay.classList.remove('active');
      }
    }

    let wsTelemetry = null;
    let wsReconnectTimer = null;

    function startTelemetryWs() {
      if (wsTelemetry) return;
      console.log('Connecting to UAS Telemetry Bridge...');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/telemetry`;
      
      try {
        wsTelemetry = new WebSocket(wsUrl);
      } catch(e) {
        console.warn('Failed to open WS on reverse proxy path, trying direct port 8081...');
        wsTelemetry = new WebSocket(`ws://${window.location.hostname}:8081`);
      }
      
      wsTelemetry.onopen = () => {
        console.log('Connected to Telemetry Bridge.');
        const badge = document.getElementById('telemetry-badge');
        if (badge) { badge.textContent = 'RX'; badge.style.color = '#00ff5e'; }
      };
      
      wsTelemetry.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Ignore non-telemetry events (CoT arrays, tak_status, chat messages, etc.)
          if (Array.isArray(data) || !data || typeof data !== 'object') return;
          if (data.type === 'tak_status' || data.type === 'chat') return;
          if (data.lat === undefined || data.lon === undefined) return;
          
          // Show telemetry if stream matches or if default simulation active
          let isActiveStream = false;
          if (currentMainFeed && currentMainFeed.label) {
            const currentName = currentMainFeed.label.toLowerCase().trim();
            const dataStreamId = (data.stream_id || '').toLowerCase().trim();
            if (dataStreamId === currentName || (dataStreamId === 'demo' && currentName === 'demo')) {
              isActiveStream = true;
            }
          } else {
            isActiveStream = (data.stream_id === 'demo');
          }
          
          const sbTel = document.getElementById('sidebar-telemetry');
          if (sbTel) sbTel.style.display = isActiveStream ? '' : 'none';
          
          if (!isActiveStream) return;

          const formatDegree = val => (val !== undefined && val !== null) ? val + '°' : '--°';
          const formatMeters = val => (val !== undefined && val !== null) ? val + ' m' : '-- m';
          const formatVal = val => (val !== undefined && val !== null) ? val : '--';

          // Update HUD
          document.getElementById('hud-lat').textContent = formatVal(data.lat);
          document.getElementById('hud-lon').textContent = formatVal(data.lon);
          document.getElementById('hud-alt').textContent = formatMeters(data.alt);
          document.getElementById('hud-hdg').textContent = formatDegree(data.hdg);
          document.getElementById('hud-pitch').textContent = formatDegree(data.pitch);
          document.getElementById('hud-roll').textContent = formatDegree(data.roll);

          // Update Sidebar
          document.getElementById('sb-lat').textContent = formatVal(data.lat);
          document.getElementById('sb-lon').textContent = formatVal(data.lon);
          document.getElementById('sb-alt').textContent = formatVal(data.alt);
          document.getElementById('sb-hdg').textContent = formatDegree(data.hdg);
          const sbPitch = document.getElementById('sb-pitch');
          if (sbPitch) sbPitch.textContent = formatDegree(data.pitch);
          const sbRoll = document.getElementById('sb-roll');
          if (sbRoll) sbRoll.textContent = formatDegree(data.roll);

          // Update Map
          if (copMapActive && copMap && copMarker) {
            const latlng = [parseFloat(data.lat), parseFloat(data.lon)];
            copMarker.setLatLng(latlng);
            
            const csEl = document.getElementById('viewer-cs');
            const cs = csEl ? csEl.textContent.replace(/^◉\s*/, '') : 'UAS FEED';
            const srcEl = document.getElementById('viewer-src');
            const src = (srcEl && srcEl.textContent) ? srcEl.textContent : 'MediaMTX';
            const popupHtml = `
              <div style="line-height: 1.5; letter-spacing: 0.5px;">
                <strong style="color:#fff;">SRC:</strong> ${src}<br>
                <strong style="color:#fff;">ID:</strong> ${cs}<br>
                <strong style="color:#fff;">LAT:</strong> ${data.lat}<br>
                <strong style="color:#fff;">LON:</strong> ${data.lon}<br>
                <strong style="color:#fff;">ALT:</strong> ${data.alt} m
              </div>
            `;
            copMarker.setPopupContent(popupHtml);

            if (window.mapAutoPan !== false) {
              copMap.panTo(latlng, { animate: true, duration: 0.5 });
            }
          }
        } catch(e) {
          console.error("Failed to parse telemetry frame", e);
        }
      };

      wsTelemetry.onclose = () => {
        console.log('Disconnected from Telemetry Bridge.');
        wsTelemetry = null;
        const badge = document.getElementById('telemetry-badge');
        if (badge) { badge.textContent = 'RETRY'; badge.style.color = '#ffaa00'; }
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(() => {
          startTelemetryWs();
        }, 1500);
      };
      
      wsTelemetry.onerror = (err) => {
        console.error('WebSocket Error on Telemetry Bridge', err);
      };
    }

    function stopTelemetryWs() {
      clearTimeout(wsReconnectTimer);
      if (wsTelemetry) {
        wsTelemetry.close();
        wsTelemetry = null;
      }
      resetTelemetryUI();
    }

    function resetTelemetryUI() {
      // Reset values
      const els = ['hud-lat', 'hud-lon', 'hud-alt', 'hud-hdg', 'hud-pitch', 'hud-roll', 'sb-lat', 'sb-lon', 'sb-alt', 'sb-hdg', 'sb-pitch', 'sb-roll'];
      els.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          if (id === 'sb-alt') el.textContent = '--';
          else if (id === 'hud-alt') el.textContent = '-- m';
          else if (id.includes('lat') || id.includes('lon')) el.textContent = '--.----';
          else el.textContent = '--°';
        }
      });
    }

    // Connect telemetry globally on page load
    setTimeout(startTelemetryWs, 1000);
  </script>
  <script>
    let isRecording = false;
    let recTimerInterval = null;
    let recSeconds = 0;

    async function toggleRecord() {
      if (!currentMainFeed || !currentMainFeed.url) {
        toast('Select a video stream first to record.');
        return;
      }
      const match = currentMainFeed.url.match(/\/hls\/([^\/]+)/);
      if (!match) {
        toast('Only MediaMTX streams can be recorded.');
        return;
      }
      const streamId = match[1];
      const btn = document.getElementById('record-main-btn');
      const recOverlay = document.getElementById('hud-rec');
      const timerEl = document.getElementById('rec-timer');

      if (!isRecording) {
        try {
          const res = await fetch('/api/record/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamId: streamId })
          });
          if (res.ok) {
            isRecording = true;
            btn.style.background = 'rgba(204, 17, 17, 0.4)';
            btn.style.borderColor = 'var(--red-alert)';
            recOverlay.style.display = 'flex';
            
            recSeconds = 0;
            if (timerEl) timerEl.textContent = '00:00';
            clearInterval(recTimerInterval);
            recTimerInterval = setInterval(() => {
              recSeconds++;
              const mins = String(Math.floor(recSeconds / 60)).padStart(2, '0');
              const secs = String(recSeconds % 60).padStart(2, '0');
              if (timerEl) timerEl.textContent = `${mins}:${secs}`;
            }, 1000);

            toast('🔴 RECORDING STARTED: ' + streamId);
          } else {
            const err = await res.json();
            toast('Failed to start recording: ' + (err.error || res.statusText));
          }
        } catch (e) {
          console.error(e);
          toast('Error starting recording.');
        }
      } else {
        try {
          const res = await fetch('/api/record/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streamId: streamId })
          });
          if (res.ok) {
            isRecording = false;
            btn.style.background = '#000';
            btn.style.borderColor = 'var(--green-dark)';
            recOverlay.style.display = 'none';
            clearInterval(recTimerInterval);
            toast('⏹ RECORDING SAVED: ' + streamId);
            if (document.getElementById('recordings-modal').style.display === 'flex') {
              openRecordingsModal();
            }
          } else {
            toast('Failed to stop recording.');
          }
        } catch (e) {
          console.error(e);
        }
      }
    }

    async function deleteRecording(name) {
      if (!confirm('Delete recording ' + name + '?')) return;
      const res = await fetch('/api/recordings/delete/' + encodeURIComponent(name), { method: 'DELETE' });
      if (res.ok) { openRecordingsModal(); }
      else { alert('Failed to delete.'); }
    }

    async function openRecordingsModal() {
      document.getElementById('recordings-modal').style.display = 'flex';
      const tbody = document.getElementById('recordings-list');
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">Loading recordings...</td></tr>';
      
      try {
        const res = await fetch('/api/recordings');
        const files = await res.json();
        tbody.innerHTML = '';
        if (files.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">No recordings found.</td></tr>';
          return;
        }
        files.forEach(f => {
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid rgba(0, 200, 70, 0.2)';
          
          const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
          const dateStr = new Date(f.mtime).toLocaleString();
          
          tr.innerHTML = `
            <td style="padding: 10px; color: #fff;">${f.name}</td>
            <td style="padding: 10px; color: var(--green-dim);">${sizeMB} MB</td>
            <td style="padding: 10px; color: var(--green-dim);">${dateStr}</td>
            <td style="padding: 10px; text-align: right;">
              <a href="/api/recordings/download/${encodeURIComponent(f.name)}" download class="btn btn-w" style="text-decoration: none; font-size: 11px; padding: 4px 8px; margin-right: 4px;">DOWNLOAD</a>
              <button onclick="deleteRecording('${f.name}')" class="btn btn-w" style="text-decoration: none; font-size: 11px; padding: 4px 8px; color: #ff4444; border-color: #ff4444;">DEL</button>
            </td>
          `;
          tbody.appendChild(tr);
        });
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--red-alert);">Failed to load recordings.</td></tr>';
      }
    }

    function closeRecordingsModal() {
      document.getElementById('recordings-modal').style.display = 'none';
    }
