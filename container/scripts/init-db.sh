#!/bin/bash
# ============================================
# WordPress 数据库初始化脚本
# WordPress Database Initialization Script
# ============================================
#
# 这个脚本创建 WordPress 所需的数据库和用户
# This script creates the database and user required by WordPress
#
# 执行时机 / When executed:
# - 容器首次启动时 / First container start
# - 从 R2 恢复数据前 / Before restoring data from R2
#
# ============================================

# 颜色定义 / Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[DB-INIT]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[DB-INIT]${NC} $1"; }

# ============================================
# 检查数据库是否已存在
# Check if database already exists
# ============================================
log_info "Checking if WordPress database exists... / 检查 WordPress 数据库是否存在..."

# 使用 MySQL 命令检查
# Use MySQL command to check
# grep -c 计算匹配行数
# grep -c counts matching lines
DB_EXISTS=$(mysql -u root -e "SHOW DATABASES LIKE 'wordpress';" 2>/dev/null | grep -c wordpress || echo "0")

if [ "$DB_EXISTS" -eq 0 ]; then
    # ============================================
    # 创建数据库和用户
    # Create database and user
    # ============================================
    log_info "Creating WordPress database... / 创建 WordPress 数据库..."
    
    # 使用 heredoc 执行多条 SQL 语句
    # Use heredoc to execute multiple SQL statements
    mysql -u root <<EOF
-- ============================================
-- 创建数据库 / Create Database
-- ============================================
-- IF NOT EXISTS: 如果数据库已存在，不会报错
-- IF NOT EXISTS: No error if database already exists
-- CHARACTER SET utf8mb4: 支持所有 Unicode 字符，包括 emoji
-- CHARACTER SET utf8mb4: Support all Unicode characters, including emoji
-- COLLATE utf8mb4_unicode_ci: Unicode 排序规则
-- COLLATE utf8mb4_unicode_ci: Unicode collation
CREATE DATABASE IF NOT EXISTS wordpress
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

-- ============================================
-- 创建用户 / Create User
-- ============================================
-- IF NOT EXISTS: 如果用户已存在，不会报错
-- IF NOT EXISTS: No error if user already exists
-- 'wordpress'@'localhost': 只允许本地连接
-- 'wordpress'@'localhost': Only allow local connections
-- IDENTIFIED BY: 设置密码
-- IDENTIFIED BY: Set password
CREATE USER IF NOT EXISTS 'wordpress'@'localhost'
    IDENTIFIED BY 'wordpress_password_123';

-- ============================================
-- 授权 / Grant Permissions
-- ============================================
-- ALL PRIVILEGES: 授予所有权限
-- ALL PRIVILEGES: Grant all permissions
-- ON wordpress.*: 对 wordpress 数据库的所有表
-- ON wordpress.*: On all tables in wordpress database
-- TO 'wordpress'@'localhost': 授予给 wordpress 用户
-- TO 'wordpress'@'localhost': Grant to wordpress user
GRANT ALL PRIVILEGES ON wordpress.*
    TO 'wordpress'@'localhost';

-- ============================================
-- 刷新权限 / Flush Privileges
-- ============================================
-- 使权限更改立即生效
-- Make permission changes take effect immediately
FLUSH PRIVILEGES;
EOF
    
    log_info "WordPress database created successfully / WordPress 数据库创建成功"
    log_info "Database: wordpress"
    log_info "User: wordpress"
    log_info "Host: localhost"
else
    log_info "WordPress database already exists / WordPress 数据库已存在"
fi

# ============================================
# 验证数据库连接
# Verify database connection
# ============================================
log_info "Verifying database connection... / 验证数据库连接..."

# 尝试用 WordPress 用户连接
# Try to connect with WordPress user
if mysql -u wordpress -pwordpress_password_123 -e "SELECT 1;" &>/dev/null; then
    log_info "Database connection verified / 数据库连接验证成功"
else
    log_warn "Database connection failed, but continuing... / 数据库连接失败，但继续执行..."
fi

echo ""
