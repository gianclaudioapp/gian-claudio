// Updates of Gian Claudio itself, from the GitHub releases (Tauri updater plugin).
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { Update, check } from "@tauri-apps/plugin-updater";

export type { Update };

/** Result of an update check: the update, none, or a failed check (offline, no release yet). */
export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "none" }
  | { status: "failed" }
  | { status: "available"; update: Update }
  | { status: "installing"; update: Update; percent: number | null };

export async function appVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

export async function checkAppUpdate(): Promise<AppUpdateState> {
  try {
    const update = await check();
    return update ? { status: "available", update } : { status: "none" };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Download and install the update, then restart. On Windows the installer
 * closes the app while it runs; open chats resume when it starts again.
 */
export async function installAppUpdate(update: Update, onProgress: (percent: number | null) => void): Promise<void> {
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      done += e.data.chunkLength;
      onProgress(total ? Math.min(100, (done / total) * 100) : null);
    }
  });
  await relaunch();
}
