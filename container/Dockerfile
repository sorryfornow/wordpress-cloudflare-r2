# ============================================
# WordPress + MariaDB Docker 镜像
# WordPress + MariaDB Docker Image
# ============================================
#
# 这个 Dockerfile 创建一个包含完整 WordPress 环境的容器镜像
# This Dockerfile creates a container image with complete WordPress environment
#
# 包含的组件 / Included components:
# - Ubuntu 22.04 (操作系统 / Operating System)
# - Apache 2.4 (Web 服务器 / Web Server)
# - PHP 8.x (脚本语言 / Scripting Language)
# - MariaDB 10.x (数据库 / Database)
# - Supervisor (进程管理 / Process Manager)
# - Cron (定时任务 / Scheduled Tasks)
# - WordPress Latest (内容管理系统 / CMS)
#
# ============================================

# --------------------------------------------
# 基础镜像 / Base Image
# --------------------------------------------
# 使用 Ubuntu 22.04 LTS 作为基础
# 这是一个稳定的长期支持版本
# Using Ubuntu 22.04 LTS as base
# This is a stable Long Term Support version
FROM ubuntu:22.04

# 设置环境变量，避免安装过程中的交互提示
# Set environment variable to avoid interactive prompts during installation
# DEBIAN_FRONTEND=noninteractive 会跳过所有安装时的用户确认
# DEBIAN_FRONTEND=noninteractive skips all user confirmations during installation
ENV DEBIAN_FRONTEND=noninteractive

# --------------------------------------------
# 安装软件包 / Install Packages
# --------------------------------------------
# apt-get update: 更新软件包列表
# apt-get install -y: 安装软件包，-y 自动确认
# 
# apt-get update: Update package list
# apt-get install -y: Install packages, -y auto-confirm

