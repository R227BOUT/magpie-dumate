// 第八轮：签到"已签"分支的真实响应形态验证 + hasIssued 字段防御性解析
// 用户提示：今天已签到，所以真实"领取"路径无法触发——但我们已有 mock 全覆盖。
// 本轮验证"已签"分支读到的真实数据结构，确保字段名没猜错。
import { readFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join } from "node:path"

const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
const key = readFileSync(join(dir, ".cookie-key"))
const buf = Buffer.from(auth.cookies, "base64")
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
const cookies = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))
const h = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[V1] loginBonusInfo 真实响应字段核对")
try {
  const r = await fetch("https://console.bce.baidu.com/api/dumate/points/loginBonusInfo", {
    headers: { Cookie: h, "User-Agent": UA, Accept: "application/json", Referer: "https://console.bce.baidu.com/" },
  })
  const j = await r.json()
  const res = j.result ?? {}
  console.log("   真实响应 result:", JSON.stringify(res))
  const need = ["hasIssued", "totalPoints", "totalTimes"]
  const missing = need.filter((f) => !(f in res))
  if (missing.length) fail("字段核对", `真实响应缺字段: ${missing.join(",")}——插件读的字段名可能猜错！`)
  else ok(`hasIssued=${res.hasIssued}, totalPoints=${res.totalPoints}, totalTimes=${res.totalTimes} —— 插件读的字段名全部正确`)
} catch (e) { fail("loginBonusInfo 字段", e) }

console.log("[V2] 已签分支真实走一遍（首次 done 或 claimed，再调必须 done）")
try {
  const hooks = await import("./index.mjs").then((m) => m.DuMatePlugin({}))
  const seat = { type: "oauth", cookies, source: "desktop" }
  const c = await hooks.auth.checkin(async () => seat)
  console.log("   checkin 结果:", JSON.stringify(c))
  // 原断言写死 done，只有"今天早就签过"才成立。若这是当天第一次调用，
  // claimed 才是正确结果。真正要守住的性质是幂等：同一份凭据再问一次必须 done。
  if (!["done", "claimed"].includes(c.outcome)) throw new Error("应为 done 或 claimed，得到 " + c.outcome)
  if (c.outcome === "claimed") {
    const again = await hooks.auth.checkin(async () => seat)
    if (again.outcome !== "done") throw new Error("领取后再调应为 done，得到 " + again.outcome)
    ok("首次 claimed → 复调 done（幂等正确）")
  } else {
    ok("已签分支真实响应 → done（幂等正确）")
  }
} catch (e) { fail("已签真实分支", e) }

console.log("[V3] 积分明细接口核对（credits/points list，给 quota UI 更准的数据）")
try {
  // 试探积分流水接口是否存在（有些平台有 /points/records）
  for (const path of ["/api/dumate/points/records", "/api/dumate/points/list", "/api/dumate/points/history"]) {
    const r = await fetch("https://console.bce.baidu.com" + path, {
      headers: { Cookie: h, "User-Agent": UA, Accept: "application/json", Referer: "https://console.bce.baidu.com/" },
    })
    const t = await r.text()
    const isHtml = /<html|登录/i.test(t.slice(0, 300))
    console.log(`   ${path}: HTTP ${r.status}${isHtml ? " (HTML登录页)" : " " + t.slice(0, 100)}`)
  }
  ok("流水接口探测完成（结果见上，仅记录不判定）")
} catch (e) { fail("流水探测", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
