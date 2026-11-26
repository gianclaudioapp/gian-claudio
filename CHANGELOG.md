# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-26

### Added
- Terminal panel next to Claude: plain shells in the context's working folder, one tab each, below or beside the chat. <kbd>Ctrl</kbd> + the key above <kbd>Tab</kbd> shows or hides it. Shells keep running while you switch contexts.
- Each context picks its shell: PowerShell, PowerShell 7, Git Bash, Command Prompt or WSL (the ones installed).
- Sandboxes: detach a chat at any point into its own folder (a git worktree with no branch, or a copy of a plain folder). The chat keeps its whole history; the original stays where it was. Uncommitted changes can move along, and you pick which files ignored by git to copy (dependencies and build folders are left out).
- A context's Sandboxes page (from its ⋯ menu or right-click): state of each sandbox and the files it changed; a click reopens it.
- A sandbox's "What was done here" panel: new, modified and deleted files with their diff, Claude's summary, and "Apply to the context's folder" (uncommitted changes; files changed on both sides are merged with conflict markers).
- From a git sandbox: create a branch (feature/, fix/, hotfix/…) with a commit of its changes, without touching the context's folder. Claude proposes the message; author and signing can be changed for that commit only; optional push and pull request (GitHub CLI). Later commits go on the same branch.
- A sandbox's chat is copied as if it had always been in the sandbox folder, so Claude works there without commenting on the move.
- "Cooking" in the title bar (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>): every chat that is working or waiting for you, in all contexts and sandboxes, with what Claude is doing or asking; a click opens it.
- Folder chips in the chat header open their folder.

### Changed
- The chat header's buttons are icons, with their text in a tooltip; "New chat" uses the accent color.
- The update dialog shows the release notes formatted, with links opening in the browser.

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
