# Gian Claudio

A Windows desktop app that keeps all your [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) sessions in one place, across several Claude accounts at once.

No more opening a terminal in every folder: pick a context, and the real `claude` CLI runs in an embedded terminal, with its history, usage and status around it.

> The interface is available in English and Italian.

> **Not affiliated with Anthropic.** Gian Claudio is an independent open-source project. Claude and Claude Code are products of Anthropic.

## Features

- **Contexts.** A context is one or more folders (one of them is the working folder), one account and a name. Each context has one current chat, which resumes where you left it when you reopen the app.
- **Many accounts, side by side.** Every account gets its own Claude Code config folder (`CLAUDE_CONFIG_DIR`), so personal and work accounts run at the same time without interfering. Subscriptions sign in from the browser. API keys are stored in Windows Credential Manager.
- **Chat history with memory.** "New chat" archives the previous one as Markdown, with a summary written by Claude. The new chat starts knowing the last chat and any chat you marked as important. Past chats open read-only, and you can search across all of them.
- **Status at a glance.** A pulsing dot shows which chats are working or waiting for you, and a Windows notification tells you when Claude is done.
- **Usage.** A small ring next to "New chat" shows the plan limits (5-hour and weekly, when Claude Code reports them) and how full the chat context is. A Usage page per account shows tokens by month, day and context, plus what the month would cost at API list prices.
- **A comfortable terminal.**
  - Copy and paste with the usual shortcuts.
  - Paste screenshots straight from the clipboard.
  - Drag and drop files into the chat.
  - Adjust the text size.
- **Stays out of the way.** It lives in the tray, can start with Windows, and comes back with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>. Light and dark theme, with a choice of accent colors.
- **Keeps Claude Code current.** At startup the app checks whether Claude Code is installed and up to date, and offers to install or update it.

## Install

Download the latest `Gian Claudio_<version>_x64-setup.exe` from the [Releases](../../releases) page and run it. It installs for the current user, without admin rights, and downloads the WebView2 runtime if it is missing.

The installer is not code-signed, so on first run Windows may show **"Windows protected your PC"**. Click **More info → Run anyway**. Later updates are installed from inside the app.

You also need the Claude Code CLI. If it is missing, the app offers to install it with the official installer.

## Where your data lives

Everything stays on your PC, in `%APPDATA%\GianClaudio`:

- `state.json`: contexts, accounts and settings;
- `accounts\<id>\`: the Claude Code config folder of each added account;
- `contexts\<context>\history\<YYYY-MM-DD>\<chat>.md`: past chats with their summaries.

The app itself only goes online to check for new versions of Claude Code (npm registry) and of Gian Claudio (GitHub releases). Your chats go to Anthropic through Claude Code, exactly as when you use it in a terminal.

## Development

Requirements:
- Windows 10 or 11;
- Node 22+;
- Rust with the MSVC toolchain;
- Visual Studio Build Tools with C++;
- the `claude` CLI.

```powershell
npm install
npm run tauri dev
```

The dev build is a sandbox: it keeps its data in `%APPDATA%\GianClaudio-dev` and leaves the global shortcut and "start with Windows" to the installed app. So you can develop Gian Claudio with Gian Claudio: talk to Claude in the installed app and try the changes in the dev build, which restarts on every Rust change.

Build the installer (NSIS):

```powershell
npm run tauri build
```

The build also signs the update files, so it needs the updater key in `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Releases are built by GitHub Actions: see [CONTRIBUTING.md](CONTRIBUTING.md#releasing-maintainers).

Rust tests (one of them starts the real `claude` CLI in a ConPTY):

```powershell
cd src-tauri; cargo test --lib
```

### Stack

Tauri 2 (Rust) with React, TypeScript and Vite. The terminal is `portable-pty` (ConPTY) on the Rust side and `@xterm/xterm` in the UI.

### Layout

- `src/`: React UI.
  - `App.tsx`: sidebar, tabs, chats.
  - `Terminal.tsx`: xterm.js.
  - `ReadOnlyChat.tsx`, `HistoryPage.tsx`, `SearchPage.tsx`: past chats.
  - `AccountsPage.tsx`, `SettingsPage.tsx`, `Usage.tsx`: accounts, settings and usage pages.
  - `api.ts`, `model.ts`, `pricing.ts`: shared code.
  - `i18n.ts` and `locales/`: translations (English is the source language).
- `src-tauri/src/`: Rust side.
  - `pty.rs`: terminals and transcripts.
  - `store.rs`: data folder, accounts, the `claude` CLI.
  - `history.rs`: past chats and summaries.
  - `status.rs`: hooks, status line, tray, notifications.
  - `usage.rs`: token usage.
  - `clipboard.rs`: clipboard and screenshot paste.
- `assets/`: source logo (SVG). Regenerate the icons with `npm run tauri icon assets/gianclaudio-icon-square.svg`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © DazornSama
