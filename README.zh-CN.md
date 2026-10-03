<p align="center">
  <img src="apps/web/src/assets/otter-mark.webp" alt="" width="96" height="96" />
</p>

<h1 align="center">QuanCard Server · 全卡卡自建服务</h1>

<p align="center">
  <strong>你的卡片与银行账户，在你自己的设备间同步，存放在只有你掌控的服务器上。</strong><br />
  <a href="https://quancard.app">全卡卡</a>的自托管、零知识同步服务与网页保险库。
</p>

<p align="center">
  <a href="https://quancard.app/server/">官网介绍</a> ·
  <a href="docs/guide/getting-started.zh-CN.md">上手指南</a> ·
  <a href="docs/deployment.md">部署指南（英文）</a> ·
  <a href="THREAT_MODEL.md">威胁模型</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/v2/14-home-samples-desktop.webp" alt="全卡卡网页保险库：按地区分组的卡片、发卡机构配色、侧边栏导航" width="860" />
</p>

> [!IMPORTANT]
> 全卡卡是**个人收藏保险库**：不发卡、不处理资金、不连接银行，也不协助绕过 KYC 或地区限制。当前为**开发预览版**，尚未经过独立安全审计；存放真实资料前，请先阅读[威胁模型](THREAT_MODEL.md)。

## 这是什么

iPhone 上的全卡卡把卡片和银行账户保存在本机，也可以通过 iCloud 同步。QuanCard Server 是第三种选择：**你自己的同步后端**，外加一个可以在任意桌面浏览器使用的完整**网页保险库**。而它本身始终看不到你的数据：

- **iPhone ⇄ 服务器 ⇄ 网页**：扫一次码完成配对，之后任何一端的修改都会端到端加密地同步到另一端。
- **零知识**：浏览器和 iPhone 在上传前完成全部加密。服务器只保存不透明、不可变的版本记录，永远看不到卡号、密钥或密码。
- **自己掌控**：一个 Docker Compose 文件，自动申请 HTTPS 证书；域名是你的，备份也由你安排。以 AGPL-3.0 开源。

> [!NOTE]
> **开源范围**：开源的是本仓库，即自建同步服务端与网页保险库。全卡卡 iPhone App 是商业应用，不开源；它使用的协议在本仓库中公开，方便你审计数据如何被加密和存储。

## 亮点

- **🔐 端到端加密**：每个条目单独以 AES-256-GCM 加密，密钥由浏览器内的 Argon2id（64 MiB）派生。服务器只校验派生出的认证密钥，无法重置或找回你的密码。
- **📱 多端同步**：与 iPhone App 使用同一套版本协议，与 iOS 测试向量逐字节一致。手机上的修改会自动出现在网页上：标签页回到前台时刷新一次，打开期间每 60 秒刷新。
- **🔗 扫码即连**：一次性二维码把保险库密钥交给 iPhone，服务器看不到。手机连上的瞬间网页就会确认，并跟进首次同步；两端播放同一段"已连接"动画。
- **🔀 可信的冲突处理**：绝不让设备时钟悄悄决定胜负。内容完全相同的副本（例如重新配对时）会自动合并；真正的分歧进入冲突中心，逐字段对比，批量处理前先确认清单。
- **💳 真正的桌面应用**：按地区与收藏导航的侧边栏、⌘K 命令面板、侧边抽屉式详情，与 iPhone 一致的发卡机构配色，浏览器内重新编码的卡面照片，以及全球转账信息（IBAN、SWIFT/BIC、ABA、Sort code 等）。
- **🙈 默认保护隐私**：卡号只显示后四位；有效期、持卡人、安全码需要再次输入密码。自动锁定时长可选，标签页切到后台 60 秒自动锁定，任务切换器中显示隐私遮罩。
- **👨‍👩‍👧 家庭可用**：所有者可以邀请成员。每位成员有独立账户和单独加密的保险库，所有者也无法读取。
- **🛡️ 加固**：TOTP 两步验证与恢复码、限流与锁定、只追加的审计日志、严格的 CSP、非 root 只读容器，零统计、零遥测。

## 快速开始

需要一台装有 Docker 的 Linux 主机、一个指向它的域名，并开放 80/443 端口。

```sh
git clone https://github.com/zoolapp/quancard-server.git && cd quancard-server
./scripts/init-env.sh vault.example.com      # 生成 .env，并打印一次性初始化令牌
docker compose up -d --wait                  # Caddy 自动申请 HTTPS 证书
```

1. 打开 `https://vault.example.com`，输入初始化令牌，创建所有者账户。
2. 新建保险库。它会附带一张示例卡；在 设置 → 示例数据 里可以载入完整的示例目录。
3. 网页端 设置 → **配对 iPhone**，然后在全卡卡 App 的 设置 → 同步 → 自建服务同步 里扫码。

只想在本机试用：`./scripts/init-env.sh localhost && docker compose -f compose.local.yaml up -d`，然后打开 <http://localhost:8080>。

