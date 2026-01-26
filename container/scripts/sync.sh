#!/bin/bash
# ============================================
# WordPress 数据同步脚本
# WordPress Data Sync Script
# ============================================
#
# 这是整个持久化方案的核心脚本
# This is the core script of the persistence solution
#
# 功能 / Functions:
# - push: 备份数据到 R2 / Backup data to R2
# - pull: 从 R2 恢复数据 / Restore data from R2
# - status: 显示备份状态 / Show backup status
#
# 使用方法 / Usage:
#   /scripts/sync.sh push    # 备份 / Backup
#   /scripts/sync.sh pull    # 恢复 / Restore
#   /scripts/sync.sh status  # 状态 / Status
#
# ============================================

# 遇到错误不退出（我们手动处理）
# Don't exit on error (we handle it manually)
# set -e  # 注释掉 / Commented out

# ============================================
# 配置变量 / Configuration Variables
# ============================================

# Worker R2 API 的基础 URL
# Base URL for Worker R2 API
# 容器内访问 localhost:80 就是访问 Worker
# Inside container, localhost:80 accesses Worker
WORKER_URL="http://localhost:80"

# 临时备份目录
# Temporary backup directory
BACKUP_DIR="/backup"

# WordPress 内容目录
# WordPress content directory
WP_CONTENT="/var/www/html/wp-content"

# 当前时间戳
# Current timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ============================================
# 颜色定义 / Color Definitions
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color / 无颜色

