import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate } from "../src/auth.ts";
const env = { PREVIEW_USER: "owner", PREVIEW_PASSWORD: "test-secret" };
test("private preview fails closed without configuration", async () => {
  assert.equal((await authenticate(new Request("https://example.com/"), {}))?.status, 503);
});
test("all route types require credentials", async () => {
  for (const path of ["/", "/api/runs", "/v/key/result", "/api/runs/key/ws"]) {
    for (const authorization of ["", "Basic !!!", "Bearer token", "Basic " + btoa("owner:wrong")]) {
      const r = await authenticate(new Request("https://example.com" + path, {headers: {authorization}}), env);
      assert.equal(r?.status, 401);
      assert.equal(r?.headers.get("Cache-Control"), "no-store");
    }
  }
});
test("valid credentials allow routing", async () => {
  assert.equal(await authenticate(new Request("https://example.com/", {headers: {authorization: "Basic " + btoa("owner:test-secret")}}), env), null);
});
