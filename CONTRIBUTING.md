# Contributing

Thanks for taking the time to help Gian Claudio. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](../../issues/new/choose) and pick the matching template. For bugs, the Windows version, the Gian Claudio version and the output of `claude --version` help a lot.

Security problems are the exception: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

You need:
- Windows 10 or 11;
- Node 22+;
- Rust (stable, MSVC toolchain);
- Visual Studio Build Tools with the C++ workload;
- the `claude` CLI.

```powershell
npm install
npm run tauri dev
```

The dev build (any debug build, in fact) runs side by side with the installed app without touching it:
- its data folder is `%APPDATA%\GianClaudio-dev`, so it has its own contexts, accounts and history. It starts with only the default account, which uses your normal Claude Code login;
- API keys go in a separate Windows Credential Manager entry;
- the window title and tray tooltip say "(dev)";
- the <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> shortcut and "Start with Windows" stay with the installed app;
- a DEV badge sits in the title bar, and closing the window quits the dev build instead of hiding it in the tray.

You can develop Gian Claudio from inside Gian Claudio. Talk to Claude in the **installed** app, not in the dev build: the dev build restarts on every Rust change, and a chat inside it would restart too.

Before opening a pull request, run the same checks as CI:

```powershell
npm run build
cd src-tauri; cargo test --lib
```

One Rust test starts the real `claude` CLI in a ConPTY. It is skipped when the CLI is not installed.

## Guidelines

- **Keep pull requests small and focused**: one fix or feature each. For larger changes, open an issue first so we can agree on the approach.
- **English in code.** Identifiers, comments, commit messages and file names are English.
- **Translations.** The UI's source language is English. Every user-facing string goes through `t("English text")` (or `tn(...)` when a placeholder is an element), from `src/i18n.ts`. Add the Italian translation to the matching file in `src/locales/`. A missing translation falls back to English. New languages are welcome: add `src/locales/<lang>.ts` and register it in `src/i18n.ts`.
- **Follow the existing style**: small components, plain CSS with the tokens in `src/styles.css`, and Rust commands that do their blocking work off the main thread (`async` + `spawn_blocking`).
- **Privacy.** The app must not send anything anywhere except through Claude Code itself and the version check. Don't add telemetry.

## Releasing (maintainers)

1. Set the new version everywhere: `npm run release:version -- 0.2.0`.
2. Move the "Unreleased" notes in [CHANGELOG.md](CHANGELOG.md) under the new version.
3. Commit, tag and push:

   ```powershell
   git commit -am "Release v0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. The **Release** action builds the installer, signs the update files and creates a **draft** release with `latest.json`.
5. Check the draft on GitHub and publish it. Installed apps see the update at their next start.

Update files are signed with the key in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. The matching public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). If the private key is lost, installed apps can no longer verify updates: everyone has to reinstall once from a setup signed with a new key.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
