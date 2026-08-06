# Ansible 部署 Caddy Manager（单文件二进制）

把 Caddy Manager 以**单文件二进制**部署到云主机（Linux x86_64 / arm64，systemd 托管），**目标机无需安装 Node.js**。

## 目录
```
deploy/ansible/
├── ansible.cfg
├── playbook.yml
├── inventory/production/
│   ├── hosts                    # 主机清单（改成你的云主机）
│   └── group_vars/all.yml       # 部署变量
└── roles/caddymanager/          # 部署角色
```

## 步骤

```bash
# 0) 在控制机构建 Linux 二进制（需要 Bun；一次构建，多机复用）
node scripts/build.mjs bun-linux-x64      # x86_64 云主机
# node scripts/build.mjs bun-linux-arm64  # ARM64 云主机

# 1) 修改主机清单
vim inventory/production/hosts          # 换成真实 IP / 用户名

# 2) 按需修改变量
vim inventory/production/group_vars/all.yml
#    - caddymanager_auth_token: "your-strong-password"   （设置初始密码；留空则自动生成）
#    - caddymanager_reload_cmd: "systemctl reload caddy"   （caddy 由 systemd 管理时）
#    - arm64 主机: caddymanager_binary_src 改成 dist/caddymanager-linux-arm64

# 3) 执行部署（控制机需已安装 ansible；目标机只需 SSH 免密 + Caddy，无需 Node）
ansible-playbook -i inventory/production/hosts playbook.yml
```

## 变量说明（group_vars/all.yml）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `caddymanager_port` | `8888` | 服务端口 |
| `caddymanager_binary_src` | `dist/caddymanager-linux-x64` | 控制机上的二进制路径 |
| `caddymanager_bin_path` | `/usr/local/bin/caddymanager` | 目标机安装路径 |
| `caddymanager_app_dir` | `/opt/caddymanager` | 数据目录 |
| `caddymanager_caddy_bin` | `/usr/bin/caddy` | caddy 可执行文件 |
| `caddymanager_caddyfile_path` | `/etc/caddy/Caddyfile` | 生成的 Caddyfile |
| `caddymanager_reload_cmd` | 空 | 生效指令，如 `systemctl reload caddy` |
| `caddymanager_auth_token` | 空 | **初始密码/访问令牌**：留空自动生成 32 位随机串（保存在控制机 `./credentials/caddymanager_token`）；**手动指定则部署时使用你设置的值**（也可用 `-e caddymanager_auth_token=xxx` 传入） |

## 特性
- **幂等**：可重复执行，二进制/配置变更时自动重启服务
- **无需 Node**：部署的只是一个自包含 ELF 可执行文件
- **安全**：AUTH_TOKEN 自动生成、`no_log` 保护、健康检查通过才算成功
- **自动生效**：面板「应用配置」自动让 Caddy 重新加载配置