RUN apt-get update && apt-get install -y \
    # ========================================
    # Web 服务器 / Web Server
    # ========================================
    # Apache HTTP Server - 世界上最流行的 Web 服务器之一
    # Apache HTTP Server - One of the world's most popular web servers
    apache2 \
    # Apache 的 PHP 模块，让 Apache 能处理 PHP 文件
    # PHP module for Apache, allows Apache to process PHP files
    libapache2-mod-php \
    
    # ========================================
    # PHP 及扩展 / PHP and Extensions
    # ========================================
    # PHP 解释器核心
    # PHP interpreter core
    php \
    # MySQL/MariaDB 数据库连接扩展
    # MySQL/MariaDB database connection extension
    php-mysql \
    # HTTP 请求库（用于 WordPress 更新检查等）
    # HTTP request library (for WordPress update checks, etc.)
    php-curl \
    # 图像处理库（用于裁剪上传的图片）
    # Image processing library (for cropping uploaded images)
    php-gd \
    # 多字节字符串处理（支持中文等 UTF-8 字符）
    # Multibyte string handling (supports Chinese and other UTF-8 characters)
    php-mbstring \
    # XML 解析（用于 RSS、导入导出等）
    # XML parsing (for RSS, import/export, etc.)
    php-xml \
    # XML-RPC 协议支持（用于远程发布）
    # XML-RPC protocol support (for remote publishing)
    php-xmlrpc \
    # SOAP 协议支持
    # SOAP protocol support
    php-soap \
    # 国际化支持
    # Internationalization support
    php-intl \
    # ZIP 压缩支持（用于安装主题/插件）
    # ZIP compression support (for installing themes/plugins)
    php-zip \
    
    # ========================================
    # 数据库 / Database
    # ========================================
    # MariaDB 服务器（MySQL 的开源分支，完全兼容）
    # MariaDB server (open source MySQL fork, fully compatible)
    mariadb-server \
    # MariaDB 客户端（用于命令行操作）
    # MariaDB client (for command line operations)
    mariadb-client \
    
    # ========================================
    # 工具 / Tools
    # ========================================
    # HTTP 请求工具（用于同步脚本）
    # HTTP request tool (for sync scripts)
    curl \
    # 文件下载工具
    # File download tool
    wget \
    # 解压工具
    # Unzip tool
    unzip \
    # 进程管理器（管理多个服务同时运行）
    # Process manager (manages multiple services running simultaneously)
    supervisor \
    # 定时任务服务（每5分钟执行备份）
    # Scheduled task service (backup every 5 minutes)
    cron \
    
    # 清理 apt 缓存，减小镜像大小
    # Clean apt cache to reduce image size
    && rm -rf /var/lib/apt/lists/*

# --------------------------------------------
# 配置 Apache / Configure Apache
# --------------------------------------------
# 启用 rewrite 模块，WordPress 的固定链接功能需要它
# Enable rewrite module, required for WordPress permalinks
# 
# URL 重写示例 / URL Rewrite Example:
# /about-me/ → /index.php?pagename=about-me
RUN a2enmod rewrite

# 设置 ServerName 避免警告
# Set ServerName to avoid warnings
RUN echo "ServerName localhost" >> /etc/apache2/apache2.conf

# 配置 PHP 允许大文件上传（用于恢复备份）
# Configure PHP to allow large uploads (for backup restore)
RUN find /etc/php -name "php.ini" -exec sh -c 'echo "upload_max_filesize = 256M" >> "$1"' _ {} \; && \
    find /etc/php -name "php.ini" -exec sh -c 'echo "post_max_size = 256M" >> "$1"' _ {} \; && \
    find /etc/php -name "php.ini" -exec sh -c 'echo "memory_limit = 512M" >> "$1"' _ {} \; && \
    find /etc/php -name "php.ini" -exec sh -c 'echo "max_execution_time = 300" >> "$1"' _ {} \;

# --------------------------------------------
# 创建目录 / Create Directories
# --------------------------------------------
RUN mkdir -p /var/www/html /scripts /backup /var/log/supervisor

# --------------------------------------------
# 下载 WordPress / Download WordPress
# --------------------------------------------
# 1. 进入临时目录
# 2. 下载最新版 WordPress
# 3. 解压
# 4. 复制到 Web 目录
# 5. 清理临时文件
#
# 1. Enter temp directory
# 2. Download latest WordPress
# 3. Extract
# 4. Copy to web directory
# 5. Clean up temp files
RUN cd /tmp && \
    wget https://wordpress.org/latest.tar.gz && \
    tar -xzf latest.tar.gz && \
    cp -r wordpress/* /var/www/html/ && \
    rm -rf /tmp/wordpress /tmp/latest.tar.gz && \
    rm -f /var/www/html/index.html

# --------------------------------------------
# 设置文件权限 / Set File Permissions
# --------------------------------------------
# www-data 是 Apache 的运行用户
# WordPress 需要写入权限来上传文件、安装插件等
#
# www-data is Apache's runtime user
# WordPress needs write permission to upload files, install plugins, etc.
RUN chown -R www-data:www-data /var/www/html && \
    chmod -R 755 /var/www/html

# --------------------------------------------
# 复制配置文件和脚本 / Copy Config Files and Scripts
# --------------------------------------------
# 同步脚本（备份/恢复核心逻辑）
# Sync script (backup/restore core logic)
COPY scripts/sync.sh /scripts/sync.sh

# 启动脚本（容器启动时执行）
# Startup script (executed when container starts)
COPY scripts/startup.sh /scripts/startup.sh

# 数据库初始化脚本
# Database initialization script
COPY scripts/init-db.sh /scripts/init-db.sh

# WordPress 配置文件
# WordPress configuration file
COPY config/wp-config.php /var/www/html/wp-config.php

# 备份触发脚本 (用于手动触发备份)
# Backup trigger script (for manual backup trigger)
COPY config/__trigger_backup.php /var/www/html/__trigger_backup.php

# 自动备份插件 (安装后自动备份)
# Auto backup plugin (backup after installation)
RUN mkdir -p /var/www/html/wp-content/mu-plugins
COPY config/mu-plugins/r2-auto-backup.php /var/www/html/wp-content/mu-plugins/r2-auto-backup.php

# Supervisor 配置（管理 Apache、MariaDB、Cron）
# Supervisor config (manages Apache, MariaDB, Cron)
COPY config/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Apache 虚拟主机配置
# Apache virtual host config
COPY config/apache-site.conf /etc/apache2/sites-available/000-default.conf

# 设置脚本可执行权限
# Set scripts as executable
RUN chmod +x /scripts/*.sh

# --------------------------------------------
# 设置定时备份 / Setup Scheduled Backup
# --------------------------------------------
# Cron 表达式格式 / Cron Expression Format:
# ┌───────────── 分钟 (0-59) / Minute
# │ ┌───────────── 小时 (0-23) / Hour
# │ │ ┌───────────── 日 (1-31) / Day of month
# │ │ │ ┌───────────── 月 (1-12) / Month
# │ │ │ │ ┌───────────── 星期 (0-7, 0和7都是周日) / Day of week
# │ │ │ │ │
# │ │ │ │ │
# */5 * * * *  = 每5分钟执行一次 / Run every 5 minutes
#
# >> /var/log/backup.log 2>&1 = 将输出和错误都写入日志文件
# >> /var/log/backup.log 2>&1 = Write both output and errors to log file

RUN echo "*/5 * * * * /scripts/sync.sh push >> /var/log/backup.log 2>&1" > /etc/cron.d/backup-cron && \
    chmod 0644 /etc/cron.d/backup-cron && \
    crontab /etc/cron.d/backup-cron

# 创建备份目录 / Create backup directory
RUN mkdir -p /backup && chmod 777 /backup

# --------------------------------------------
# 暴露端口 / Expose Port
# --------------------------------------------
# 声明容器监听 80 端口（HTTP）
# Declare container listens on port 80 (HTTP)
EXPOSE 80

# --------------------------------------------
# 启动命令 / Startup Command
# --------------------------------------------
# 当容器启动时，执行 startup.sh 脚本
# When container starts, execute startup.sh script
CMD ["/scripts/startup.sh"]
