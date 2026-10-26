// 单元测试：纯函数层（不联网）—— parseCookieString / buildCookieHeader / extractCsrfToken / readDesktopLogin 容错
// 通过 _internal 导出避免重复实现。
import { DuMatePlugin, _internal } from "./index.mjs"

const { parseCookieString, buildCookieHeader, extractCsrfToken } = _internal ?? {}
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[U1] parseCookieString")
try {
  const cs = parseCookieString('a=1; b="hello world"; c=x=y;  ;d=4')
  if (cs.length !== 4) throw new Error("count=" + cs.length)
  if (cs[1].value !== "hello world") throw new Error("quoted value")
  if (cs[2].value !== "x=y") throw new Error("first-= split")
  if (cs.every((c) => c.domain === ".baidu.com") !== true) throw new Error("domain default")
  ok("4 items, quoted/unquoted/= in value handled")
} catch (e) { fail("parseCookieString", e) }

console.log("[U2] buildCookieHeader 域名过滤 + 引号规则")
try {
  const cookies = [
    { name: "A", value: "1", domain: ".baidu.com" },
    { name: "B", value: "2", domain: ".bce.baidu.com" },
    { name: "C", value: "3", domain: "passport.baidu.com" },
    { name: "D", value: "has space", domain: ".baidu.com" },
    { name: "E", value: '"pre-quoted"', domain: ".baidu.com" },
  ]
  const h = buildCookieHeader(cookies, "console.bce.baidu.com")
  if (!h.includes("A=1")) throw new Error("A should match")
  if (!h.includes("B=2")) throw new Error("B should match")
  if (h.includes("C=3")) throw new Error("C(passport) should NOT match")
  if (!h.includes('D="has space"')) throw new Error("space needs quotes: " + h)
  if (!h.includes("E=pre-quoted")) throw new Error("pre-quoted stripped: " + h)
  ok("domain filter + re-quote correct")
} catch (e) { fail("buildCookieHeader", e) }

console.log("[U3] extractCsrfToken")
try {
  const cookies = [
    { name: "bce-user-info", value: '"tok123"', domain: ".bce.baidu.com" },
    { name: "bce-user-info", value: "other", domain: ".passport.baidu.com" },
  ]
  const t = extractCsrfToken(cookies, "console.bce.baidu.com")
  if (t !== "tok123") throw new Error("got " + t)
  ok("picks matching-domain cookie, strips quotes")
} catch (e) { fail("extractCsrfToken", e) }

console.log("[U4] 未登录 loader / usage / checkin 快速路径")
try {
  const hooks = await DuMatePlugin({})
  const noAuth = async () => ({})
  const u = await hooks.auth.usage(noAuth)
  if (!(u.error && u.signIn === "kept")) throw new Error("usage no-auth shape")
  const c = await hooks.auth.checkin(noAuth)
  if (c.outcome !== "failed") throw new Error("checkin no-auth shape")
  const l = await hooks.auth.loader(noAuth)
  const res = await l.fetch("https://example.invalid/x", { method: "POST", body: "{}" })
  if (res.status !== 401 || res.headers.get("x-magpie-sign-in") !== "expired") throw new Error("loader no-auth 401")
  ok("all three hooks degrade gracefully")
} catch (e) { fail("no-auth paths", e) }

console.log("[U5] 损坏 auth.json / 缺 .cookie-key 时不崩")
try {
  process.env.DUMATE_USER_DATA_DIR = "Z:/definitely/not/exist"
  // bust ESM cache with a query string
  const m = await import("./index.mjs?broken=" + Date.now())
  const hooks2 = await m.DuMatePlugin({})
  const flow = await hooks2.auth.methods[0].authorize()
  const r = await flow.callback()
  if (r.type !== "failed") throw new Error("should fail gracefully, got " + JSON.stringify(r).slice(0, 100))
  ok("desktop login missing dir -> friendly failure")
  delete process.env.DUMATE_USER_DATA_DIR
} catch (e) { fail("broken desktop login", e) }

console.log("[U6] 图标：auth.icon 是非空 data:image URI，且带真实 PNG 魔数")
try {
  const hooks = await DuMatePlugin({})
  const icon = hooks.auth.icon
  if (typeof icon !== "string") throw new Error("auth.icon 应为字符串，实际 " + typeof icon)
  if (!icon.startsWith("data:image/")) throw new Error("图标不是 data:image URI")
  if (icon.length < 200) throw new Error("图标内容过短，可能是空壳: " + icon.slice(0, 40))
  if (icon.length > 1024 * 1024) throw new Error("超出 magpie 的 1MB 上限")
  // 优先取桌面端真实图标时应为 PNG（含 PNG 魔数 iVBORw0KGgo）；回退为 SVG。
  const isPng = icon.startsWith("data:image/png;base64,")
  const isSvg = icon.startsWith("data:image/svg+xml;base64,")
  if (!isPng && !isSvg) throw new Error("未知图标类型: " + icon.slice(0, 30))
  if (isPng && !icon.includes("iVBORw0KGgo")) throw new Error("PNG data URI 缺魔数，base64 可能损坏")
  ok(`auth.icon OK（${isPng ? "桌面端 PNG" : "内置 SVG 回退"}，${Math.round(icon.length / 1024)}KB）`)
} catch (e) { fail("auth.icon", e) }

