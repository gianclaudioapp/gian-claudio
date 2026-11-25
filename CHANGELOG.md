# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-25

### Added
- App menu behind the ☰ button next to the logo: File, Edit, View, Window and Help, keyboard friendly. <kbd>F11</kbd> toggles full screen.
- Help ▸ About Gian Claudio: app and Claude Code versions, update check, project links.
- Links in the terminal: hold <kbd>Ctrl</kbd> over a file path or URL to highlight it, <kbd>Ctrl</kbd>+click to open it with its default program. Paths with spaces and paths relative to the working folder work too.
- Chat header: separate rings for the 5-hour session limit and the chat's context, and the context split into base (instructions, tools, memory), conversation and free space.

### Changed
- "New context" has its own row in the sidebar.
- "New chat" explains in a tooltip why it is disabled while Claude works.
- Development builds run side by side with the installed app: their own data folder, a DEV badge, and the window's × quits instead of hiding to the tray.

## [0.1.0] - 2026-11-25

### Added
- Contexts: folders, an account and a name, with one current chat that resumes when the app reopens.
- Several Claude accounts used side by side, each with its own Claude Code configuration folder.
- Chat history with summaries written by Claude, important chats, a read-only view and search.
- Status dots and Windows notifications from Claude Code hooks.
- Usage ring (plan limits and context fill) and a Usage page per account.
- Terminal comforts: copy and paste, screenshot paste, drag and drop, adjustable text size.
- Tray icon, start with Windows, global shortcut <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>.
- Claude Code install and update checks.
- English and Italian interface.
- In-app updates: the app checks GitHub releases at startup and installs new versions with one click.
- Per-user installer (no admin rights needed).
