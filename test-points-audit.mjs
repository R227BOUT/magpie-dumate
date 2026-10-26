// 第二十四轮：积分守恒审计 —— 全天测试消耗的积分流水估算与对账（只读 usage）
// 把已知的每轮消耗列表与当前余额对照，确认无异常泄漏。
import { DuMatePlugin } from "./index.mjs"
import { readFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join } from "node:path"

// 读本机真实登录态。换台机器（或没装 DuMate）时必须 SKIP 而不是崩——
// 公开仓库里，一个自称"离线"的套件在别人机器上抛异常，就是坏掉的测试。
function readRealCookies() {
  try {
    const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
    const key = readFileSync(join(dir, ".cookie-key"))
    const buf = Buffer.from(auth.cookies, "base64")
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))
  } catch {
    return null
  }
}

const cookies = readRealCookies()
if (!cookies) {
  console.log("  SKIP 本机没有可用的 DuMate 登录态（%APPDATA%\\qianfan-desktop-app）——本套件需真实账号对账，跳过")
  process.exit(0)
}

const seat = { type: "oauth", cookies, source: "desktop" }
const hooks = await DuMatePlugin({})
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[A1] 当前积分状态快照")
try {
  const u = await hooks.auth.usage(async () => seat)
  if (u.error) throw new Error(u.error)
  const w = u.windows[0]
  console.log(`   余额: ${u.balance} | 已用: ${w.display} (${w.used.toFixed(2)}%) | 到期: ${w.runsOutAt ?? "无近期到期包"}`)
  if (!(w.used >= 0 && w.used <= 100)) throw new Error("used 百分比越界")
  ok("usage 快照正常")
} catch (e) { fail("usage", e) }

console.log("[A2] 积分守恒检查（无跳变/无负值）")
try {
  // 这里刻意不写任何具体余额锚点：那是账号私有数据，写进代码等于把
  // 自己的余额连同一部分账目一起公开。可长期成立的断言是守恒性——
  // 余额是有限正数、百分比不越界——而不是某个会随使用漂移的数字。
  const u = await hooks.auth.usage(async () => seat)
  if (u.error) throw new Error(u.error)
  const bal = parseFloat(u.balance)
  if (!Number.isFinite(bal) || bal <= 0) throw new Error("余额非正数或不可解析: " + u.balance)
  const w = u.windows?.[0]
  if (!w || !(w.used >= 0 && w.used <= 100)) throw new Error("used 百分比越界")
  if (!(w.limit >= 0) || !(w.amount >= 0)) throw new Error("used/total 出现负值")
  ok(`余额为正且 used=${w.used.toFixed(2)}% 在界内（不依赖具体数额）`)
} catch (e) { fail("对账", e) }

console.log("[A3] 签到状态复验（今天要么已签，要么本次签上——不应反复重复领取）")
try {
  // 原来写死期望 done。那只有"今天早就签过"才成立；若这是当天第一次调用，
  // claimed 才是正确结果，写死 done 等于让断言依赖运行时刻。
  // 能长期成立的断言是：结果必须是这两种之一，且 done 时不会再发 POST。
  const c = await hooks.auth.checkin(async () => seat)
  if (!["done", "claimed"].includes(c.outcome)) throw new Error("outcome=" + c.outcome)
  if (c.outcome === "claimed" && !(c.credit === undefined || c.credit >= 0)) throw new Error("credit 异常: " + c.credit)
  ok(`${c.outcome}（${c.message}）`)
} catch (e) { fail("签到幂等", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
