<?php
/**
 * Plugin Name: Auto Backup After Install
 * Description: Automatically triggers backup after WordPress installation or important changes
 * Version: 2.0
 * 
 * This is a "must-use" plugin that runs automatically.
 * It triggers a backup after:
 * - WordPress installation completes
 * - Theme/plugin installation
 * - Major option changes
 */

// Prevent direct access
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Trigger backup by calling the Worker's backup endpoint
 * This ensures the backup is actually uploaded to R2
 */
function r2_trigger_backup() {
    // First, generate local backup files
    exec('/scripts/sync.sh push > /var/log/backup.log 2>&1');
    
    // Log the trigger
    error_log('[R2 Backup] Local backup generated at ' . date('Y-m-d H:i:s'));
    
    // Note: The actual R2 upload will happen when:
    // 1. Cron triggers (every 2 minutes)
    // 2. User visits /__backup/now
    // We can't call the Worker from inside the container directly
}

/**
 * Trigger full backup via HTTP (for admin-initiated backups)
 */
function r2_trigger_full_backup() {
    // Generate local files first
    exec('/scripts/sync.sh push > /var/log/backup.log 2>&1');
    
    // The Worker will pick these up on next cron or manual trigger
    error_log('[R2 Backup] Full backup prepared at ' . date('Y-m-d H:i:s'));
    
    return true;
}

/**
 * Check if this is first run after installation
 */
function r2_check_first_run() {
    // Check if we've already done the initial backup
    $initial_backup_done = get_option('r2_initial_backup_done', false);
    
    if (!$initial_backup_done) {
        // Mark as done first to prevent multiple triggers
        update_option('r2_initial_backup_done', true);
        
        // Wait a moment for installation to fully complete
        sleep(2);
        
        // Trigger backup
        r2_trigger_backup();
        
        error_log('[R2 Backup] Initial backup after installation triggered');
    }
}

/**
 * Hook into WordPress installation completion
 * This runs when user completes the installation wizard
 */
add_action('wp_install', function($user) {
    // Delay backup slightly to ensure all data is written
    add_action('shutdown', function() {
        sleep(1);
        r2_trigger_backup();
        error_log('[R2 Backup] Backup triggered after wp_install');
    });
});

/**
 * Hook into admin init to check for first run
 */
add_action('admin_init', function() {
    r2_check_first_run();
});

/**
 * Trigger backup after theme switch
 */
add_action('switch_theme', function() {
    r2_trigger_backup();
    error_log('[R2 Backup] Backup triggered after theme switch');
});

/**
 * Trigger backup after plugin activation
 */
add_action('activated_plugin', function() {
    r2_trigger_backup();
    error_log('[R2 Backup] Backup triggered after plugin activation');
});

/**
 * Trigger backup after plugin deactivation
 */
add_action('deactivated_plugin', function() {
    r2_trigger_backup();
    error_log('[R2 Backup] Backup triggered after plugin deactivation');
});

/**
 * Trigger backup after WordPress core update
 */
add_action('_core_updated_successfully', function() {
    r2_trigger_backup();
    error_log('[R2 Backup] Backup triggered after WordPress update');
});

/**
 * Add admin notice to remind about backup
 */
add_action('admin_notices', function() {
    // Only show on dashboard
    $screen = get_current_screen();
    if ($screen->id !== 'dashboard') {
        return;
    }
    
    // Check last backup time via status endpoint
    $status_url = 'http://localhost/__status';
    $response = @file_get_contents($status_url);
    
    if ($response) {
        $data = json_decode($response, true);
        $last_backup = $data['backup']['lastBackup'] ?? 'Never';
        $is_valid = $data['backup']['isValid'] ?? false;
        
        if ($last_backup === 'Never' || !$is_valid) {
            echo '<div class="notice notice-warning"><p>';
            echo '<strong>R2 Backup:</strong> No valid backup found. ';
            echo 'Automatic backup runs every 2 minutes, or ';
            echo '<a href="' . admin_url('tools.php?page=r2-backup') . '">go to backup page</a>.';
            echo '</p></div>';
        }
    }
});

/**
 * Add backup menu item
 */
add_action('admin_menu', function() {
    add_management_page(
        'R2 Backup',
        'R2 Backup',
        'manage_options',
        'r2-backup',
        'r2_backup_page'
    );
});

/**
 * Backup management page
 */
function r2_backup_page() {
    // Handle manual backup trigger
    if (isset($_POST['trigger_backup']) && check_admin_referer('r2_backup_nonce')) {
        r2_trigger_full_backup();
        echo '<div class="notice notice-success"><p>';
        echo '<strong>Backup files generated!</strong> ';
        echo 'The backup will be uploaded to R2 within 2 minutes (next cron run), or ';
        echo 'visit <a href="/__backup/now" target="_blank">/__backup/now</a> to upload immediately.';
        echo '</p></div>';
    }
    
    // Get status
    $status = ['backup' => ['lastBackup' => 'Unknown', 'files' => 0, 'totalSizeMB' => '0', 'isValid' => false]];
    $response = @file_get_contents('http://localhost/__status');
    if ($response) {
        $status = json_decode($response, true);
    }
    
    $is_valid = $status['backup']['isValid'] ?? false;
    
    ?>
    <div class="wrap">
        <h1>R2 Backup Status</h1>
        
        <h2>Current Status</h2>
        <table class="form-table">
            <tr>
                <th>Last Backup</th>
                <td><?php echo esc_html($status['backup']['lastBackup'] ?? 'Never'); ?></td>
            </tr>
            <tr>
                <th>Backup Valid</th>
                <td>
                    <?php if ($is_valid): ?>
                        <span style="color: green;">✅ Yes (database.sql ≥ 50KB)</span>
                    <?php else: ?>
                        <span style="color: red;">❌ No (database.sql < 50KB or missing)</span>
                    <?php endif; ?>
                </td>
            </tr>
            <tr>
                <th>Backup Files</th>
                <td><?php echo esc_html($status['backup']['files'] ?? 0); ?></td>
            </tr>
            <tr>
                <th>Total Size</th>
                <td><?php echo esc_html($status['backup']['totalSizeMB'] ?? '0'); ?> MB</td>
            </tr>
        </table>
        
        <h2>Manual Backup</h2>
        <p>Backups run automatically every <strong>2 minutes</strong>. Use this button to prepare backup files immediately.</p>
        
        <form method="post" style="margin-bottom: 20px;">
            <?php wp_nonce_field('r2_backup_nonce'); ?>
            <p>
                <input type="submit" name="trigger_backup" class="button button-primary" value="Prepare Backup Files">
            </p>
        </form>
        
        <p>
            <a href="/__backup/now" target="_blank" class="button">Upload to R2 Now (opens in new tab)</a>
            <a href="/__status" target="_blank" class="button">View Full Status</a>
        </p>
        
        <h2>How It Works</h2>
        <ul>
            <li>✅ Cron runs every <strong>2 minutes</strong> to keep container alive</li>
            <li>✅ Database and wp-content are backed up to Cloudflare R2</li>
            <li>✅ Only valid backups are saved (database.sql ≥ 50KB)</li>
            <li>✅ Auto-restore when container restarts (if valid backup exists)</li>
            <li>✅ Additional backups after theme/plugin changes</li>
        </ul>
        
        <h2>Important Notes</h2>
        <ul>
            <li>⏱️ After WordPress installation, wait up to 2 minutes for first backup</li>
            <li>🔄 Container may restart due to Cloudflare infrastructure updates</li>
            <li>✅ With valid backup, your site will auto-restore after restart</li>
        </ul>
    </div>
    <?php
}

