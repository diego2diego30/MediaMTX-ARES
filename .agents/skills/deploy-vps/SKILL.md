---
name: deploy-vps
description: Standard operating procedure for committing local MediaMTX ARES code changes and auto-deploying them to the live VPS server.
---

# Deploy MediaMTX ARES to VPS

Use this skill whenever you need to stage, commit, and deploy changes to the live VPS server (`5.161.45.97` / `ares-werx.com`).

## Workflow Steps

1. **Check Git Status**
   Check working tree status in the project root:
   ```bash
   cd "/Users/diego/MediaMTX ARES" && git status
   ```

2. **Stage and Commit Local Changes**
   If files were modified or created, stage and commit them with a descriptive commit message:
   ```bash
   git add .
   git commit -m "<descriptive message of changes made>"
   ```

3. **Run One-Click Sync & Deploy Script**
   Execute the automated sync-to-git script:
   ```bash
   ./sync-to-git.sh
   ```
   *Note: `./sync-to-git.sh` automatically pushes to GitHub `main` branch, SSHs into `root@5.161.45.97`, pulls the latest code, rebuilds Docker containers, and reloads Nginx.*

4. **Verify Deployment Logs**
   Ensure the script outputs:
   `🎉 SUCCESS! Live server updated seamlessly!`
   If you need to verify container status on the VPS, run:
   ```bash
   ssh root@5.161.45.97 "docker logs --tail 30 telemetry-bridge"
   ```
