import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { metadata, viewport } from "../app/layout";
import manifest from "../app/manifest";
import { APP_NAME } from "../lib/brand";

const root = path.resolve(import.meta.dirname, "..");
const pngSize = file => {  // width and height are stored at bytes 16-24 of every PNG
  const b = readFileSync(path.join(root, file));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test("the app is named Ondo State Climate Watch", () => {
  expect(APP_NAME).toBe("Ondo State Climate Watch");
  expect(metadata.title.default).toBe(APP_NAME);
  expect(metadata.title.template).toBe(`%s | ${APP_NAME}`);
  expect(metadata.openGraph.siteName).toBe(APP_NAME);
  expect(manifest().name).toBe(APP_NAME);
});

test("metadata is complete", () => {
  expect(metadata.description.length).toBeGreaterThan(40);
  expect(metadata.manifest).toBe("/manifest.webmanifest");
  expect(metadata.twitter.card).toBe("summary_large_image");
  expect(metadata.robots.index).toBe(false);
  expect(viewport.themeColor).toMatch(/^#[0-9a-f]{6}$/i);
});

test("favicon and share images exist at the sizes browsers expect", () => {
  expect(existsSync(path.join(root, "app/favicon.ico"))).toBe(true);
  expect(pngSize("app/icon.png")).toEqual([512, 512]);
  expect(pngSize("app/apple-icon.png")).toEqual([180, 180]);
  expect(pngSize("app/opengraph-image.png")).toEqual([1200, 630]);
  expect(pngSize("app/twitter-image.png")).toEqual([1200, 630]);
});

test("every icon listed in the manifest is a real file of the declared size", () => {
  const icons = manifest().icons;
  expect(icons.length).toBeGreaterThanOrEqual(3);
  for (const { src, sizes } of icons) {
    const [w, h] = sizes.split("x").map(Number);
    expect(pngSize(`public${src}`)).toEqual([w, h]);
  }
});
