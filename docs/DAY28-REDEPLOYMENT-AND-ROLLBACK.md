# DAY 28 — REDEPLOYMENT, REBUILD & ROLLBACK GUIDE
## Aspire by Adyapan — Infrastructure Provisioning and Cold Recovery Standard

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-14  
**Author:** DevOps, Platform Engineering & SRE  
**Classification:** Operational Guide  

---

## 1. Overview & Cold-Rebuild Scope

This guide defines the complete process for rebuilding the **Aspire by Adyapan** application stack from scratch following catastrophic infrastructure destruction (hardware failure, region outage, host compromise) or rolling back an unrecoverable bad release.

Because Day 26 (Docker and production deployment) is currently on hold, this guide addresses:
1. **Host-Level / Bare-Metal Environment Provisioning** (Clean Linux / Windows VM).
2. **Persistence Hierarchy Reconstruction**.
3. **Database Restore & Schema Migration Re-alignment**.
4. **Outbox Replay & Queue Re-initialization**.
5. **Pre-Release Rollback Procedures**.

---

## 2. Phase 1: Clean Host Provisioning & Runtime Setup

### 2.1 Host Prerequisites
- **Operating System:** Ubuntu 22.04 LTS+ / Debian 12 / Windows Server 2022.
- **Node.js Runtime:** Node.js v20.x or v22.x LTS (Supports Node v24).
- **In-Memory Store:** Redis 7.x (Installed locally or via managed Redis cluster).
- **Core Build Tools:** `build-essential`, `python3` (Required to compile native `better-sqlite3` bindings).

### 2.2 Host Dependency Installation (Debian/Ubuntu Example)
```bash
# Update packages
sudo apt update && sudo apt install -y curl git build-essential python3 redis-server

# Install Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify runtimes
node -v    # v22.x+
npm -v     # v10.x+
redis-cli ping  # PONG
```

### 2.3 Clone Application Repository
```bash
sudo mkdir -p /opt/aspire
sudo chown -R $USER:$USER /opt/aspire
git clone https://github.com/adyapan/aspire.git /opt/aspire
cd /opt/aspire
npm ci --production
```

---

## 3. Phase 2: Directory Hierarchy & Configuration Reconstruction

### 3.1 Initialize Storage Directory Hierarchy
Aspire expects specific local persistence mount points:
```bash
mkdir -p data/uploads/organizations
mkdir -p data/logo
mkdir -p data/backups
chmod -R 750 data
```

### 3.2 Environment Variable Configuration
Copy the configuration template and populate secrets:
```bash
cp .env.example .env
chmod 600 .env
```

Populate the following critical runtime parameters in `.env`:
```env
PORT=3000
NODE_ENV=production
DB_PATH=./data/aspire.db
STORAGE_LOCAL_DIR=./data/uploads
REDIS_URL=redis://127.0.0.1:6379

# Cryptographic Keys (Retrieve from Hardware Password Vault)
AUTH_SECRET="<SECURE_RANDOM_48_BYTES>"
CERTIFICATE_SIGNING_SECRET="<SECURE_RANDOM_32_BYTES>"
BACKUP_ENCRYPTION_KEY="<SECURE_BACKUP_ENCRYPTION_KEY>"

# External Services (When enabled)
RESEND_API_KEY="re_..."
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
R2_BUCKET_NAME="aspire-backups"
```

---

## 4. Phase 3: Restoring Persistence State from Encrypted Archive

### 4.1 Ingest Backup Archive
Download the designated recovery point from Cloudflare R2 / AWS S3 into `data/backups/`:
```bash
# Example S3 download
aws s3 cp s3://aspire-backups/bak_20261114_131938_e8c95174 ./data/backups/bak_20261114_131938_e8c95174 --recursive
```

### 4.2 Verify Integrity
Confirm the archive is authentic and undamaged:
```bash
npm run backup:verify -- --id bak_20261114_131938_e8c95174
```

### 4.3 Execute Staged Live Disaster Recovery
Restore the SQLite database and organization assets:
```bash
npm run backup:restore -- --id bak_20261114_131938_e8c95174 --confirm
```

---

## 5. Phase 4: Schema Migration Alignment & Catch-Up

