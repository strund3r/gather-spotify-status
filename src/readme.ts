// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { err, out } from "./colors";
import { APP_NAME } from "./constants";
import { ensurePrivateDir } from "./fsutil";
import { openExternal } from "./open";
import { configDir } from "./paths";
import { errorMessage } from "./util";
import { VERSION } from "./version";

/** Path of the PDF to copy: embedded in the compiled binary, or assets/ in the repo (`bun src/index.ts`). */
function embeddedReadme(): string {
  try {
    // Bun's bundler embeds this file in the executable and returns its (virtual) path.
    const embedded: unknown = require("../assets/README.pdf");
    if (typeof embedded === "string") return embedded;
  } catch {
    // dev mode without a built PDF: fall through (the read below reports it)
  }
  return path.join(import.meta.dir, "..", "assets", "README.pdf");
}

/** --readme: write the bundled README.pdf next to the config and open it in the default PDF viewer. */
export async function openReadme(): Promise<boolean> {
  const dir = configDir();
  const dest = path.join(dir, `README-${VERSION}.pdf`);

  try {
    if (!fs.existsSync(dest)) {
      ensurePrivateDir(dir);
      fs.writeFileSync(dest, fs.readFileSync(embeddedReadme()));
      // Drop PDFs from older versions.
      for (const f of fs.readdirSync(dir)) {
        if (/^README-.+\.pdf$/.test(f) && f !== path.basename(dest)) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch (e) {
    console.error(err.red(`Could not extract the README (${errorMessage(e)}).`));
    return false;
  }

  console.log(`${out.dim("Opening")} ${dest}`);
  if (!(await openExternal(dest))) {
    console.warn(err.yellow(`Couldn't open a PDF viewer. Open the file above manually (${APP_NAME} v${VERSION}).`));
  }
  return true;
}
