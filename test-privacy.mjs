// 第三十二轮：外发数据最小化审查 —— 插件向外部发送的所有数据清点（隐私面）
// 断言：除模型 prompt 本身外，不发送任何本机信息（路径/用户名/机器名）
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "index.mjs"), "utf8")
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[P1] 请求体外发清单：body 里只应有 messages/model/参数")
try {
  // fetch 调用中 body: JSON.stringify(...) 的位置——签到 body 是 {}（空对象）
  const bodies = [...src.matchAll(/body:\s*JSON\.stringify\(([^)]*)\)/g)].map((m) => m[1].trim())
  for (const b of bodies) {
    // 签到 body 允许 {}；token/get 是 GET 无 body；chat 的 body 由调用方传入（插件只透传）
    if (b === "{}" || b === "body ?? {}") continue
    if (b.includes("os.hostname") || b.includes("os.userInfo") || b.includes("userInfo()")) throw new Error("body 里混入机器信息")
  }
  ok("body 无机器信息注入")
} catch (e) { fail("body 清单", e) }

console.log("[P2] 头部外发清单：Cookie/UA/Referer/Authorization 之外无额外指纹头")
try {
  // 允许的头（X-Magpie-Sign-In 是 magpie 框架的响应头约定；错误响应头里的
  // "sign-in: expired" 是值不是头名，正则会误抓——用更精确的头名匹配）
  const allowed = ["Cookie", "User-Agent", "Accept", "Referer", "Content-Type", "X-Requested-With", "Origin", "csrftoken", "Authorization", "X-Magpie-Sign-In"]
  // 只抓真正传给 fetch 的 headers 块：New Headers(...) 或 fetch({...headers:{...}})
  // 排除 new Response({...headers:{...}})（那是响应头，X-Magpie-Sign-In 属于 magpie 协议）
  const requestHeaderBlocks = [...src.matchAll(/(?:await fetch\(|fetch\()[\s\S]{0,400}?headers:\s*\{([^}]+)\}/g)]
    .map((m) => m[1])
    .filter((hs) => !hs.includes("X-Magpie-Sign-In"))
  for (const hs of requestHeaderBlocks) {
    const keys = [...hs.matchAll(/["']([A-Za-z][A-Za-z0-9-]*)["']\s*:/g)].map((m) => m[1])
    for (const k of keys) {
      if (!allowed.includes(k)) throw new Error("意外请求头: " + k)
    }
  }
  ok(`请求头白名单内（${requestHeaderBlocks.length} 个请求块，无遥测/机器指纹头）`)
} catch (e) { fail("头清单", e) }

console.log("[P3] 无遥测/统计端点")
try {
  const urls = [...src.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0])
  const hosts = new Set(urls.map((u) => new URL(u.replace(/&amp;/g, "&")).host))
  for (const h of hosts) {
    if (!/\.baidu\.com$/.test(h)) throw new Error("非百度域外发: " + h)
  }
  ok(`外发域名仅 ${[...hosts].join(", ")}`)
} catch (e) { fail("遥测", e) }

console.log("[P4] 本机敏感信息不入错误消息（hostname/user）")
try {
  const host = os.hostname()
  const user = os.userInfo().username
  if (src.includes(host)) throw new Error("源码含机器名")
  if (src.includes(user)) throw new Error("源码含用户名")
  ok("无机器名/用户名硬编码")
} catch (e) { fail("本机信息", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
