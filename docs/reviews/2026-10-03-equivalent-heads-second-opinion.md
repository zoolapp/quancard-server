# Second opinion: equivalent heads are not a conflict — 2026-10-03

- Subject: draft sync-v1 §3.1 (two rules: identical content; untouched sample data).
- Reviewer: codex seat (read-only). Author: Claude (Opus 5.5). Score **2/5**.

## Reviewer blockers

1. Rule 2 (sample data, ignoring name, institution, notes and tags) hides real user edits. Example:
   notes "我的工资卡" against the catalogue text would be judged "equivalent".
2. A save must take as parents only the heads the edit was based on, never a head that arrived
   later and was never shown.
3. Define the comparison exactly: photos by verified content, unknown fields or versions, null vs
   empty, array order.
4. The real defect is re-joining by uploading every item as a new root. Collapsing duplicates in
   the view alone leaves history growing.

## Synthesis

**一致（采纳）**
- 规则 1 可以做，但要严格比较：除 `updatedAt` 外的所有字段都比（包括 `createdAt`、转账标识的 `id`、数组顺序）。照片按解密后实际字节的 SHA-256 比较，读不到照片时不判定为相等。只有全部版本都相等才折叠，A = B ≠ C 仍然是冲突。
- 措辞改成"视图折叠"：不写入，也不承诺 DAG 收敛。
- 保存时的父节点只能取编辑开始时看到的版本：网页编辑器已经固定了 `base`（cb8d4aa），iOS 用 `SyncEditToken.heads` 拒绝过期的编辑。

**不一致 / 我漏掉的**
- 规则 2 是我写错了。末句"用户改过的示例仍然冲突"和前面的判定条件互相矛盾。**删除规则 2。** 示例数据冲突改由冲突中心提供一个显式的批量操作：先展示差异，再由用户确认。
- 转账标识的 `id`：我原本打算忽略。按评审意见保留比较，宁可多报冲突。

**我信谁、为什么**
- 信评审。冲突规则一旦误判就是静默丢数据，代价不对称，所以只保留"严格相同"这一条自动规则，其余都交给用户显式操作。
- 根治重连：iPhone 加入时先拉取，与远端相同的条目直接关联、不再上传新根。这是 iOS 同步引擎的改动，单独立项（见 roadmap）。规则 1 先消除它在界面上造成的冲突。
