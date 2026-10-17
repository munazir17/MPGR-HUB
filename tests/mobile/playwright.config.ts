import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", fullyParallel: false, workers: 1,
  outputDir: "../../test-results/mobile",
  use: { baseURL: "http://127.0.0.1:4173", browserName: "chromium", hasTouch: true, isMobile: true,
    trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: process.env.MOBILE_CHROMIUM_EXECUTABLE ? {
      executablePath: process.env.MOBILE_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    } : {},
  },
  projects: [
    { name: "mobile-360", use: { viewport: { width: 360, height: 800 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: { cwd: path.resolve(__dirname, "../.."), command: "node_modules/.bin/vite --config tests/mobile/vite.config.ts", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
