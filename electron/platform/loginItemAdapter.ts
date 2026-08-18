// Port of OctoPunk/OctoPunk/Platform/LoginItem/LoginItemAdapter.swift
// (SMAppService → app.setLoginItemSettings).

import { app } from "electron";
import type { LoginItemPort } from "../application/ports";

export class MainAppLoginItemAdapter implements LoginItemPort {
  async register(): Promise<void> {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  async unregister(): Promise<void> {
    app.setLoginItemSettings({ openAtLogin: false });
  }
}
