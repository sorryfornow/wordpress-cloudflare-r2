import { Container } from "@cloudflare/containers";

interface Env {
  WORDPRESS: DurableObjectNamespace<WordPressContainer>;
  DATA_BUCKET: R2Bucket;
}

// ============================================================
// Event types
// ============================================================
type EventType =
  | "CONTAINER_RECYCLED"
  | "RESTORE_START"
  | "RESTORE_SUCCESS"
  | "RESTORE_FAILED"
  | "RESTORE_SKIPPED"
  | "BACKUP_COMPLETE"
  | "BACKUP_FAILED"
  | "MANUAL_RESTORE"
  | "MANUAL_BACKUP"
  | "SNAPSHOT_HOURLY"   // hourly snapshot written to snapshots/hourly/
  | "SNAPSHOT_DAILY";   // daily snapshot written to snapshots/daily/

interface LogEvent {
  time: string;
  type: EventType;
  [key: string]: unknown;
}

// ============================================================
// Backup intervals (all in ms)
// ============================================================
const DB_BACKUP_INTERVAL      = 10 * 60 * 1000;        // 10 minutes
const WP_CONTENT_INTERVAL     =  6 * 60 * 60 * 1000;   //  6 hours
const HOURLY_SNAPSHOT_INTERVAL =  1 * 60 * 60 * 1000;  //  1 hour
const DAILY_SNAPSHOT_INTERVAL  = 24 * 60 * 60 * 1000;  // 24 hours

const HOURLY_SNAPSHOTS_TO_KEEP = 24;
const DAILY_SNAPSHOTS_TO_KEEP  =  7;

// ============================================================
// Log retention
// ============================================================
const RETENTION_DAYS = 30;

