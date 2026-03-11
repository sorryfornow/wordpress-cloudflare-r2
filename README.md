# WordPress on Cloudflare Containers + R2

A complete solution to run **WordPress** on **Cloudflare Containers** with **R2** for persistent data storage.

## 🚀 What is this?

Run your WordPress site on Cloudflare's global edge network with automatic backup, restore, keep-alive, and persistent event logging. No traditional server required.

## ✨ Features

- **🌍 Global Edge Deployment** - WordPress runs on Cloudflare's 300+ edge locations
- **💾 Persistent Storage** - Database and uploads automatically backed up to R2
- **🔄 Auto Backup** - Database every 10 minutes, wp-content every 6 hours via Cron
- **📸 Snapshot Protection** - Hourly snapshots (last 24h) and daily snapshots (last 7 days) stored in R2
- **♻️ Auto Restore** - Automatically restores from R2 when container restarts
- **📋 Persistent Event Log** - Container recycles, restores, and backups logged to R2 (`logs/events.json`), survives container recycling
- **⚡ Interactive Setup** - `setup.sh` configures and deploys in one flow
- **🛡️ Built-in Security** - Cloudflare's WAF, DDoS protection included
- **💰 Cost Effective** - ~$5-15/month per site

## 📐 Architecture

```
User Request
     │
     ▼
┌─────────────────────┐
│  Cloudflare Worker  │  ← Request routing, R2 API, Auto-restore, Event logging
└─────────────────────┘
     │
     ▼
┌─────────────────────┐     ┌──────────────────────────┐
│  Container          │◄───►│  Cloudflare R2           │
│  ├── Apache         │     │  ├── backup/database.sql  │
│  ├── PHP 8.1        │     │  ├── backup/wp-content    │
│  ├── MariaDB        │     │  ├── backup/timestamp.txt │
│  └── WordPress      │     │  └── logs/events.json     │  ← Persistent log
└─────────────────────┘     └──────────────────────────┘
         ▲
         │
    Cron Trigger (every 2 min)
    - Keep-alive ping
    - Auto backup to R2
```

## 🛠️ Quick Start

### Prerequisites

- Node.js v18+
- Docker Desktop (running)
- Cloudflare account with Workers Paid plan ($5/month)

### Deployment (Interactive)

```bash
git clone https://github.com/sorryfornow/wordpress-cloudflare-r2.git
cd wordpress-cloudflare-r2
bash setup.sh
```

The script will prompt you for:

| Prompt | Example | Default |
|--------|---------|---------|
| Worker name | `wordpress-r2` | `wordpress-r2` |
| R2 bucket name | `wordpress-r2-data` | `<worker-name>-data` |
| Custom domain | `blog.example.com` | *(skip)* |

It then automatically:
1. Updates `wrangler.jsonc` with your inputs
2. Runs `npm install`
3. Checks / performs `wrangler login`
4. Creates the R2 bucket
5. Deploys the Worker

After deployment, visit your Workers URL and complete the WordPress installation wizard.

### Deploying a Second (or Third) Site

Each site needs a unique Worker name and R2 bucket. Clone into a new directory and run `setup.sh` again with different values:

```bash
git clone https://github.com/sorryfornow/wordpress-cloudflare-r2.git wordpress-site2
cd wordpress-site2
bash setup.sh
```

```
Worker name  : wordpress-site2
R2 bucket    : wordpress-site2-data
Custom domain: site2.example.com   (optional)
```

Each site gets a fully independent Worker, container, R2 bucket, backup, and event log.

### Updating (Worker code only)

If you only modify `src/index.ts`, no Docker rebuild is needed:

```bash
npx wrangler deploy
```

The container keeps running and existing data is unaffected.

## 🔗 Endpoints

| URL | Purpose |
|-----|---------|
| `/` | Website homepage |
| `/wp-admin` | Admin dashboard |
| `/__status` | Backup status & container info (JSON) |
| `/__logs` | Persistent event log (JSON) |
| `/__logs?type=CONTAINER_RECYCLED` | Filter by event type |
| `/__snapshots` | List available hourly and daily snapshots |
| `/__restore?from=hourly/2026031102` | Restore from a specific snapshot |
| `/__logs?limit=20` | Limit results |
| `/__backup/now` | Trigger manual backup |
| `/__restore/now` | Trigger manual restore from R2 |
| `/__reboot` | Restart container |

## 🔄 Backup & Restore

### Automatic Backup

Backup frequency is split by file type to balance data safety with performance:

| File | Frequency | Rationale |
|------|-----------|-----------|
| `database.sql` | Every 10 minutes | Posts, settings, comments — changes frequently but small |
| `wp-content.tar.gz` | Every 6 hours | Media files — large, changes infrequently |

Intervals are tracked via timestamp files in R2 (not wall-clock schedule), so timing is based on actual elapsed time. On the very first run (no timestamp exists), both files are backed up immediately.

- Only runs if WordPress is fully installed (database.sql > 50KB)
- Check `/__status` to verify last backup time

### Snapshot Protection

Beyond the rolling latest backup, snapshots are taken automatically and stored independently in R2:

| Snapshot | Frequency | Retention | Contents | Use case |
|----------|-----------|-----------|----------|----------|
| `snapshots/hourly/YYYYMMDDHH/` | Every hour | Last 24 | database.sql only | Recover deleted posts, accidental changes |
| `snapshots/daily/YYYYMMDD/` | Every day | Last 7 | database.sql + wp-content | Full rollback from hack or major incident |

Snapshots are copied from the current `backup/` files — no extra container load. Restoring from a specific snapshot:

