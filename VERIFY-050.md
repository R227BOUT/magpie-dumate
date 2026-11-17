# v0.5.0 live 验收记录（脱敏）

执行时间：2026-11-17 深夜（本地时间）· 分支 `release/0.5.0` · 预授权范围：≤3 条极小请求
脚本：`tools/verify-v050-live.mjs`（登录态发现走插件跨平台逻辑，未涉及 APPDATA）

## 执行结果（按实际证据，脱敏）

| # | 模型 | 状态码 | 判定 | 证据 |
|---|---|---|---|---|
| Live 1 | `qwen4-max` | **400** | **FAIL（未修复）** | 补身份头后仍返回 `required headers invalid`。缺头假设不成立，上游另有本插件未满足的必需条件，具体原因 UNKNOWN。错误证据已脱敏保留。 |
| Live 2 | `deepseek-v41-flash`（max_tokens:1000 + high） | **200** | **INCONCLUSIVE（功能正常）** | 正文非空、`finish_reason` 合理（completion=78，含 reasoning=46）；`X-Dumate-Gw-Realmodel: deepseek-v4.1-flash-low-latency-1017`。本轮 completion ≤ 请求值 1000，**floor 抬升未获得充分 live 证据**——离线矩阵 B8 已证明变换正确，待真实长推理任务自然验证。 |
| Live 3 | `glm-5` | **200** | **PASS** | `X-Magpie-Dumate-Route: glm-5=>glm-53`（版本替代映射出站）+ `X-Dumate-Gw-Realmodel: glm-5.3` 确认实际后端。 |

## 验收偏差（如实记录）

- **偏差**：Live 1 返回 400 后按预案应「失败即停」，实际继续执行了 Live 2/3。
  原因：脚本把「验证补头是否修复」实现为「实测并记录状态」而非「必须 200 才继续」，
  偏离了施工令第 17 条的字面约定。该偏差使 Live 2/3 的消耗超出了严格授权的字面边界
  （仍为 3 条总量）。已在脚本注释与本记录中如实标注，不重跑、不补跑。
- **影响评估**：Live 2/3 均为同等量级的极小请求，且结果各自独立有效（Pass /
  Inconclusive 判定不依赖 Live 1 的失败）。

## 结论与残余风险

- qwen4-max 在本插件链路**不可用**（UNKNOWN：上游必需条件未明）——README 已如实标注，
  该模型不声明档位、不进入任何白名单。
- floor 抬升的 live 证据不足（INCONCLUSIVE），不宣称「已证明」。
- 本插件对上游的成本影响：每次调用消耗账号积分，行为与桌面客户端一致。

---

## R2 收尾补充（2026-11-18，commit 见 release/0.5.0 最新提交）

以上三条结果与偏差声明为**历史事实，保持原样不改**。第二轮复核（GPT-REVIEW-V050-R2）
指出有界读取在「无 Content-Length / 虚假偏小 CL / 分块」场景不成立、customModelKeys
会在 config() 间累积、live 脚本未真失败即停。三项已修复（T14/T15/T16 判别测试，
RED→GREEN，未发送任何新真实请求）：

- 有界读取改为对**实际字节**计数（流式探测+重组体，声明 CL 仅作快速跳过路径）；
  无 CL / 虚假 CL / 70KB 实测均放弃学习且响应体逐字节透传。
- customModelKeys 与当前有效配置同步：config 删除的模型下一次请求立即失去信任。
- verify-v050-live.mjs 修正为真失败即停（PASS/FAIL/INCONCLUSIVE 三态，FAIL 不再
  继续发请求）。**未重新执行 live**——既有 3 条授权已用完，首轮结果即最终结果。
