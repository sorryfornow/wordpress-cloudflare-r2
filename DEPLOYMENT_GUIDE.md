# WordPress on Cloudflare Containers + R2 - Complete Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Deployment Guide](#deployment-guide)
3. [Code Structure](#code-structure)
4. [Using WordPress](#using-wordpress)
5. [Migration Guide](#migration-guide)
6. [Backup & Restore](#backup--restore)
7. [Monitoring & Logging](#monitoring--logging)
8. [Troubleshooting](#troubleshooting)
9. [Container Sleep & Keep-Alive](#container-sleep--keep-alive)

---

## Architecture Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Request                              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                       │
│                      (300+ Global Locations)                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  • Route requests                                        │    │
│  │  • R2 API endpoints (/r2/*)                             │    │
│  │  • Management endpoints (/__status, /__reboot)          │    │
│  │  • Forward other requests to Container                   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
┌───────────────────────────┐     ┌───────────────────────────┐
│    Cloudflare Container   │     │      Cloudflare R2        │
│  ┌─────────────────────┐  │     │  ┌─────────────────────┐  │
│  │  Ubuntu 22.04       │  │     │  │  backup/            │  │
│  │  ├── Apache 2.4     │  │◄───►│  │  ├── database.sql   │  │
│  │  ├── PHP 8.x        │  │     │  │  ├── wp-content.tar │  │
│  │  ├── MariaDB 10.x   │  │     │  │  └── timestamp.txt  │  │
│  │  └── WordPress      │  │     │  └─────────────────────┘  │
│  └─────────────────────┘  │     │     (Persistent Storage)  │
│     (Ephemeral Disk)      │     └───────────────────────────┘
└───────────────────────────┘
```

### Data Flow

1. **User Request** → Cloudflare Edge → Worker
2. **Worker** checks URL path:
   - `/r2/*` → Handle R2 operations
   - `/__status` → Return status JSON
   - `/__backup/now` → Trigger manual backup
   - `/__restore/now` → Trigger manual restore
   - `/__reboot` → Restart container
   - `/wp-admin/install.php` → Check for auto-restore
   - Everything else → Forward to Container
3. **Container** runs WordPress (Apache + PHP + MariaDB)
4. **Cron Backup** (every 30 minutes): Worker triggers → Container generates → Worker uploads to R2
5. **Auto-Restore** (when install.php detected): Worker downloads from R2 → Push to Container → Apply restore

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| Worker | Request routing, R2 API | Cloudflare Edge |
| Container | Run WordPress stack | Cloudflare Infrastructure |
| R2 | Persistent backup storage | Cloudflare Object Storage |
| MariaDB | WordPress database | Inside Container |
| Apache + PHP | Web server | Inside Container |

### Access Points

| URL | Purpose |
|-----|---------|
| `/` | Website homepage |
| `/wp-admin` | WordPress admin dashboard |
| `/wp-login.php` | Login page |
| `/__status` | Container & backup status (JSON) |
| `/__backup/now` | Trigger immediate backup |
| `/__restore/now` | Trigger manual restore from R2 |
| `/__reboot` | Restart container |
| `/r2/list` | List R2 backup files (JSON) |

---

## Deployment Guide

### Prerequisites

- Node.js v18+
- Docker Desktop (running)
- Cloudflare account with Workers Paid plan ($5/month)

### Step 1: Project Setup

```bash
# Extract project
unzip wordpress-r2.zip
cd wordpress-r2

# Install dependencies
npm install
```

### Step 2: Cloudflare Login

```bash
npx wrangler login
```

Browser opens → Click "Allow" to authorize.

### Step 3: Create R2 Bucket

```bash
npx wrangler r2 bucket create wordpress-data
```

Or create via Cloudflare Dashboard:
1. Go to https://dash.cloudflare.com
2. Navigate to R2 Object Storage
3. Click "Create bucket"
4. Name: `wordpress-data`

### Step 4: Deploy

```bash
npx wrangler deploy
```

**First deployment takes 5-10 minutes** (building Docker image).

Expected output:
```
Deployed wordpress-r2 triggers
  https://wordpress-r2.your-account.workers.dev
```

### Step 5: Wait for Container

```bash
npx wrangler containers list
```

Wait until status shows the container is running (2-3 minutes).

### Step 6: Complete WordPress Setup

1. Visit your deployed URL
2. Select language
3. Fill in:
   - Site Title: Your site name
   - Username: admin (or custom)
   - Password: **Strong password (SAVE THIS!)**
   - Email: your@email.com
4. Click "Install WordPress"

### Step 7: Verify Backup

Visit `https://your-site/__status` to confirm backup is working.

---

## Code Structure

```
wordpress-r2/
├── src/
│   └── index.ts          # Worker code (request routing)
├── container/
│   ├── Dockerfile        # Container image definition
│   ├── config/
│   │   ├── wp-config.php      # WordPress configuration
│   │   ├── supervisord.conf   # Process manager config
│   │   └── apache-site.conf   # Apache virtual host
│   └── scripts/
│       ├── startup.sh         # Container startup script
│       ├── init-db.sh         # Database initialization
│       └── sync.sh            # Backup/restore script
├── wrangler.jsonc        # Cloudflare deployment config
├── package.json          # Node.js dependencies
└── tsconfig.json         # TypeScript configuration
```

### Key Files Explained

#### `src/index.ts` - Worker Entry Point

```typescript
// Handles request routing
export class WordPressContainer extends Container {
  defaultPort = 80;      // Container listens on port 80
  sleepAfter = "60m";    // Sleep after 60 minutes idle

  async fetch(request: Request): Promise<Response> {
    // Route /r2/* to R2 operations
    // Route /__status to status endpoint
    // Forward everything else to container
    return this.containerFetch(request);
  }
}
```

#### `container/scripts/startup.sh` - Container Initialization

```bash
# 1. Initialize MariaDB data directory
# 2. Start MariaDB in background
# 3. Create WordPress database and user
# 4. Set file permissions
# 5. Start Apache in foreground (keeps container alive)
```

#### `wrangler.jsonc` - Deployment Configuration

```jsonc
{
  "name": "wordpress-r2",
  "containers": [{
    "class_name": "WordPressContainer",
    "image": "./container/Dockerfile",
    "instance_type": "standard-1",  // 4GB RAM, 1/2 vCPU
    "max_instances": 1
  }],
  "r2_buckets": [{
    "binding": "DATA_BUCKET",
    "bucket_name": "wordpress-data"
  }]
}
```

---

## Using WordPress

### Access Points

| URL | Purpose |
|-----|---------|
| `/` | Website homepage |
| `/wp-admin` | Admin dashboard |
| `/wp-login.php` | Login page |
| `/__status` | Container & backup status |
| `/__reboot` | Restart container |
| `/r2/list` | List R2 backup files |

### Admin Dashboard

1. Go to `https://your-site/wp-admin`
2. Login with credentials you created during setup
3. From here you can:
   - Write posts/pages
   - Install themes
   - Install plugins
   - Manage media
   - Configure settings

### Installing Themes

1. Go to Appearance → Themes → Add New
2. Search or upload theme
3. Click Install → Activate

### Installing Plugins

1. Go to Plugins → Add New
2. Search or upload plugin
3. Click Install → Activate

### Creating Content

**Posts** (Blog articles):
1. Go to Posts → Add New
2. Write content using block editor
3. Click Publish

**Pages** (Static pages):
1. Go to Pages → Add New
2. Write content
3. Click Publish

### Recommended Plugins for Development

| Plugin | Purpose |
|--------|---------|
| Elementor | Visual page builder |
| Yoast SEO | Search engine optimization |
| WPForms Lite | Contact forms |
| UpdraftPlus | Additional backup |
| WP Super Cache | Performance caching |

---

## Migration Guide

### Migrating Existing WordPress to Cloudflare Containers

#### Method 1: Manual Migration

**Step 1: Export from existing WordPress**

On your current WordPress server:

```bash
# Export database
mysqldump -u USERNAME -p DATABASE_NAME > database.sql

# Package wp-content
tar -czf wp-content.tar.gz wp-content/
```

**Step 2: Deploy fresh Cloudflare WordPress**

Follow the [Deployment Guide](#deployment-guide) above.

**Step 3: Import data**

Option A: Use a migration plugin
1. Install "All-in-One WP Migration" on both sites
2. Export from old site
3. Import to new site

Option B: Manual database import
1. Access your container (if terminal available)
2. Upload database.sql to R2
3. Import: `mysql -u wordpress -p wordpress < database.sql`

**Step 4: Update URLs**

In WordPress admin or via SQL:
```sql
UPDATE wp_options SET option_value = 'https://new-url' 
WHERE option_name IN ('siteurl', 'home');
```

#### Method 2: Plugin-Based Migration

1. Install "Duplicator" or "All-in-One WP Migration" on source site
2. Create full backup package
3. Deploy fresh WordPress on Cloudflare
4. Install same plugin on new site
5. Import the backup package

### Post-Migration Checklist

- [ ] Test all pages load correctly
- [ ] Check images display properly
- [ ] Verify forms work
- [ ] Test user login
- [ ] Check permalinks
- [ ] Update DNS (if using custom domain)
- [ ] Install SSL (Cloudflare handles this automatically)

---

## Backup & Restore

### Automatic Backup

Backups run automatically in two ways:

1. **Scheduled backup**: Every 5 minutes via cron job
2. **Event-triggered backup**: Automatically after:
   - WordPress installation completes
   - Theme activation/switch
   - Plugin activation/deactivation
   - WordPress core update

**What's backed up:**
- Full database dump (`database.sql`)
- wp-content folder (`wp-content.tar.gz`)
  - Themes
  - Plugins
  - Uploads (images, media)
  - Custom files

**What's NOT backed up:**
- WordPress core files (restored from fresh install)
- Cache files
- Temporary files

### Manual Backup

#### Method 1: Via URL (Recommended)

Visit this URL to trigger an immediate backup:

```
https://your-site/__backup/now
```

#### Method 2: Via WordPress Admin

1. Go to **Tools → R2 Backup** in WordPress admin
2. Click **"Backup Now"** button
3. Wait 10-30 seconds
4. Refresh to confirm backup completed

#### Method 3: Via Terminal (if you have container access)

```bash
/scripts/sync.sh push
```

### Important: Before Redeploying

**Always ensure your data is backed up before running `npx wrangler deploy`:**

1. Visit `/__status` and check `lastBackup` time
2. If your recent changes aren't backed up:
   - Visit `/__backup/now` to trigger backup
   - Wait 30 seconds
   - Check `/__status` again to confirm
3. Then proceed with `npx wrangler deploy`

```
⚠️  CAUTION: Redeploying destroys the current container.
    If backup hasn't run, you will lose recent changes!
    
    Safe workflow:
    1. Make changes in WordPress
    2. Visit /__backup/now (or wait 5 minutes)
    3. Verify at /__status
    4. npx wrangler deploy
```

### Checking Backup Status

Visit: `https://your-site/__status`

Response:
```json
{
  "status": "running",
  "backup": {
    "files": 3,
    "totalSizeBytes": 1234567,
    "totalSizeMB": "1.18",
    "lastBackup": "20260126_123456"
  }
}
```

### Restore Process

Restore happens automatically when the Worker detects WordPress needs data:

1. User visits the site
2. Worker checks if WordPress database has data
3. If empty and R2 has backup, Worker automatically:
   - Downloads backup files from R2
   - Sends them to container
   - Triggers database and wp-content restore
4. WordPress loads with restored data

#### Manual Restore

If automatic restore fails, you can trigger it manually:

```
https://your-site/__restore/now
```

This will:
1. Check R2 for backup files
2. Push files to container
3. Restore database
4. Restore wp-content folder

---

## Monitoring & Logging

### Viewing Logs

All logs are available in Cloudflare Dashboard:

1. Go to **Workers & Pages** → **wordpress-r2**
2. Click **Logs** tab
3. Select **Real-time Logs** or **Past Logs**

### Log Prefixes

| Prefix | Description |
|--------|-------------|
| `[CONTAINER]` | Container lifecycle events (start/stop) |
| `[REQUEST]` | Incoming HTTP requests |
| `[CRON]` | Scheduled backup tasks (every 30 minutes) |
| `[AUTO-RESTORE]` | Automatic restore detection and process |
| `[RESTORE]` | Detailed restore operation logs |

### Example Logs

**Container Start:**
```
[CONTAINER] Constructor called at 2026-01-27T10:00:00.000Z
[CONTAINER] ====== CONTAINER STARTED ====== 2026-01-27T10:00:01.000Z
```

**Cron Backup:**
```
[CRON] ====== SCHEDULED TASK STARTED ====== 2026-01-27T10:30:00.000Z
[CRON] Event type: */30 * * * *
[CRON] Sending keep-alive ping...
[CRON] Ping response status: 200
[CRON] Starting backup...
[CRON] ✅ database.sql backed up (1234567 bytes)
[CRON] ✅ wp-content.tar.gz backed up (13456789 bytes)
[CRON] ====== BACKUP COMPLETED ====== 2026-01-27T10:30:15.000Z
```

**Auto-Restore:**
```
[AUTO-RESTORE] ====== DETECTED INSTALL.PHP ======
[AUTO-RESTORE] R2 backup files count: 3
[AUTO-RESTORE] Backup found, performing automatic restore...
[RESTORE] ====== Starting performRestore ======
[RESTORE] Pushing database.sql (1234.5 KB) to container...
[RESTORE] ✅ database.sql pushed: Saved database.sql: 1234567 bytes
[RESTORE] Applying restore...
[RESTORE] ====== performRestore finished, success=true ======
[AUTO-RESTORE] ====== RESTORE SUCCESSFUL ======
```

### Status Endpoint

Check current status via `/__status`:

```json
{
  "status": "running",
  "containerInfo": {
    "sleepAfter": "168h (7 days)",
    "cronSchedule": "*/30 * * * * (every 30 minutes)"
  },
  "backup": {
    "files": 3,
    "fileList": [
      {"key": "backup/database.sql", "size": 1234567},
      {"key": "backup/wp-content.tar.gz", "size": 13456789},
      {"key": "backup/timestamp.txt", "size": 16}
    ],
    "totalSizeMB": "14.02",
    "lastBackup": "20260127_103000"
  },
  "endpoints": {
    "status": "/__status",
    "backupNow": "/__backup/now",
    "restoreNow": "/__restore/now",
    "reboot": "/__reboot"
  }
}
```

---

## Troubleshooting

### Common Issues

#### Data lost after redeployment

**Cause:** Backup didn't run before `npx wrangler deploy`

**Solution:**
Always backup before redeploying:
1. Visit `/__backup/now` to trigger backup
2. Wait 30 seconds
3. Check `/__status` to confirm `lastBackup` is recent
4. Then run `npx wrangler deploy`

**Prevention:** 
The auto-backup plugin now triggers backup after WordPress installation and major changes. But always verify backup status before redeploying.

#### Error: "Error establishing a database connection"

**Cause:** MariaDB not running or not ready

**Solution:**
1. Wait 2-3 minutes for container to fully initialize
2. Visit `/__reboot` to restart container
3. Check container logs in Cloudflare Dashboard

#### Error: "Worker threw exception" (Error 1101)

**Cause:** Worker code error

**Solution:**
1. Check `npx wrangler tail` for error details
2. Verify wrangler.jsonc configuration
3. Redeploy: `npx wrangler deploy`

#### Container keeps restarting

**Cause:** Startup script failing

**Solution:**
1. Check container logs in Cloudflare Dashboard
2. Enable observability in wrangler.jsonc:
   ```jsonc
   "observability": { "enabled": true }
   ```
3. Redeploy and check logs

#### Changes lost after restart

**Cause:** Backup didn't run before container stopped

**Solution:**
- Wait at least 5 minutes after making changes
- Consider reducing backup interval in Dockerfile

### Useful Commands

```bash
# View live logs
npx wrangler tail

# Check container status
npx wrangler containers list

# Redeploy
npx wrangler deploy

# List R2 files
curl https://your-site/r2/list
```

### Getting Help

1. Check Cloudflare Dashboard for container logs
2. Use `npx wrangler tail` for Worker logs
3. Visit Cloudflare Discord or Community Forums
4. Check GitHub issues: https://github.com/cloudflare/workers-sdk

---

## Cost Estimate

| Service | Free Tier | Overage |
|---------|-----------|---------|
| Workers | 100K requests/day | $0.50/million |
| Container | Usage-based | ~$0.02/hour running |
| R2 Storage | 10GB | $0.015/GB/month |
| R2 Operations | 1M Class A, 10M Class B | $4.50/million Class A |

**Estimated monthly cost for low-traffic personal site: $5-15**

---

## Security Recommendations

1. **Change default database password** in:
   - `container/config/wp-config.php`
   - `container/scripts/startup.sh`
   
2. **Generate new WordPress security keys:**
   - Visit: https://api.wordpress.org/secret-key/1.1/salt/
   - Replace keys in `wp-config.php`

3. **Use strong admin password**

4. **Install security plugin** (Wordfence, Sucuri)

5. **Keep WordPress updated**

6. **Enable Cloudflare security features:**
   - WAF rules
   - Bot protection
   - Rate limiting

---

## Custom Domain Setup

1. Add domain to Cloudflare (if not already)
2. In Workers & Pages settings, add Custom Domain
3. Or add route in wrangler.jsonc:
   ```jsonc
   "routes": [
     { "pattern": "yourdomain.com/*", "zone_name": "yourdomain.com" }
   ]
   ```
4. Redeploy: `npx wrangler deploy`
5. Update WordPress URLs in Settings → General

---

## Quick Start After Deployment

### Your WordPress URLs

| URL | Purpose |
|-----|---------|
| `https://your-site/` | Website homepage |
| `https://your-site/wp-admin` | Admin dashboard |
| `https://your-site/__status` | View container & backup status |
| `https://your-site/__backup/now` | Trigger manual backup |
| `https://your-site/__restore/now` | Trigger manual restore from R2 |
| `https://your-site/__reboot` | Restart container |

### First-Time Setup

1. **Complete Installation Wizard**
   - Select language
   - Set site title
   - Create admin username and password (**SAVE THIS!**)
   - Enter your email
   - Click "Install WordPress"

2. **Login to Admin Dashboard**
   - Visit `/wp-admin`
   - Login with credentials you just created

3. **Basic Operations**

   | Task | Location |
   |------|----------|
   | Write a blog post | Posts → Add New |
   | Create a page | Pages → Add New |
   | Change theme | Appearance → Themes |
   | Install plugins | Plugins → Add New |
   | Upload media | Media → Add New |
   | Site settings | Settings → General |

### Recommended First Steps

1. **Settings → General**: Set site title and tagline
2. **Settings → Permalinks**: Choose "Post name" for clean URLs
3. **Appearance → Themes**: Browse and install a theme you like
4. **Plugins → Add New**: Install essential plugins:
   - Yoast SEO (search optimization)
   - WPForms Lite (contact forms)
   - UpdraftPlus (additional backup)

---

## Development Guide

### Modifying This Project

**To modify Worker logic**: Edit `src/index.ts`

**To modify container configuration**:
- `container/Dockerfile` - Install new packages
- `container/config/wp-config.php` - WordPress settings
- `container/scripts/startup.sh` - Startup process

**After modifications, redeploy**:
```bash
npx wrangler deploy
```

### File Purposes

| File | Purpose |
|------|---------|
| `src/index.ts` | Cloudflare Worker - handles request routing and R2 API |
| `container/Dockerfile` | Defines the container image (Ubuntu + Apache + PHP + MariaDB) |
| `container/scripts/startup.sh` | Runs when container starts - initializes DB and starts services |
| `container/scripts/sync.sh` | Backup/restore script - syncs data with R2 |
| `container/config/wp-config.php` | WordPress database and security configuration |
| `container/config/__trigger_backup.php` | PHP script to trigger manual backup |
| `container/config/mu-plugins/r2-auto-backup.php` | Auto-backup plugin (triggers backup after install/changes) |
| `wrangler.jsonc` | Cloudflare deployment configuration |

### Important Security Notes

⚠️ **Before production use**:

1. Change database password in both files:
   - `container/config/wp-config.php` (line with `DB_PASSWORD`)
   - `container/scripts/startup.sh` (line with `IDENTIFIED BY`)

2. Generate new WordPress security keys:
   - Visit: https://api.wordpress.org/secret-key/1.1/salt/
   - Replace the keys in `wp-config.php`

3. This solution may lose up to 5 minutes of data (backup interval)
   - Suitable for personal/test projects
   - For production, consider managed WordPress hosting

---

## Container Sleep & Keep-Alive

### How Container Sleep Works

Cloudflare Containers automatically sleep after a period of inactivity to save resources. When a new request arrives, the container "wakes up" (cold start), which takes 30-60 seconds.

**Important:** Containers may also restart due to Cloudflare infrastructure updates, even with keep-alive configured. This is why auto-restore is essential.

```
Timeline without keep-alive:

0min ──── 30min ──── 60min ──── 90min ──── 120min
  │                    │                      │
Request            No activity            Container sleeps
  │                    │                      │
  └────── Active ──────┴──── Idle ────────────┴── Sleep (cold start on next request)
```

### Current Configuration

The project is configured with:

1. **Sleep timeout**: 168 hours / 7 days (`sleepAfter = "168h"` - maximum allowed)
2. **Cron keep-alive + backup**: Every 30 minutes (`*/30 * * * *` in `wrangler.jsonc`)
3. **Auto-restore**: Automatically restores from R2 when `install.php` is detected

```
Timeline with keep-alive and auto-restore:

0min ──── 30min ──── 60min ──── 90min ──── 120min
  │         │          │          │          │
  │       Cron       Cron       Cron       Cron
  │    (ping+backup) (ping+backup)  ...    (ping+backup)
  │         │          │          │          │
  └─────────┴──────────┴──────────┴──────────┴── Container stays active

If container restarts unexpectedly:
  │
  ▼
User visits site → WordPress shows install.php → Worker detects this
  │
  ▼
Auto-restore from R2 → Redirect to homepage → Site restored!
```

### Adjusting Sleep Behavior

#### Option 1: Change Sleep Timeout

Edit `src/index.ts`:

```typescript
export class WordPressContainer extends Container {
  sleepAfter = "168h";  // Current: 7 days (168 hours) - maximum allowed
  // sleepAfter = "2h";   // 2 hours
  // sleepAfter = "24h";  // 24 hours
}
```

**Note:** Use Go duration format: `"30m"`, `"2h"`, `"168h"`. Not `"7d"`.

#### Option 2: Adjust Cron Frequency

Edit `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["*/30 * * * *"]  // Current: every 30 minutes
}
```

**Common patterns:**

| Cron Expression | Description |
|-----------------|-------------|
| `*/30 * * * *` | Every 30 minutes (current) |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 */2 * * *` | Every 2 hours |
| `0 9-22 * * *` | Every hour from 9am to 10pm only |
| `0 9,12,18 * * *` | At 9am, 12pm, and 6pm only |

#### Option 3: Disable Keep-Alive (Save Money)

To let the container sleep naturally, remove the cron trigger from `wrangler.jsonc`:

```jsonc
// Remove this section:
"triggers": {
  "crons": ["*/30 * * * *"]
},
```

And remove the `scheduled` function from `src/index.ts`.

### Cost Considerations

| Mode | Behavior | Cost | Best For |
|------|----------|------|----------|
| Always-on (with cron) | Never sleeps | Higher | Production sites, frequent visitors |
| Business hours only | Sleeps at night | Medium | Business websites |
| Natural sleep | Sleeps after 2h idle | Lower | Personal blogs, low traffic |

**Tip**: For personal projects with low traffic, consider using business-hours-only cron to balance cost and responsiveness:

```jsonc
"triggers": {
  "crons": ["0 9-22 * * *"]  // Keep alive 9am-10pm only
}
```

### After Making Changes

Always redeploy after modifying these settings:

```bash
npx wrangler deploy
```

---

## Command Reference

```bash
# Deploy or update
npx wrangler deploy

# View live logs
npx wrangler tail

# Check container status
npx wrangler containers list

# Login to Cloudflare
npx wrangler login

# Create R2 bucket
npx wrangler r2 bucket create wordpress-data

# List R2 buckets
npx wrangler r2 bucket list
```

---

## Version History

- v1.0.0 - Initial deployment with R2 backup
