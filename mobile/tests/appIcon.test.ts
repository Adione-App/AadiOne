/**
 * The launcher icon configuration — run with `npm run test:unit`.
 *
 * Android: a real adaptive icon (separate foreground and full-bleed
 * background layers) in app.json AND in the committed native project (EAS
 * builds from android/ as committed). iOS: one opaque, full-bleed 1024px
 * icon — iOS applies its own mask, so the file has no alpha and no
 * pre-rounded transparent corners.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(ROOT, "android/app/src/main/res");
const app = JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")).expo;

/** PNG IHDR: width, height, colour type (2 = RGB, 6 = RGBA). */
function png(file: string) {
  const b = readFileSync(path.join(ROOT, file));
  assert.equal(b.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

/** WebP canvas size (VP8X / VP8L / VP8). */
function webp(file: string) {
  const b = readFileSync(file);
  assert.equal(b.toString("ascii", 8, 12), "WEBP", `${file} is not a WebP`);
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
}

describe("Android adaptive icon", () => {
  it("app.json declares separate foreground and background layers — no white fallback", () => {
    const icon = app.android.adaptiveIcon;
    assert.equal(icon.foregroundImage, "./assets/adaptive-icon-foreground.png");
    assert.equal(icon.backgroundImage, "./assets/adaptive-icon-background.png");
    assert.notEqual(String(icon.backgroundColor).toUpperCase(), "#FFFFFF");
    const fg = png(icon.foregroundImage.replace("./", ""));
    const bg = png(icon.backgroundImage.replace("./", ""));
    assert.deepEqual([fg.width, fg.height, fg.colorType], [1024, 1024, 6]); // transparent around the artwork
    assert.deepEqual([bg.width, bg.height, bg.colorType], [1024, 1024, 2]); // full bleed, opaque
  });

  it("the native adaptive icon uses both mipmap layers; the launcher applies the shape", () => {
    for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
      const xml = readFileSync(path.join(RES, "mipmap-anydpi-v26", name), "utf8");
      assert.match(xml, /<adaptive-icon/);
      assert.match(xml, /<background android:drawable="@mipmap\/ic_launcher_background"\/>/);
      assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
    }
  });

  it("every density has 108dp layers and 48dp legacy icons", () => {
    const scale = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const [density, s] of Object.entries(scale)) {
      const dir = path.join(RES, `mipmap-${density}`);
      for (const layer of ["ic_launcher_foreground", "ic_launcher_background"]) {
        assert.deepEqual(webp(path.join(dir, `${layer}.webp`)), { width: 108 * s, height: 108 * s }, `${density}/${layer}`);
      }
      for (const legacy of ["ic_launcher", "ic_launcher_round"]) {
        assert.deepEqual(webp(path.join(dir, `${legacy}.webp`)), { width: 48 * s, height: 48 * s }, `${density}/${legacy}`);
      }
    }
  });

  it("the manifest still points at the launcher icons", () => {
    const manifest = readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8");
    assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
    assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  });
});

describe("iOS icon", () => {
  it("one opaque, full-bleed 1024px icon (no alpha); no Android layers on iOS", () => {
    assert.equal(app.icon, "./assets/icon-ios.png");
    const icon = png("assets/icon-ios.png");
    assert.deepEqual([icon.width, icon.height, icon.colorType], [1024, 1024, 2]);
    assert.equal(app.ios.icon, undefined); // the top-level icon is the iOS icon
    assert.ok(existsSync(path.join(ROOT, "assets/icon-ios.png")));
  });
});
