// 第三十三轮：跨平台桌面登录态定位（RanceLee 报告的问题）
// 全部离线：平台/环境/主目录都是注入的，不依赖真实 macOS。
// 也验证「当前激活账号」才决定模型配置目录，不猜账号、不写死用户名。
import { _internal } from "./index.mjs"
import { desktopUserDataDir, discoverConfig, DUMATE_APP_DIR } from "./paths.mjs"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const sandbox = join(tmpdir(), "dumate-cross-platform")
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// 用当前平台的 join 构造期望值，断言与操作系统无关。
const home = join(sandbox, "fakehome")
const appDir = (platform, env) => desktopUserDataDir(platform, env, home)

console.log("[M1] macOS 走 ~/Library/Application Support")
try {
  const got = appDir("darwin", {})
  const want = join(home, "Library", "Application Support", DUMATE_APP_DIR)
  if (got !== want) throw new Error(`期望 ${want}，得到 ${got}`)
  if (got.includes("APPDATA")) throw new Error("macOS 仍拼了 APPDATA")
  ok("darwin 路径正确，不再依赖 APPDATA")
} catch (e) { fail("macOS 默认路径", e) }

console.log("[M2] Linux 走 XDG_CONFIG_HOME，未设置时回落 ~/.config")
try {
  const custom = join(sandbox, "xdg-custom")
  if (appDir("linux", { XDG_CONFIG_HOME: custom }) !== join(custom, DUMATE_APP_DIR)) throw new Error("XDG 未生效")
  if (appDir("linux", {}) !== join(home, ".config", DUMATE_APP_DIR)) throw new Error("默认 .config 回落错误")
  ok("两个分支均正确")
} catch (e) { fail("Linux 路径", e) }

console.log("[M3] Windows 保持原有 APPDATA 语义")
try {
  const roaming = join(sandbox, "AppData", "Roaming")
  if (appDir("win32", { APPDATA: roaming }) !== join(roaming, DUMATE_APP_DIR)) throw new Error("APPDATA 路径变了")
  // 缺失 APPDATA 时仍退化成相对路径，readDesktopLogin 因此返回 null 而不是乱猜别人家目录
  if (appDir("win32", {}) !== DUMATE_APP_DIR) throw new Error("APPDATA 缺失语义被改动")
  ok("Windows 行为零回归")
} catch (e) { fail("Windows 语义", e) }

console.log("[M4] DUMATE_USER_DATA_DIR 在三个平台上都优先")
try {
  const custom = join(sandbox, "custom user data")
  for (const p of ["darwin", "linux", "win32"]) {
    if (appDir(p, { DUMATE_USER_DATA_DIR: custom }) !== custom) throw new Error(`${p} 覆盖未生效`)
  }
  // 空白值不能当成有效路径
  if (appDir("darwin", { DUMATE_USER_DATA_DIR: "   " }) !== join(home, "Library", "Application Support", DUMATE_APP_DIR)) {
    throw new Error("纯空白覆盖未被忽略")
  }
  ok("三平台覆盖优先 + 空白值忽略")
} catch (e) { fail("显式覆盖优先级", e) }

console.log("[M5] _internal 暴露的是同一个函数（供既有套件继续调用）")
try {
  if (typeof _internal.desktopUserDataDir !== "function") throw new Error("_internal 未导出")
  if (_internal.desktopUserDataDir !== desktopUserDataDir) throw new Error("导出与模块内函数不是同一个")
  ok("_internal.desktopUserDataDir 可用")
} catch (e) { fail("内部导出", e) }

// ---- 模型配置定位 ----------------------------------------------------------
function makeUserData(name, { accounts = ["acct1"], active = "acct1", authExtra = {} } = {}) {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "auth.json"), JSON.stringify({
    activeProfileId: active,
    accountProfiles: accounts.map((a) => ({ profileId: a, bceAccountId: a, displayName: "test" })),
    ...authExtra,
  }))
  const xdg = join(root, "qianfan_desk_xdg")
  for (const a of accounts) {
    const d = join(xdg, a, "config", "opencode")
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, "opencode.json"), JSON.stringify({ provider: { QianfanPersonalQuota: { models: {} } } }))
  }
  // 真实 DuMate 会额外放这些非账号目录，不应干扰「唯一账号」判断
  mkdirSync(join(xdg, "global"), { recursive: true })
  mkdirSync(join(xdg, "data"), { recursive: true })
  return root
}

