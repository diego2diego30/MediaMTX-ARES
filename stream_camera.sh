#!/bin/bash
# =============================================
# ARES TRANSMISSION SYSTEM — UAS Camera Feed
# Streams Mac Camera to MediaMTX via RTMP
# =============================================

STREAM_NAME="${1:-macbook_cam}"
VIDEO_DEV="${2:-0}"   # 0 = MacBook Pro Camera
RTMP_USER="${RTMP_USER:-ares_pilot}"
RTMP_PASS="${RTMP_PASS:-ares_secure}"
RTMP_URL="rtmp://${RTMP_USER}:${RTMP_PASS}@localhost:1935/${STREAM_NAME}"

echo ""
echo "   █████╗ ██████╗ ███████╗███████╗"
echo "  ██╔══██╗██╔══██╗██╔════╝██╔════╝"
echo "  ███████║██████╔╝█████╗  ███████╗"
echo "  ██╔══██║██╔══██╗██╔═══╝ ╚════██║"
echo "  ██║  ██║██║  ██║███████╗███████║"
echo "  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝"
echo ""
echo "  [ARES_WERX — TRANSMISSION MODULE]"
echo "     EVERY CHALLENGE EVERY DAY"
echo ""

# ── Enumerate current AVFoundation devices ──────────────────────
echo "  Detecting devices..."
DEVICE_LIST=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1)

echo ""
echo "  VIDEO devices:"
echo "$DEVICE_LIST" | grep -A20 "AVFoundation video" | grep "^\[AVFoundation" | grep -v "AVFoundation video\|AVFoundation audio" | sed 's/^/    /'

echo ""
echo "  AUDIO devices:"
echo "$DEVICE_LIST" | grep -A20 "AVFoundation audio" | grep "^\[AVFoundation" | grep -v "AVFoundation audio" | sed 's/^/    /'

# ── Auto-detect MacBook Pro Microphone index ────────────────────
# Counts which [N] line the microphone appears at in the audio section
AUDIO_DEV=$(echo "$DEVICE_LIST" \
  | awk '/AVFoundation audio devices:/{found=1; next} found && /\[AVFoundation/{
      match($0, /\[([0-9]+)\]/, a)
      if ($0 ~ /MacBook Pro Microphone/) { print a[1]; exit }
    }')

# Fall back to index 0 if not found
AUDIO_DEV="${AUDIO_DEV:-0}"

echo ""
echo "  Selected:  Video [${VIDEO_DEV}]  Audio [${AUDIO_DEV}]"
echo "  Target:    ${RTMP_URL}"
echo ""
echo "  View via:"
echo "    RTSP  →  rtsp://localhost:8554/${STREAM_NAME}"
echo "    HLS   →  http://localhost:8080/hls/${STREAM_NAME}/index.m3u8"
echo ""
echo "  Press Ctrl+C to terminate."
echo "  ─────────────────────────────────────────"
echo ""

ffmpeg \
  -f avfoundation \
  -framerate 30 \
  -video_size 1280x720 \
  -i "${VIDEO_DEV}:${AUDIO_DEV}" \
  -vcodec libx264 \
  -preset ultrafast \
  -tune zerolatency \
  -x264-params "keyint=60:min-keyint=60:scenecut=0" \
  -b:v 2000k \
  -maxrate 2000k \
  -bufsize 4000k \
  -pix_fmt yuv420p \
  -acodec aac \
  -b:a 128k \
  -ar 44100 \
  -f flv \
  "${RTMP_URL}"
