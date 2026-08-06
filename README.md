# Caddy Manager

一个运行在 **8888 端口** 的 Caddy 反向代理配置管理服务：通过 Web 面板 / REST API 统一管理「所有经过云主机 Caddy 代理的后端服务」，一键**生成 → 校验 → 替换 → 热生效** Caddy 配置，并内置**动态域名 IP 自动跟随机制**，解决「后端动态域名 IP 已变、Caddy 上游还指向旧 IP 导致连不上」的问题。

零第三方依赖（仅用 Node.js 内置模块），Node >= 18 即可运行。

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 🧭 规则管理 | 域名 / 上游地址 / TLS 模式 / 路径匹配 / 健康检查 / 附加指令，CRUD + 启停 |
| ⚙️ 一键生效 | `caddy fmt` 规范化 → `caddy validate` 校验 → 原子写盘 → **admin API 热加载**（最快路径，不 spawn 进程），失败自动降级 `caddy reload` / `caddy start` / 自定义命令 |
| 🔄 动态域名跟随 | **两种机制**（见下）：Caddy 原生 `dynamic a` 定时刷新 A 记录（推荐，无需重载）；或管理器看门狗定时解析、IP 变化自动改 upstream 并热重载 |
| 🚀 高性能 | 零依赖、响应缓存、Gzip、状态缓存（5s TTL）、写盘合并、`QUIET` 模式；实测 **~1.2 万 QPS / 0.08ms** |
| 📦 单文件二进制 | 用 Bun 交叉编译出 Linux x64/arm64 自包含可执行程序，**目标机无需安装 Node**，页面资源已内嵌 |
| 🌐 负载均衡 | 单个规则支持多个上游地址，自动生成 `lb_policy round_robin` |
| 🔐 鉴权 | 可选 `AUTH_TOKEN` Bearer 鉴权（生产必开） |

---

## 动态域名机制（重点）

后端大规模使用动态域名、IP 随时变化时，任选其一（推荐第 1 种，也可两者叠加）：

### 1) Caddy 原生 `dynamic a`（推荐）

规则「动态 DNS 机制」选 `caddy`，生成如下配置 —— **Caddy 按 `refresh` 周期自行重新解析 A/AAAA 记录并替换上游池，无需任何重载，IP 一变立即跟随**：

```caddy
shop.example.com {
    reverse_proxy {
        dynamic a dyn-shop.example.com 8080 {
            refresh 30s
            versions ipv4 ipv6
        }
        health_uri /healthz
    }
}
```

> ✅ 已用真实 Caddy v2.11.4 + 本地可控 DNS 端到端验证：翻转 A 记录后，一个 refresh 周期内上游池自动切到新 IP（旧后端 0 流量），翻回后自动恢复。`dynamic a` 是标准 Caddy 内置模块，无需 xcaddy 定制编译。

### 2) 管理器看门狗（`manager` 模式）

规则「动态 DNS 机制」选 `manager`：后台守护进程按 `dnsInterval` 定时解析监听域名，**IP 变化时自动改写规则 upstream（同端口）并触发热重载**，同时记录 `resolvedIps / lastChangedAt / lastError` 便于审计。也可随时点面板「🔄 刷新 DNS」或调 `POST /api/refresh-dns` 立即执行。

> 适用场景：需要把解析结果固化进配置文件、或 Caddy 配置由其他系统消费、需要明确看到「当前指向的 IP」。

---

## 快速开始（本地）

```bash
node src/server.js          # 默认 8888 端口
# 打开 http://localhost:8888
```

首次运行自动创建 `data/rules.json`；`/etc/caddy` 可写时生成目标默认为 `/etc/caddy/Caddyfile`，否则为 `data/Caddyfile`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8888` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录 |
| `RULES_FILE` | `<DATA_DIR>/rules.json` | 规则存储文件 |
| `CADDY_BIN` | `caddy` | caddy 可执行文件 |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile`（可写时） | 生成的目标 Caddyfile |
| `CADDY_RELOAD_CMD` | 空 | 自定义生效命令，如 `systemctl reload caddy`（优先于 admin API / caddy reload） |
| `CADDY_START_CMD` | 空 | 自定义启动命令，如 `systemctl restart caddy` |
| `AUTH_TOKEN` | 空 | API Bearer Token（生产必设） |
| `GLOBAL_TLS_EMAIL` | 空 | 全局 ACME 邮箱 |
| `SEED_EXAMPLES` | 空 | 首次启动写入示例规则 |
| `DNS_WATCH_INTERVAL_MS` | `5000` | 看门狗扫描间隔（manager 模式规则按各自 `dnsInterval` 节流） |
| `QUIET` | 空 | `1` 时关闭请求日志，提升吞吐 |

