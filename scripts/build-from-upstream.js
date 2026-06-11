#!/usr/bin/env node
/**
 * build-from-upstream.js — Patch upstream Codex and repackage
 *
 * For macOS and Windows: no forge needed.
 * Takes the upstream app, patches ASAR in-place, replaces codex CLI, outputs distributable.
 *
 * Usage:
 *   node scripts/build-from-upstream.js --platform mac-arm64
 *   node scripts/build-from-upstream.js --platform mac-x64
 *   node scripts/build-from-upstream.js --platform win
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");

const STANDALONE_APP_NAME = "Codex Rebuild";
const STANDALONE_BUNDLE_ID = "com.openai.codex.rebuild";
const STANDALONE_URL_SCHEME = "codex-rebuild";

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "win": "x86_64-pc-windows-msvc",
};

// ─── Helpers ────────────────────────────────────────────────────

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch {}
      count++;
    } else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function resolveCodexVendor(platform) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;
  const binName = platform === "win" ? "codex.exe" : "codex";

  // Try platform-specific package (0.128+)
  const PKG_MAP = { "mac-arm64": "codex-darwin-arm64", "mac-x64": "codex-darwin-x64", "win": "codex-win32-x64" };
  const platPkg = PKG_MAP[platform];
  if (platPkg) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@cometix", platPkg, "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  }
  // Try old-style vendor (pre-0.128)
  const localPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, "codex", binName);
  if (fs.existsSync(localPath)) return localPath;

  // npm pack fallback — fetch platform-specific package
  // First get latest cometix base version, then append platform suffix
  const PLAT_SUFFIX = {
    "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64",
    "win": "win32-x64",
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  };
  const suffix = PLAT_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }

  // e.g. "0.128.0-cometix" → "@cometix/codex@0.128.0-cometix-darwin-x64"
  const platPkgSpec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [codex] fetching ${platPkgSpec} via npm pack...`);
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tgzName = execSync(`npm pack ${platPkgSpec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();
    const extractDir = path.join(tmpDir, "extracted");
    clearDir(extractDir);
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
    const p = path.join(extractDir, "package", "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }
  return null;
}

// ─── macOS build ────────────────────────────────────────────────

function buildMac(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] ${platform}/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // 1. Find the .app in the ZIP extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(tempDir, `${variant}-extract`);

  // Find Codex.app
  let appPath = null;
  if (fs.existsSync(extractDir)) {
    const findApp = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "Codex.app" && e.isDirectory()) return path.join(dir, e.name);
        if (e.isDirectory()) { const r = findApp(path.join(dir, e.name)); if (r) return r; }
      }
      return null;
    };
    appPath = findApp(extractDir);
  }

  if (!appPath) {
    console.error(`[x] Codex.app not found in cache. Run sync-upstream first.`);
    process.exit(1);
  }

  console.log(`   [source] ${appPath}`);

  // 2. Copy .app to output (ditto preserves symlinks + resource forks)
  const outAppDir = path.join(OUT_DIR, platform);
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, `${STANDALONE_APP_NAME}.app`);
  console.log(`   [copy] Codex.app -> out/${STANDALONE_APP_NAME}.app`);
  execSync(`ditto "${appPath}" "${outApp}"`);

  const resourcesDir = path.join(outApp, "Contents", "Resources");

  // 3. Repack patched ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  patchStandaloneAsar(asarDir);
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // 4. Update ASAR integrity hash in Info.plist
  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    patchMacInfoPlist(infoPlist);
    updateAsarIntegrity(asarPath, infoPlist);
  }

  // 5. Strip original signature + quarantine
  console.log("   [codesign] removing original signature");
  try { execSync(`codesign --remove-signature "${outApp}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`xattr -rd com.apple.quarantine "${outApp}"`, { stdio: "pipe" }); } catch {}

  // 6. Replace codex CLI
  replaceCodex(platform, resourcesDir, "codex");

  // 7. Ad-hoc re-sign (prevents "damaged app" Gatekeeper error)
  console.log("   [codesign] ad-hoc signing");
  try {
    execSync(`codesign --sign - --force --deep "${outApp}"`, { stdio: "pipe" });
    console.log("   [ok] ad-hoc signed");
  } catch (e) {
    console.log(`   [!] ad-hoc sign failed: ${e.message}`);
  }

  // 8. Create DMG
  const version = getVersion(asarDir);
  const dmgName = `Codex-Rebuild-${platform}-${version}.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);
  console.log(`   [dmg] ${dmgName}`);
  execSync(`hdiutil create -volname "${STANDALONE_APP_NAME}" -srcfolder "${outAppDir}" -ov -format UDZO "${dmgPath}"`, { stdio: "pipe" });
  const sizeMB = (fs.statSync(dmgPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${dmgPath} (${sizeMB} MB)`);
}

// ─── Windows build ──────────────────────────────────────────────

function buildWin(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] win/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Windows: use the MSIX extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const extractDir = path.join(tempDir, "win-extract");
  const appDir = path.join(extractDir, "app");

  if (!fs.existsSync(appDir)) {
    console.error(`[x] MSIX extract not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Copy app/ to output
  const outAppDir = path.join(OUT_DIR, "win");
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex-win32-x64");
  console.log("   [copy] MSIX app/ -> out/");
  copyRecursive(appDir, outApp);

  const resourcesDir = path.join(outApp, "resources");

  // Compute old ASAR header hash (before repack)
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] old hash: ${oldHash.slice(0, 16)}...`);

  // Repack patched ASAR
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // Compute new hash and patch exe
  const newHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] new hash: ${newHash.slice(0, 16)}...`);

  if (oldHash !== newHash) {
    // Find Codex.exe in app root
    const exePath = path.join(outApp, "Codex.exe");
    if (fs.existsSync(exePath)) {
      patchExeHash(exePath, oldHash, newHash);
    } else {
      console.log("   [!] Codex.exe not found for hash patching");
    }
  }

  // Replace codex CLI
  replaceCodex(platform, resourcesDir, "codex.exe");

  // Create ZIP
  const version = getVersion(asarDir);
  const zipName = `Codex-win-x64-${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`   [zip] ${zipName}`);
  execSync(`7zz a -tzip -mx=5 "${zipPath}" .`, { cwd: outApp });

  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${zipPath} (${sizeMB} MB)`);
}

// ─── ASAR integrity ─────────────────────────────────────────────

function computeAsarHeaderHash(asarPath) {
  const crypto = require("crypto");
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) {
    console.log("   [!] old hash not found in exe");
    return;
  }
  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] exe hash patched at offset ${idx}`);
}

function updateAsarIntegrity(asarPath, infoPlistPath) {
  const newHash = computeAsarHeaderHash(asarPath);
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.hash -string "${newHash}" "${infoPlistPath}"`, { stdio: "pipe" });
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.algorithm -string "SHA256" "${infoPlistPath}"`, { stdio: "pipe" });

  // Verify
  const verify = execSync(`plutil -extract ElectronAsarIntegrity.Resources/app\\\\.asar.hash raw "${infoPlistPath}"`, { encoding: "utf-8" }).trim();
  if (verify === newHash) {
    console.log(`   [integrity] hash updated: ${newHash.slice(0, 16)}...`);
  } else {
    console.log(`   [!] integrity verify failed`);
  }
}

// ─── Shared ─────────────────────────────────────────────────────

function plistReplace(plistPath, keyPath, type, value) {
  execSync(`plutil -replace "${keyPath}" -${type} "${value}" "${plistPath}"`, { stdio: "pipe" });
}

function patchMacInfoPlist(infoPlist) {
  plistReplace(infoPlist, "CFBundleDisplayName", "string", STANDALONE_APP_NAME);
  plistReplace(infoPlist, "CFBundleName", "string", STANDALONE_APP_NAME);
  plistReplace(infoPlist, "BundleSigningBaseName", "string", STANDALONE_APP_NAME);
  plistReplace(infoPlist, "CFBundleIdentifier", "string", STANDALONE_BUNDLE_ID);
  plistReplace(infoPlist, "CrProductDirName", "string", STANDALONE_BUNDLE_ID);
  plistReplace(infoPlist, "CFBundleURLTypes.0.CFBundleURLName", "string", STANDALONE_APP_NAME);
  plistReplace(infoPlist, "CFBundleURLTypes.0.CFBundleURLSchemes.0", "string", STANDALONE_URL_SCHEME);
  console.log(`   [identity] ${STANDALONE_APP_NAME} (${STANDALONE_BUNDLE_ID})`);
}

function replaceOnce(content, from, to, fileLabel) {
  if (content.includes(to)) return content;
  if (!content.includes(from)) {
    throw new Error(`Unable to patch ${fileLabel}: pattern not found`);
  }
  return content.replace(from, to);
}

function replaceBetween(content, start, end, replacement, fileLabel) {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`Unable to patch ${fileLabel}: start pattern not found`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Unable to patch ${fileLabel}: end pattern not found`);
  return `${content.slice(0, startIndex)}${replacement}${content.slice(endIndex)}`;
}

function patchStandaloneAsar(asarDir) {
  const bootstrapPath = path.join(asarDir, ".vite", "build", "bootstrap.js");
  const shellMainPath = path.join(asarDir, ".vite", "build", "rebuild-shell-main.js");
  const sharedPath = path.join(asarDir, ".vite", "build", "src-K8ZToA-n.js");
  const packagePath = path.join(asarDir, "package.json");
  const shellHtmlPath = path.join(asarDir, ".vite", "build", "rebuild-shell.html");

  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    if (pkg.main !== ".vite/build/rebuild-shell-main.js") {
      pkg.rebuildOriginalMain = pkg.rebuildOriginalMain || pkg.main;
      pkg.main = ".vite/build/rebuild-shell-main.js";
    }
    if (pkg.productName !== STANDALONE_APP_NAME) {
      pkg.productName = STANDALONE_APP_NAME;
    }
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  if (fs.existsSync(bootstrapPath)) {
    let content = fs.readFileSync(bootstrapPath, "utf-8");
    const standaloneBootstrap =
      "const __codexRebuildStandalone=process.env.CODEX_REBUILD_STANDALONE!==`0`;const __codexRebuildShellOnly=__codexRebuildStandalone&&process.env.CODEX_REBUILD_SHELL_ONLY!==`0`;if(__codexRebuildStandalone){let e=process.env.CODEX_REBUILD_HOME?.trim()||i.join(process.env.HOME||r.app.getPath(`home`),`.codex-rebuild`);process.env.CODEX_HOME||=e;process.env.CODEX_SQLITE_HOME||=i.join(e,`sqlite`);process.env.CODEX_ELECTRON_USER_DATA_PATH||=i.join(r.app.getPath(`appData`),`Codex Rebuild`);__codexRebuildShellOnly&&r.app.commandLine.appendSwitch(`use-mock-keychain`);}";
    content = replaceBetween(
      content,
      "i=e.o(i);",
      "let a=require(`node:util`)",
      `i=e.o(i);${standaloneBootstrap}`,
      "bootstrap standalone env",
    );
    content = replaceOnce(
      content,
      "r.app.setName(t.Zi(Q)),",
      "r.app.setName(__codexRebuildStandalone?`Codex Rebuild`:t.Zi(Q)),",
      "bootstrap app name",
    );
    const shellBranch =
      "else if(__codexRebuildShellOnly){r.app.whenReady().then(async()=>{let e=new r.BrowserWindow({width:1120,height:760,minWidth:860,minHeight:560,title:`Codex Rebuild`,backgroundColor:`#f4f6f8`,show:!0,webPreferences:{contextIsolation:!0,nodeIntegration:!1,sandbox:!0,spellcheck:!1,devTools:!1}});e.setMenuBarVisibility(!1),e.on(`closed`,()=>{r.app.quit()}),await e.loadFile(i.join(__dirname,`rebuild-shell.html`)),e.focus()})}";
    content = replaceOnce(
      content,
      "else{let e=n.k(Q);",
      `${shellBranch}else{let e=n.k(Q);`,
      "shell-only startup branch",
    );
    fs.writeFileSync(bootstrapPath, content);
  }

  fs.writeFileSync(shellMainPath, getShellMainJs());
  fs.writeFileSync(shellHtmlPath, getShellHtml());

  if (fs.existsSync(sharedPath)) {
    let content = fs.readFileSync(sharedPath, "utf-8");
    const protocolFrom = "e.setAsDefaultProtocolClient(`codex`)";
    const protocolTo = "e.setAsDefaultProtocolClient(process.env.CODEX_REBUILD_STANDALONE===`0`?`codex`:`codex-rebuild`)";
    if (content.includes(protocolFrom) || content.includes(protocolTo)) {
      content = replaceOnce(content, protocolFrom, protocolTo, "protocol handler");
      fs.writeFileSync(sharedPath, content);
    }
  }

  console.log("   [identity] ASAR standalone paths patched");
}

function getShellMainJs() {
  return `"use strict";

const { app, BrowserWindow, dialog, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_NAME = "Codex Rebuild";
const CODEX_HOME = process.env.CODEX_REBUILD_HOME?.trim() || path.join(os.homedir(), ".codex-rebuild");

if (process.env.CODEX_REBUILD_FULL === "1") {
  process.env.CODEX_REBUILD_SHELL_ONLY = "0";
  require("./bootstrap.js");
  return;
}

process.env.CODEX_REBUILD_STANDALONE ||= "1";
process.env.CODEX_REBUILD_SHELL_ONLY ||= "1";
process.env.CODEX_HOME ||= CODEX_HOME;
process.env.CODEX_SQLITE_HOME ||= path.join(CODEX_HOME, "sqlite");
process.env.CODEX_ELECTRON_USER_DATA_PATH ||= path.join(app.getPath("appData"), APP_NAME);

app.commandLine.appendSwitch("use-mock-keychain");
app.setName(APP_NAME);
app.setPath("userData", process.env.CODEX_ELECTRON_USER_DATA_PATH);

let mainWindow = null;

function installOfflineGuards() {
  const filter = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({ cancel: true });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#f4f6f8",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("file:")) return { action: "deny" };
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    dialog.showErrorBox(APP_NAME, \`Renderer stopped: \${details.reason}\`);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const html = fs.readFileSync(path.join(__dirname, "rebuild-shell.html"), "utf8");
  await mainWindow.loadURL(\`data:text/html;charset=utf-8,\${encodeURIComponent(html)}\`);
  mainWindow.show();
  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installOfflineGuards();
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error));
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error));
      });
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
`;
}

function getShellHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Rebuild</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-2: #edf2f5;
      --ink: #1f2328;
      --muted: #6b6f76;
      --line: #cdd6dd;
      --accent: #136f63;
      --blue: #2b5f9e;
      --shadow: rgba(24, 28, 34, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #15181a;
        --panel: #202427;
        --panel-2: #1a1e21;
        --ink: #edf0f2;
        --muted: #a1a8ae;
        --line: #343b40;
        --accent: #5ec6b5;
        --blue: #7ea7db;
        --shadow: rgba(0, 0, 0, 0.28);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .app {
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
      height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: var(--panel-2);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .brand {
      height: 56px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 16px;
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }
    .mark {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: linear-gradient(135deg, var(--accent), var(--blue));
      box-shadow: 0 4px 14px var(--shadow);
      flex: 0 0 auto;
    }
    .nav {
      padding: 10px;
      display: grid;
      gap: 4px;
    }
    .nav button {
      height: 34px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--ink);
      text-align: left;
      padding: 0 10px;
      font: inherit;
    }
    .nav button.active {
      background: var(--panel);
      box-shadow: inset 0 0 0 1px var(--line);
    }
    .spacer { flex: 1; }
    .status {
      margin: 12px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 70%, transparent);
      font-size: 12px;
    }
    main {
      min-width: 0;
      display: grid;
      grid-template-rows: 56px minmax(0, 1fr) 76px;
      background: var(--panel);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 9px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .workspace {
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        linear-gradient(var(--line) 1px, transparent 1px),
        linear-gradient(90deg, var(--line) 1px, transparent 1px);
      background-size: 28px 28px;
      background-color: var(--panel);
    }
    .empty {
      width: min(560px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow: 0 16px 44px var(--shadow);
      padding: 22px;
    }
    .empty h2 {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 650;
    }
    .empty p {
      margin: 0;
      color: var(--muted);
    }
    footer {
      border-top: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: var(--panel);
    }
    .composer {
      flex: 1;
      min-width: 0;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      display: flex;
      align-items: center;
      color: var(--muted);
      padding: 0 12px;
      background: var(--panel-2);
    }
    .send {
      width: 42px;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--muted);
      font: inherit;
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><div class="mark"></div><span>Codex Rebuild</span></div>
      <nav class="nav">
        <button class="active">Workspace</button>
        <button>Threads</button>
        <button>Settings</button>
      </nav>
      <div class="spacer"></div>
      <div class="status">Shell mode</div>
    </aside>
    <main>
      <header>
        <h1>Workspace</h1>
        <div class="pill">Runtime paused</div>
      </header>
      <section class="workspace">
        <div class="empty">
          <h2>Codex Rebuild shell</h2>
          <p>The desktop frame is running without account, update, agent, or model runtime startup.</p>
        </div>
      </section>
      <footer>
        <div class="composer">Prompt input is unavailable in shell mode</div>
        <button class="send" aria-label="Send" disabled>&gt;</button>
      </footer>
    </main>
  </div>
</body>
</html>
`;
}

function replaceCodex(platform, resourcesDir, binName) {
  const vendor = resolveCodexVendor(platform);
  if (vendor) {
    const dest = path.join(resourcesDir, binName);
    fs.copyFileSync(vendor, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex not found, keeping upstream codex`);
  }
}

function getVersion(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    console.error("[x] Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win>");
    process.exit(1);
  }

  console.log(`\n== Build from upstream: ${platform} ==\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (platform.startsWith("mac")) {
    buildMac(platform);
  } else {
    buildWin(platform);
  }
}

main();
