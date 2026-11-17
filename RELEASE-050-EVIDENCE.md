# magpie-dumate v0.5.0 正式合并验收证据（GPT-RELEASE-V050）

- **验收对象**：`51f3c13`（release/0.5.0 tip，即 R3 复核批准合并的最终代码）
- **验收方式**：全新干净 detached worktree（`git worktree add --detach /tmp/magpie-release-verify 51f3c13`，工作区 0 脏文件），在本机独立执行；非 CI
- **验收日期**：2026-11-18
- **Node 版本**：v24.19.0（arm64，darwin 25.6.0）

## 1. 冻结确认

| 检查 | 结果 |
|---|---|
| `origin/release/0.5.0` | `51f3c13f9855927d5f90f53d2793a79479fd0b7a` ✓ |
| `origin/main` | `1d950b324b971fa162183d8114ce38a9ea411559`（未变化） ✓ |
| 可合并性 | main → 51f3c13 线性直系，fast-forward 可行 |

## 2. `node run-tests.mjs --quick`（离线回归）

```
✓ test-unit                     8 pass 0 fail
✓ test-static                   8 pass 0 fail
✓ test-config-edge              4 pass 0 fail
✓ test-checkin-branches         9 pass 0 fail
✓ test-desktop-paths            7 pass 0 fail
✓ test-macos-paths             10 pass 0 fail
✓ test-model-catalog           19 pass 0 fail
✓ test-token-lifecycle          6 pass 0 fail
✓ test-delivery-review          5 pass 0 fail
✓ test-edge-cases               6 pass 0 fail
✓ test-bug-regression           6 pass 0 fail
✓ test-determinism              1 pass 0 fail
✓ test-upgrade-compat           4 pass 0 fail
✓ test-security                 7 pass 0 fail
✓ test-sse-robustness           5 pass 0 fail
✓ test-docs-audit               7 pass 0 fail
✓ test-release-ready            3 pass 0 fail
✓ test-windows-paths            1 pass 0 fail
✓ test-privacy                  4 pass 0 fail
✓ test-request-transform       19 pass 0 fail
✓ test-budget-clamp            14 pass 0 fail
────────────────────────────────────────────────
合计: 153 pass, 0 fail, 23 套件
✓ secrets  脱敏检查通过
```

## 3. PASS / FAIL / SKIP 分类

- **PASS**：153（21 个套件，全部 0 fail）
- **FAIL**：0
- **SKIP（单列，不计入实质通过）**：`test-points-audit`、`test-client-fingerprint`
  —— 两套件需本机真实 DuMate 登录态做对账/指纹比对，本环境检测不到所需数据目录，
  套件自身打印 SKIP 并以 0 退出（行为与 0.4.0 基线一致，非本次引入）

## 4. `node tools/check-secrets.mjs --all`

通过（脱敏闸门以本机真实昵称/accountId/cookie 扫描全部受控文件，零命中）。

## 5. `npm pack --dry-run --json`

- 发布包共 **55** 个文件；运行时模块齐全：
  `index.mjs / paths.mjs / models.mjs / models.default.json / reasoning.mjs / budget.mjs`
  （v0.5.0 新增模块在包内 ✓）
- `package.json` version = `0.5.0`

## 6. 合并与标签

- `main` ← fast-forward 至 release/0.5.0（无 force push）
- 标签 `v0.5.0` → **`51f3c13`**（指向通过本验收的最终代码）

## 7. 已披露遗留事项（原样保留，进入下一版本）

1. `qwen4-max`：补齐身份头后仍 400 `required headers invalid`——上游必需条件未明（UNKNOWN），该模型在此链路不可用
2. DeepSeek `floor` 抬升：live 证据 INCONCLUSIVE（离线变换已证明；真实长推理任务待自然验证）
3. 首轮 live 验收中 Live 1 后未停止的执行偏差，已如实登记于 `VERIFY-050.md`
4. 独立复核方未能完整复跑 153 项测试（其环境无法下载仓库）；本证据由 ZCode 在干净 worktree 独立生成
