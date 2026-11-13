// Cross-platform discovery of the DuMate desktop data directory and the
// per-account OpenCode model catalog.
//
// Reported by RanceLee (公众号 HelloRanceLee, 2026-11-13): the 0.2.1 plugin
// only joined %APPDATA% + "qianfan-desktop-app". APPDATA is empty on macOS and
// Linux, so the plugin always looked for a relative path and desktop sign-in
// could never be found on a Mac. See README.md -> 致谢.
import { readFileSync, readdirSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { homedir } from "node:os"

export const DUMATE_APP_DIR = "qianfan-desktop-app"

// An explicit override always wins, on every platform. Keep it first so a
// custom install location is never shadowed by a platform default.
export function desktopUserDataDir(platform = process.platform, env = process.env, home = homedir()) {
  const override = String(env.DUMATE_USER_DATA_DIR ?? "").trim()
  if (override) return override
  if (platform === "darwin") return join(home, "Library", "Application Support", DUMATE_APP_DIR)
  if (platform === "linux") return join(env.XDG_CONFIG_HOME || join(home, ".config"), DUMATE_APP_DIR)
  // Windows keeps the original APPDATA contract. A missing APPDATA yields a
  // relative path, which readDesktopLogin() degrades to "no desktop login"
  // instead of guessing a home directory that may belong to another user.
  return join(env.APPDATA || "", DUMATE_APP_DIR)
}

const SAFE_ACCOUNT = /^[a-zA-Z0-9_-]{1,160}$/
// DuMate also creates non-account folders next to the account folders.
// Observed on this machine (2026-11-13): "global" and "data".
const NON_ACCOUNT_DIRS = new Set(["global", "data"])

// Locate <userDataDir>/qianfan_desk_xdg/<active account>/config/opencode/opencode.json.
// Never hardcodes a username, account id or port.
export function discoverConfig({ userDataDir = desktopUserDataDir(), env = process.env } = {}) {
  const override = String(env.DUMATE_OPENCODE_CONFIG ?? "").trim()
  if (override) return isAbsolute(override) ? override : undefined

  const root = join(userDataDir, "qianfan_desk_xdg")
  let account
  try {
    const auth = JSON.parse(readFileSync(join(userDataDir, "auth.json"), "utf8"))
    const profiles = Array.isArray(auth?.accountProfiles) ? auth.accountProfiles : []
    const active = profiles.find((p) => p?.profileId && p.profileId === auth?.activeProfileId)
    account = active?.bceAccountId
  } catch {
    // No readable auth.json: fall through to the single-account heuristic.
  }

  if (account !== undefined && account !== null && account !== "") {
    if (typeof account !== "string" || !SAFE_ACCOUNT.test(account)) return undefined
    return join(root, account, "config", "opencode", "opencode.json")
  }

  // Without an active profile, only an unambiguous single-account install is
  // safe. Multiple accounts are never guessed.
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !NON_ACCOUNT_DIRS.has(d.name) && SAFE_ACCOUNT.test(d.name))
    if (dirs.length === 1) return join(root, dirs[0].name, "config", "opencode", "opencode.json")
  } catch {
    // No catalog directory at all.
  }
  return undefined
}
