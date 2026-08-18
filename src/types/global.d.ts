import type { OctoPunkBridge } from "../../electron/preload";

declare global {
  interface Window {
    octopunk: OctoPunkBridge;
  }
}

export {};
