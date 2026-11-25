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

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
