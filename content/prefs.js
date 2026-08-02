/* prefs.js — 偏好设置面板脚本（由 PreferencePanes.register 的 scripts 参数加载到面板窗口）
 *
 * 依赖：config.js、imaClient.js（必须在 scripts 数组中先于本文件加载）
 */
"use strict";

Zotero.__imaSync = Zotero.__imaSync || {};

/** 在偏好设置面板中点击「获取我的知识库」时调用 */
Zotero.__imaSync.loadKBs = async function (win) {
  try {
    if (!ImaSyncConfig.clientId && !ImaSyncConfig.apiKey && !ImaSyncConfig.token) {
      Services.prompt.alert(win, "IMA Sync", "请先在「IMA Skills API Key」区填写 Client ID 与 Api Key（或高级区填写 Bearer token）。");
      return;
    }
    const client = ImaSyncConfig.makeClient();
    const kbs = await client.getKnowledgeBaseList();
    if (!kbs || !kbs.length) {
      Services.prompt.alert(win, "IMA Sync", "未获取到知识库，请检查凭证是否有效或是否有知识库。");
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
      const url = "chrome://zoteroimasync/content/kbselect.xhtml?kbs=" +
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
    Services.prompt.alert(win, "IMA Sync", "获取知识库失败：" + (e && e.message ? e.message : String(e)));
  }
};
