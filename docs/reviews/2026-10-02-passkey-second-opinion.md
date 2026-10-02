# Second opinion: passkey v1 (PRF unlock) — 2026-10-02

- Subject: [docs/protocol/passkey-v1.md](../protocol/passkey-v1.md), together with auth-v1, THREAT_MODEL and `apps/web/src/session.ts`
- Reviewer: codex seat (gpt-6-astra, read-only, high reasoning). Author: Claude (Opus 5.5).
- Score: **3/5**. The cryptographic approach is sound. The proposal is not ready to implement until the six blockers below are part of the spec.

## Reviewer blockers (summary)

1. Keep the PRF output client-side. Requests must use field allow-lists that drop `clientExtensionResults.prf.results`. Request bodies, logs and audit events must be checked for it.
2. Make the key lifecycle work after a passkey unlock. `confirmPassword()` depends on `authCheck`, which a passkey unlock never sets. Registration needs the raw Account Key, but only a non-extractable `CryptoKey` is kept.
3. Bind credentials to accounts. One credentialID belongs to one account (DB unique). `user.id` is an opaque handle. The server checks the credential lookup against `userHandle`. An unlock inside a session is pinned to the session's account.
4. Constrain challenges: per operation type, per account and session, single use, re-checked against the security stamp. Define the follow-up `get()` that registration needs.
5. State the revocation boundary. Deleting a server record does not remove the decryption ability of "old wrapped copy plus a working authenticator". Decide whether deleting a passkey revokes the sessions it created.
6. Drop the claim "losing every passkey never loses data". Recovery still depends on the password plus 2FA or recovery codes.

## Synthesis

**一致（采纳）**
- 用 PRF 派生 KEK、再包裹一份 Account Key 副本的路线成立。账户无关的固定 PRF salt 没问题，HKDF 的全零 salt 也可以接受。
- UV passkey 跳过 TOTP 可以作为产品策略，但这是策略变更，注册时必须明示，并且需要所有者批准。
- 改动面要克制：Account Key 不轮换，"用 passkey 重设密码"另立 ADR。
- 不手写 CBOR/COSE，用成熟的验证库。

**不一致**
- 对方认为 HKDF info 应加入 rpId 和 accountID。我只部分同意：accountID 已经由 envelope 的 AAD 和明文 accountID 绑定。不过加进去成本为零，还能统一编码。**采纳**，info 定为 `"quancard.passkey.v1|kek|" ‖ rpId ‖ "|" ‖ accountID(uppercase) ‖ "|" ‖ base64url(credentialID)`。
- "iOS 原生无法共享"：对方指出这对已知域名或定制构建并不绝对。**同意并收窄表述**：对任意自托管域名，同一个预构建 App 做不到。
- signCount 回退不应一律拒绝，同步型 passkey 的计数恒为 0。**采纳**：两个值都非零且发生回退时才拒绝，并写审计。
- 我原稿漏掉了 blocker 2（passkey 解锁后 `authCheck` 为空，会导致"显示卡号"直接报错）。这是真实存在的代码级问题，对方是对的。

**我信谁、为什么**
- 结论站在对方一边：**本轮不实现 passkey P1**，只交付修订后的规格和评估结论。原因有三：6 个阻断项里有 2 个会触及 `session.ts` 的密钥生命周期；所有者还没批准新依赖和 TOTP 策略；没有真机 HTTPS 环境，无法验证 PRF。
- 下一步：passkey-v1.md 增加 §7"实现前置条件"，逐条落实以上阻断项。P1 开工前再做一次第二意见。
- 对用户的评估结论：**适合做，但只能作为"第二把钥匙"（PRF 解锁），不能替代密码，也不能和 iOS 原生共享。** 如果网页端只是偶尔使用，优先级不高；如果打算把它做成 macOS 等桌面端的主力入口，值得排进 0.3。
