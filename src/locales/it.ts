/*
 * Italian translations: English source text → Italian.
 * Keys must match the English strings passed to t() / tn() exactly.
 */
import { itApp } from "./it.app";
import { itAccounts } from "./it.accounts";
import { itSettings } from "./it.settings";
import { itChat } from "./it.chat";

export const it: Record<string, string> = { ...itApp, ...itAccounts, ...itSettings, ...itChat };