```bash
# List available snapshots
curl https://your-site/__snapshots

# Restore from a specific hourly snapshot
curl https://your-site/__restore?from=hourly/2026031102

# Restore from a specific daily snapshot
curl https://your-site/__restore?from=daily/20260311
```

### Automatic Restore

There are two layers of automatic restore:

**1. Proactive restore via Cron (primary)**
- Every 2 minutes, cron checks if WordPress has lost state (`needsRestore=true`)
- If detected, cron immediately triggers a restore from R2 — no user visit required
- Container is typically recovered within 2 minutes of a recycle event
- All proactive restores are logged with `trigger: "cron (proactive)"`

**2. Reactive restore via install.php (fallback)**
- If a user visits before cron has run, the Worker intercepts the `install.php` request
- Returns a friendly "waking up" page immediately (no blank screen or browser spinner)
- Page JS triggers restore in the background and polls `/__status` every 5 seconds
- Automatically redirects to homepage once the site is back online

### Manual Operations
```bash
# Trigger backup
curl https://your-site/__backup/now

# Trigger restore
curl https://your-site/__restore/now

# Check status
curl https://your-site/__status

# View event log
curl https://your-site/__logs
```

## 📋 Persistent Event Log

All critical lifecycle events are written to `logs/events.json` in R2, independent of container state — **logs survive container recycling**.

### Event Types

| Event | When |
|-------|------|
| `CONTAINER_RECYCLED` | `install.php` accessed — container lost state |
| `RESTORE_START` | Restore from R2 initiated |
| `RESTORE_SUCCESS` | Restore completed successfully (includes snapshot timestamp) |
| `RESTORE_FAILED` | Restore failed (includes error detail) |
| `RESTORE_SKIPPED` | Backup invalid or missing, skipped restore |
| `BACKUP_COMPLETE` | Backup written to R2 successfully |
| `BACKUP_FAILED` | Backup failed (includes reason) |
| `MANUAL_RESTORE` | Restore triggered via `/__restore` |
| `MANUAL_BACKUP` | Backup triggered via `/__backup/now` |
| `SNAPSHOT_HOURLY` | Hourly snapshot written to `snapshots/hourly/` |
| `SNAPSHOT_DAILY` | Daily snapshot written to `snapshots/daily/` |

### Retention

Events older than **30 days** are automatically pruned on each write. There is no entry count limit — storage is bounded purely by the 30-day window.

Snapshots are pruned automatically: hourly keeps the last 24, daily keeps the last 7.

### Query Examples

```bash
# All events (newest first, default limit 50)
curl https://your-site/__logs

# Only container recycle events
curl https://your-site/__logs?type=CONTAINER_RECYCLED

# Last 100 events
curl https://your-site/__logs?limit=100
```

## 📊 Monitoring

### Persistent Logs (recommended)
Query `/__logs` for a full history of container recycles, restores, and backups stored in R2.

### Cloudflare Real-time Logs
For live cron/request activity:
1. Go to **Workers & Pages** → **your-worker-name**
2. Click **Logs** tab
3. Select **Real-time Logs**

Console log prefixes:
- `[CONTAINER]` - Container start events
- `[CRON]` - Scheduled backup tasks
- `[AUTO-RESTORE]` - Automatic restore process
- `[RESTORE]` - Restore operation details
- `[REQUEST]` - Incoming requests
- `[LOG]` - Event log write confirmations

## 📁 Project Structure

```
wordpress-r2/
├── setup.sh                  # Interactive setup & deploy script
├── src/
│   └── index.ts              # Cloudflare Worker (routing, backup, restore, event log)
├── container/
│   ├── Dockerfile            # Container image definition
│   ├── config/
│   │   ├── wp-config.php     # WordPress configuration
│   │   ├── __trigger_backup.php  # Backup/restore handler
│   │   └── mu-plugins/
│   │       └── r2-auto-backup.php  # Auto backup plugin
│   └── scripts/
│       ├── startup.sh        # Container startup script
│       └── sync.sh           # Backup script
├── wrangler.jsonc            # Cloudflare deployment config (edited by setup.sh)
├── DEPLOYMENT_GUIDE.md       # Full documentation
└── README.md                 # This file
```

## ⚠️ Important Notes

### Container Behavior
- `sleepAfter`: 168 hours (7 days maximum — Cloudflare's upper limit)
- Cron pings container every 2 minutes, resetting the inactivity timer — container should never sleep under normal operation
- Cloudflare infrastructure migrations can still force a recycle at any time, regardless of activity
- Cron detects and recovers from recycles within 2 minutes via proactive restore
- All logs are stored in R2 and survive container recycling

### Data Safety
- Always ensure a valid backup exists before making changes
- Check `/__status` to verify backup timestamp and validity
- Auto-restore handles most restart scenarios automatically
- Check `/__logs?type=RESTORE_FAILED` if restore issues are suspected

### Limitations
- **Data persistence**: Relies on R2 backup/restore cycle
- **Cold start**: Container takes 30-60 seconds if sleeping
- **Recommended for**: Personal blogs, small sites, development/testing
- **Not recommended for**: High-traffic production sites, e-commerce

## 💰 Cost Estimate

| Service | Free Tier | Estimated Cost |
|---------|-----------|----------------|
| Workers | 100K requests/day | ~$0.50/million |
| Container | - | ~$0.02/hour running |
| R2 Storage | 10GB | $0.015/GB/month |

**Estimated monthly cost per site: $5-15**

## 🤝 Contributing

Pull requests are welcome! Feel free to:

- Report bugs
- Suggest features
- Improve documentation
- Submit pull requests
