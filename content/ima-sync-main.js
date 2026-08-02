/* ima-sync-main.js — 插件主脚本（由 bootstrap loadSubScript 加载，Zotero 7/8/9）
 *
 * 注意：脚本以 "use strict" 加载，顶层函数声明不会自动挂到 loadSubScript 的 target (ctx)，
 * 必须在末尾通过 _globalThis 显式挂载（zotero-plugin-template 同款模式）。
 */
"use strict";

const PANE_URL = "chrome://zoteroimasync/content/pane.xhtml";
const ITEM_MENU_ID = "zotero-imasync-itemmenu-open";

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

/** 等待 Zotero 完全就绪后注册偏好面板与菜单 */
async function main(pluginId) {
  try {
    try {
      await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
      ]);
    } catch (e) {
      try { await Zotero.initializationPromise; } catch (e2) {}
    }

    // 0) 偏好键默认值（避免 XUL preference 绑定显示 undefined）
    try {
      const defaults = {
        "imaSync.clientId": "",
        "imaSync.apiKey": "",
        "imaSync.token": "",
        "imaSync.credType": "skills",
        "imaSync.knowledgeBaseId": "",
        "imaSync.duplicateStrategy": "DUPLICATE_NAME_STRATEGY_SAVE",
        "imaSync.apiMode": "openapi",
        "imaSync.folderId": "",
        "imaSync.forceResync": false,
      };
      for (const [key, val] of Object.entries(defaults)) {
        if (Zotero.Prefs.get(key, true) === undefined) {
          Zotero.Prefs.set(key, val);
        }
      }
    } catch (e) {
      await logError("init defaults", e);
    }

    // 1) 偏好设置面板（Zotero 设置 → 高级 → 插件）
    try {
      if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
        Zotero.PreferencePanes.register({
          pluginID: pluginId || "zotero-ima-sync@andypeng",
          src: rootURI + "content/prefs.xhtml",
          label: "IMA Sync",
          image: rootURI + "icons/favicon.png",
          scripts: [rootURI + "content/imaClient.js", rootURI + "content/config.js", rootURI + "content/prefs.js"],
        });
        await logError("info", "prefs pane registered: " + (rootURI + "content/prefs.xhtml"));
      } else {
        await logError("info", "Zotero.PreferencePanes.register 不可用");
      }
    } catch (e) {
      await logError("register prefs", e);
    }

    // 1.5) 面板 onload 诊断钩子 + 偏好面板工具函数
    // 注意：用 Object.assign 合并而非整体赋值，避免覆盖其他模块在
    // Zotero.__imaSync 上挂载的临时数据（如 _kbSelect 对话框传参）。
    try {
      Zotero.__imaSync = Object.assign(Zotero.__imaSync || {}, {
        prefsLoaded: async (win) => {
          await logError("info", "prefs pane LOADED: " + (win && win.location && win.location.href));
        },
        /** 在偏好设置面板中点击「获取我的知识库」时调用 */
        loadKBs: async (win) => {
          try {
            if (!ImaSyncConfig.clientId && !ImaSyncConfig.apiKey && !ImaSyncConfig.token) {
              Services.prompt.alert(win, "IMA Sync", "请先在「IMA Skills API Key」区填写 Client ID 与 Api Key（或高级区填写 Bearer token）。");
              return;
            }
            const client = ImaSyncConfig.makeClient();
            const kbs = await client.getKnowledgeBaseList();
            if (!kbs || !kbs.length) {
              Services.prompt.alert(win, "IMA Sync", "未获取到知识库，请检查 token 是否有效。");
              return;
            }
            if (kbs.length === 1) {
              Zotero.Prefs.set("imaSync.knowledgeBaseId", kbs[0].id);
              Services.prompt.alert(win, "IMA Sync", `已选择知识库：${kbs[0].name}\nID：${kbs[0].id}`);
              return;
            }
            // 多知识库：用自定义对话框选择（避免 Services.prompt.select 在 Zotero 9 的签名不兼容）
            // 注意：Zotero 9 (Fx140) 中独立 HTML chrome 窗口读不到 Zotero 全局、window.arguments
            // 也不可靠；kbs 通过 URL 查询参数传入（窗口自身 location 一定可读），回调通过
            // window.opener 访问父窗口的 Zotero.__imaSync._kbSelect（对话框读取后自动清理）。
            const picked = await new Promise((resolve) => {
              const args = {
                kbs,
                onPick: (kb) => resolve(kb),
                onCancel: () => resolve(null),
              };
              Zotero.__imaSync = Zotero.__imaSync || {};
              Zotero.__imaSync._kbSelect = args;
              const url = rootURI + "content/kbselect.xhtml?kbs=" +
                encodeURIComponent(JSON.stringify(kbs));
              try {
                Services.ww.openWindow(
                  win,
                  url,
                  "kbselect",
                  "chrome,centerscreen,resizable=yes,width=480,height=360",
                  null
                );
              } catch (e2) {
                try { delete Zotero.__imaSync._kbSelect; } catch (e3) {}
                // 兜底：列出名称供手动复制编码串 ID
                const lines = kbs.map((k, i) => `${i + 1}. ${k.name}  =>  ${k.id}`).join("\n");
                Services.prompt.alert(win, "IMA Sync", "请手动复制以下知识库 ID 到「知识库 ID」框：\n\n" + lines);
                resolve(null);
              }
            });
            if (picked) {
              Zotero.Prefs.set("imaSync.knowledgeBaseId", picked.id);
              Services.prompt.alert(win, "IMA Sync", `已选择知识库：${picked.name}\nID：${picked.id}`);
            }
          } catch (e) {
            await logError("loadKBs", e);
            Services.prompt.alert(win, "IMA Sync", "获取知识库失败：" + (e && e.message ? e.message : String(e)));
          }
        },
      });
    } catch (e) {}

    // 2) 为已打开的窗口注入右键菜单
    try {
      const wins = (Zotero.getMainWindows && Zotero.getMainWindows()) || [];
      for (const win of wins) addItemMenu(win);
      await logError("info", "injected menu into " + wins.length + " windows");
    } catch (e) {
      await logError("inject menu", e);
    }

    await logError("info", "IMA Sync main() completed OK");
  } catch (e) {
    await logError("main outer", e);
  }
}

