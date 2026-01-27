import { Container } from "@cloudflare/containers";

interface Env {
  WORDPRESS: DurableObjectNamespace<WordPressContainer>;
  DATA_BUCKET: R2Bucket;
}

export class WordPressContainer extends Container {
  defaultPort = 80;
  sleepAfter = "168h";  // 7 days = 168 hours (maximum)
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

    // R2 API endpoints
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

    // Status endpoint
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
        
        // Check if backup is valid (database.sql > 50KB)
        const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
        const minDbSize = 50 * 1024;
        const isValidBackup = dbBackup && dbBackup.size >= minDbSize;
        
        return Response.json({
          status: "running",
          containerInfo: {
            sleepAfter: "168h (7 days)",
            cronSchedule: "*/15 * * * * (every 15 minutes)",
          },
          backup: {
            files: r2List.objects.length,
            fileList: r2List.objects.map(o => ({ key: o.key, size: o.size })),
            totalSizeBytes: totalSize,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            lastBackup: lastBackup,
            isValid: isValidBackup,
            validationNote: isValidBackup 
              ? "✅ Backup is valid (database.sql > 50KB)" 
              : "⚠️ Backup may be invalid (database.sql < 50KB or missing). Please complete WordPress setup and run /__backup/now",
          },
          endpoints: {
            status: "/__status",
            backupNow: "/__backup/now",
            restoreNow: "/__restore/now",
            reboot: "/__reboot",
          },
          note: "View logs in Cloudflare Dashboard → Workers & Pages → wordpress-r2 → Logs → Real-time Logs",
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // Manual backup trigger endpoint
    if (pathname === "/__backup/now") {
      return await this.handleBackup(request);
    }

    // Manual restore endpoint
    if (pathname === "/__restore/now") {
      return await this.handleRestore(request);
    }

    // Reboot endpoint
    if (pathname === "/__reboot") {
      return new Response("Reboot requested. Please wait 2 minutes and refresh.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // AUTO-RESTORE: Intercept install.php requests
    if (pathname.includes("install.php")) {
      console.log("[AUTO-RESTORE] ====== DETECTED INSTALL.PHP ======");
      console.log(`[AUTO-RESTORE] Full URL: ${request.url}`);
      
      // Check if R2 has backup
      const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
      console.log(`[AUTO-RESTORE] R2 backup files count: ${r2List.objects.length}`);
      
      // Find database.sql and check its size
      const dbBackup = r2List.objects.find(obj => obj.key === "backup/database.sql");
      const minDbSize = 50 * 1024; // 50 KB minimum for valid WordPress database
      
      if (dbBackup) {
        console.log(`[AUTO-RESTORE] database.sql size: ${dbBackup.size} bytes`);
        
        if (dbBackup.size < minDbSize) {
          console.log(`[AUTO-RESTORE] ⚠️ database.sql is too small (${dbBackup.size} bytes < ${minDbSize} bytes)`);
          console.log("[AUTO-RESTORE] This looks like an empty database backup, skipping restore");
          console.log("[AUTO-RESTORE] Please complete WordPress installation and run /__backup/now");
          // Don't restore, let user complete fresh installation
        } else if (r2List.objects.length >= 2) {
          console.log("[AUTO-RESTORE] Backup is valid, performing automatic restore...");
          
          try {
            const restoreResult = await this.performRestore(request.url);
            console.log(`[AUTO-RESTORE] Restore result: success=${restoreResult.success}`);
            
            if (restoreResult.success) {
              console.log("[AUTO-RESTORE] ====== RESTORE SUCCESSFUL ======");
              // Return a page that redirects to homepage
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
  <p>Redirecting to homepage in 3 seconds...</p>
  <p><a href="/">Click here if not redirected</a></p>
  <pre>${restoreResult.message}</pre>
</body>
</html>`,
                {
                  status: 200,
                  headers: { "Content-Type": "text/html; charset=utf-8" }
                }
              );
            } else {
              console.log("[AUTO-RESTORE] ====== RESTORE FAILED ======");
              console.log(`[AUTO-RESTORE] Failure message: ${restoreResult.message}`);
            }
          } catch (e) {
            console.error("[AUTO-RESTORE] Exception:", e);
          }
        }
      } else {
        console.log("[AUTO-RESTORE] No database.sql in R2, showing fresh install page");
      }
    }

    // Forward all other requests to container
    try {
      return await this.containerFetch(request);
    } catch (error) {
      return new Response(`Container error: ${String(error)}`, { status: 500 });
    }
  }

  // Handle backup request
  private async handleBackup(request: Request): Promise<Response> {
    const results: string[] = [];
    
    try {
      // Step 1: Generate backup files
      results.push("Step 1: Generating backup files in container...");
      const generateResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=generate", request.url).toString())
      );
      const generateResult = await generateResponse.text();
      results.push(generateResult);
      
      if (!generateResult.includes("Backup Files Ready")) {
        return new Response(
          `Backup generation failed:\n\n${results.join("\n")}`,
          { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      
      // Step 2: Check database.sql size before uploading
      results.push("\nStep 2: Validating backup...");
      const dbResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=database.sql", request.url).toString())
      );
      
      if (!dbResponse.ok) {
        results.push("❌ Failed to fetch database.sql");
        return new Response(results.join("\n"), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      
      const dbData = await dbResponse.arrayBuffer();
      const minDbSize = 50 * 1024; // 50 KB minimum
      
      if (dbData.byteLength < minDbSize) {
        results.push(`❌ database.sql is too small: ${(dbData.byteLength / 1024).toFixed(1)} KB`);
        results.push(`   Minimum required: ${minDbSize / 1024} KB`);
        results.push("");
        results.push("⚠️ WordPress may not be fully installed yet.");
        results.push("Please complete WordPress installation first, then run backup again.");
        return new Response(results.join("\n"), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      
      results.push(`✅ database.sql size OK: ${(dbData.byteLength / 1024).toFixed(1)} KB`);
      
      // Step 3: Upload to R2
      results.push("\nStep 3: Uploading files to R2...");
      
      // Upload database.sql (already fetched)
      await this.env.DATA_BUCKET.put("backup/database.sql", dbData);
      results.push(`  ✅ database.sql uploaded (${(dbData.byteLength / 1024).toFixed(1)} KB)`);
      
      // Upload wp-content.tar.gz
      const wpResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=wp-content.tar.gz", request.url).toString())
      );
      if (wpResponse.ok) {
        const wpData = await wpResponse.arrayBuffer();
        await this.env.DATA_BUCKET.put("backup/wp-content.tar.gz", wpData);
        results.push(`  ✅ wp-content.tar.gz uploaded (${(wpData.byteLength / 1024).toFixed(1)} KB)`);
      } else {
        results.push(`  ❌ Failed to fetch wp-content.tar.gz`);
      }
      
      // Upload timestamp.txt
      const tsResponse = await this.containerFetch(
        new Request(new URL("/__trigger_backup.php?action=get&file=timestamp.txt", request.url).toString())
      );
      if (tsResponse.ok) {
        const tsData = await tsResponse.arrayBuffer();
        await this.env.DATA_BUCKET.put("backup/timestamp.txt", tsData);
        results.push(`  ✅ timestamp.txt uploaded`);
      }
      
      results.push("\n=== Backup Complete ===");
      results.push("Visit /__status to verify.");
      
      return new Response(results.join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    } catch (error) {
      return new Response(`Backup failed: ${String(error)}`, { status: 500 });
    }
  }

  // Handle restore request
  private async handleRestore(request: Request): Promise<Response> {
    const result = await this.performRestore(request.url);
    
    return new Response(
      `=== Manual Restore ===\n\n${result.message}\n\n${result.success ? "✅ Restore Complete! Please refresh the page." : "❌ Restore Failed"}`,
      {
        status: result.success ? 200 : 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      }
    );
  }

  // Perform restore from R2 to container
  private async performRestore(baseUrl: string): Promise<{ success: boolean; message: string }> {
    const logs: string[] = [];
    console.log("[RESTORE] ====== Starting performRestore ======");
    
    try {
      // Check R2 backup
      const r2List = await this.env.DATA_BUCKET.list({ prefix: "backup/" });
      logs.push(`R2 backup files: ${r2List.objects.length}`);
      console.log(`[RESTORE] R2 backup files: ${r2List.objects.length}`);
      
      if (r2List.objects.length === 0) {
        console.log("[RESTORE] No backup found in R2");
        return { success: false, message: "No backup found in R2" };
      }

      for (const obj of r2List.objects) {
        logs.push(`  - ${obj.key} (${(obj.size / 1024).toFixed(1)} KB)`);
      }
      logs.push("");

      // Push files to container
      for (const file of ["database.sql", "wp-content.tar.gz", "timestamp.txt"]) {
        try {
          console.log(`[RESTORE] Getting ${file} from R2...`);
          const r2Object = await this.env.DATA_BUCKET.get(`backup/${file}`);
          if (!r2Object) {
            logs.push(`⚠️ No ${file} in R2, skipping`);
            console.log(`[RESTORE] No ${file} in R2`);
            continue;
          }
          
          const fileData = await r2Object.arrayBuffer();
          logs.push(`Pushing ${file} (${(fileData.byteLength / 1024).toFixed(1)} KB)...`);
          console.log(`[RESTORE] Pushing ${file} (${fileData.byteLength} bytes) to container...`);
          
          const restoreUrl = new URL(`/__trigger_backup.php?action=restore&file=${file}`, baseUrl).toString();
          console.log(`[RESTORE] POST to: ${restoreUrl}`);
          
          const restoreResponse = await this.containerFetch(
            new Request(restoreUrl, {
              method: "POST",
              body: fileData,
              headers: { "Content-Type": "application/octet-stream" }
            })
          );
          
          console.log(`[RESTORE] Response status: ${restoreResponse.status}`);
          
          if (restoreResponse.ok) {
            const responseText = await restoreResponse.text();
            logs.push(`  ✅ ${file} pushed to container`);
            console.log(`[RESTORE] ✅ ${file} pushed: ${responseText}`);
          } else {
            const errorText = await restoreResponse.text();
            logs.push(`  ❌ Failed: ${restoreResponse.status}`);
            console.log(`[RESTORE] ❌ ${file} failed: ${restoreResponse.status} - ${errorText}`);
          }
        } catch (fileError) {
          logs.push(`  ❌ Error: ${String(fileError)}`);
          console.error(`[RESTORE] Exception for ${file}:`, fileError);
        }
      }
      
      // Apply restore
      logs.push("\nApplying restore...");
      console.log("[RESTORE] Applying restore...");
      
      const applyUrl = new URL("/__trigger_backup.php?action=apply", baseUrl).toString();
      console.log(`[RESTORE] GET: ${applyUrl}`);
      
      const applyResponse = await this.containerFetch(
        new Request(applyUrl)
      );
      const applyResult = await applyResponse.text();
      logs.push(applyResult);
      console.log(`[RESTORE] Apply result: ${applyResult}`);
      
      const success = applyResult.includes("Database restored") || applyResult.includes("✅");
      console.log(`[RESTORE] ====== performRestore finished, success=${success} ======`);
      return { success, message: logs.join("\n") };
    } catch (error) {
      logs.push(`Error: ${String(error)}`);
      console.error("[RESTORE] Exception:", error);
      return { success: false, message: logs.join("\n") };
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

  // Cron: runs every 30 minutes to keep alive and backup
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] ====== SCHEDULED TASK STARTED ====== ${new Date().toISOString()}`);
    console.log(`[CRON] Event type: ${event.cron}`);
    
    let keepAliveSuccess = false;
    
    try {
      const containerId = env.WORDPRESS.idFromName("main");
      const container = env.WORDPRESS.get(containerId);
      
      // ALWAYS keep container warm first - this is the most important part
      console.log("[CRON] Sending keep-alive ping...");
      try {
        const pingResponse = await container.fetch(new Request("https://localhost/__status"));
        console.log(`[CRON] Keep-alive ping response: ${pingResponse.status}`);
        keepAliveSuccess = pingResponse.ok;
      } catch (pingError) {
        console.error("[CRON] Keep-alive ping failed:", pingError);
        // Try a simpler ping
        try {
          const simplePing = await container.fetch(new Request("https://localhost/"));
          console.log(`[CRON] Simple ping response: ${simplePing.status}`);
          keepAliveSuccess = true;
        } catch (e) {
          console.error("[CRON] Simple ping also failed:", e);
        }
      }
      
      if (!keepAliveSuccess) {
        console.log("[CRON] ⚠️ Could not reach container, skipping backup");
        console.log(`[CRON] ====== SCHEDULED TASK ENDED (container unreachable) ====== ${new Date().toISOString()}`);
        return;
      }
      
      // Check if WordPress is installed before backing up
      console.log("[CRON] Checking if WordPress is installed...");
      let shouldBackup = false;
      
      try {
        const checkResponse = await container.fetch(
          new Request("https://localhost/__trigger_backup.php?action=check")
        );
        
        if (checkResponse.ok) {
          const checkData = await checkResponse.json() as { needsRestore: boolean };
          
          if (checkData.needsRestore) {
            console.log("[CRON] ⚠️ WordPress is NOT installed yet, skipping backup");
          } else {
            console.log("[CRON] ✅ WordPress is installed, will proceed with backup");
            shouldBackup = true;
          }
        }
      } catch (checkError) {
        console.log("[CRON] Could not check WordPress status:", checkError);
        // Don't skip backup entirely - try anyway
        shouldBackup = true;
      }
      
      if (!shouldBackup) {
        console.log(`[CRON] ====== SCHEDULED TASK ENDED (no backup needed) ====== ${new Date().toISOString()}`);
        return;
      }
      
      // Trigger backup
      console.log("[CRON] Starting backup...");
      try {
        const generateResponse = await container.fetch(
          new Request("https://localhost/__trigger_backup.php?action=generate")
        );
        
        console.log(`[CRON] Generate response status: ${generateResponse.status}`);
        
        if (generateResponse.ok) {
          const generateText = await generateResponse.text();
          console.log(`[CRON] Generate result contains 'Backup Files Ready': ${generateText.includes("Backup Files Ready")}`);
          
          if (generateText.includes("Backup Files Ready")) {
            // Check database.sql size before uploading
            const dbCheckResponse = await container.fetch(
              new Request("https://localhost/__trigger_backup.php?action=get&file=database.sql")
            );
            
            if (dbCheckResponse.ok) {
              const dbData = await dbCheckResponse.arrayBuffer();
              const minDbSize = 50 * 1024; // 50 KB minimum
              
              if (dbData.byteLength < minDbSize) {
                console.log(`[CRON] ⚠️ database.sql is too small (${dbData.byteLength} bytes < ${minDbSize} bytes)`);
                console.log("[CRON] Skipping backup - WordPress may not be fully installed");
                console.log(`[CRON] ====== SCHEDULED TASK ENDED (invalid backup) ====== ${new Date().toISOString()}`);
                return;
              }
              
              console.log(`[CRON] ✅ database.sql size OK: ${dbData.byteLength} bytes`);
              
              // Upload database.sql
              await env.DATA_BUCKET.put("backup/database.sql", dbData);
              console.log(`[CRON] ✅ database.sql backed up (${dbData.byteLength} bytes)`);
            }
            
            // Upload wp-content.tar.gz
            const wpResponse = await container.fetch(
              new Request("https://localhost/__trigger_backup.php?action=get&file=wp-content.tar.gz")
            );
            if (wpResponse.ok) {
              const wpData = await wpResponse.arrayBuffer();
              await env.DATA_BUCKET.put("backup/wp-content.tar.gz", wpData);
              console.log(`[CRON] ✅ wp-content.tar.gz backed up (${wpData.byteLength} bytes)`);
            }
            
            // Upload timestamp.txt
            const tsResponse = await container.fetch(
              new Request("https://localhost/__trigger_backup.php?action=get&file=timestamp.txt")
            );
            if (tsResponse.ok) {
              const tsData = await tsResponse.arrayBuffer();
              await env.DATA_BUCKET.put("backup/timestamp.txt", tsData);
              console.log(`[CRON] ✅ timestamp.txt backed up`);
            }
            
            console.log(`[CRON] ====== BACKUP COMPLETED ====== ${new Date().toISOString()}`);
          } else {
            console.log("[CRON] Backup generation did not complete successfully");
          }
        } else {
          console.log(`[CRON] Generate request failed: ${generateResponse.status}`);
        }
      } catch (backupError) {
        console.error("[CRON] Backup failed:", backupError);
      }
    } catch (error) {
      console.error("[CRON] ====== SCHEDULED TASK FAILED ======", error);
    }
    
    console.log(`[CRON] ====== SCHEDULED TASK ENDED ====== ${new Date().toISOString()}`);
  },
};