---

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | Caddy 安装/运行状态、配置路径、动态规则数 |
| GET | `/api/rules` | 规则列表 |
| POST | `/api/rules` | 新建规则 |
| GET | `/api/rules/:id` | 规则详情 |
| PUT | `/api/rules/:id` | 更新规则（部分字段） |
| DELETE | `/api/rules/:id` | 删除规则 |
| POST | `/api/rules/:id/toggle` | 启用/停用 |
| GET | `/api/preview` | 预览生成的 Caddyfile |
| POST | `/api/apply` | 应用配置：`{dryRun:true}` 仅校验；`{writeOnly:true}` 仅写盘；默认完整生效 |
| POST | `/api/refresh-dns` | 立即执行动态域名解析 + 自动更新 + 热重载 |
| POST | `/api/examples` | 载入示例规则 |
| GET | `/api/meta` | 表单模板元信息 |

规则字段：`name`、`domains`、`upstream`（支持多地址空格/逗号分隔）、`path`、`stripPrefix`、`tls`（auto/internal/off）、`healthPath`、`extra`、`enabled`、`dnsMode`（off/caddy/manager）、`dnsHost`、`lookupInterval`、`dnsInterval`、`dnsResolvers`。

---

## 单文件二进制（Linux 无需 Node）

服务可以编译成**单文件自包含可执行程序**（内置 JS 引擎，目标机零依赖、无需安装 Node），用 [Bun](https://bun.sh) 交叉编译：

```bash
npm i -g bun 或 brew install bun     # 构建工具，只在控制机需要
node scripts/build.mjs bun-linux-x64     # Linux x86_64（常见云主机）
node scripts/build.mjs bun-linux-arm64   # Linux ARM64
node scripts/build.mjs bun-darwin-x64    # macOS（本地调试）
```

产物在 `dist/`，例如 `caddymanager-linux-x64`（约 90MB，ELF 单文件，页面资源已内嵌）：

```bash
# 目标机：一个文件拷过去就能跑
scp dist/caddymanager-linux-x64 root@云主机:/usr/local/bin/caddymanager
ssh root@云主机 "caddymanager"    # 默认 8888 端口
```

> 验证情况：macOS 版二进制已完整实测（内嵌页面 / API / 规则 / 真实 caddy 校验全通过）；Linux 版已交叉编译并经 `file` 确认为 ELF x86-64/aarch64，建议上线前在目标机跑一次冒烟：`./caddymanager-linux-x64 & curl -s localhost:8888/api/status`。

## 部署（Linux 云主机）

**方式 A：单文件二进制（推荐，无需 Node）**
```bash
node scripts/build.mjs bun-linux-x64
scp dist/caddymanager-linux-x64 root@云主机:/usr/local/bin/caddymanager
ssh root@云主机 "mkdir -p /opt/caddymanager/data && caddymanager"   # 生产请用 systemd 托管（见 deploy/）
```

**方式 B：源码运行（开发/调试，需 Node >= 18）**
```bash
sudo bash deploy/install.sh          # 安装 systemd 服务并启动
```

systemd 单元见 [`deploy/caddymanager.service`](deploy/caddymanager.service)。生产建议：`AUTH_TOKEN` 必设；`CADDY_RELOAD_CMD=systemctl reload caddy` 交给 systemd 管理 caddy。

### Ansible 一键部署

Ansible 只需「拷一个二进制 + 生成 systemd 单元 + 启动」，目标机**无需安装 Node**，非常适合批量/幂等部署。完整 playbook 见 [`deploy/ansible/`](deploy/ansible/)：

```bash
# 控制机：先构建 linux 二进制，再执行
node scripts/build.mjs bun-linux-x64
vim deploy/ansible/inventory/production/hosts        # 1) 改成你的云主机
vim deploy/ansible/inventory/production/group_vars/all.yml   # 2) 配置 CADDY_RELOAD_CMD / 端口等
ansible-playbook -i deploy/ansible/inventory/production/hosts deploy/ansible/playbook.yml   # 3) 部署
```

特性：幂等可重复执行；`AUTH_TOKEN` 自动生成（`lookup('password')` 存控制机、`no_log` 保护）；健康检查通过才算成功；二进制/配置变更自动重启服务。

---

## 测试与验证

```bash
npm test                        # 31 项单元/API 测试
node scripts/e2e-dynamic-dns.mjs  # 端到端验证 Caddy dynamic a 自动跟随 A 记录变化
```

应用配置流水线（`POST /api/apply`）：
1. 生成 Caddyfile
2. `caddy fmt` 规范化
3. `caddy validate` 校验（**不合格绝不写盘**）
4. 原子写盘（tmp + rename）
5. 生效：自定义命令 → admin API 热加载 → `caddy reload` → `caddy start`

## 安全提示

- 本服务可改写 Caddy 配置并触发重载，**必须设置 `AUTH_TOKEN`**，且建议仅在内网/VPN 内暴露 8888 端口。
