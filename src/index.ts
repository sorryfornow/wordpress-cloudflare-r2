import { Container } from "@cloudflare/containers";

interface Env {
  WORDPRESS: DurableObjectNamespace<WordPressContainer>;
  DATA_BUCKET: R2Bucket;
}

// ============================================================
// 持久化事件日志 — 写入 R2 的 logs/events.json
// Persistent event log — writes to R2 logs/events.json
// ============================================================
type EventType =
  | "CONTAINER_RECYCLED"   // install.php 被访问，容器已回收
  | "RESTORE_START"        // 开始从 R2 镜像恢复
  | "RESTORE_SUCCESS"      // 镜像恢复成功
  | "RESTORE_FAILED"       // 镜像恢复失败
  | "RESTORE_SKIPPED"      // 备份无效，跳过恢复
  | "BACKUP_COMPLETE"      // 备份写入 R2 成功
  | "BACKUP_FAILED"        // 备份失败
  | "MANUAL_RESTORE"       // 手动触发恢复
  | "MANUAL_BACKUP";       // 手动触发备份

interface LogEvent {
  time: string;
  type: EventType;
  [key: string]: unknown;
}

// 保留最近 90 天的事件，无条数上限
// Keep events from the last 90 days, no entry count cap
const RETENTION_DAYS = 90;

