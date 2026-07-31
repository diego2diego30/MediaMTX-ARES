---
name: deploy-vps
description: Standard operating procedure for committing local MediaMTX ARES code changes and auto-deploying them to the live VPS server.
---

# Deploy MediaMTX ARES to VPS

Use this skill whenever you need to stage, commit, and deploy changes to the live VPS server (`5.161.45.97` / `ares-werx.com`).

## CI/CD Pipeline Architecture

Deployments are automated via **GitHub Actions** (`.github/workflows/deploy.yml`). Pushing commits to `main` triggers a 3-stage pipeline:
1. **Validation Gate (CI):** Verifies Node.js code syntax (`node --check telemetry_bridge.js`), shell scripts (`bash -n`), and XML schemas (`manifest.xml`, `.pref`).
2. **Automated VPS Deployment (CD):** Connects via SSH (`VPS_SSH_KEY`), pulls `main` code to `/root/MediaMTX-ARES`, rebuilds Docker containers, and reloads Nginx.
3. **Health Check & Auto-Rollback:** Pings `https://ares-werx.com/`. If the server fails health checks, it automatically reverts the VPS to `HEAD~1` and restores working containers.

## Workflow Steps

1. **Check Git Status**
   Check working tree status in the project root:
   ```bash
   cd "/Users/diego/MediaMTX ARES" && git status
   ```

2. **Stage and Commit Local Changes**
   Stage and commit modified files with a descriptive message:
   ```bash
   git add .
   git commit -m "<descriptive message of changes made>"
   ```

3. **Push to Trigger CI/CD Pipeline**
   Push commits to the `main` branch to automatically trigger GitHub Actions deployment:
   ```bash
   git push origin main
   ```
   *Alternative:* Execute `./sync-to-git.sh` which commits, pushes to `main`, and triggers the workflow.

4. **Verify Deployment & Server Status**
   Check live server health or view telemetry logs on the VPS:
   ```bash
   curl -s -f -k https://ares-werx.com/
   ssh root@5.161.45.97 "docker logs --tail 30 telemetry-bridge"
   ```
