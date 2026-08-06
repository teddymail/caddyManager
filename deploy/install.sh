#!/bin/sh
# Caddy Manager 安装脚本（Linux 云主机）
# 用法: sudo bash deploy/install.sh
set -e

APP_DIR=/opt/caddymanager
SERVICE=caddymanager

echo "==> 1/4 安装依赖"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js >= 18，请先安装（https://nodejs.org）" >&2
  exit 1
fi
if ! command -v caddy >/dev/null 2>&1; then
  echo "需要 Caddy，请先安装（https://caddyserver.com/download）" >&2
  exit 1
fi
node -e "if(Number(process.versions.node.split('.')[0])<18){console.error('Node >= 18 必需');process.exit(1)}"

echo "==> 2/4 拷贝应用到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -R src public package.json "$APP_DIR/"
mkdir -p "$APP_DIR/data"

echo "==> 3/4 安装 systemd 服务"
cp deploy/caddymanager.service /etc/systemd/system/$SERVICE.service
systemctl daemon-reload

echo "==> 4/4 启动"
systemctl enable --now $SERVICE
systemctl status $SERVICE --no-pager || true

cat <<'MSG'

安装完成。请务必修改 /etc/systemd/system/caddymanager.service：
  1) Environment=AUTH_TOKEN=...    设置强随机访问令牌
  2) 按 caddy 部署方式配置 CADDY_RELOAD_CMD
然后执行: sudo systemctl restart caddymanager
面板地址: http://<云主机IP>:8888
MSG