📖 **[上手指南](docs/guide/getting-started.zh-CN.md)** 带你走完第一个小时：配对、成员、两步验证、冲突与日常运维。**[部署指南](docs/deployment.md)**（英文）介绍 nginx / Traefik / Cloudflare Tunnel 部署、升级与全部配置项。

## 截图

| | |
| --- | --- |
| ![带品牌形象的创建保险库页](docs/screenshots/v2/02-create-vault-desktop.webp) | ![侧边抽屉中的卡片详情（默认遮罩）](docs/screenshots/v2/05-detail-masked-desktop.webp) |
| ![⌘K 命令面板（深色）](docs/screenshots/v2/15-palette-dark.webp) | ![含转账信息的账户列表（深色）](docs/screenshots/v2/16-home-accounts-samples-dark.webp) |
| ![手机布局](docs/screenshots/v2/14-home-samples-mobile.webp) | ![手机上的锁定页（深色）](docs/screenshots/v2/11-unlock-mobile-dark.webp) |

截图中的数据均为测试数据或内置示例数据，使用公开测试号码，无法用于支付。

## 工作原理

```text
 浏览器 / iPhone（可信）                                你的服务器（不可信，只存密文）
 ─────────────────────                                ──────────────────────────────
 密码 ─Argon2id─▶ authKey ───────────────────────────▶ Argon2id(authKey) 校验值
                └▶ KEK ─包裹─▶ 账户密钥 ──────────────▶ 包裹后的账户密钥
                                └─包裹─▶ 保险库密钥 ──▶ 包裹后的保险库密钥
 卡片 / 账户 ─AES-256-GCM(保险库密钥)─▶ 版本 ─────────▶ 不透明、不可变的版本记录
 iPhone ◀── 一次性二维码（含保险库密钥，从不发给服务器）── 浏览器
```

- **一套协议，所有客户端**：网页端实现了 iPhone 的 `quancard.envelope.v1` 与 sync v1 格式，与 iOS 测试向量逐字节一致（[`vectors/`](vectors/SOURCES.md)、[`packages/protocol`](packages/protocol)，Apache-2.0）。macOS 等后续客户端可以通过 `GET /api/v1/status` 获知服务器支持哪些能力。
- **卡面照片**：在浏览器内重新编码（去除 EXIF、长边 ≤ 1600 px、≤ 1 MiB），加密后随条目版本存储，只会出现在你的服务器和你配对的设备上。
- **示例数据**：与 iPhone App 使用同一份示例目录和同样的条目 ID，在任一设备载入的示例，其他设备都能识别，也能一键移除。

协议规范：[auth v1](docs/protocol/auth-v1.md) · [pairing v1](docs/protocol/pairing-v1.md) · [sync v1](docs/protocol/sync-v1.md) · [HTTP API（OpenAPI）](docs/protocol/openapi.yaml) · [passkey v1（提案）](docs/protocol/passkey-v1.md)。

## 安全模型

数据库、备份或网络抓包被窃取，都不会泄露卡片内容；但弱密码仍可能被离线猜出，请使用长口令。服务器运营者能看到元数据：账户名、有多少条版本记录、写入时间。**被攻破或恶意的服务器可能下发篡改过的网页代码**，这是所有浏览器端端到端加密应用共有的边界。所以请自己运行服务器并及时更新，在不信任的主机上优先使用 iPhone App。详见 [THREAT_MODEL.md](THREAT_MODEL.md)；发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 项目状态

| 模块 | 状态 |
| --- | --- |
| 服务端：账户、两步验证、邀请、会话、审计、保险库数据面、配对、能力发现 | ✅ 已实现并测试 |
| 网页保险库：桌面外壳、⌘K、卡片与账户、照片、显示详情、冲突中心、示例数据、PWA | ✅ 已实现，端到端测试与 UI 门禁通过 |
| iPhone 自建同步：扫码配对、连接动画、相同副本合并 | ✅ App 内已实现（等待 App Store 上架） |
| Docker 镜像、HTTPS compose、备份与恢复 | ✅ 已验证 |
| Passkey（PRF 解锁） | 📝 [已有规范并经过评审](docs/protocol/passkey-v1.md)，尚未实现 |
| 浏览器内加密导入导出 `.qvault`、macOS 客户端、sync v2（照片独立存储） | 🗓 [路线图](docs/roadmap-multi-platform.md) |
| 独立安全审计 | 🗓 计划中 |

## 许可证

服务端与网页端采用 [AGPL-3.0-only](LICENSE)；`packages/protocol` 与 `vectors/` 采用 [Apache-2.0](packages/protocol/LICENSE)，方便其他客户端与审计者自由复用。全卡卡名称、海獭角色与 App 图标是 ZOOL LLC 的品牌资产（[说明](apps/web/src/assets/SOURCES.md)）。© 2026 ZOOL LLC。
