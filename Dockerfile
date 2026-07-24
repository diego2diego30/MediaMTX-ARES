# syntax=docker/dockerfile:1

# ---------- Build Stage ----------
FROM golang:1.22-alpine AS builder
WORKDIR /app

# Install git and ca-certificates
RUN apk add --no-cache git ca-certificates

# Clone the MediaMTX-ARES repository (replace <REPO_URL> with actual URL)
ARG REPO_URL="<REPO_URL>"
RUN git clone $REPO_URL .

# Build the MediaMTX binary (assumes a Makefile or go build script)
RUN go build -v -o mediamtx ./cmd/mediamtx

# ---------- Runtime Stage ----------
FROM alpine:latest
RUN apk add --no-cache ca-certificates ffmpeg
WORKDIR /app

# Copy built binary
COPY --from=builder /app/mediamtx /usr/local/bin/mediamtx

# Expose streaming ports (RTMP, HLS, etc.)
EXPOSE 1935 8080

# Default command to run MediaMTX
ENTRYPOINT ["mediamtx", "-config", "/app/config.yml"]
