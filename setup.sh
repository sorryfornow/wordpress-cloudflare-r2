#!/bin/bash
# ============================================================
# WordPress Cloudflare R2 — Interactive Setup & Deploy Script
# ============================================================

set -e

# ── Colors ──────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BOLD}WordPress on Cloudflare Containers + R2${NC}"
echo -e "${BOLD}Interactive Setup Script${NC}"
echo "──────────────────────────────────────────"
echo ""

# ── Step 1: Collect inputs ───────────────────────────────────
echo -e "${CYAN}Step 1: Project Configuration${NC}"
echo ""

# Worker name
read -p "Worker name (e.g. wordpress-r2, wordpress-blog2) [wordpress-r2]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-wordpress-r2}"

# R2 bucket name
DEFAULT_BUCKET="${WORKER_NAME}-data"
read -p "R2 bucket name [${DEFAULT_BUCKET}]: " BUCKET_NAME
BUCKET_NAME="${BUCKET_NAME:-$DEFAULT_BUCKET}"

# Custom domain (optional)
read -p "Custom domain (optional, press Enter to skip): " CUSTOM_DOMAIN

echo ""
echo -e "${YELLOW}Summary:${NC}"
echo "  Worker name : ${BOLD}${WORKER_NAME}${NC}"
echo "  R2 bucket   : ${BOLD}${BUCKET_NAME}${NC}"
if [ -n "$CUSTOM_DOMAIN" ]; then
  echo "  Custom domain: ${BOLD}${CUSTOM_DOMAIN}${NC}"
fi
echo ""

read -p "Proceed? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

# ── Step 2: Update wrangler.jsonc ────────────────────────────
echo -e "${CYAN}Step 2: Updating wrangler.jsonc...${NC}"

# Use node to safely edit the JSONC (strips comments for editing, rewrites cleanly)
node - << NODEEOF
const fs = require('fs');
const path = 'wrangler.jsonc';

let raw = fs.readFileSync(path, 'utf8');

// Strip single-line comments so JSON.parse works
const stripped = raw.replace(/\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');

let config;
try {
  config = JSON.parse(stripped);
} catch (e) {
  console.error('Failed to parse wrangler.jsonc:', e.message);
  process.exit(1);
}

config.name = '${WORKER_NAME}';
config.r2_buckets[0].bucket_name = '${BUCKET_NAME}';

// Write back with preserved schema comment
const output = JSON.stringify(config, null, 2)
  .replace('"\\$schema"', '"\\$schema"'); // keep key intact

fs.writeFileSync(path, output, 'utf8');
console.log('  wrangler.jsonc updated.');
NODEEOF

echo ""

# ── Step 3: Install dependencies ─────────────────────────────
echo -e "${CYAN}Step 3: Installing dependencies...${NC}"
npm install
echo ""

# ── Step 4: Wrangler login check ─────────────────────────────
echo -e "${CYAN}Step 4: Checking Cloudflare login...${NC}"
if ! npx wrangler whoami &>/dev/null; then
  echo "  Not logged in. Opening browser for authentication..."
  npx wrangler login
else
  echo -e "  ${GREEN}Already logged in.${NC}"
fi
echo ""

# ── Step 5: Create R2 bucket ─────────────────────────────────
echo -e "${CYAN}Step 5: Creating R2 bucket '${BUCKET_NAME}'...${NC}"
if npx wrangler r2 bucket create "${BUCKET_NAME}" 2>&1 | grep -q "already exists\|Created"; then
  echo -e "  ${GREEN}Bucket ready.${NC}"
else
  npx wrangler r2 bucket create "${BUCKET_NAME}" || true
fi
echo ""

# ── Step 6: Deploy ───────────────────────────────────────────
echo -e "${CYAN}Step 6: Deploying (first deploy may take 5-10 minutes)...${NC}"
echo ""
npx wrangler deploy

echo ""
echo "──────────────────────────────────────────"
echo -e "${GREEN}${BOLD}Deployment complete!${NC}"
echo ""
echo -e "Your site endpoints:"
echo -e "  ${BOLD}https://${WORKER_NAME}.workers.dev/${NC}"
echo -e "  ${BOLD}https://${WORKER_NAME}.workers.dev/__status${NC}"
echo -e "  ${BOLD}https://${WORKER_NAME}.workers.dev/__logs${NC}"
if [ -n "$CUSTOM_DOMAIN" ]; then
  echo ""
  echo -e "${YELLOW}Custom domain '${CUSTOM_DOMAIN}' was entered.${NC}"
  echo -e "To bind it, go to:"
  echo -e "  Cloudflare Dashboard → Workers & Pages → ${WORKER_NAME} → Custom Domains"
fi
echo ""
echo -e "Visit your site and complete the WordPress installation wizard."
echo "──────────────────────────────────────────"
