<?php
/**
 * ============================================
 * WordPress 配置文件
 * WordPress Configuration File
 * ============================================
 * 
 * 这个文件包含 WordPress 运行所需的基本配置
 * This file contains basic configuration required for WordPress to run
 * 
 * 重要提示 / Important:
 * - 生产环境请更换安全密钥 / Change security keys for production
 * - 数据库密码应该更复杂 / Database password should be more complex
 * 
 * 更多信息 / More info:
 * https://wordpress.org/documentation/article/editing-wp-config-php/
 */

// ============================================
// 数据库设置 / Database Settings
// ============================================

/**
 * 数据库名称 / Database Name
 * 
 * WordPress 数据存储的数据库名
 * The name of the database where WordPress data is stored
 */
define( 'DB_NAME', 'wordpress' );

/**
 * 数据库用户名 / Database Username
 * 
 * 连接数据库的用户名
 * Username for connecting to the database
 */
define( 'DB_USER', 'wordpress' );

/**
 * 数据库密码 / Database Password
 * 
 * 连接数据库的密码
 * 注意：生产环境请使用更强的密码！
 * 
 * Password for connecting to the database
 * Note: Use a stronger password for production!
 */
define( 'DB_PASSWORD', 'wordpress_password_123' );

/**
 * 数据库主机 / Database Host
 * 
 * localhost 表示数据库在同一台机器上
 * localhost means database is on the same machine
 */
define( 'DB_HOST', 'localhost' );

/**
 * 数据库字符集 / Database Charset
 * 
 * utf8mb4 支持所有 Unicode 字符，包括 emoji
 * utf8mb4 supports all Unicode characters, including emoji
 */
define( 'DB_CHARSET', 'utf8mb4' );

/**
 * 数据库排序规则 / Database Collation
 * 
 * 留空使用默认排序规则
 * Leave empty to use default collation
 */
define( 'DB_COLLATE', '' );

// ============================================
// 认证密钥和盐 / Authentication Keys and Salts
// ============================================
/**
 * 这些密钥用于加密 Cookie 和密码
 * These keys are used to encrypt cookies and passwords
 * 
 * 重要：生产环境请访问以下地址生成新的密钥！
 * Important: For production, visit the following URL to generate new keys!
 * https://api.wordpress.org/secret-key/1.1/salt/
 * 
 * 每个密钥应该是唯一的长随机字符串
 * Each key should be a unique long random string
 */
define( 'AUTH_KEY',         'change-this-to-a-unique-phrase-1-修改为唯一字符串' );
define( 'SECURE_AUTH_KEY',  'change-this-to-a-unique-phrase-2-修改为唯一字符串' );
define( 'LOGGED_IN_KEY',    'change-this-to-a-unique-phrase-3-修改为唯一字符串' );
define( 'NONCE_KEY',        'change-this-to-a-unique-phrase-4-修改为唯一字符串' );
define( 'AUTH_SALT',        'change-this-to-a-unique-phrase-5-修改为唯一字符串' );
define( 'SECURE_AUTH_SALT', 'change-this-to-a-unique-phrase-6-修改为唯一字符串' );
define( 'LOGGED_IN_SALT',   'change-this-to-a-unique-phrase-7-修改为唯一字符串' );
define( 'NONCE_SALT',       'change-this-to-a-unique-phrase-8-修改为唯一字符串' );

// ============================================
// 数据库表前缀 / Database Table Prefix
// ============================================
/**
 * WordPress 数据库表的前缀
 * Prefix for WordPress database tables
 * 
 * 例如：wp_posts, wp_users, wp_options
 * Example: wp_posts, wp_users, wp_options
 * 
 * 如果在同一数据库运行多个 WordPress，每个需要不同前缀
 * If running multiple WordPress in same database, each needs different prefix
 */
$table_prefix = 'wp_';

// ============================================
// 调试模式 / Debug Mode
// ============================================
/**
 * 调试模式开关
 * Debug mode switch
 * 
 * true  = 显示错误信息（开发时使用）
 * false = 隐藏错误信息（生产环境使用）
 * 
 * true  = Show error messages (use during development)
 * false = Hide error messages (use in production)
 */
define( 'WP_DEBUG', false );

// ============================================
// Cloudflare 相关设置 / Cloudflare Related Settings
// ============================================

/**
 * 处理 HTTPS 反向代理
 * Handle HTTPS reverse proxy
 * 
 * Cloudflare 终止 SSL，转发 HTTP 到容器
 * 这个设置让 WordPress 知道用户实际使用的是 HTTPS
 * 
 * Cloudflare terminates SSL, forwards HTTP to container
 * This setting tells WordPress the user is actually using HTTPS
 */
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
}

/**
 * 获取真实用户 IP
 * Get real user IP
 * 
 * Cloudflare 会在这个头中传递真实用户 IP
 * 否则 WordPress 会看到 Cloudflare 的 IP
 * 
 * Cloudflare passes real user IP in this header
 * Otherwise WordPress would see Cloudflare's IP
 */
if (isset($_SERVER['HTTP_CF_CONNECTING_IP'])) {
    $_SERVER['REMOTE_ADDR'] = $_SERVER['HTTP_CF_CONNECTING_IP'];
}

// ============================================
// 文件系统设置 / Filesystem Settings
// ============================================

/**
 * 文件系统方法
 * Filesystem method
 * 
 * 'direct' 表示直接写入文件系统
 * 避免 FTP 连接提示
 * 
 * 'direct' means write directly to filesystem
 * Avoids FTP connection prompts
 */
define( 'FS_METHOD', 'direct' );

// ============================================
// 性能设置 / Performance Settings
// ============================================

/**
 * PHP 内存限制
 * PHP memory limit
 * 
 * WordPress 可使用的最大内存
 * Maximum memory WordPress can use
 */
define( 'WP_MEMORY_LIMIT', '256M' );

/**
 * 自动保存间隔（秒）
 * Auto-save interval (seconds)
 * 
 * 编辑文章时自动保存的间隔
 * Interval for auto-saving while editing posts
 */
define( 'AUTOSAVE_INTERVAL', 300 ); // 5 分钟 / 5 minutes

/**
 * 文章修订版本数量
 * Number of post revisions
 * 
 * 保留多少个历史版本
 * How many historical versions to keep
 */
define( 'WP_POST_REVISIONS', 5 );

// ============================================
// 绝对路径设置 / Absolute Path Settings
// ============================================
/**
 * WordPress 安装目录的绝对路径
 * Absolute path to WordPress installation directory
 * 
 * 不要修改这部分！
 * Do not modify this section!
 */
if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

/**
 * 加载 WordPress 核心
 * Load WordPress core
 * 
 * 这行必须在文件末尾
 * This line must be at the end of the file
 */
require_once ABSPATH . 'wp-settings.php';
