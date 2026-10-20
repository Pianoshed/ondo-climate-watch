import { transformWithOxc } from "vite";
import { defineConfig } from "vitest/config";

// The app's components are .js files that contain JSX. Vite picks the parser from the file extension,
// so this plugin compiles our own .js files as JSX (automatic runtime, like Next.js).
const jsxInJs = {
  name: "jsx-in-js",
  enforce: "pre",
  transform(code, id) {
    const file = id.split("?")[0];
    if (!/\.js$/.test(file) || file.includes("/node_modules/")) return null;
    return transformWithOxc(code, `${file}x`, { jsx: { runtime: "automatic" } });
  },
};

export default defineConfig({ plugins: [jsxInJs], test: { environment: "jsdom" } });
