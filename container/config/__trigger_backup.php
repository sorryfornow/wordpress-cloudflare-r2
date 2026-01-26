<?php
/**
 * Backup & Restore Script
 * 
 * Actions:
 * - generate: Generate backup files
 * - get: Download backup file
 * - status: Get backup status
 * - restore: Receive and restore file from Worker
 * - check: Check if WordPress is installed
 */

header('Content-Type: text/plain; charset=utf-8');

$action = $_GET['action'] ?? 'generate';

if ($action === 'generate') {
    // Generate backup files
    echo "=== Generating Backup Files ===\n";
    echo "Time: " . date('Y-m-d H:i:s') . "\n\n";
    
    $output = [];
    $return_var = 0;
    exec('/scripts/sync.sh push 2>&1', $output, $return_var);
    
    echo implode("\n", $output);
    echo "\n\n";
    
    if ($return_var === 0) {
        echo "=== Backup Files Ready ===\n";
    } else {
        echo "=== Backup Generation Failed (exit code: $return_var) ===\n";
    }
    
} elseif ($action === 'get') {
    // Serve backup file
    $file = $_GET['file'] ?? '';
    $allowed = ['database.sql', 'wp-content.tar.gz', 'timestamp.txt'];
    
    if (!in_array($file, $allowed)) {
        http_response_code(400);
        die('Invalid file');
    }
    
    $filepath = '/backup/' . $file;
    
    if (!file_exists($filepath)) {
        http_response_code(404);
        die('File not found: ' . $file);
    }
    
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize($filepath));
    header('X-Backup-File: ' . $file);
    readfile($filepath);
    exit;
    
} elseif ($action === 'status') {
    // Return backup files status
    header('Content-Type: application/json');
    $files = [];
    $backupDir = '/backup';
    
    foreach (['database.sql', 'wp-content.tar.gz', 'timestamp.txt'] as $file) {
        $filepath = $backupDir . '/' . $file;
        if (file_exists($filepath)) {
            $files[$file] = [
                'exists' => true,
                'size' => filesize($filepath),
                'modified' => date('Y-m-d H:i:s', filemtime($filepath))
            ];
        } else {
            $files[$file] = ['exists' => false];
        }
    }
    
    echo json_encode(['files' => $files], JSON_PRETTY_PRINT);
    
} elseif ($action === 'check') {
    // Check if WordPress needs restore
    header('Content-Type: application/json');
    
    // Check if wp_options table exists and has data
    $needsRestore = true;
    
    try {
        $pdo = new PDO('mysql:host=localhost;dbname=wordpress', 'wordpress', 'wordpress_password_123');
        $stmt = $pdo->query("SELECT COUNT(*) FROM wp_options WHERE option_name = 'siteurl'");
        $count = $stmt->fetchColumn();
        $needsRestore = ($count == 0);
    } catch (Exception $e) {
        $needsRestore = true;
    }
    
    echo json_encode([
        'needsRestore' => $needsRestore,
        'timestamp' => date('Y-m-d H:i:s')
    ]);
    
} elseif ($action === 'restore') {
    // Receive file from Worker and save to /backup
    $file = $_GET['file'] ?? '';
    $allowed = ['database.sql', 'wp-content.tar.gz', 'timestamp.txt'];
    
    if (!in_array($file, $allowed)) {
        http_response_code(400);
        die('Invalid file');
    }
    
    // Ensure backup directory exists
    if (!is_dir('/backup')) {
        mkdir('/backup', 0777, true);
    }
    
    // Read POST body and save to file
    $input = file_get_contents('php://input');
    $filepath = '/backup/' . $file;
    
    $bytes = file_put_contents($filepath, $input);
    
    if ($bytes === false) {
        http_response_code(500);
        die('Failed to save file');
    }
    
    echo "Saved $file: $bytes bytes";
    
} elseif ($action === 'apply') {
    // Apply the restore from /backup files
    echo "=== Applying Restore ===\n";
    echo "Time: " . date('Y-m-d H:i:s') . "\n\n";
    
    // Check if backup files exist
    if (!file_exists('/backup/database.sql')) {
        echo "No database.sql found, skipping restore.\n";
        exit;
    }
    
    // Restore database
    echo "Restoring database...\n";
    $output = [];
    exec('mysql -u wordpress -pwordpress_password_123 wordpress < /backup/database.sql 2>&1', $output, $ret);
    echo implode("\n", $output) . "\n";
    
    if ($ret === 0) {
        echo "✅ Database restored\n";
    } else {
        echo "❌ Database restore failed\n";
    }
    
    // Restore wp-content
    if (file_exists('/backup/wp-content.tar.gz')) {
        echo "Restoring wp-content...\n";
        
        // Backup current wp-content
        if (is_dir('/var/www/html/wp-content')) {
            exec('mv /var/www/html/wp-content /var/www/html/wp-content.bak.' . time());
        }
        
        // Extract
        exec('tar -xzf /backup/wp-content.tar.gz -C /var/www/html 2>&1', $output2, $ret2);
        
        // Fix permissions
        exec('chown -R www-data:www-data /var/www/html/wp-content');
        exec('chmod -R 755 /var/www/html/wp-content');
        
        if ($ret2 === 0) {
            echo "✅ wp-content restored\n";
            // Remove backup
            exec('rm -rf /var/www/html/wp-content.bak.*');
        } else {
            echo "❌ wp-content restore failed\n";
        }
    }
    
    echo "\n=== Restore Complete ===\n";
}