console.log("[M6] 按激活账号定位 opencode.json")
try {
  const root = makeUserData("active", { accounts: ["acct1", "acct2"], active: "acct2" })
  const got = discoverConfig({ userDataDir: root, env: {} })
  const want = join(root, "qianfan_desk_xdg", "acct2", "config", "opencode", "opencode.json")
  if (got !== want) throw new Error(`期望 ${want}，得到 ${got}`)
  ok("多账号下选中激活账号（不再是 accountProfiles[0]）")
} catch (e) { fail("激活账号定位", e) }

console.log("[M7] 无激活信息时，只有唯一账号才自动选")
try {
  const one = makeUserData("single", { accounts: ["onlyone"], active: undefined })
  if (!discoverConfig({ userDataDir: one, env: {} })?.includes("onlyone")) throw new Error("唯一账号未被选中")
  const many = makeUserData("many", { accounts: ["a1", "a2"], active: undefined })
  if (discoverConfig({ userDataDir: many, env: {} }) !== undefined) throw new Error("多账号被擅自猜测")
  ok("唯一账号可用，多账号不猜")
} catch (e) { fail("账号歧义处理", e) }

console.log("[M8] 账号目录名做注入校验")
try {
  const root = makeUserData("injection", { accounts: ["acct1"] })
  const authPath = join(root, "auth.json")
  writeFileSync(authPath, JSON.stringify({
    activeProfileId: "evil",
    accountProfiles: [{ profileId: "evil", bceAccountId: "../../etc", displayName: "x" }],
  }))
  if (discoverConfig({ userDataDir: root, env: {} }) !== undefined) throw new Error("路径穿越未被拒绝")
  ok("非法账号 ID 返回 undefined")
} catch (e) { fail("目录名注入", e) }

console.log("[M9] DUMATE_OPENCODE_CONFIG 只接受绝对路径")
try {
  const root = makeUserData("override", { accounts: ["acct1"] })
  const abs = join(sandbox, "my-opencode.json")
  if (discoverConfig({ userDataDir: root, env: { DUMATE_OPENCODE_CONFIG: abs } }) !== abs) throw new Error("绝对路径覆盖失败")
  if (discoverConfig({ userDataDir: root, env: { DUMATE_OPENCODE_CONFIG: "relative.json" } }) !== undefined) {
    throw new Error("相对路径不该被接受")
  }
  ok("绝对路径生效，相对路径拒绝")
} catch (e) { fail("配置覆盖", e) }

console.log("[M10] macOS 风格的登录目录能被真实读取链路打开")
try {
  // 用注入的 macOS 风格路径作为 userDataDir，走 readDesktopLogin 的完整解密流程
  const { createCipheriv, randomBytes } = await import("node:crypto")
  const macLike = join(home, "Library", "Application Support", DUMATE_APP_DIR)
  mkdirSync(macLike, { recursive: true })
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify([{ name: "bce-sessionid", value: "v", domain: ".baidu.com" }]), "utf8"), c.final()])
  writeFileSync(join(macLike, "auth.json"), JSON.stringify({ cookies: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") }))
  writeFileSync(join(macLike, ".cookie-key"), key)
  const prev = process.env.DUMATE_USER_DATA_DIR
  let r
  try {
    process.env.DUMATE_USER_DATA_DIR = macLike
    r = _internal.readDesktopLogin()
  } finally {
    if (prev === undefined) delete process.env.DUMATE_USER_DATA_DIR
    else process.env.DUMATE_USER_DATA_DIR = prev
  }
  if (!r || !r.cookies.length) throw new Error("macOS 风格目录下的登录态读不到")
  ok("桌面登录态读取链路在 macOS 路径形态下可用")
} catch (e) { fail("登录态读取链路", e) }

rmSync(sandbox, { recursive: true, force: true })
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
