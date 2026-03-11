# WordPress on Cloudflare Containers + R2

A complete solution to run **WordPress** on **Cloudflare Containers** with **R2** for persistent data storage.

## 🚀 What is this?

Run your WordPress site on Cloudflare's global edge network with automatic backup, restore, keep-alive, and persistent event logging. No traditional server required.

## ✨ Features

- **🌍 Global Edge Deployment** - WordPress runs on Cloudflare's 300+ edge locations
- **💾 Persistent Storage** - Database and uploads automatically backed up to R2
- **🔄 Auto Backup** - Every 2 minutes via Cron trigger
- **♻️ Auto Restore** - Automatically restores from R2 when container restarts
- **📋 Persistent Event Log** - Container recycles, restores, and backups logged to R2 (`logs/events.json`), survives container recycling
- **⚡ One-Click Deploy** - Simple deployment with `npx wrangler deploy`
- **🛡️ Built-in Security** - Cloudflare's WAF, DDoS protection included
- **💰 Cost Effective** - ~$5-15/month for personal sites

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

### Deployment

```bash
# 1. Clone the repository
git clone https://github.com/sorryfornow/wordpress-cloudflare-r2.git
cd wordpress-cloudflare-r2

# 2. Install dependencies
npm install

# 3. Login to Cloudflare
npx wrangler login

# 4. Create R2 bucket
npx wrangler r2 bucket create wordpress-data

# 5. Deploy (first time takes 5-10 minutes)
npx wrangler deploy
```

After deployment, visit your Workers URL and complete the WordPress installation wizard.

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
| `/__logs?limit=20` | Limit results |
| `/__backup/now` | Trigger manual backup |
| `/__restore/now` | Trigger manual restore from R2 |
| `/__reboot` | Restart container |

## 🔄 Backup & Restore

### Automatic Backup
- Cron runs every 2 minutes
- Backs up database and wp-content to R2
- Only runs if WordPress is fully installed (database.sql > 50KB)
- Check `/__status` to verify last backup time

### Automatic Restore
- Triggered when container restarts and WordPress loses state
- Worker detects `install.php` request
- Automatically restores from R2 backup
- Redirects to homepage after restore

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
| `MANUAL_RESTORE` | Restore triggered via `/__restore/now` |
| `MANUAL_BACKUP` | Backup triggered via `/__backup/now` |

### Retention

Events older than **90 days** are automatically pruned on each write. There is no entry count limit — storage is bounded purely by the 90-day window.

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
1. Go to **Workers & Pages** → **wordpress-r2**
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
├── wrangler.jsonc            # Cloudflare deployment config
├── DEPLOYMENT_GUIDE.md       # Full documentation
└── README.md                 # This file
```

## ⚠️ Important Notes

### Container Behavior
- `sleepAfter`: 168 hours (7 days maximum)
- Cron keeps container alive with 2-minute pings
- Container may still restart due to Cloudflare infrastructure updates
- All logs are stored in R2 and are unaffected by container recycling

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

**Estimated monthly cost for low-traffic personal site: $5-15**

## 🤝 Contributing

Pull requests are welcome! Feel free to:

- Report bugs
- Suggest features
- Improve documentation
- Submit pull requests

## 📄 License

MIT License - feel free to use and modify.

## 🙏 Acknowledgments

- Built for [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- Created with assistance from Claude AI
