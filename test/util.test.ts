import { describe, expect, test } from "bun:test";
import { AxiosError, AxiosHeaders } from "axios";
import { UsageError, UserError } from "../src/errors";
import { compareSemver, describeError, errorCode, errorMessage, isRecord } from "../src/util";

test("compareSemver", () => {
  expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
  expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
  expect(compareSemver("1.2.0", "1.2.1")).toBeLessThan(0);
  expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  expect(compareSemver("1.2", "1.2.0")).toBe(0);
});

test("isRecord", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord("x")).toBe(false);
});

test("errorMessage / errorCode", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("plain")).toBe("plain");
  expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
  expect(errorCode(new Error("x"))).toBeUndefined();
  expect(errorCode(42)).toBeUndefined();
});

describe("describeError", () => {
  const axiosError = (status: number, data: unknown) => {
    const config = { headers: new AxiosHeaders({ Authorization: "Basic SECRET" }) };
    return new AxiosError("Request failed", "ERR_BAD_REQUEST", config, null, {
      status,
      statusText: "",
      headers: {},
      config,
      data,
    });
  };

  test("OAuth-style error body", () => {
    expect(describeError(axiosError(400, { error: "invalid_grant", error_description: "Refresh token revoked" }))).toBe(
      "ERR_BAD_REQUEST - HTTP 400 - invalid_grant: Refresh token revoked",
    );
  });
  test("Web API-style error body", () => {
    expect(describeError(axiosError(403, { error: { status: 403, message: "Forbidden" } }))).toBe(
      "ERR_BAD_REQUEST - HTTP 403 - Forbidden",
    );
  });
  test("never includes request headers", () => {
    expect(describeError(axiosError(500, "oops"))).not.toContain("SECRET");
  });
  test("non-axios errors", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
  });
});

test("UserError / UsageError exit codes", () => {
  expect(new UserError("x").exitCode).toBe(1);
  expect(new UserError("x", 130).exitCode).toBe(130);
  const usage = new UsageError("bad");
  expect(usage).toBeInstanceOf(UserError);
  expect(usage.exitCode).toBe(2);
});