When restoring a database created at schema level `N` into an application codebase at schema level `N+K`:

```
+---------------------------+        +---------------------------+
| Restored Backup Database  |        | Newly Deployed Codebase   |
| Schema: 018_certificates  |  --->  | Codebase Schema: 020_obs  |
+---------------------------+        +---------------------------+
               |                                   |
               +-----------------> <---------------+
                                   |
                                   v
             [Application Startup runMigrations(db)]
             Executes 019_public_candidate_experience
             Executes 020_monitoring_observability
             Upgrades DB cleanly to Schema 020
```

1. **Automatic Alignment:**
   On startup, `backend/src/db/migrations.js` inspects `schema_migrations` in the restored database. Any missing migrations between the snapshot and current code are automatically applied inside a single transactional block.
2. **Manual Migration Inspection:**
   To check migration level before starting the server:
   ```bash
   node -e "const db = require('better-sqlite3')('data/aspire.db'); console.log('Applied migrations:', db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC').all());"
   ```

---

## 6. Phase 5: Redis Outbox & Background Processing Reconciliation

### 6.1 Redis Resilience Principle
Redis is treated as an ephemeral message broker and cache, not an authoritative datastore.
If Redis was destroyed during the incident:
1. Flush or re-create Redis database:
   ```bash
   redis-cli flushall
   ```
2. Restart Redis service:
   ```bash
   sudo systemctl restart redis-server
   ```

### 6.2 Transactional Outbox Replay
Unsent transactional events stored in the SQLite `outbox_events` table remain intact after restore:
- The outbox processor will query `outbox_events WHERE status = 'PENDING'` and re-enqueue notification and audit jobs into BullMQ automatically.
- No notifications or exam completion events are lost.

---

## 7. Phase 6: Service Startup & Health Gateways

### 7.1 Start Application Under Process Manager
Using `pm2` or `systemd`:
```bash
# Using systemd:
sudo systemctl daemon-reload
sudo systemctl enable --now aspire-api

# Or using pm2:
pm2 start backend/src/app.js --name aspire-api
pm2 save
```

### 7.2 Execute Readiness Health Checks
Run the following verification sequence:
```bash
# 1. Observability health check (HTTP 200 required)
curl -s http://localhost:3000/health | jq .

# 2. Database latency check
curl -s http://localhost:3000/api/health/db | jq .

# 3. Super Admin authentication smoke test
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@adyapan.internal","password":"<password>"}' | jq .
```

---

## 8. Deployment Rollback Protocol (Reverting a Bad Release)

If a new code deployment introduces breaking changes or fatal bugs, follow this rapid rollback procedure:

```
                                  DEPLOYMENT FAILURE DETECTED
                                               |
                                               v
                                [1. Stop Application Traffic]
                                pm2 stop aspire-api
                                               |
                                               v
                        [2. Check Schema Changes in Failed Release]
                       /                                          \
         Did release apply schema migrations?       No schema migrations applied
                     /                                             \
                    v                                               v
      [3. Restore Pre-Deploy Database Snapshot]            [Git Revert Codebase]
      cp data/backups/aspire.db.pre-deploy  \             git checkout <last_good_commit>
         data/aspire.db                      \            npm install --production
      rm -f data/aspire.db-wal                \                    |
                                               +-------------------+
                                               |
                                               v
                                    [4. Restart Application]
                                    pm2 start aspire-api
                                               |
                                               v
                                  [5. Health Verification]
                                  curl http://localhost:3000/health
```

### 8.1 Step-by-Step Rollback Execution
1. **Stop Traffic:**
   ```bash
   pm2 stop aspire-api
   ```
2. **Revert Persistent Data (If Migration Applied):**
   Prior to any major release, a pre-deploy snapshot is taken automatically or via `npm run backup:create`. Revert the database:
   ```bash
   cp data/backups/aspire.db.pre-deploy data/aspire.db
   rm -f data/aspire.db-wal data/aspire.db-shm
   ```
3. **Revert Git Codebase:**
   ```bash
   git checkout <PREVIOUS_STABLE_COMMIT_HASH>
   npm install --production
   ```
4. **Restart Application & Confirm Recovery:**
   ```bash
   pm2 start aspire-api
   curl http://localhost:3000/health
   ```