# ============================================
# 日志函数 / Log Functions
# ============================================
log_info() {
    echo -e "${GREEN}[SYNC]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_warn() {
    echo -e "${YELLOW}[SYNC]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    echo -e "${RED}[SYNC]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_step() {
    echo -e "${BLUE}[SYNC]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# ============================================
# 备份函数 - 生成备份文件（由 Worker 拉取）
# Push Function - Generate backup files (Worker will pull them)
# ============================================
push_data() {
    log_info "=========================================="
    log_info "Starting backup / 开始备份"
    log_info "=========================================="
    
    # 创建备份目录
    # Create backup directory
    mkdir -p $BACKUP_DIR
    chmod 777 $BACKUP_DIR
    
    # ----------------------------------------
    # 步骤 1: 导出数据库
    # Step 1: Export database
    # ----------------------------------------
    log_step "Step 1: Exporting database / 导出数据库"
    
    mysqldump -u wordpress -pwordpress_password_123 \
        --single-transaction \
        --quick \
        --lock-tables=false \
        wordpress > $BACKUP_DIR/database.sql 2>/dev/null
    
    # 检查导出结果 / Check export result
    if [ ! -s $BACKUP_DIR/database.sql ]; then
        log_error "Database export failed or empty / 数据库导出失败或为空"
        return 1
    fi
    
    # 显示文件大小 / Show file size
    DB_SIZE=$(du -h $BACKUP_DIR/database.sql | cut -f1)
    log_info "Database exported: $DB_SIZE / 数据库已导出: $DB_SIZE"
    
    # ----------------------------------------
    # 步骤 2: 打包 wp-content 目录
    # Step 2: Package wp-content directory
    # ----------------------------------------
    log_step "Step 2: Packaging wp-content / 打包 wp-content"
    
    tar -czf $BACKUP_DIR/wp-content.tar.gz \
        -C /var/www/html \
        --exclude='wp-content/cache' \
        --exclude='wp-content/upgrade' \
        --exclude='wp-content/wflogs' \
        --exclude='*.log' \
        --exclude='*.tmp' \
        wp-content 2>/dev/null
    
    # 检查打包结果 / Check packaging result
    if [ ! -s $BACKUP_DIR/wp-content.tar.gz ]; then
        log_error "wp-content packaging failed / wp-content 打包失败"
        return 1
    fi
    
    # 显示文件大小 / Show file size
    WP_SIZE=$(du -h $BACKUP_DIR/wp-content.tar.gz | cut -f1)
    log_info "wp-content packaged: $WP_SIZE / wp-content 已打包: $WP_SIZE"
    
    # ----------------------------------------
    # 步骤 3: 写入时间戳
    # Step 3: Write timestamp
    # ----------------------------------------
    echo $TIMESTAMP > $BACKUP_DIR/timestamp.txt
    
    log_info "=========================================="
    log_info "Backup files ready! / 备份文件已准备好！"
    log_info "Timestamp: $TIMESTAMP"
    log_info "Files location: $BACKUP_DIR"
    log_info "=========================================="
    
    return 0
}

# ============================================
# 恢复函数 - 从 R2 下载数据
# Pull Function - Download data from R2
# ============================================
pull_data() {
    log_info "=========================================="
    log_info "Starting restore from R2 / 开始从 R2 恢复"
    log_info "=========================================="
    
    # 创建备份目录
    # Create backup directory
    mkdir -p $BACKUP_DIR
    
    # ----------------------------------------
    # 步骤 1: 检查 R2 中是否有备份
    # Step 1: Check if backup exists in R2
    # ----------------------------------------
    log_step "Step 1: Checking R2 for backups / 检查 R2 备份"
    
    # 获取文件列表 / Get file list
    BACKUP_LIST=$(curl -s "${WORKER_URL}/r2/list" 2>/dev/null)
    
    # 检查是否有数据库备份 / Check if database backup exists
    if ! echo "$BACKUP_LIST" | grep -q "database.sql"; then
        log_warn "No database backup found in R2 / R2 中没有数据库备份"
        return 1
    fi
    
    log_info "Backup found in R2 / 在 R2 中找到备份"
    
    # ----------------------------------------
    # 步骤 2: 下载数据库
    # Step 2: Download database
    # ----------------------------------------
    log_step "Step 2: Downloading database / 下载数据库"
    
    curl -s "${WORKER_URL}/r2/get/backup/database.sql" -o $BACKUP_DIR/database.sql
    
    # 检查下载结果 / Check download result
    if [ ! -s $BACKUP_DIR/database.sql ]; then
        log_error "Database download failed or empty / 数据库下载失败或为空"
        return 1
    fi
    
    DB_SIZE=$(du -h $BACKUP_DIR/database.sql | cut -f1)
    log_info "Database downloaded: $DB_SIZE / 数据库已下载: $DB_SIZE"
    
    # ----------------------------------------
    # 步骤 3: 下载 wp-content
    # Step 3: Download wp-content
    # ----------------------------------------
    log_step "Step 3: Downloading wp-content / 下载 wp-content"
    
    curl -s "${WORKER_URL}/r2/get/backup/wp-content.tar.gz" -o $BACKUP_DIR/wp-content.tar.gz
    
    # 检查下载结果 / Check download result
    if [ ! -s $BACKUP_DIR/wp-content.tar.gz ]; then
        log_warn "wp-content download failed, skipping / wp-content 下载失败，跳过"
    else
        WP_SIZE=$(du -h $BACKUP_DIR/wp-content.tar.gz | cut -f1)
        log_info "wp-content downloaded: $WP_SIZE / wp-content 已下载: $WP_SIZE"
    fi
    
    # ----------------------------------------
    # 步骤 4: 恢复数据库
    # Step 4: Restore database
    # ----------------------------------------
    log_step "Step 4: Restoring database / 恢复数据库"
    
    # 导入数据库 / Import database
    # mysql 会读取 SQL 文件并执行
    # mysql reads SQL file and executes it
    mysql -u wordpress -pwordpress_password_123 wordpress < $BACKUP_DIR/database.sql 2>/dev/null
    
    if [ $? -ne 0 ]; then
        log_error "Database restore failed / 数据库恢复失败"
        return 1
    fi
    
    log_info "Database restored / 数据库已恢复"
    
    # ----------------------------------------
    # 步骤 5: 恢复 wp-content
    # Step 5: Restore wp-content
    # ----------------------------------------
    if [ -s $BACKUP_DIR/wp-content.tar.gz ]; then
        log_step "Step 5: Restoring wp-content / 恢复 wp-content"
        
        # 备份当前 wp-content（以防万一）
        # Backup current wp-content (just in case)
        if [ -d "$WP_CONTENT" ]; then
            mv $WP_CONTENT ${WP_CONTENT}.bak.$$ 2>/dev/null || true
        fi
        
        # 解压到 WordPress 目录
        # Extract to WordPress directory
        tar -xzf $BACKUP_DIR/wp-content.tar.gz -C /var/www/html 2>/dev/null
        
        if [ $? -eq 0 ]; then
            # 设置正确的权限 / Set correct permissions
            chown -R www-data:www-data $WP_CONTENT 2>/dev/null || true
            chmod -R 755 $WP_CONTENT 2>/dev/null || true
            
            # 删除旧备份 / Remove old backup
            rm -rf ${WP_CONTENT}.bak.$$ 2>/dev/null || true
            
            log_info "wp-content restored / wp-content 已恢复"
        else
            # 恢复失败，还原旧的 / Restore failed, revert to old
            log_warn "wp-content restore failed, reverting / wp-content 恢复失败，还原"
            rm -rf $WP_CONTENT 2>/dev/null || true
            mv ${WP_CONTENT}.bak.$$ $WP_CONTENT 2>/dev/null || true
        fi
    fi
    
    # ----------------------------------------
    # 步骤 6: 获取备份时间
    # Step 6: Get backup timestamp
    # ----------------------------------------
    LAST_BACKUP=$(curl -s "${WORKER_URL}/r2/get/backup/timestamp.txt" 2>/dev/null || echo "unknown")
    
    # ----------------------------------------
    # 步骤 7: 清理
    # Step 7: Clean up
    # ----------------------------------------
    log_step "Step 6: Cleaning up / 清理"
    rm -f $BACKUP_DIR/database.sql $BACKUP_DIR/wp-content.tar.gz
    
    log_info "=========================================="
    log_info "Restore completed! / 恢复完成！"
    log_info "Backup timestamp: $LAST_BACKUP / 备份时间: $LAST_BACKUP"
    log_info "=========================================="
    
    return 0
}

# ============================================
# 状态函数 - 显示备份状态
# Status Function - Show backup status
# ============================================
show_status() {
    log_info "=========================================="
    log_info "Backup Status / 备份状态"
    log_info "=========================================="
    
    # 获取 R2 文件列表 / Get R2 file list
    echo ""
    log_info "Files in R2 / R2 中的文件:"
    curl -s "${WORKER_URL}/r2/list" | python3 -m json.tool 2>/dev/null || \
        curl -s "${WORKER_URL}/r2/list"
    
    # 获取最后备份时间 / Get last backup time
    echo ""
    LAST_BACKUP=$(curl -s "${WORKER_URL}/r2/get/backup/timestamp.txt" 2>/dev/null)
    if [ -n "$LAST_BACKUP" ]; then
        log_info "Last backup / 最后备份: $LAST_BACKUP"
    else
        log_warn "No backup timestamp found / 未找到备份时间戳"
    fi
    
    log_info "=========================================="
}

# ============================================
# 主程序 / Main Program
# ============================================

# 根据参数执行相应功能
# Execute corresponding function based on argument
case "${1:-help}" in
    push)
        # 备份到 R2 / Backup to R2
        push_data
        exit $?
        ;;
    pull)
        # 从 R2 恢复 / Restore from R2
        pull_data
        exit $?
        ;;
    status)
        # 显示状态 / Show status
        show_status
        ;;
    *)
        # 显示帮助 / Show help
        echo ""
        echo "WordPress R2 Sync Script / WordPress R2 同步脚本"
        echo ""
        echo "Usage / 用法:"
        echo "  $0 push     - Backup to R2 / 备份到 R2"
        echo "  $0 pull     - Restore from R2 / 从 R2 恢复"
        echo "  $0 status   - Show backup status / 显示备份状态"
        echo ""
        echo "Examples / 示例:"
        echo "  $0 push     # Run backup now / 立即备份"
        echo "  $0 pull     # Restore data / 恢复数据"
        echo "  $0 status   # Check status / 检查状态"
        echo ""
        exit 1
        ;;
esac
