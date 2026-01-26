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

  // Called when container starts
  override onStart(): void {
    console.log(`[CONTAINER] ====== CONTAINER STARTED ====== ${new Date().toISOString()}`);
  }

  // Called when container stops/sleeps
  override onStop(): void {
    console.log(`[CONTAINER] ====== CONTAINER STOPPED ====== ${new Date().toISOString()}`);
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
        return Response.json({
          status: "running",
          containerInfo: {
            sleepAfter: "168h (7 days)",
            cronSchedule: "*/30 * * * * (every 30 minutes)",
          },
          backup: {
            files: r2List.objects.length,
            fileList: r2List.objects.map(o => ({ key: o.key, size: o.size })),
            totalSizeBytes: totalSize,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            lastBackup: lastBackup,
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
      
      for (const obj of r2List.objects) {
        console.log(`[AUTO-RESTORE]   - ${obj.key} (${obj.size} bytes)`);
      }
      
      if (r2List.objects.length >= 2) {  // At least database.sql and wp-content.tar.gz
        console.log("[AUTO-RESTORE] Backup found, performing automatic restore...");
        
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
      } else {
        console.log("[AUTO-RESTORE] No backup in R2, showing fresh install page");
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
      
      // Step 2: Upload to R2
      results.push("\nStep 2: Uploading files to R2...");
      
      for (const file of ["database.sql", "wp-content.tar.gz", "timestamp.txt"]) {
        try {
          results.push(`  Fetching ${file}...`);
          const fileResponse = await this.containerFetch(
            new Request(new URL(`/__trigger_backup.php?action=get&file=${file}`, request.url).toString())
          );
          
          if (!fileResponse.ok) {
            results.push(`  ❌ Failed to fetch ${file}: ${fileResponse.status}`);
            continue;
          }
          
          const fileData = await fileResponse.arrayBuffer();
          results.push(`  Uploading ${file} (${(fileData.byteLength / 1024).toFixed(1)} KB)...`);
          
          await this.env.DATA_BUCKET.put(`backup/${file}`, fileData);
          results.push(`  ✅ ${file} uploaded to R2`);
        } catch (fileError) {
          results.push(`  ❌ Error with ${file}: ${String(fileError)}`);
        }
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
    
    try {
      const containerId = env.WORDPRESS.idFromName("main");
      const container = env.WORDPRESS.get(containerId);
      
      // Keep container warm
      console.log("[CRON] Sending keep-alive ping...");
      const pingResponse = await container.fetch(new Request("https://localhost/"));
      console.log(`[CRON] Ping response status: ${pingResponse.status}`);
      
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
            // Upload files to R2
            for (const file of ["database.sql", "wp-content.tar.gz", "timestamp.txt"]) {
              try {
                console.log(`[CRON] Fetching ${file} from container...`);
                const fileResponse = await container.fetch(
                  new Request(`https://localhost/__trigger_backup.php?action=get&file=${file}`)
                );
                if (fileResponse.ok) {
                  const fileData = await fileResponse.arrayBuffer();
                  await env.DATA_BUCKET.put(`backup/${file}`, fileData);
                  console.log(`[CRON] ✅ ${file} backed up (${fileData.byteLength} bytes)`);
                } else {
                  console.log(`[CRON] ❌ Failed to fetch ${file}: ${fileResponse.status}`);
                }
              } catch (e) {
                console.error(`[CRON] ❌ Exception backing up ${file}:`, e);
              }
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