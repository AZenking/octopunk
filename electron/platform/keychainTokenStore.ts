// Port of OctoPunk/OctoPunk/Platform/Keychain/KeychainTokenStore.swift.
// Uses Electron safeStorage (Keychain-backed on macOS) with a state file in
// the OctoPunk application-support directory. A legacy RelayDesk token file
// is migrated forward on first read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeStorage } from "electron";
import type { KeychainPort } from "../application/ports";

function octoPunkDirectory(): string {
  return path.join(os.homedir(), "Library", "Application Support", "OctoPunk");
}

function tokenFile(service: string): string {
  const fileName = service === "com.charles.RelayDesk" ? "mcp-access-token.relaydesk" : "mcp-access-token";
  return path.join(octoPunkDirectory(), fileName);
}

export class KeychainTokenStore implements KeychainPort {
  private readonly service: string;
  private readonly legacyService: string | null;
  private readonly account = "mcp-access-token";

  constructor(service = "com.charles.OctoPunk", legacyService: string | null = "com.charles.RelayDesk") {
    this.service = service;
    this.legacyService = legacyService;
  }

  async loadToken(): Promise<string | null> {
    const token = this.readEncrypted(tokenFile(this.service));
    if (token != null) return token;
    if (this.legacyService == null) return null;
    return this.readEncrypted(tokenFile(this.legacyService));
  }

  async saveToken(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Keychain operation failed (safeStorage unavailable).");
    }
    const encrypted = safeStorage.encryptString(token);
    fs.mkdirSync(octoPunkDirectory(), { recursive: true });
    fs.writeFileSync(tokenFile(this.service), encrypted);
  }

  private readEncrypted(file: string): string | null {
    try {
      const data = fs.readFileSync(file);
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(data));
    } catch {
      return null;
    }
  }
}
