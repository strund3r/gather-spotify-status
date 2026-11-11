// SPDX-License-Identifier: GPL-3.0-or-later
// OS keychain storage for secrets, via Bun's native Bun.secrets
// (macOS Keychain, Windows Credential Manager, Linux Secret Service / libsecret).
import { APP_NAME } from "./constants";
import { logger } from "./logger";
import { errorMessage } from "./util";

/** Undocumented GSS_KEYCHAIN_SERVICE override so tests never touch the real entries. */
function service(): string {
  return process.env.GSS_KEYCHAIN_SERVICE || APP_NAME;
}

export function keychainName(): string {
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Manager";
  return "Secret Service (GNOME Keyring / KWallet)";
}

/** Read a secret; null if missing or the keychain is unavailable. */
export async function getSecret(name: string): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: service(), name });
  } catch (e) {
    logger.debug(`keychain read of ${name} failed: ${errorMessage(e)}`);
    return null;
  }
}

/** Store a secret and verify it reads back. false if the keychain is unavailable or the write didn't stick. */
export async function storeSecret(name: string, value: string): Promise<boolean> {
  try {
    await Bun.secrets.set({ service: service(), name, value });
    return (await Bun.secrets.get({ service: service(), name })) === value;
  } catch (e) {
    logger.debug(`keychain write of ${name} failed: ${errorMessage(e)}`);
    return false;
  }
}

export async function deleteSecret(name: string): Promise<void> {
  try {
    await Bun.secrets.delete({ service: service(), name });
  } catch (e) {
    logger.debug(`keychain delete of ${name} failed: ${errorMessage(e)}`);
  }
}
