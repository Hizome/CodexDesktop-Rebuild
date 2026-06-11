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

function stripRebuildShellBranch(content) {
  const marker = "else if(__codexRebuildShellOnly){";
  const originalStartup = "else{let e=n.k(Q);";
  for (;;) {
    const startIndex = content.indexOf(marker);
    if (startIndex < 0) return content;
    const originalStartupIndex = content.indexOf(originalStartup, startIndex);
    if (originalStartupIndex < 0) {
      throw new Error("Unable to strip rebuild shell branch: original startup marker not found");
    }
    content =
      content.slice(0, startIndex) +
      originalStartup +
      content.slice(originalStartupIndex + originalStartup.length);
  }
}

function getStandaloneBootstrap() {
  return [
    "const __codexRebuildStandalone=process.env.CODEX_REBUILD_STANDALONE!==`0`;",
    "function __codexRebuildSendMockJson(e,t,n=200){let r=JSON.stringify(t);e.writeHead(n,{\"content-type\":\"application/json\",\"access-control-allow-origin\":\"*\",\"access-control-allow-headers\":\"*\",\"access-control-allow-methods\":\"GET,POST,OPTIONS\"}),e.end(r)}",
    "function __codexRebuildStartMockApi(){if(globalThis.__codexRebuildMockApiServer)return;try{let e=require(`node:http`),t=()=>Date.now(),n=()=>({id:`resp_codex_rebuild_mock`,object:`response`,created_at:Math.floor(t()/1e3),status:`completed`,model:`codex-rebuild-offline`,output:[{id:`msg_codex_rebuild_mock`,type:`message`,status:`completed`,role:`assistant`,content:[{type:`output_text`,text:`Codex Rebuild is running in offline mock mode. Network model calls are disabled.`}]}],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}),r=e.createServer((e,r)=>{let i=[];e.on(`data`,e=>i.push(e)),e.on(`end`,()=>{let i=e.url||`/`;if(e.method===`OPTIONS`){r.writeHead(204,{\"access-control-allow-origin\":\"*\",\"access-control-allow-headers\":\"*\",\"access-control-allow-methods\":\"GET,POST,OPTIONS\"}),r.end();return}if(i.includes(`/models`)){__codexRebuildSendMockJson(r,{object:`list`,data:[{id:`codex-rebuild-offline`,object:`model`,created:0,owned_by:`codex-rebuild`} ]});return}if(i.includes(`/chat/completions`)){__codexRebuildSendMockJson(r,{id:`chatcmpl_codex_rebuild_mock`,object:`chat.completion`,created:Math.floor(t()/1e3),model:`codex-rebuild-offline`,choices:[{index:0,message:{role:`assistant`,content:`Codex Rebuild is running in offline mock mode. Network model calls are disabled.`},finish_reason:`stop`}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});return}if(i.includes(`/responses`)){__codexRebuildSendMockJson(r,n());return}__codexRebuildSendMockJson(r,{ok:!0,mock:!0})})});globalThis.__codexRebuildMockApiServer=r,r.on(`error`,()=>{globalThis.__codexRebuildMockApiServer=null}),r.listen(48333,`127.0.0.1`)}catch(e){globalThis.__codexRebuildMockApiServer=null}}",
    "if(__codexRebuildStandalone){let e=process.env.CODEX_REBUILD_HOME?.trim()||i.join(process.env.HOME||r.app.getPath(`home`),`.codex-rebuild`);process.env.CODEX_HOME||=e;process.env.CODEX_SQLITE_HOME||=i.join(e,`sqlite`);process.env.CODEX_ELECTRON_USER_DATA_PATH||=i.join(r.app.getPath(`appData`),`Codex Rebuild`);process.env.CODEX_REBUILD_MOCKS||=`1`;process.env.CODEX_SPARKLE_ENABLED||=`false`;process.env.OPENAI_API_KEY||=`codex-rebuild-mock-key`;process.env.CODEX_API_BASE_URL||=`http://127.0.0.1:48333/v1`;process.env.CODEX_API_ENDPOINT||=process.env.CODEX_API_BASE_URL;process.env.CODEX_APP_SERVER_LOGIN_ISSUER||=`codex-rebuild-mock`;r.app.commandLine.appendSwitch(`use-mock-keychain`);__codexRebuildStartMockApi();}",
  ].join("");
}

function patchStandaloneAsar(asarDir) {
  const bootstrapPath = path.join(asarDir, ".vite", "build", "bootstrap.js");
  const sharedPath = path.join(asarDir, ".vite", "build", "src-K8ZToA-n.js");
  const packagePath = path.join(asarDir, "package.json");

  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    if (pkg.main === ".vite/build/rebuild-shell-main.js") {
      pkg.main = pkg.rebuildOriginalMain || ".vite/build/bootstrap.js";
    }
    delete pkg.rebuildOriginalMain;
    if (pkg.productName !== STANDALONE_APP_NAME) {
      pkg.productName = STANDALONE_APP_NAME;
    }
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  if (fs.existsSync(bootstrapPath)) {
    let content = fs.readFileSync(bootstrapPath, "utf-8");
    content = stripRebuildShellBranch(content);
    content = replaceBetween(
      content,
      "i=e.o(i);",
      "let a=require(`node:util`)",
      `i=e.o(i);${getStandaloneBootstrap()}`,
      "bootstrap standalone env",
    );
    content = replaceOnce(
      content,
      "r.app.setName(t.Zi(Q)),",
      "r.app.setName(__codexRebuildStandalone?`Codex Rebuild`:t.Zi(Q)),",
      "bootstrap app name",
    );
    fs.writeFileSync(bootstrapPath, content);
  }

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
