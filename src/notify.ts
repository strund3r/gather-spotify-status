// SPDX-License-Identifier: GPL-3.0-or-later
// Cross-platform OS desktop notifications via native tools (notify-send, osascript, WinRT toast).
import { spawnSync } from "node:child_process";
import { APP_NAME } from "./constants";

const NOTIFY_TIMEOUT_MS = 5000;

const WIN_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual></toast>')",
  "$nodes = $xml.GetElementsByTagName('text')",
  "$nodes.Item(0).AppendChild($xml.CreateTextNode($env:GSS_NOTIFY_TITLE)) > $null",
  "$nodes.Item(1).AppendChild($xml.CreateTextNode($env:GSS_NOTIFY_BODY)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_NAME}').Show($toast)`,
].join("; ");

export interface NotificationCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** Build the platform-specific command for displaying a desktop notification, or null if unsupported. */
export function notificationCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): NotificationCommand | null {
  if (platform === "linux") {
    return { cmd: "notify-send", args: ["--app-name", APP_NAME, "--", title, body] };
  }
  if (platform === "darwin") {
    return {
      cmd: "osascript",
      args: [
        "-e",
        "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
        title,
        body,
      ],
    };
  }
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WIN_TOAST_SCRIPT],
      env: { GSS_NOTIFY_TITLE: title, GSS_NOTIFY_BODY: body },
    };
  }
  return null;
}

/** Run the OS notification command with a short timeout and suppressed stdio. */
export function runNotifyProcess(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; error?: Error } {
  return spawnSync(cmd, args, {
    env,
    stdio: "ignore",
    timeout: NOTIFY_TIMEOUT_MS,
    windowsHide: true,
  });
}

export interface NotifyOptions {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; error?: Error };
}

/** Show a best-effort OS desktop notification. Never throws; returns true only on exit status 0. */
export function sendDesktopNotification(title: string, body: string, opts: NotifyOptions = {}): boolean {
  const spec = notificationCommand(title, body, opts.platform ?? process.platform);
  if (!spec) return false;
  try {
    const env = spec.env ? { ...process.env, ...spec.env } : process.env;
    const res = (opts.run ?? runNotifyProcess)(spec.cmd, spec.args, env);
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}