console.log("[U7] 图标回退：桌面端不可用时仍给出内置矢量，且绝不抛错")
try {
  const { iconFromDesktopApp, iconFromBundle } = _internal ?? {}
  if (typeof iconFromBundle !== "function") throw new Error("iconFromBundle 未导出")
  const svgIcon = iconFromBundle()
  if (!svgIcon.startsWith("data:image/svg+xml;base64,")) throw new Error("内置图标非 SVG data URI")
  // 解码回来必须是合法 svg 根元素——防 base64 或文件内容损坏却"看起来成功"
  const decoded = Buffer.from(svgIcon.split(",")[1], "base64").toString("utf8")
  if (!decoded.trimStart().startsWith("<svg")) throw new Error("解码后不是 svg: " + decoded.slice(0, 40))
  if (!decoded.includes('viewBox="0 0 512 512"')) throw new Error("svg 缺 512 viewBox")
  // 指向不存在的 userData 目录时必须安静返回空串（不得抛异常拖垮插件加载）。
  // 直接调函数即可：desktopUserDataDir() 每次读 env，无需重新 import
  // （用 ?query 重新 import 会让 import.meta.url 带 query，反而打乱 icon.svg 的解析）。
  const prev = process.env.DUMATE_USER_DATA_DIR
  process.env.DUMATE_USER_DATA_DIR = "Z:/definitely/not/exist"
  const fromMissing = iconFromDesktopApp()
  if (prev === undefined) delete process.env.DUMATE_USER_DATA_DIR
  else process.env.DUMATE_USER_DATA_DIR = prev
  if (fromMissing !== "") throw new Error("无桌面端时应返回空串，实际: " + String(fromMissing).slice(0, 40))
  ok("回退链完整：桌面端缺失 → 内置 SVG，且不抛错")
} catch (e) { fail("图标回退", e) }

console.log("[U8] 装了桌面端时应取到官方图标（真 PNG，非回退矢量）")
try {
  const { iconFromDesktopApp } = _internal ?? {}
  const fromApp = iconFromDesktopApp()
  if (!fromApp) {
    // 没装 DuMate 的机器上这条不成立，跳过而不是判失败——否则换机器就红。
    console.log("  SKIP 本机未检测到 DuMate 桌面端，U8 不适用")
  } else {
    if (!fromApp.startsWith("data:image/png;base64,")) throw new Error("桌面端图标应为 PNG")
    if (!fromApp.includes("iVBORw0KGgo")) throw new Error("PNG 魔数缺失")
    // 真正解码一次：官方 512 图标解码后必须以 PNG 签名开头（\x89PNG）
    const raw = Buffer.from(fromApp.split(",")[1], "base64")
    if (raw.length < 1024) throw new Error("图标字节数过小: " + raw.length)
    if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
      throw new Error("解码后不是合法 PNG，前 4 字节: " + raw.subarray(0, 4).toString("hex"))
    }
    ok(`官方图标解码校验通过（${Math.round(raw.length / 1024)}KB，PNG 签名正确）`)
  }
} catch (e) { fail("官方图标", e) }

console.log("[U9] 插件自带 icon.png 优先于客户端图标（复制进插件才是自包含）")
try {
  const { iconFromPluginDir } = _internal ?? {}
  if (typeof iconFromPluginDir !== "function") throw new Error("iconFromPluginDir 未导出")
  const bundled = iconFromPluginDir()
  if (!bundled) {
    // 用户还没把 PNG 复制进插件目录。这条不算失败——但要说清楚现在走的是哪一级，
    // 否则"图标能用"会掩盖掉"插件其实不自包含"这件事。
    console.log("  SKIP 插件目录内暂无 icon.png（当前依赖客户端或 SVG 兜底；把客户端 icons/256x256.png 复制为 icon.png 即可自包含）")
  } else {
    if (!bundled.startsWith("data:image/png;base64,")) throw new Error("插件内 icon.png 应被识别为 PNG")
    const raw = Buffer.from(bundled.split(",")[1], "base64")
    if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
      throw new Error("icon.png 不是合法 PNG（签名不符）—— 复制时可能存成了别的内容")
    }
    if (bundled.length > 1024 * 1024) throw new Error("icon.png 编码后超过 magpie 1MB 上限")
    // 优先级验证：最终的 auth.icon 必须落在插件自带这份上。
    const hooks = await DuMatePlugin({})
    if (hooks.auth.icon !== bundled) throw new Error("优先序错误：auth.icon 没采用插件自带的 icon.png")
    ok(`插件自带 icon.png 生效（${Math.round(raw.length / 1024)}KB），且优先于客户端图标`)
  }
} catch (e) { fail("插件自带图标", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
