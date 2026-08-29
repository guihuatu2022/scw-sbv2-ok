# scw-singbox（加固版）

在 Scaleway Serverless Containers（0.1 vCPU / 128MB / 仅 HTTP / 单请求最长 3600s）上部署 sing-box **VLESS + WS + TLS + CDN** 代理，前置 Cloudflare Worker 做反代 + 伪装站。

## 加固点（相对原版）

1. **Worker 共享密钥闸门**：WS 路径转发前校验 `X-Proxy-Token`，无凭据请求直接返回伪装页，不激活容器 → 防爬虫/主动探测导致冷启动。
2. **容器 Private + IAM 限 CF IP**：非 Cloudflare 来源 IP 在鉴权层被 403，容器根本不启动 → 防域名扫描导致无法休眠。
3. **高熵 WS_PATH 强制**：仓库公开，默认路径等于公开；改为未设置即启动失败，强制部署时设置高熵随机路径。
4. **出站 SSRF 防护**：sing-box `route` 层 `ip_is_private` 走 block 出站，挡掉 Scaleway 元数据 `169.254.42.42` 等内网。
5. **伪装站细节**：补 `robots.txt` / `favicon`，修掉假 `.example` 邮箱，外链加 `rel="noopener noreferrer"`。
6. **客户端联动**：uTLS chrome 指纹 + mux + 0-RTT early data，与服务端严格对齐。

## 关键修复：sing-box 1.12+ 配置格式迁移

原版 `config.template.json` 用的是 sing-box 1.11 及更早的 DNS / domain_strategy 旧格式，**在 sing-box v1.13.12 下 `sing-box check` 直接 FATAL、容器启动失败**。本版已迁移到 1.12+ 新格式并经真实二进制校验通过：

- DNS server：`address: "1.1.1.1"` → `{ "type": "udp", "tag": "resolver", "server": "1.1.1.1" }`
- 出站解析：direct 的 `domain_strategy` → `domain_resolver: { server, strategy }`
- 全局解析：`route.default_domain_resolver: { server, strategy }`