async function logEvent(
  bucket: R2Bucket,
  type: EventType,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    const event: LogEvent = { time: new Date().toISOString(), type, ...details };

    let events: LogEvent[] = [];
    try {
      const existing = await bucket.get("logs/events.json");
      if (existing) events = JSON.parse(await existing.text());
    } catch { events = []; }

    events.unshift(event);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    events = events.filter(e => new Date(e.time).getTime() >= cutoff);

    await bucket.put("logs/events.json", JSON.stringify(events, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    console.log(`[LOG] Event recorded: ${type} at ${event.time}`);
  } catch (e) {
    console.error("[LOG] Failed to write event log:", e);
  }
}

// ============================================================
// Snapshot helpers
// ============================================================

// Check whether enough time has elapsed since the last operation,
// using a timestamp file stored in R2.
// Returns true on first run (file missing → lastTime = 0).
async function shouldRun(bucket: R2Bucket, timestampKey: string, interval: number): Promise<boolean> {
  try {
    const obj = await bucket.get(timestampKey);
    const lastTime = obj ? new Date(await obj.text()).getTime() : 0;
    return (Date.now() - lastTime) >= interval;
  } catch {
    return true;
  }
}

async function writeTimestamp(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.put(key, new Date().toISOString());
}

// Copy a single R2 object from src key to dst key.
async function copyR2Object(bucket: R2Bucket, srcKey: string, dstKey: string): Promise<boolean> {
  try {
    const obj = await bucket.get(srcKey);
    if (!obj) return false;
    const data = await obj.arrayBuffer();
    await bucket.put(dstKey, data);
    return true;
  } catch {
    return false;
  }
}

// Prune old snapshot folders under a given prefix, keeping only the newest N.
// Folder names must sort lexicographically (YYYYMMDDHH or YYYYMMDD format).
async function pruneSnapshots(bucket: R2Bucket, prefix: string, keep: number): Promise<void> {
  try {
    const listed = await bucket.list({ prefix, delimiter: "/" });
    // listed.delimitedPrefixes gives us the "folder" names
    const folders = (listed.delimitedPrefixes ?? []).sort(); // oldest first
    const toDelete = folders.slice(0, Math.max(0, folders.length - keep));
    for (const folder of toDelete) {
      // List all objects inside this folder and delete them
      const contents = await bucket.list({ prefix: folder });
      for (const obj of contents.objects) {
        await bucket.delete(obj.key);
      }
      console.log(`[SNAPSHOT] Pruned old snapshot: ${folder}`);
    }
  } catch (e) {
    console.error("[SNAPSHOT] Prune error:", e);
  }
}

// Take an hourly snapshot: copy latest database.sql to snapshots/hourly/YYYYMMDDHH/
async function takeHourlySnapshot(bucket: R2Bucket): Promise<void> {
  const now = new Date();
  const folder = now.toISOString().slice(0, 13).replace(/[-T:]/g, ""); // e.g. 2026031102
  const prefix = `snapshots/hourly/${folder}/`;

  const ok = await copyR2Object(bucket, "backup/database.sql", `${prefix}database.sql`);
  if (ok) {
    await writeTimestamp(bucket, "backup/hourly-snapshot-timestamp.txt");
    await pruneSnapshots(bucket, "snapshots/hourly/", HOURLY_SNAPSHOTS_TO_KEEP);
    await logEvent(bucket, "SNAPSHOT_HOURLY", { folder, files: ["database.sql"] });
    console.log(`[SNAPSHOT] Hourly snapshot taken: ${folder}`);
  }
}

// Take a daily snapshot: copy latest database.sql + wp-content to snapshots/daily/YYYYMMDD/
async function takeDailySnapshot(bucket: R2Bucket): Promise<void> {
  const now = new Date();
  const folder = now.toISOString().slice(0, 10).replace(/-/g, ""); // e.g. 20260311
  const prefix = `snapshots/daily/${folder}/`;

  const files: string[] = [];
  if (await copyR2Object(bucket, "backup/database.sql",      `${prefix}database.sql`))      files.push("database.sql");
  if (await copyR2Object(bucket, "backup/wp-content.tar.gz", `${prefix}wp-content.tar.gz`)) files.push("wp-content.tar.gz");
  if (await copyR2Object(bucket, "backup/timestamp.txt",     `${prefix}timestamp.txt`))      files.push("timestamp.txt");

  if (files.length > 0) {
    await writeTimestamp(bucket, "backup/daily-snapshot-timestamp.txt");
    await pruneSnapshots(bucket, "snapshots/daily/", DAILY_SNAPSHOTS_TO_KEEP);
    await logEvent(bucket, "SNAPSHOT_DAILY", { folder, files });
    console.log(`[SNAPSHOT] Daily snapshot taken: ${folder}`);
  }
}

// ============================================================
// WordPress Container
// ============================================================
export class WordPressContainer extends Container {
  defaultPort = 80;
  sleepAfter = "168h";
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    console.log(`[CONTAINER] Constructor called at ${new Date().toISOString()}`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    console.log(`[REQUEST] ${request.method} ${pathname} at ${new Date().toISOString()}`);

    // ── R2 passthrough API ────────────────────────────────────
    if (pathname === "/r2/list") {
      try {
        const listed = await this.env.DATA_BUCKET.list();
        return Response.json({ files: listed.objects.map(obj => ({ key: obj.key, size: obj.size, uploaded: obj.uploaded })) });
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    if (pathname.startsWith("/r2/get/")) {
      try {
        const key = decodeURIComponent(pathname.replace("/r2/get/", ""));
        const object = await this.env.DATA_BUCKET.get(key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(object.size) },
        });
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    if (pathname.startsWith("/r2/put/") && request.method === "PUT") {
      try {
        const key = decodeURIComponent(pathname.replace("/r2/put/", ""));
        const body = await request.arrayBuffer();
        await this.env.DATA_BUCKET.put(key, body);
        return Response.json({ success: true, key, size: body.byteLength });
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    // ── Status ────────────────────────────────────────────────
    if (pathname === "/__status") {
      try {
        const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
        const totalSize = r2List.objects.reduce((sum, obj) => sum + obj.size, 0);
        let lastBackup = "Never";
        try {
          const ts = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
          if (ts) lastBackup = (await ts.text()).trim();
        } catch {}
        const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
        const isValidBackup = dbBackup && dbBackup.size >= 50 * 1024;
        return Response.json({
          status: "running",
          containerInfo: { sleepAfter: "168h (7 days)", cronSchedule: "*/2 * * * * (every 2 minutes)" },
          backup: {
            files: r2List.objects.length,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            lastBackup, isValid: isValidBackup,
            intervals: { database: "every 10 minutes", wpContent: "every 6 hours" },
          },
          snapshots: { hourly: `last ${HOURLY_SNAPSHOTS_TO_KEEP} hours`, daily: `last ${DAILY_SNAPSHOTS_TO_KEEP} days` },
          endpoints: {
            status: "/__status", logs: "/__logs", snapshots: "/__snapshots",
            backupNow: "/__backup/now", restoreNow: "/__restore/now",
            restoreFrom: "/__restore?from=hourly/YYYYMMDDHH or daily/YYYYMMDD",
            reboot: "/__reboot",
          },
        });
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    // ── Event log ─────────────────────────────────────────────
    if (pathname === "/__logs") {
      try {
        const logsObj = await this.env.DATA_BUCKET.get("logs/events.json");
        if (!logsObj) return Response.json({ events: [], total: 0 }, { headers: { "Access-Control-Allow-Origin": "*" } });
        const events: LogEvent[] = JSON.parse(await logsObj.text());
        const filterType = url.searchParams.get("type");
        const filtered = filterType ? events.filter(e => e.type === filterType) : events;
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        return Response.json(
          { events: filtered.slice(0, limit), total: events.length, filtered: filtered.length, showing: Math.min(limit, filtered.length) },
          { headers: { "Access-Control-Allow-Origin": "*" } }
        );
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    // ── Snapshot list ─────────────────────────────────────────
    if (pathname === "/__snapshots") {
      try {
        const [hourly, daily] = await Promise.all([
          this.env.DATA_BUCKET.list({ prefix: "snapshots/hourly/", delimiter: "/" }),
          this.env.DATA_BUCKET.list({ prefix: "snapshots/daily/",  delimiter: "/" }),
        ]);
        return Response.json({
          hourly: (hourly.delimitedPrefixes ?? []).sort().reverse().map(p => p.replace("snapshots/hourly/", "").replace("/", "")),
          daily:  (daily.delimitedPrefixes  ?? []).sort().reverse().map(p => p.replace("snapshots/daily/",  "").replace("/", "")),
          restoreExample: "/__restore?from=hourly/2026031102  or  /__restore?from=daily/20260311",
        }, { headers: { "Access-Control-Allow-Origin": "*" } });
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    }

    // ── Manual backup ─────────────────────────────────────────
    if (pathname === "/__backup/now") return await this.handleBackup(request);

    // ── Restore (manual, with optional ?from= param) ──────────
    if (pathname === "/__restore/now" || pathname === "/__restore") {
      return await this.handleRestore(request);
    }

    // ── Reboot ────────────────────────────────────────────────
    if (pathname === "/__reboot") {
      return new Response("Reboot requested. Please wait 2 minutes and refresh.", { headers: { "Content-Type": "text/plain" } });
    }

    // ── AUTO-RESTORE: intercept install.php ───────────────────
    if (pathname.includes("install.php")) {
      console.log("[AUTO-RESTORE] ====== DETECTED INSTALL.PHP ======");

      await logEvent(this.env.DATA_BUCKET, "CONTAINER_RECYCLED", {
        url: request.url,
        userAgent: request.headers.get("user-agent") || "unknown",
        message: "install.php accessed — container recycled and lost state",
      });

      const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
      const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
      const hasValidBackup = dbBackup && dbBackup.size >= 50 * 1024 && r2List.objects.length >= 2;

      let snapshotTime = "unknown";
      try {
        const tsObj = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
        if (tsObj) snapshotTime = (await tsObj.text()).trim();
      } catch {}

      if (!hasValidBackup) {
        await logEvent(this.env.DATA_BUCKET, "RESTORE_SKIPPED", {
          reason: dbBackup ? "database.sql too small" : "No backup in R2 — fresh install",
          dbSize: dbBackup?.size ?? 0,
        });
        // No valid backup — fall through to WordPress install wizard
      } else {
        await logEvent(this.env.DATA_BUCKET, "RESTORE_START", {
          trigger: "auto (install.php)", snapshotTimestamp: snapshotTime,
        });

        const origin = new URL(request.url).origin;

        return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Site is waking up…</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #fff; max-width: 440px; width: 100%;
      padding: 48px 40px; text-align: center; border-top: 4px solid #1a1a1a;
    }
    .spinner {
      width: 36px; height: 36px; border: 3px solid #e0e0e0;
      border-top-color: #1a1a1a; border-radius: 50%;
      margin: 0 auto 28px; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.2em; font-weight: 600; color: #1a1a1a; margin-bottom: 10px; }
    .sub { font-size: 0.9em; color: #777; line-height: 1.6; margin-bottom: 24px; }
    .snapshot { font-size: 0.78em; color: #aaa; font-family: 'Courier New', monospace; margin-bottom: 28px; }
    .status-row { display: flex; align-items: center; gap: 10px; background: #f8f8f8; padding: 10px 14px; font-size: 0.82em; color: #555; margin-bottom: 8px; text-align: left; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #ccc; }
    .dot.active { background: #4caf50; animation: pulse 1s ease-in-out infinite; }
    .dot.done   { background: #4caf50; }
    .dot.error  { background: #f44336; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .success-msg { display:none; color: #2e7d32; font-weight:600; margin-bottom:10px; }
    .error-msg   { display:none; color: #c62828; font-size:0.85em; margin-top:16px; }
    .manual { margin-top: 24px; font-size: 0.8em; color: #bbb; }
    .manual a { color: #888; }
  </style>
</head>
<body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <div class="success-msg" id="successMsg">✅ Restored! Redirecting…</div>
  <h1>The site is waking up</h1>
  <p class="sub">The server was recycled and is being restored from the latest backup. This usually takes 30–60 seconds.</p>
  <p class="snapshot">Snapshot: ${snapshotTime}</p>
  <div class="status-row"><div class="dot done"></div>Backup found in R2</div>
  <div class="status-row"><div class="dot active" id="dotRestore"></div><span id="msgRestore">Restoring from snapshot…</span></div>
  <div class="status-row" style="opacity:0.4"><div class="dot" id="dotReady"></div><span id="msgReady">Waiting for site to come online…</span></div>
  <div class="error-msg" id="errorMsg">Restore is taking longer than expected. <a href="/">Try refreshing manually</a>.</div>
  <p class="manual">You can also <a href="/__restore/now">trigger a restore manually</a>.</p>
</div>
<script>
(function () {
  var origin = '${origin}';
  var giveUpAt = Date.now() + 3 * 60 * 1000;
  fetch(origin + '/__restore/now').then(function (r) {
    document.getElementById('dotRestore').className = 'dot done';
    document.getElementById('msgRestore').textContent = r.ok ? 'Restore complete' : 'Restore finished (check logs)';
  }).catch(function () {
    document.getElementById('dotRestore').className = 'dot done';
  });
  function tryReady() {
    if (Date.now() > giveUpAt) {
      document.getElementById('errorMsg').style.display = 'block';
      document.getElementById('spinner').style.display = 'none';
      return;
    }
    document.getElementById('dotReady').className = 'dot active';
    document.getElementById('msgReady').textContent = 'Waiting for site to come online…';
    document.querySelector('.status-row:last-of-type').style.opacity = '1';
    fetch(origin + '/__status').then(function (r) { return r.json(); }).then(function (data) {
      if (data.status === 'running') {
        document.getElementById('dotReady').className = 'dot done';
        document.getElementById('msgReady').textContent = 'Site is online!';
        document.getElementById('successMsg').style.display = 'block';
        document.getElementById('spinner').style.display = 'none';
        setTimeout(function () { window.location.href = '/'; }, 2000);
      } else { setTimeout(tryReady, 5000); }
    }).catch(function () { setTimeout(tryReady, 5000); });
  }
  setTimeout(tryReady, 8000);
})();
</script>
</body>
</html>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }

    // Forward to container
    try {
      return await this.containerFetch(request);
    } catch (error) {
      return new Response(`Container error: ${String(error)}`, { status: 500 });
    }
  }

  // ── Manual backup ───────────────────────────────────────────
  private async handleBackup(request: Request): Promise<Response> {
    const results: string[] = [];
    await logEvent(this.env.DATA_BUCKET, "MANUAL_BACKUP", { trigger: "manual /__backup/now" });

    try {
      results.push("Step 1: Generating backup files...");
      const generateResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=generate", request.url).toString())
      );
      const generateResult = await generateResponse.text();
      results.push(generateResult);

      if (!generateResult.includes("Backup Files Ready")) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "Generation failed", output: generateResult.slice(0, 500) });
        return new Response(`Backup generation failed:\n\n${results.join("\n")}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      results.push("\nStep 2: Validating...");
      const dbResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=database.sql", request.url).toString())
      );
      if (!dbResponse.ok) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "Failed to fetch database.sql" });
        return new Response(results.join("\n"), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      const dbData = await dbResponse.arrayBuffer();
      if (dbData.byteLength < 50 * 1024) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "database.sql too small", size: dbData.byteLength });
        return new Response(results.join("\n"), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      results.push(`✅ database.sql: ${(dbData.byteLength / 1024).toFixed(1)} KB`);
      results.push("\nStep 3: Uploading to R2...");

      await this.env.DATA_BUCKET.put("backup/database.sql", dbData);
      await writeTimestamp(this.env.DATA_BUCKET, "backup/db-timestamp.txt");
      results.push(`  ✅ database.sql uploaded`);

      const wpResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=wp-content.tar.gz", request.url).toString())
      );
      if (wpResponse.ok) {
        const wpData = await wpResponse.arrayBuffer();
        await this.env.DATA_BUCKET.put("backup/wp-content.tar.gz", wpData);
        await writeTimestamp(this.env.DATA_BUCKET, "backup/wp-content-timestamp.txt");
        results.push(`  ✅ wp-content.tar.gz uploaded (${(wpData.byteLength / 1024).toFixed(1)} KB)`);
      }

      const tsResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=timestamp.txt", request.url).toString())
      );
      if (tsResponse.ok) await this.env.DATA_BUCKET.put("backup/timestamp.txt", await tsResponse.arrayBuffer());

      let snapshotTime = new Date().toISOString();
      try { const tsObj = await this.env.DATA_BUCKET.get("backup/timestamp.txt"); if (tsObj) snapshotTime = (await tsObj.text()).trim(); } catch {}

      await logEvent(this.env.DATA_BUCKET, "BACKUP_COMPLETE", {
        trigger: "manual /__backup/now", snapshotTimestamp: snapshotTime, dbSizeKB: (dbData.byteLength / 1024).toFixed(1),
      });

      results.push("\n=== Backup Complete ===");
      return new Response(results.join("\n"), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (error) {
      await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { error: String(error) });
      return new Response(`Backup failed: ${String(error)}`, { status: 500 });
    }
  }

  // ── Restore (supports ?from=hourly/YYYYMMDDHH or ?from=daily/YYYYMMDD) ──
  private async handleRestore(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from"); // e.g. "hourly/2026031102" or "daily/20260311"

    await logEvent(this.env.DATA_BUCKET, "MANUAL_RESTORE", {
      trigger: "manual /__restore",
      from: fromParam ?? "latest",
    });
    await logEvent(this.env.DATA_BUCKET, "RESTORE_START", {
      trigger: "manual /__restore",
      from: fromParam ?? "latest",
    });

    const result = await this.performRestore(request.url, fromParam ?? null);

    if (result.success) {
      let snapshotTime = "unknown";
      try {
        const key = fromParam ? `snapshots/${fromParam}/timestamp.txt` : "backup/timestamp.txt";
        const tsObj = await this.env.DATA_BUCKET.get(key);
        if (tsObj) snapshotTime = (await tsObj.text()).trim();
      } catch {}
      await logEvent(this.env.DATA_BUCKET, "RESTORE_SUCCESS", {
        trigger: "manual /__restore", from: fromParam ?? "latest", snapshotTimestamp: snapshotTime,
      });
    } else {
      await logEvent(this.env.DATA_BUCKET, "RESTORE_FAILED", {
        trigger: "manual /__restore", from: fromParam ?? "latest", message: result.message.slice(0, 500),
      });
    }

    return new Response(
      `=== Restore (from: ${fromParam ?? "latest"}) ===\n\n${result.message}\n\n${result.success ? "✅ Restore Complete!" : "❌ Restore Failed"}`,
      { status: result.success ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // ── Core restore logic ─────────────────────────────────────
  // fromSnapshot: null = use backup/  |  "hourly/YYYYMMDDHH" or "daily/YYYYMMDD" = use snapshots/
  private async performRestore(baseUrl: string, fromSnapshot: string | null): Promise<{ success: boolean; message: string }> {
    const logs: string[] = [];
    const prefix = fromSnapshot ? `snapshots/${fromSnapshot}/` : "backup/";

    try {
      const r2List = await this.env.DATA_BUCKET.list({ prefix });
      logs.push(`R2 files at ${prefix}: ${r2List.objects.length}`);
      if (r2List.objects.length === 0) return { success: false, message: `No backup found at ${prefix}` };
      for (const obj of r2List.objects) logs.push(`  - ${obj.key} (${(obj.size / 1024).toFixed(1)} KB)`);
      logs.push("");

      for (const file of ["database.sql", "wp-content.tar.gz", "timestamp.txt"]) {
        try {
          const r2Object = await this.env.DATA_BUCKET.get(`${prefix}${file}`);
          if (!r2Object) { logs.push(`⚠️ No ${file}, skipping`); continue; }
          const fileData = await r2Object.arrayBuffer();
          logs.push(`Pushing ${file} (${(fileData.byteLength / 1024).toFixed(1)} KB)...`);
          const restoreResponse = await this.containerFetch(
            new Request(new URL(`/__trigger_backup.php?action=restore&file=${file}`, baseUrl).toString(), {
              method: "POST", body: fileData, headers: { "Content-Type": "application/octet-stream" }
            })
          );
          logs.push(restoreResponse.ok ? `  ✅ ${file} pushed` : `  ❌ Failed: ${restoreResponse.status}`);
        } catch (e) { logs.push(`  ❌ Error: ${String(e)}`); }
      }

      logs.push("\nApplying restore...");
      const applyResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=apply", baseUrl).toString())
      );
      const applyResult = await applyResponse.text();
      logs.push(applyResult);
      const success = applyResult.includes("Database restored") || applyResult.includes("✅");
      return { success, message: logs.join("\n") };
    } catch (error) {
      return { success: false, message: logs.join("\n") + `\nError: ${String(error)}` };
    }
  }
}

// ============================================================
// Worker entry point
// ============================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const containerId = env.WORDPRESS.idFromName("main");
      const container = env.WORDPRESS.get(containerId);
      return await container.fetch(request);
    } catch (error) {
      return new Response(`Worker error: ${String(error)}`, { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] ====== SCHEDULED TASK STARTED ====== ${new Date().toISOString()}`);
    let keepAliveSuccess = false;

    try {
      const containerId = env.WORDPRESS.idFromName("main");
      const container = env.WORDPRESS.get(containerId);

      // ── Keep-alive ping ───────────────────────────────────
      try {
        const pingResponse = await container.fetch(new Request("https://localhost/__status"));
        keepAliveSuccess = pingResponse.ok;
        console.log(`[CRON] Keep-alive ping: ${pingResponse.status}`);
      } catch {
        try { await container.fetch(new Request("https://localhost/")); keepAliveSuccess = true; }
        catch (e) { console.error("[CRON] Simple ping failed:", e); }
      }

      if (!keepAliveSuccess) { console.log("[CRON] Container unreachable, skipping"); return; }

      // ── Check WordPress state ─────────────────────────────
      let shouldBackup = false;
      try {
        const checkResponse = await container.fetch(
          new Request("https://localhost/__trigger_backup.php?action=check")
        );
        if (checkResponse.ok) {
          const checkData = await checkResponse.json() as { needsRestore: boolean };

          if (checkData.needsRestore) {
            // ── Proactive restore ───────────────────────────
            console.log("[CRON] ⚠️ WordPress needs restore — triggering proactive restore...");
            await logEvent(env.DATA_BUCKET, "CONTAINER_RECYCLED", {
              trigger: "cron detected",
              message: "needsRestore=true detected by cron — container was recycled",
            });

            const r2List = await env.DATA_BUCKET.list({ prefix: "backup/" });
            const dbBackup = r2List.objects.find(o => o.key === "backup/database.sql");
            const hasValidBackup = dbBackup && dbBackup.size >= 50 * 1024 && r2List.objects.length >= 2;

            if (!hasValidBackup) {
              await logEvent(env.DATA_BUCKET, "RESTORE_SKIPPED", {
                trigger: "cron", reason: dbBackup ? "database.sql too small" : "No backup in R2",
              });
              return;
            }

            await logEvent(env.DATA_BUCKET, "RESTORE_START", { trigger: "cron (proactive)" });
            try {
              const restoreResponse = await container.fetch(new Request("https://localhost/__restore/now"));
              const restoreText = await restoreResponse.text();
              const success = restoreResponse.ok && restoreText.includes("✅");
              if (success) {
                let snapshotTime = "unknown";
                try { const tsObj = await env.DATA_BUCKET.get("backup/timestamp.txt"); if (tsObj) snapshotTime = (await tsObj.text()).trim(); } catch {}
                console.log(`[CRON] ✅ Proactive restore complete. Snapshot: ${snapshotTime}`);
                await logEvent(env.DATA_BUCKET, "RESTORE_SUCCESS", { trigger: "cron (proactive)", snapshotTimestamp: snapshotTime });
              } else {
                await logEvent(env.DATA_BUCKET, "RESTORE_FAILED", { trigger: "cron (proactive)", message: restoreText.slice(0, 500) });
              }
            } catch (e) {
              await logEvent(env.DATA_BUCKET, "RESTORE_FAILED", { trigger: "cron (proactive)", error: String(e) });
            }
            return; // Skip backup this cycle — let next cycle confirm everything is stable
          } else {
            shouldBackup = true;
          }
        }
      } catch { shouldBackup = true; }

      if (!shouldBackup) return;

      // ── Incremental backup ────────────────────────────────
      try {
        const [shouldBackupDb, shouldBackupWp] = await Promise.all([
          shouldRun(env.DATA_BUCKET, "backup/db-timestamp.txt",         DB_BACKUP_INTERVAL),
          shouldRun(env.DATA_BUCKET, "backup/wp-content-timestamp.txt", WP_CONTENT_INTERVAL),
        ]);

        if (!shouldBackupDb && !shouldBackupWp) {
          console.log("[CRON] No backup due this cycle, skipping");
          // Still check for snapshot duties below
        } else {
          // Generate backup files in container
          const generateResponse = await container.fetch(
            new Request("https://localhost/__trigger_backup.php?action=generate")
          );
          if (!generateResponse.ok || !(await generateResponse.text()).includes("Backup Files Ready")) {
            await logEvent(env.DATA_BUCKET, "BACKUP_FAILED", { trigger: "cron", reason: "generate failed" });
            return;
          }

          // Database (every 10 min)
          if (shouldBackupDb) {
            const dbRes = await container.fetch(new Request("https://localhost/__trigger_backup.php?action=get&file=database.sql"));
            if (dbRes.ok) {
              const dbData = await dbRes.arrayBuffer();
              if (dbData.byteLength < 50 * 1024) {
                await logEvent(env.DATA_BUCKET, "BACKUP_FAILED", { trigger: "cron", reason: "database.sql too small", size: dbData.byteLength });
                return;
              }
              await env.DATA_BUCKET.put("backup/database.sql", dbData);
              await writeTimestamp(env.DATA_BUCKET, "backup/db-timestamp.txt");
              console.log(`[CRON] ✅ database.sql backed up (${dbData.byteLength} bytes)`);
            }
          }

          // wp-content (every 6 hours)
          if (shouldBackupWp) {
            const wpRes = await container.fetch(new Request("https://localhost/__trigger_backup.php?action=get&file=wp-content.tar.gz"));
            if (wpRes.ok) {
              const wpData = await wpRes.arrayBuffer();
              await env.DATA_BUCKET.put("backup/wp-content.tar.gz", wpData);
              await writeTimestamp(env.DATA_BUCKET, "backup/wp-content-timestamp.txt");
              console.log(`[CRON] ✅ wp-content.tar.gz backed up (${wpData.byteLength} bytes)`);
            }
          }

          // Always update main timestamp
          const tsRes = await container.fetch(new Request("https://localhost/__trigger_backup.php?action=get&file=timestamp.txt"));
          if (tsRes.ok) await env.DATA_BUCKET.put("backup/timestamp.txt", await tsRes.arrayBuffer());

          let snapshotTime = new Date().toISOString();
          try { const tsObj = await env.DATA_BUCKET.get("backup/timestamp.txt"); if (tsObj) snapshotTime = (await tsObj.text()).trim(); } catch {}

          await logEvent(env.DATA_BUCKET, "BACKUP_COMPLETE", {
            trigger: "cron", snapshotTimestamp: snapshotTime,
            dbBackedUp: shouldBackupDb, wpContentBackedUp: shouldBackupWp,
          });
          console.log(`[CRON] ====== BACKUP COMPLETED ====== ${new Date().toISOString()}`);
        }

        // ── Snapshot duties (independent of backup) ─────────
        const [shouldHourly, shouldDaily] = await Promise.all([
          shouldRun(env.DATA_BUCKET, "backup/hourly-snapshot-timestamp.txt", HOURLY_SNAPSHOT_INTERVAL),
          shouldRun(env.DATA_BUCKET, "backup/daily-snapshot-timestamp.txt",  DAILY_SNAPSHOT_INTERVAL),
        ]);

        if (shouldHourly) await takeHourlySnapshot(env.DATA_BUCKET);
        if (shouldDaily)  await takeDailySnapshot(env.DATA_BUCKET);

      } catch (e) {
        await logEvent(env.DATA_BUCKET, "BACKUP_FAILED", { trigger: "cron", error: String(e) });
      }

    } catch (error) {
      console.error("[CRON] SCHEDULED TASK FAILED:", error);
    }
    console.log(`[CRON] ====== SCHEDULED TASK ENDED ====== ${new Date().toISOString()}`);
  },
};
