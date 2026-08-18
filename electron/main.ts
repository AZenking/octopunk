// Port of OctoPunk/OctoPunk/App/OctoPunkApp.swift (OctoPunkLauncher).
// `--mcp-stdio` runs the MCP server on stdio (full or restricted sub-agent
// session); otherwise the React/Vite GUI window opens.

import path from "node:path";
import { app, BrowserWindow } from "electron";
import { AppEnvironment } from "./appEnvironment";
import { registerIpc } from "./ipc";

function resolveLaunchMode(argv: string[]): "gui" | "stdio" {
  return argv.includes("--mcp-stdio") ? "stdio" : "gui";
}

// Compiled main.js lands in dist-electron/electron; the icons ship with the
// sources under electron/resources. Resolved from __dirname so `pnpm dev` and
// `pnpm start` both find them without a copy step. The dock icon must be a
// PNG — app.dock.setIcon() silently fails on .icns paths — and it carries a
// transparent margin because runtime-set dock icons fill the whole slot,
// while macOS 26 renders its own Liquid Glass icons inset (~85%).
const resourcesDir = path.join(__dirname, "..", "..", "electron", "resources");
const dockIconPath = path.join(resourcesDir, "icon-dock.png");
const windowIconPath = path.join(resourcesDir, "icon.icns");

async function runStdio(): Promise<void> {
  // stdout is the MCP channel; never log there. A hidden dock icon keeps the
  // restricted per-task instances out of the user's face.
  try {
    app.dock?.hide();
  } catch {
    // Not on this platform.
  }
  await app.whenReady();
  const environment = new AppEnvironment();
  try {
    await environment.mcpServer.runStdio();
    app.exit(0);
  } catch (error) {
    process.stderr.write(
      `OctoPunk STDIO MCP failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    app.exit(1);
  }
}

async function runGUI(): Promise<void> {
  await app.whenReady();
  // `electron .` runs from the Electron helper bundle, so the dock would show
  // Electron's icon; pin OctoPunk's own icon instead.
  try {
    app.dock?.setIcon(dockIconPath);
  } catch {
    // Not on this platform, or the file moved — cosmetic only.
  }
  const environment = new AppEnvironment();
  const attachWindowObservers = registerIpc(environment);

  const createWindow = (): void => {
    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1080,
      minHeight: 720,
      title: "OctoPunk",
      icon: windowIconPath,
      show: false,
      // No native title bar: the sidebar is the drag surface (`.app-drag`)
      // and the macOS traffic lights overlay the sidebar's padded top.
      titleBarStyle: "hidden",
      ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.once("ready-to-show", () => {
      window.show();
    });
    // DevTools never open on their own; toggle manually via
    // F12 / Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows, Linux).
    window.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keydown") return;
      const key = input.key.toLowerCase();
      const toggleDevTools =
        input.key === "F12" ||
        (input.control && input.shift && key === "i") ||
        (input.meta && input.alt && key === "i");
      if (toggleDevTools) {
        window.webContents.toggleDevTools();
      }
    });
    attachWindowObservers(window);
    const devServerURL = process.env.VITE_DEV_SERVER_URL;
    if (devServerURL != null && devServerURL.length > 0) {
      void window.loadURL(devServerURL);
    } else {
      // Compiled output lives at dist-electron/electron/; the renderer at dist/.
      void window.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
    }
  };

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

const mode = resolveLaunchMode(process.argv);
if (mode === "stdio") {
  void runStdio();
} else {
  void runGUI();
}
