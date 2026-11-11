import { afterEach, expect, spyOn, test } from "bun:test";
import { configureLogger, logger } from "../src/logger";

const written: string[] = [];
const spies = [process.stdout, process.stderr].map((stream) =>
  spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }),
);

afterEach(() => {
  written.length = 0;
  configureLogger({ timestamps: false, debug: () => false });
});

test("plain lines by default; warn/error prefixed", () => {
  logger.info("hello");
  logger.warn("careful");
  logger.error("bad");
  logger.debug("hidden");
  expect(written).toEqual(["hello\n", "[warn] careful\n", "[error] bad\n"]);
});

test("timestamps (daemon) and debug toggled at runtime", () => {
  let debug = false;
  configureLogger({ timestamps: true, debug: () => debug });
  logger.debug("off");
  debug = true;
  logger.debug("on");
  expect(written).toHaveLength(1);
  expect(written[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[debug\] on\n$/);
});

test("restore", () => {
  for (const s of spies) s.mockRestore();
});
