# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-08-02

Initial public release. This is the first versioned release after extensive development and
real-runtime verification against Zotero 9 (Firefox ESR 140).

### Added

- Sync Zotero items with PDF attachments to a Tencent ima knowledge base
  - Pipeline: `create_media` → upload to Tencent Cloud COS (prefers `cos_url` direct PUT,
    falls back to COS V5 signed upload with pure-JS SHA-1 fallback) → `add_knowledge`
- IMA Skills API Key authentication (default, recommended)
  - Legacy Bearer token / MCP mode retained as advanced fallback
- Three sync scopes: selected items / a Collection / all items
- Duplicate-name strategy: SAVE / REPLACE / CANCEL
- Automatic skip of already-synced items via `ima-sync-media-id` marker in the item `Extra` field
  (with optional "force re-sync")
- Knowledge-base picker dialog (`kbselect.xhtml`) for multi-knowledge-base selection
- Preferences panel tab (Settings → Advanced → Plugins → IMA Sync) with native
  `preference=` binding to `Zotero.Prefs`
- Real-time progress window (per-item success / skipped / failure)
- Zotero 7 / 8 / 9 compatibility (`applications.zotero`, `registerChrome` +
  `loadSubScript` bootstrap architecture, no `ChromeUtils.import`)

### Fixed (during pre-release verification, all verified in real Zotero 9 runtime)

- `add_knowledge` `220001` parameter error: request body now includes
  `media_type` / `title` / `file_info.{cos_key, file_name, file_size}`
- "Get My Knowledge Bases" crash in Zotero 9: replaced fragile
  `Services.prompt.select` (signature changed in Fx140) with a custom HTML dialog;
  fixed both entry points (`ima-sync-main.js` and `prefs.js`)
- Knowledge-base dialog rendered blank in Zotero 9: rewrote `kbselect.xhtml` as a standard
  HTML document; data passed via URL query parameters + `window.opener` callbacks
  (XUL `<listbox>` and `window.arguments` are unreliable in Zotero 9)
- Control panel auth blank / unresponsive: independent chrome windows have no `Zotero`
  global in Zotero 9 — `openPane()` now passes the main window as parent and the panel
  bridges `Zotero` from `window.opener`; added the missing Bearer token input field
- `pane.xhtml` XML parsing error (`not well-formed`): inline scripts must be wrapped in
  CDATA in XHTML documents

### Security

- No hard-coded credentials in source or packages
- No telemetry, no third-party tracking
- User-provided API credentials stored locally in Zotero `prefs.js`

## [Unreleased]

- None planned yet. Suggestions welcome via Issues.
