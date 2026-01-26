#!/bin/bash
# 启动脚本 / Startup script

echo "=== Starting WordPress Container ==="

# 1. 初始化 MariaDB 数据目录
echo "Step 1: Initializing MariaDB..."
if [ ! -d "/var/lib/mysql/mysql" ]; then
    mysql_install_db --user=mysql --datadir=/var/lib/mysql 2>&1 || echo "mysql_install_db had warnings"
fi

# 确保权限正确
chown -R mysql:mysql /var/lib/mysql 2>/dev/null || true

# 2. 启动 MariaDB 后台运行 (使用 mysqld_safe)
echo "Step 2: Starting MariaDB..."
/usr/bin/mysqld_safe --datadir=/var/lib/mysql &

# 等待 MariaDB 就绪
echo "Waiting for MariaDB..."
sleep 5
for i in {1..30}; do
    if mysqladmin ping -u root 2>/dev/null; then
        echo "MariaDB is ready!"
        break
    fi
    echo "  Waiting... $i/30"
    sleep 2
done

# 3. 创建数据库和用户
echo "Step 3: Creating database..."
mysql -u root -e "CREATE DATABASE IF NOT EXISTS wordpress CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || echo "Database may already exist"
mysql -u root -e "CREATE USER IF NOT EXISTS 'wordpress'@'localhost' IDENTIFIED BY 'wordpress_password_123';" 2>/dev/null || echo "User may already exist"
mysql -u root -e "GRANT ALL PRIVILEGES ON wordpress.* TO 'wordpress'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null || echo "Grants applied"

echo "Database setup complete!"

# 4. 设置 WordPress 权限
echo "Step 4: Setting permissions..."
chown -R www-data:www-data /var/www/html 2>/dev/null || true
chmod -R 755 /var/www/html 2>/dev/null || true

# 确保 mu-plugins 目录存在
mkdir -p /var/www/html/wp-content/mu-plugins 2>/dev/null || true
chown -R www-data:www-data /var/www/html/wp-content/mu-plugins 2>/dev/null || true

# 创建备份目录并设置权限
mkdir -p /backup 2>/dev/null || true
chmod 777 /backup 2>/dev/null || true

# 启动 cron 服务（用于 5 分钟备份）
echo "Starting cron service..."
service cron start 2>/dev/null || true

# 5. 启动 Apache（前台运行，保持容器存活）
echo "Step 5: Starting Apache in foreground..."
echo "=== WordPress Container Ready ==="

# 设置 Apache 环境变量
export APACHE_RUN_USER=www-data
export APACHE_RUN_GROUP=www-data
export APACHE_PID_FILE=/var/run/apache2/apache2.pid
export APACHE_RUN_DIR=/var/run/apache2
export APACHE_LOCK_DIR=/var/lock/apache2
export APACHE_LOG_DIR=/var/log/apache2

mkdir -p /var/run/apache2 /var/lock/apache2

# 前台运行 Apache（这会阻塞，保持容器运行）
exec /usr/sbin/apache2 -DFOREGROUND