迁移依据见 [sing-box 迁移文档](https://sing-box.sagernet.org/migration/)。

## 架构

```
客户端 ──HTTPS/WSS──> Cloudflare Worker (自定义域名)
                         ├── WS_PATH + X-Proxy-Token → 反代到 Scaleway Private 容器 (Host覆写 + X-Auth-Token)
                         │                              └── sing-box VLESS+WS (0.0.0.0:PORT)
                         │                                   └── route: 私网/元数据 → block
                         ├── /robots.txt /favicon.ico → 站点辅助文件
                         └── 其他路径 → 返回伪装页面 (OpenSoft Hub 软件下载站)
```

## 需要准备的 4 个秘密值

部署前先生成以下 4 个值，记到密码管理器里：

| 名称 | 怎么生成 | 用在哪 |
|------|---------|--------|
| `UUID` | `sing-box generate uuid` 或 `uuidgen` | Scaleway 容器环境变量 + Karing |
| `WS_PATH` | 32 位十六进制，如 `/db/8f3a2c1e9b7d4056a1c2e8f0b3d4a5c6.iso` | Scaleway 容器 + Worker + Karing（三处必须完全一致） |
| `WS_SECRET` | 32 位随机字符串（`openssl rand -hex 16`） | Worker 变量 + Karing 的 `X-Proxy-Token` 头 |
| `CONTAINER_TOKEN` | Scaleway IAM API Key 的 secret（控制台生成，见步骤 3） | Worker 变量（转发时加 `X-Auth-Token` 头） |

---

## 部署步骤

### 步骤 0：本地生成秘密值

```bash
# UUID
sing-box generate uuid          # 或 uuidgen

# WS_PATH（高熵随机路径）
echo "/db/$(openssl rand -hex 16).iso"

# WS_SECRET（共享密钥）
openssl rand -hex 16
```

把这三个值记下来。`CONTAINER_TOKEN` 在步骤 3 生成。

### 步骤 1：推送代码到 GitHub

```bash
git clone https://github.com/你的用户名/scw-sb-yh.git
cd scw-sb-yh
git remote set-url origin https://github.com/你的用户名/scw-sb-yh.git
git push -u origin main
```

GitHub Actions 会自动构建镜像并推送到 GHCR：
```
ghcr.io/你的用户名/scw-sb-yh:latest
```
到仓库 Actions 页确认构建成功（绿勾）后再继续。

> 注意：你的仓库如果是 public，**不要把真实的 UUID/WS_PATH/WS_SECRET 提交进代码或环境变量文件**。它们只通过 Scaleway 控制台和 Worker 变量注入，不出现在仓库里。

### 步骤 2：创建 Scaleway Serverless Container

Scaleway 控制台：

1. 进入 **Serverless Containers**，创建命名空间（如 `proxy`）
2. 创建新容器：
   - **镜像**：`ghcr.io/你的用户名/scw-sb-yh:latest`
   - **vCPU**：100m (0.1)
   - **内存**：128 MB
   - **并发**：默认或 1-2
   - **端口**：8080（HTTP 协议，非 TCP）
3. **环境变量**（Settings → Environment Variables）：
   - `UUID` = 步骤 0 生成的 UUID
   - `WS_PATH` = 步骤 0 生成的高熵路径（如 `/db/8f3a....iso`）
   - `LOG_LEVEL` = `error`
4. **部署**。部署成功后会得到一个容器域名，格式类似：
   ```
   https://your-container-xxx.functions.fnc.fr-par.scw.cloud
   ```
   记下这个域名 = `ORIGIN_DOMAIN`。

### 步骤 3：把容器设为 Private + 限制只允许 Cloudflare IP（核心防扫描）

这一步直接解决"容器域名被扫描导致无法休眠"的问题。

> 建议顺序：先用 **Public** 模式 + 步骤 4/5/6 把整条链路调通（能正常代理），确认无误后**再切 Private**。Private 是上线前的最后一道闸，不是调试期开的。

**最小可用方案（仅 Private + Token）**：

1. 容器详情页 → **Security** 标签 → **Privacy Policy** 设为 **Private**
2. 创建 IAM 应用 + API Key（用于 `X-Auth-Token`）：
   - 进 **IAM** → **Applications** → 新建应用（如 `container-invoker`）
   - 给该应用创建 **API Key**，记下生成的 **secret key** = 这就是 `CONTAINER_TOKEN`
   - 创建 **IAM Policy**：
     - **Principal**：选上面那个应用
     - **Permission Set**：`ContainersPrivateAccess`
     - **Scope**：选你的 project

切到 Private 后，Worker 转发时会带 `X-Auth-Token`，正常代理不受影响；无 token 的直接扫域名请求 → 403，容器不启动。

**加固方案（Private + Token + 限制只允许 CF IP）**：在上面的 IAM Policy 里加 **CEL 条件**，限制只有来自 Cloudflare 的请求才放行：
     ```
     inIpRange(request.ip, "173.245.48.0/20") ||
     inIpRange(request.ip, "103.21.244.0/22") ||
     inIpRange(request.ip, "103.22.200.0/22") ||
     inIpRange(request.ip, "103.31.4.0/22") ||
     inIpRange(request.ip, "141.101.64.0/18") ||
     inIpRange(request.ip, "108.162.192.0/18") ||
     inIpRange(request.ip, "190.93.240.0/20") ||
     inIpRange(request.ip, "188.114.96.0/20") ||
     inIpRange(request.ip, "197.234.240.0/22") ||
     inIpRange(request.ip, "198.41.128.0/17") ||
     inIpRange(request.ip, "162.158.0.0/15") ||
     inIpRange(request.ip, "104.16.0.0/13") ||
     inIpRange(request.ip, "104.24.0.0/14") ||
     inIpRange(request.ip, "172.64.0.0/13") ||
     inIpRange(request.ip, "131.0.72.0/22")
     ```
     （Cloudflare 全部网段见 https://www.cloudflare.com/ips/ ，CF 偶尔增减网段，需定期核对）

效果：直接扫容器域名的请求来源不是 CF IP → 平台在鉴权层直接 403，**容器根本不启动**，零冷启动成本。

> **重要验证**：CEL 里的 CF 网段基于"Worker subrequest 源 IP 属于 Cloudflare 公布网段"这一前提。上线前务必实测：先只开 Private+Token 确认能连；**再加 CEL IP 限制**，如果代理断了说明 Worker 出口 IP 不在你填的网段里，那就退回「Private+Token」方案即可（仍然能挡住无 token 的扫描）。

### 步骤 4：部署 Cloudflare Worker

1. 把仓库里的 `_workers.js` 内容粘到 Cloudflare 控制台 **Workers & Pages** → 新建 Worker 的编辑器里（或用 `wrangler deploy`）
2. Worker **Settings → Variables** 里添加 4 个变量（敏感的设为 **Secret/加密**）：

   | 变量 | 值 | 是否 Secret |
   |------|-----|------------|
   | `WS_PATH` | 步骤 0 的高熵路径（与容器一致） | 可普通 |
   | `ORIGIN_DOMAIN` | 步骤 2 的容器域名 | 是 |
   | `CONTAINER_TOKEN` | 步骤 3 的 IAM API secret | 是 |
   | `WS_SECRET` | 步骤 0 的共享密钥 | 是 |

3. （可选但推荐）给 Worker 绑定**自定义域名**：
   - Worker Settings → **Triggers** → **Custom Domains** → 加一个你的域名（需在 Cloudflare 托管 DNS）
   - 用自定义域名比 `*.workers.dev` 更不易被识别、更稳

### 步骤 5：验证伪装站

浏览器访问你的 Worker 域名：
- `https://你的域名/` → 看到 OpenSoft Hub 软件下载站首页
- `https://你的域名/downloads` → 下载列表
- `https://你的域名/你的WS_PATH`（普通 GET，不带密钥头）→ 返回"Direct Download Link"伪装页（不是 404，不是 sing-box 错误）
- `https://你的域名/任意不存在的路径` → 404 页

只要不带 `X-Proxy-Token` 头，命中 WS 路径也只返回伪装页、不激活容器——这就是闸门生效的标志。

### 步骤 6：Karing 客户端配置

仓库里的 `karing-client-template.json` 是模板，填入对应值：

```json
{
  "type": "vless",
  "tag": "scw-singbox",
  "server": "你的worker域名或自定义域名",
  "server_port": 443,
  "uuid": "你的UUID（与容器一致）",
  "flow": "",
  "transport": {
    "type": "ws",
    "path": "/db/你的高熵路径.iso（与容器一致）",
    "headers": { "X-Proxy-Token": "你的WS_SECRET" },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  },
  "tls": {
    "enabled": true,
    "server_name": "你的worker域名或自定义域名",
    "utls": { "enabled": true, "fingerprint": "chrome" }
  },
  "multiplex": { "enabled": true, "padding": false }
}
```

Karing 操作：
1. 打开 Karing → 配置 → 新建 → 选 **手动输入 / sing-box JSON**（或导入 JSON 文件）
2. 把上面填好值的 JSON 作为单节点导入
3. 选中该节点，开启系统代理/TUN 即可

> 说明：`karing-client-template.json` 是一个 **sing-box outbound 对象**（字段对照用）。Karing 支持导入 sing-box 格式配置；如果你的 Karing 版本只接受完整 sing-box config 或 share URI，可把该 outbound 包进 `{"outbounds":[...]}` 结构，或在 Karing UI 里按上表字段逐项填写（等价）。

**联动要点（三处必须严格一致，否则连不上）**：
- `path` = 容器的 `WS_PATH` = Worker 的 `WS_PATH`
- `X-Proxy-Token` 头值 = Worker 的 `WS_SECRET`
- `uuid` = 容器的 `UUID`
- `max_early_data` + `early_data_header_name` = 与服务端 config 一致（已对齐为 2048 / `Sec-WebSocket-Protocol`）
- `multiplex.enabled` = true（服务端也开了），`padding` 两端一致（默认 false）

---

## 行为说明与排障

- **冷启动**：容器缩到 0 后，首次连接会有几百 ms ~ 数秒延迟（拉镜像 + sing-box 初始化）。镜像很小（busybox + 单二进制），已尽量压低。
- **3600s 断流**：单条 WS 连接最长 1 小时被平台切断，客户端会自动重连；若容器仍温热则热启动，几乎无感。
- **日志脱敏**：启动日志里 UUID 和 WS_PATH 都显示 `***`，排查时去 Scaleway 控制台看容器日志。
- **排障模式**：临时把容器环境变量 `LOG_LEVEL` 改成 `debug`，排查完改回 `error`。
- **连不上排查顺序**：
  1. 浏览器访问 WS 路径应返回伪装页（说明 Worker 在线）
  2. 检查 Karing 的 `path` / `X-Proxy-Token` / `uuid` 是否三处一致
  3. 容器是否 Private 且 IAM 策略允许 CF IP
  4. Worker 变量是否 4 个都配了（缺一个会 503）

## 局限（serverless HTTP-only 架构天花板）

- **GFW 流量指纹**：VLESS+WS+TLS+CDN 对长时间大流量仍相对易被识别。已用 uTLS chrome 指纹 + mux 缓解；敏感时期可把两端 `multiplex.padding` 同步改为 `true`（多耗一点 CPU 换隐蔽性）。
- **不适合大流量稳定传输**（4K 视频、大文件长传、实时游戏），适合轻度间歇性浏览。要彻底解决需换支持裸 TCP 的平台（小 VPS + Reality）。

## 构建说明

- sing-box 版本：v1.13.12
- 构建不带任何 `-tags`，只含 VLESS + WS 核心功能
- 运行时 busybox:1.36-musl，镜像几 MB
- Go 运行时参数：`GOMAXPROCS=1, GOMEMLIMIT=100MiB, GOGC=off`
