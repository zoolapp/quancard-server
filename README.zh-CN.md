<h1 align="center">QuanCard Server（全卡卡自托管服务）</h1>

<p align="center">
  <a href="https://quancard.app">全卡卡</a>的自托管、零知识同步服务与网页保险库——把你自己的银行卡和银行账户信息，保存在你自己控制的服务器上。
</p>

<p align="center"><a href="README.md">English</a></p>

> [!IMPORTANT]
> 全卡卡是**个人收藏保险库**：不发卡、不处理资金、不连接银行，也不协助绕过 KYC 或地区限制。当前为 0.1 开发预览版，尚未经过独立安全审计；存放真实资料前请先阅读[威胁模型](THREAT_MODEL.md)。

## 为什么需要它

iPhone 上的全卡卡把卡片保存在本地，并可通过 iCloud 同步。但有些用户不希望依赖任何厂商的云。QuanCard Server 让你自己运行同步后端，并提供网页端，可以在任意桌面浏览器中浏览、添加和编辑卡片——**服务器始终无法读取你的数据**。

## 功能

- **零知识加密**：所有内容在浏览器（或 iPhone）内以 AES-256-GCM 加密后才上传，服务器只保存密文。
- **密码不出浏览器**：Argon2id（64 MiB）+ HKDF。服务器只校验派生出的认证密钥，无法重置或找回你的密码。
- **默认 HTTPS**：一条 `docker compose up`，自动申请 Let's Encrypt 证书；明文 HTTP 一律拒绝。
- **网页端管理卡片与账户**：增删改查、搜索、地区筛选、收藏、卡面照片、全球转账信息（IBAN、SWIFT/BIC、ABA 等）。
- **默认遮罩**：卡号只显示后四位；有效期、持卡人、安全码需再次输入密码才显示；空闲 5 分钟自动锁定。
- **诚实的冲突处理**：与 iPhone 相同的不可变版本协议；并发修改并列展示，绝不按时间自动选赢家。
- **iPhone 配对**：一次性二维码（10 分钟、仅一次）把保险库密钥交给你的手机，服务器看不到密钥。
- **家庭可用**：所有者可邀请成员，每人拥有独立账户、独立加密的保险库。
- **加固**：TOTP 两步验证、限流、锁定、只追加审计日志、严格 CSP、非 root 只读容器、零统计零遥测。

## 快速开始

需要一台装有 Docker 的 Linux 主机、一个指向它的域名，并开放 80/443 端口。

```sh
git clone https://github.com/zoolapp/quancard-server.git && cd quancard-server
./scripts/init-env.sh vault.example.com
docker compose up -d --wait
```

打开 `https://vault.example.com`，输入上一步打印的初始化令牌，创建所有者账户。只想本机试用：`./scripts/init-env.sh localhost && docker compose -f compose.local.yaml up -d`，然后打开 <http://localhost:8080>。

使用自己的 nginx / Traefik / Cloudflare Tunnel、备份恢复、升级与全部配置项，见[部署指南（英文）](docs/deployment.md)。

## 两个常见问题

**卡面照片怎么同步？** 照片在浏览器内重新编码（去除 EXIF、长边 ≤ 1600 px、≤ 1 MiB），加密后随该卡片的版本一起上传。照片只会出现在你的服务器和你配对的设备上，不会进入任何第三方云。注意：同步协议 v1 中每次编辑带照片的卡片都会重新上传照片，保险库接近 64 MiB 上限时会提示；独立照片存储与历史压缩计划在 sync v2 中实现。

**能在网页端添加卡片吗？** 可以。新卡片就是普通的同步版本，经过与 iPhone 完全相同的严格校验，配对的设备会像收到其他修改一样收到它。

## 安全模型

数据库、备份或网络抓包被窃取都不会泄露卡片内容；但弱密码仍可能被离线猜测，请使用长口令。服务器运营者能看到元数据（账户名、版本数量与时间等）。**被攻破或恶意的服务器可能下发篡改过的网页代码**——这是所有浏览器端端到端加密应用的共同边界——因此请自己运行服务器并保持更新；在不信任的主机上优先使用 iPhone App。详见 [THREAT_MODEL.md](THREAT_MODEL.md)；漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

服务端与网页端：[AGPL-3.0-only](LICENSE)。`packages/protocol` 与 `vectors/`：[Apache-2.0](packages/protocol/LICENSE)，便于其他客户端与审计者复用。© 2026 ZOOL LLC。