async function logEvent(
  bucket: R2Bucket,
  type: EventType,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    const event: LogEvent = {
      time: new Date().toISOString(),
      type,
      ...details,
    };

    let events: LogEvent[] = [];
    try {
      const existing = await bucket.get("logs/events.json");
      if (existing) {
        events = JSON.parse(await existing.text());
      }
    } catch {
      events = [];
    }

    // Prepend new event
    events.unshift(event);

    // Drop anything older than RETENTION_DAYS
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

    if (pathname === "/r2/list") {
      try {
        const listed = await this.env.DATA_BUCKET.list();
        return Response.json({
          files: listed.objects.map((obj) => ({
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded,
          })),
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    if (pathname.startsWith("/r2/get/")) {
      try {
        const key = decodeURIComponent(pathname.replace("/r2/get/", ""));
        const object = await this.env.DATA_BUCKET.get(key);
        if (!object) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(object.body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(object.size),
          },
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    if (pathname.startsWith("/r2/put/") && request.method === "PUT") {
      try {
        const key = decodeURIComponent(pathname.replace("/r2/put/", ""));
        const body = await request.arrayBuffer();
        await this.env.DATA_BUCKET.put(key, body);
        return Response.json({ success: true, key: key, size: body.byteLength });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // ── Status endpoint ──────────────────────────────────────
    if (pathname === "/__status") {
      try {
        const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
        const totalSize = r2List.objects.reduce((sum, obj) => sum + obj.size, 0);
        let lastBackup = "Never";
        try {
          const timestamp = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
          if (timestamp) {
            lastBackup = (await timestamp.text()).trim();
          }
        } catch {}
        
        const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
        const minDbSize = 50 * 1024;
        const isValidBackup = dbBackup && dbBackup.size >= minDbSize;
        
        return Response.json({
          status: "running",
          containerInfo: {
            sleepAfter: "168h (7 days)",
            cronSchedule: "*/2 * * * * (every 2 minutes)",
          },
          backup: {
            files: r2List.objects.length,
            fileList: r2List.objects.map(o => ({ key: o.key, size: o.size })),
            totalSizeBytes: totalSize,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            lastBackup: lastBackup,
            isValid: isValidBackup,
            validationNote: isValidBackup 
              ? "Backup is valid (database.sql > 50KB)" 
              : "Backup may be invalid. Please complete WordPress setup and run /__backup/now",
          },
          endpoints: {
            status: "/__status",
            logs: "/__logs",
            backupNow: "/__backup/now",
            restoreNow: "/__restore/now",
            reboot: "/__reboot",
          },
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // ── Persistent event log endpoint ─────────────────────────
    if (pathname === "/__logs") {
      try {
        const logsObj = await this.env.DATA_BUCKET.get("logs/events.json");
        if (!logsObj) {
          return Response.json({ events: [], total: 0, message: "No events recorded yet." }, {
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        const events: LogEvent[] = JSON.parse(await logsObj.text());

        const filterType = url.searchParams.get("type");
        const filtered = filterType ? events.filter(e => e.type === filterType) : events;
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const paged = filtered.slice(0, limit);

        return Response.json({ events: paged, total: events.length, filtered: filtered.length, showing: paged.length }, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // ── Manual backup ─────────────────────────────────────────
    if (pathname === "/__backup/now") {
      return await this.handleBackup(request);
    }

    // ── Manual restore ────────────────────────────────────────
    if (pathname === "/__restore/now") {
      return await this.handleRestore(request);
    }

    // ── Reboot ────────────────────────────────────────────────
    if (pathname === "/__reboot") {
      return new Response("Reboot requested. Please wait 2 minutes and refresh.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ── AUTO-RESTORE: Intercept install.php (container recycled) ──
    if (pathname.includes("install.php")) {
      console.log("[AUTO-RESTORE] ====== DETECTED INSTALL.PHP ======");

      await logEvent(this.env.DATA_BUCKET, "CONTAINER_RECYCLED", {
        url: request.url,
        userAgent: request.headers.get("user-agent") || "unknown",
        message: "install.php accessed — container recycled and lost state",
      });

      const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
      const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
      const minDbSize = 50 * 1024;
      
      if (dbBackup) {
        if (dbBackup.size < minDbSize) {
          await logEvent(this.env.DATA_BUCKET, "RESTORE_SKIPPED", {
            reason: "database.sql too small",
            dbSize: dbBackup.size,
            minRequired: minDbSize,
          });
        } else if (r2List.objects.length >= 2) {
          await logEvent(this.env.DATA_BUCKET, "RESTORE_START", {
            trigger: "auto (install.php)",
            r2Files: r2List.objects.map(o => ({ key: o.key, size: o.size })),
          });
          
          try {
            const restoreResult = await this.performRestore(request.url);
            
            if (restoreResult.success) {
              let snapshotTime = "unknown";
              try {
                const tsObj = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
                if (tsObj) snapshotTime = (await tsObj.text()).trim();
              } catch {}

              await logEvent(this.env.DATA_BUCKET, "RESTORE_SUCCESS", {
                trigger: "auto (install.php)",
                snapshotTimestamp: snapshotTime,
              });

              return new Response(
                `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3;url=/">
  <title>WordPress Restored</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 50px; }
    .success { color: green; }
    pre { text-align: left; background: #f5f5f5; padding: 20px; max-width: 600px; margin: 20px auto; overflow: auto; font-size: 12px; }
  </style>
</head>
<body>
  <h1 class="success">✅ WordPress Restored from Backup!</h1>
  <p>Snapshot time: <strong>${snapshotTime}</strong></p>
  <p>Redirecting to homepage in 3 seconds...</p>
  <p><a href="/">Click here if not redirected</a></p>
  <pre>${restoreResult.message}</pre>
</body>
</html>`,
                { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
              );
            } else {
              await logEvent(this.env.DATA_BUCKET, "RESTORE_FAILED", {
                trigger: "auto (install.php)",
                message: restoreResult.message.slice(0, 500),
              });
            }
          } catch (e) {
            await logEvent(this.env.DATA_BUCKET, "RESTORE_FAILED", {
              trigger: "auto (install.php)",
              error: String(e),
            });
          }
        }
      } else {
        await logEvent(this.env.DATA_BUCKET, "RESTORE_SKIPPED", {
          reason: "No database.sql in R2 — fresh install",
        });
      }
    }

    try {
      return await this.containerFetch(request);
    } catch (error) {
      return new Response(`Container error: ${String(error)}`, { status: 500 });
    }
  }

  private async handleBackup(request: Request): Promise<Response> {
    const results: string[] = [];
    await logEvent(this.env.DATA_BUCKET, "MANUAL_BACKUP", { trigger: "manual /__backup/now" });

    try {
      results.push("Step 1: Generating backup files in container...");
      const generateResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=generate", request.url).toString())
      );
      const generateResult = await generateResponse.text();
      results.push(generateResult);
      
      if (!generateResult.includes("Backup Files Ready")) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "Generation failed", output: generateResult.slice(0, 500) });
        return new Response(`Backup generation failed:\n\n${results.join("\n")}`,
          { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      
      results.push("\nStep 2: Validating backup...");
      const dbResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=database.sql", request.url).toString())
      );
      
      if (!dbResponse.ok) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "Failed to fetch database.sql" });
        return new Response(results.join("\n"), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      
      const dbData = await dbResponse.arrayBuffer();
      const minDbSize = 50 * 1024;
      
      if (dbData.byteLength < minDbSize) {
        await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { reason: "database.sql too small", size: dbData.byteLength });
        return new Response(results.join("\n"), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      
      results.push(`✅ database.sql size OK: ${(dbData.byteLength / 1024).toFixed(1)} KB`);
      results.push("\nStep 3: Uploading files to R2...");
      
      await this.env.DATA_BUCKET.put("backup/database.sql", dbData);
      results.push(`  ✅ database.sql uploaded (${(dbData.byteLength / 1024).toFixed(1)} KB)`);
      
      const wpResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=wp-content.tar.gz", request.url).toString())
      );
      if (wpResponse.ok) {
        const wpData = await wpResponse.arrayBuffer();
        await this.env.DATA_BUCKET.put("backup/wp-content.tar.gz", wpData);
        results.push(`  ✅ wp-content.tar.gz uploaded (${(wpData.byteLength / 1024).toFixed(1)} KB)`);
      }
      
      const tsResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=timestamp.txt", request.url).toString())
      );
      if (tsResponse.ok) {
        const tsData = await tsResponse.arrayBuffer();
        await this.env.DATA_BUCKET.put("backup/timestamp.txt", tsData);
      }

      let snapshotTime = new Date().toISOString();
      try {
        const tsObj = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
        if (tsObj) snapshotTime = (await tsObj.text()).trim();
      } catch {}
      
      await logEvent(this.env.DATA_BUCKET, "BACKUP_COMPLETE", {
        trigger: "manual /__backup/now",
        snapshotTimestamp: snapshotTime,
        dbSizeKB: (dbData.byteLength / 1024).toFixed(1),
      });
      
      results.push("\n=== Backup Complete ===");
      return new Response(results.join("\n"), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (error) {
      await logEvent(this.env.DATA_BUCKET, "BACKUP_FAILED", { error: String(error) });
      return new Response(`Backup failed: ${String(error)}`, { status: 500 });
    }
  }

  private async handleRestore(request: Request): Promise<Response> {
    await logEvent(this.env.DATA_BUCKET, "MANUAL_RESTORE", { trigger: "manual /__restore/now" });
    await logEvent(this.env.DATA_BUCKET, "RESTORE_START", { trigger: "manual /__restore/now" });

    const result = await this.performRestore(request.url);

    if (result.success) {
      let snapshotTime = "unknown";
      try {
        const tsObj = await this.env.DATA_BUCKET.get("backup/timestamp.txt");
        if (tsObj) snapshotTime = (await tsObj.text()).trim();
      } catch {}
      await logEvent(this.env.DATA_BUCKET, "RESTORE_SUCCESS", {
        trigger: "manual /__restore/now",
        snapshotTimestamp: snapshotTime,
      });
    } else {
      await logEvent(this.env.DATA_BUCKET, "RESTORE_FAILED", {
        trigger: "manual /__restore/now",
        message: result.message.slice(0, 500),
      });
    }
    
    return new Response(
      `=== Manual Restore ===\n\n${result.message}\n\n${result.success ? "✅ Restore Complete!" : "❌ Restore Failed"}`,
      { status: result.success ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  private async performRestore(baseUrl: string): Promise<{ success: boolean; message: string }> {
    const logs: string[] = [];
    try {
      const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
      logs.push(`R2 backup files: ${r2List.objects.length}`);
      if (r2List.objects.length === 0) return { success: false, message: "No backup found in R2" };
      for (const obj of r2List.objects) logs.push(`  - ${obj.key} (${(obj.size / 1024).toFixed(1)} KB)`);
      logs.push("");

      for (const file of ["database.sql", "wp-content.tar.gz", "timestamp.txt"]) {
        try {
          const r2Object = await this.env.DATA_BUCKET.get(`backup/${file}`);
          if (!r2Object) { logs.push(`⚠️ No ${file} in R2, skipping`); continue; }
          const fileData = await r2Object.arrayBuffer();
          logs.push(`Pushing ${file} (${(fileData.byteLength / 1024).toFixed(1)} KB)...`);
          const restoreResponse = await this.containerFetch(
            new Request(new URL(`/__trigger_backup.php?action=restore&file=${file}`, baseUrl).toString(), {
              method: "POST", body: fileData,
              headers: { "Content-Type": "application/octet-stream" }
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
      
      try {
        const pingResponse = await container.fetch(new Request("https://localhost/__status"));
        keepAliveSuccess = pingResponse.ok;
        console.log(`[CRON] Keep-alive ping: ${pingResponse.status}`);
      } catch {
        try {
          await container.fetch(new Request("https://localhost/"));
          keepAliveSuccess = true;
        } catch (e) { console.error("[CRON] Simple ping failed:", e); }
      }
      
      if (!keepAliveSuccess) { console.log("[CRON] Container unreachable, skipping backup"); return; }
      
      let shouldBackup = false;
      try {
        const checkResponse = await container.fetch(
          new Request("https://localhost/__trigger_backup.php?action=check")
        );
        if (checkResponse.ok) {
          const checkData = await checkResponse.json() as { needsRestore: boolean };
          shouldBackup = !checkData.needsRestore;
        }
      } catch { shouldBackup = true; }
      
      if (!shouldBackup) return;
      
      try {
        const generateResponse = await container.fetch(
          new Request("https://localhost/__trigger_backup.php?action=generate")
        );
        if (generateResponse.ok) {
          const generateText = await generateResponse.text();
          if (generateText.includes("Backup Files Ready")) {
            const dbCheckResponse = await container.fetch(
              new Request("https://localhost/__trigger_backup.php?action=get&file=database.sql")
            );
            if (dbCheckResponse.ok) {
              const dbData = await dbCheckResponse.arrayBuffer();
              if (dbData.byteLength < 50 * 1024) {
                await logEvent(env.DATA_BUCKET, "BACKUP_FAILED", { trigger: "cron", reason: "database.sql too small", size: dbData.byteLength });
                return;
              }
              await env.DATA_BUCKET.put("backup/database.sql", dbData);
            }
            
            const wpResponse = await container.fetch(new Request("https://localhost/__trigger_backup.php?action=get&file=wp-content.tar.gz"));
            if (wpResponse.ok) await env.DATA_BUCKET.put("backup/wp-content.tar.gz", await wpResponse.arrayBuffer());
            
            const tsResponse = await container.fetch(new Request("https://localhost/__trigger_backup.php?action=get&file=timestamp.txt"));
            if (tsResponse.ok) await env.DATA_BUCKET.put("backup/timestamp.txt", await tsResponse.arrayBuffer());

            let snapshotTime = new Date().toISOString();
            try { const tsObj = await env.DATA_BUCKET.get("backup/timestamp.txt"); if (tsObj) snapshotTime = (await tsObj.text()).trim(); } catch {}

            await logEvent(env.DATA_BUCKET, "BACKUP_COMPLETE", { trigger: "cron", snapshotTimestamp: snapshotTime });
            console.log(`[CRON] ====== BACKUP COMPLETED ====== ${new Date().toISOString()}`);
          }
        }
      } catch (e) {
        await logEvent(env.DATA_BUCKET, "BACKUP_FAILED", { trigger: "cron", error: String(e) });
      }
    } catch (error) {
      console.error("[CRON] SCHEDULED TASK FAILED:", error);
    }
    console.log(`[CRON] ====== SCHEDULED TASK ENDED ====== ${new Date().toISOString()}`);
  },
};
