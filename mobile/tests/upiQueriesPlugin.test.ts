/**
 * The UPI visibility config plugin (plugins/withUpiQueries.js) must load on
 * its own — `expo config`, `expo-doctor` and every EAS build evaluate it — and
 * keep declaring the same apps Cashfree's checkout needs to see. Run with
 * `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("withUpiQueries config plugin", () => {
  it("loads without any app source file (it is evaluated by expo config and EAS builds)", () => {
    const plugin = require("../plugins/withUpiQueries.js");
    assert.equal(typeof plugin, "function");
    const source = readFileSync(require.resolve("../plugins/withUpiQueries.js"), "utf8");
    assert.doesNotMatch(source, /require\(['"]\.\.\/src\//);
  });

  it("declares upi:// and the common UPI apps on Android and iOS (unchanged)", () => {
    const { ANDROID_PACKAGES, IOS_SCHEMES } = require("../plugins/withUpiQueries.js");
    assert.deepEqual(ANDROID_PACKAGES, ["com.google.android.apps.nbu.paisa.user", "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp"]);
    assert.deepEqual(IOS_SCHEMES, ["upi", "tez", "gpay", "phonepe", "paytmmp", "paytm", "bhim"]);
  });
});
