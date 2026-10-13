import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUpdateLine, npmSpecName, versionLabel } from "../src/format.ts";

test("strips the version range from npm specs", () => {
  assert.equal(npmSpecName("pi-web-access"), "pi-web-access");
  assert.equal(npmSpecName("pi-web-access@^0.37"), "pi-web-access");
  assert.equal(npmSpecName("@scope/pkg@1.x"), "@scope/pkg");
});

test("labels show as much of the version change as is known", () => {
  assert.equal(
    versionLabel("pi-web-access", { installed: "0.37.0", latest: "0.40.0" }),
    "pi-web-access 0.37.0 -> 0.40.0",
  );
  assert.equal(versionLabel("pi-web-access", { latest: "0.40.0" }), "pi-web-access 0.40.0");
  assert.equal(versionLabel("github.com/a/b", undefined), "github.com/a/b");
});

test("joins pi and package updates into one line", () => {
  assert.equal(
    formatUpdateLine({ pi: "pi 1.1.0 -> 1.2.0", packages: ["pi-web-access", "foo"] }),
    "Updates available: pi 1.1.0 -> 1.2.0 · pi-web-access · foo",
  );
  assert.equal(formatUpdateLine({ packages: ["foo"] }), "Updates available: foo");
});
