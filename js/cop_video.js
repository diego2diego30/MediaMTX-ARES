let pipVideoElement;
let hlsInstance = null;

function initPipDraggable() {
  const container = document.getElementById('pip-container');
  const header = document.getElementById('pip-drag-handle');
  pipVideoElement = document.getElementById('pip-video-player');

  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  header.addEventListener("mousedown", dragStart);
  document.addEventListener("mouseup", dragEnd);
  document.addEventListener("mousemove", drag);

  function dragStart(e) {
    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;
    if (e.target === header || e.target.parentNode === header) {
      isDragging = true;
    }
  }

  function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;
    isDragging = false;
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      setTranslate(currentX, currentY, container);
    }
  }

  function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  }
}

window.activePipStream = null;

function openPip(title, path) {
  window.activePipStream = path;
  const container = document.getElementById('pip-container');
  const titleEl = document.getElementById('pip-title');
  container.classList.remove('hidden');
  titleEl.textContent = title;

  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  let host = window.location.hostname;
  if (host === '') { // Local dev fallback
    host = 'localhost';
  }
  const mtxPort = '8888'; 
  const IS_PROXIED = window.location.port === '' || window.location.port === '80' || window.location.port === '8080' || window.location.port === '443';
  let streamUrl;
  
  if (IS_PROXIED) {
    // When served via NGINX or Cloudflare, route through the /hls/ proxy to avoid CORS/port issues
    streamUrl = `/hls/${path}/index.m3u8`;
  } else {
    streamUrl = `${proto}//${host}:${mtxPort}/${path}/index.m3u8`;
  }

  if (Hls.isSupported()) {
    if (hlsInstance) hlsInstance.destroy();
    pipVideoElement.removeAttribute('src');
    pipVideoElement.load();
    hlsInstance = new Hls({
      xhrSetup: function(xhr, targetUrl) {
        if (targetUrl && (targetUrl.startsWith('/') || targetUrl.includes(window.location.host))) {
          xhr.withCredentials = true;
        }
      }
    });
    hlsInstance.loadSource(streamUrl);
    hlsInstance.attachMedia(pipVideoElement);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      pipVideoElement.muted = true;
      pipVideoElement.play().catch(() => {});
    });
  } else if (pipVideoElement.canPlayType('application/vnd.apple.mpegurl')) {
    pipVideoElement.src = streamUrl;
    pipVideoElement.addEventListener('loadedmetadata', function() {
      pipVideoElement.play();
    });
  }
}

function closePip() {
  window.activePipStream = null;
  const container = document.getElementById('pip-container');
  container.classList.add('hidden');
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  pipVideoElement.pause();
  pipVideoElement.removeAttribute('src');
  pipVideoElement.load();
}
