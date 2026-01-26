# WordPress on Cloudflare Containers + R2

A complete solution to run **WordPress** on **Cloudflare Containers** with **R2** for persistent data storage.

## 🚀 What is this?

Run your WordPress site on Cloudflare's global edge network with automatic backup, restore, and keep-alive. No traditional server required.

## ✨ Features

- **🌍 Global Edge Deployment** - WordPress runs on Cloudflare's 300+ edge locations
- **💾 Persistent Storage** - Database and uploads automatically backed up to R2
- **🔄 Auto Backup** - Every 30 minutes via Cron trigger
- **♻️ Auto Restore** - Automatically restores from R2 when container restarts
- **⚡ One-Click Deploy** - Simple deployment with `npx wrangler deploy`
- **🛡️ Built-in Security** - Cloudflare's WAF, DDoS protection included
- **📊 Detailed Logging** - Container lifecycle and backup/restore logs
- **💰 Cost Effective** - ~$5-15/month for personal sites

## 📐 Architecture

```
User Request
     │
     ▼
┌─────────────────────┐
│  Cloudflare Worker  │  ← Request routing, R2 API, Auto-restore
└─────────────────────┘
     │
     ▼
┌─────────────────────┐     ┌─────────────────┐
│  Container          │◄───►│  Cloudflare R2  │
│  ├── Apache         │     │  (Backup)       │
│  ├── PHP 8.1        │     │  ├── database   │
│  ├── MariaDB        │     │  └── wp-content │
│  └── WordPress      │     └─────────────────┘
└─────────────────────┘
         ▲
         │
    Cron Trigger (every 30 min)
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

## 🔗 Endpoints

| URL | Purpose |
|-----|---------|
| `/` | Website homepage |
| `/wp-admin` | Admin dashboard |
| `/__status` | Backup status & container info (JSON) |
| `/__backup/now` | Trigger manual backup |
| `/__restore/now` | Trigger manual restore from R2 |
| `/__reboot` | Restart container |

## 🔄 Backup & Restore

### Automatic Backup
- Cron runs every 30 minutes
- Backs up database and wp-content to R2
- Check `/__status` to verify last backup time

### Automatic Restore
- When container restarts and WordPress needs installation
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
```

## 📊 Monitoring

View logs in Cloudflare Dashboard:
1. Go to **Workers & Pages** → **wordpress-r2**
2. Click **Logs** tab
3. Select **Real-time Logs**

Log prefixes:
- `[CONTAINER]` - Container start/stop events
- `[CRON]` - Scheduled backup tasks
- `[AUTO-RESTORE]` - Automatic restore process
- `[RESTORE]` - Restore operation details
- `[REQUEST]` - Incoming requests

## 📁 Project Structure

```
wordpress-r2/
├── src/
│   └── index.ts              # Cloudflare Worker
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

## 📖 Documentation

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for complete documentation including:

- Detailed deployment instructions
- Architecture explanation
- Backup & restore guide
- Container lifecycle management
- Migration guide
- Troubleshooting

## ⚠️ Important Notes

### Container Behavior
- `sleepAfter`: 168 hours (7 days maximum)
- Cron keeps container alive with 30-minute pings
- Container may still restart due to Cloudflare infrastructure updates

### Data Safety
- Always ensure backup exists before making changes
- Check `/__status` to verify backup timestamp
- Auto-restore handles most restart scenarios

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
