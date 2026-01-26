<?php
/**
 * Plugin Name: Auto Backup After Install
 * Description: Automatically triggers backup after WordPress installation or important changes
 * Version: 1.0
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
 * Trigger backup by calling the sync script
 */
function r2_trigger_backup() {
    // Run backup in background (non-blocking)
    exec('/scripts/sync.sh push > /var/log/backup.log 2>&1 &');
    
    // Log the trigger
    error_log('[R2 Backup] Backup triggered at ' . date('Y-m-d H:i:s'));
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
        
        if ($last_backup === 'Never') {
            echo '<div class="notice notice-warning"><p>';
            echo '<strong>R2 Backup:</strong> No backup found yet. ';
            echo '<a href="' . admin_url('admin.php?page=r2-backup-now') . '">Trigger backup now</a> or wait for automatic backup (every 5 minutes).';
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
        r2_trigger_backup();
        echo '<div class="notice notice-success"><p>Backup triggered! Please wait 10-30 seconds and refresh to see status.</p></div>';
    }
    
    // Get status
    $status = ['backup' => ['lastBackup' => 'Unknown', 'files' => 0, 'totalSizeMB' => '0']];
    $response = @file_get_contents('http://localhost/__status');
    if ($response) {
        $status = json_decode($response, true);
    }
    
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
                <th>Backup Files</th>
                <td><?php echo esc_html($status['backup']['files'] ?? 0); ?></td>
            </tr>
            <tr>
                <th>Total Size</th>
                <td><?php echo esc_html($status['backup']['totalSizeMB'] ?? '0'); ?> MB</td>
            </tr>
        </table>
        
        <h2>Manual Backup</h2>
        <p>Backups run automatically every 5 minutes. Use this button to trigger an immediate backup.</p>
        
        <form method="post">
            <?php wp_nonce_field('r2_backup_nonce'); ?>
            <p>
                <input type="submit" name="trigger_backup" class="button button-primary" value="Backup Now">
            </p>
        </form>
        
        <h2>How It Works</h2>
        <ul>
            <li>✅ Database is backed up to Cloudflare R2</li>
            <li>✅ wp-content folder (themes, plugins, uploads) is backed up</li>
            <li>✅ Automatic backup every 5 minutes via cron</li>
            <li>✅ Automatic backup after theme/plugin changes</li>
            <li>✅ Data restored automatically when container restarts</li>
        </ul>
        
        <h2>Important</h2>
        <p><strong>Before redeploying (npx wrangler deploy):</strong></p>
        <ol>
            <li>Check the "Last Backup" time above</li>
            <li>If your recent changes aren't backed up yet, click "Backup Now"</li>
            <li>Wait 10-30 seconds and refresh to confirm backup completed</li>
            <li>Then proceed with deployment</li>
        </ol>
    </div>
    <?php
}