/**
 * 在指定主窗口的条目右键菜单中注入菜单项。
 * @param {Window} win Zotero 主窗口
 */
function addItemMenu(win) {
  try {
    const doc = win.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup || doc.getElementById(ITEM_MENU_ID)) return;
    const item = doc.createXULElement("menuitem");
    item.id = ITEM_MENU_ID;
    item.setAttribute("label", "同步到 ima 知识库…");
    item.setAttribute("class", "menuitem-iconic");
    item.addEventListener("command", openPane);
    popup.appendChild(item);
  } catch (e) {
    logError("addItemMenu", e);
  }
}

/** 打开同步控制面板（chrome 窗口）
 * 注意：必须把主窗口作为 openWindow 的 parent 传入——Zotero 9 中独立
 * chrome 窗口没有 Zotero 全局，pane.xhtml 通过 window.opener 桥接拿到 Zotero。
 */
function openPane() {
  const parent = (Zotero && typeof Zotero.getMainWindow === "function" && Zotero.getMainWindow()) || null;
  try {
    Services.ww.openWindow(
      parent,
      PANE_URL,
      "ima-sync-pane",
      "chrome,resizable=yes,centerscreen,width=780,height=660",
      null
    );
  } catch (e) {
    logError("openPane chrome://", e);
    try {
      Services.ww.openWindow(
        parent,
        rootURI + "content/pane.xhtml",
        "ima-sync-pane",
        "chrome,resizable=yes,centerscreen,width=780,height=660",
        null
      );
    } catch (e2) {
      logError("openPane rootURI fallback", e2);
    }
  }
}

/** 插件禁用/卸载时清理 */
function cleanup() {
  try {
    const wins = (Zotero.getMainWindows && Zotero.getMainWindows()) || [];
    for (const win of wins) {
      const el = win.document.getElementById(ITEM_MENU_ID);
      if (el) el.remove();
    }
  } catch (e) {
    logError("cleanup", e);
  }
}

/* ---- 显式挂载到 loadSubScript target（strict 模式下必须） ---- */
_globalThis.main = main;
_globalThis.addItemMenu = addItemMenu;
_globalThis.openPane = openPane;
_globalThis.cleanup = cleanup;
