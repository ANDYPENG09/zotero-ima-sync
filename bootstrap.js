/* bootstrap.js — Zotero 7/8/9 插件入口（适配 Zotero 9：不使用 ChromeUtils.import）
 *
 * 所有可失败步骤均 try/catch 并写入插件错误日志（Zotero 数据目录 ima-sync-errors.log），
 * 防止 bootstrap 异常导致插件被禁用，同时便于诊断。
 */
"use strict";

var _mainCtx = null;          // loadSubScript 注入的主脚本上下文
var _chromeHandle = null;     // registerChrome 返回的句柄

/** 写插件错误日志（Zotero 数据目录，fallback profile 目录），不依赖 Zotero debug 开关 */
async function logError(context, err) {
  try {
    const raw = (err && (err.stack || err.message || err)) || String(err);
    const line = `${new Date().toISOString()} [${context}] ${raw}\n`;
    let dir = "";
    try {
      const d = Zotero.getZoteroDirectory();
      dir = typeof d === "string" ? d : (d && (d.path || String(d)));
    } catch (e) {}
    if (!dir) {
      try {
        const { PathUtils } = ChromeUtils.importESModule("resource://gre/modules/PathUtils.sys.mjs");
        dir = PathUtils.join(PathUtils.profileDir, "ima-sync");
        try { await IOUtils.makeDirectory(dir, { ignoreExisting: true }); } catch (e2) {}
      } catch (e) {
        return;
      }
    }
    await IOUtils.write(dir + "/ima-sync-errors.log", new TextEncoder().encode(line), { append: true });
  } catch (e2) {
    try { Zotero.debug("IMA Sync logError failed: " + e2, 2); } catch (e3) {}
  }
}

function install(data, reason) {}

function uninstall(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  try {
    // Zotero 7+ 传入字符串 rootURI
    if (!rootURI || typeof rootURI !== "string") {
      rootURI = "chrome://zoteroimasync/content/";
    }

    // 注册 chrome 包：chrome://zoteroimasync/content/...（供面板窗口/样式使用；失败不致命）
    try {
      if (Zotero.platformMajorVersion >= 102) {
        const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(
          Ci.amIAddonManagerStartup
        );
        const manifestURI = Services.io.newURI(rootURI + "manifest.json");
        _chromeHandle = aomStartup.registerChrome(manifestURI, [
          ["content", "zoteroimasync", rootURI + "content/"],
        ]);
      }
    } catch (e) {
      await logError("registerChrome", e);
    }

    // 加载主脚本（全局挂在 ctx 上）
    const ctx = { rootURI, id };
    ctx._globalThis = ctx;
    try {
      Services.scriptloader.loadSubScript(rootURI + "content/ima-sync-main.js", ctx);
      _mainCtx = ctx;
      if (typeof ctx.main === "function") {
        ctx.main(id).catch(async (e) => { await logError("main", e); });
      } else {
        await logError("main", "ctx.main 不存在（loadSubScript 未挂载 main 函数）");
      }
    } catch (e) {
      await logError("loadSubScript", e);
    }
  } catch (e) {
    await logError("startup", e);
  }
}

function shutdown({ id, version, rootURI }, reason) {
  try {
    if (reason === APP_SHUTDOWN) return;
    if (_mainCtx && typeof _mainCtx.cleanup === "function") {
      try { _mainCtx.cleanup(); } catch (e) { logError("cleanup", e); }
    }
    _mainCtx = null;
    if (_chromeHandle) {
      try { _chromeHandle.destruct(); } catch (e) {}
      _chromeHandle = null;
    }
  } catch (e) {
    logError("shutdown", e);
  }
}

/** Zotero 主窗口每次打开时回调，用于把右键菜单注入新窗口 */
function onMainWindowLoad({ window }) {
  if (_mainCtx && typeof _mainCtx.addItemMenu === "function") {
    try { _mainCtx.addItemMenu(window); } catch (e) { logError("onMainWindowLoad", e); }
  }
}

function onMainWindowUnload({ window }) {}
