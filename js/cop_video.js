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
  const iframeElement = document.getElementById('pip-iframe-player');
  
  container.classList.remove('hidden');
  titleEl.textContent = title;

  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  let host = window.location.hostname;
  if (host === '') { // Local dev fallback
    host = 'localhost';
  }
  const mtxPort = '8888'; 
  const webrtcPort = '8889';
  const IS_PROXIED = window.location.port === '' || window.location.port === '80' || window.location.port === '8080' || window.location.port === '443';
  
  // Prefer WebRTC via MediaMTX's native HTML player for zero latency
  let webrtcUrl;
  if (IS_PROXIED) {
    // Requires NGINX to proxy /webrtc/ to 8889 (or serve the WebRTC index on the same path if configured in mediamtx.yml)
    // We'll point directly to the stream path which MediaMTX handles if webRTC is true.
    webrtcUrl = `/webrtc/${path}/`; 
  } else {
    webrtcUrl = `${proto}//${host}:${webrtcPort}/${path}/`;
  }

  // Hide HLS video player, show WebRTC iframe
  pipVideoElement.classList.add('hidden');
  pipVideoElement.removeAttribute('src');
  pipVideoElement.load();
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  iframeElement.classList.remove('hidden');
  iframeElement.src = webrtcUrl;
}

function closePip() {
  window.activePipStream = null;
  const container = document.getElementById('pip-container');
  const iframeElement = document.getElementById('pip-iframe-player');
  
  container.classList.add('hidden');
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  pipVideoElement.pause();
  pipVideoElement.removeAttribute('src');
  pipVideoElement.load();
  
  iframeElement.src = ''; // stop WebRTC stream
  iframeElement.classList.add('hidden');
}
