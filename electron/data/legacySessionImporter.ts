// Port of OctoPunk/OctoPunk/Data/Persistence/Migration/LegacySessionImporter.swift.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TeamRunSnapshot } from "../domain/models";
import type { TeamRunRepository } from "../domain/repositoryPort";

export class LegacySessionImporter {
  readonly sourceURL: string;
  private readonly backupPrefix: string;

  constructor() {
    const support = path.join(os.homedir(), "Library", "Application Support");
    const currentSourceURL = path.join(support, "OctoPunk", "last-session.json");
    const legacySourceURL = path.join(support, "RelayDesk", "last-session.json");
    if (fs.existsSync(currentSourceURL)) {
      this.sourceURL = currentSourceURL;
      this.backupPrefix = "octopunk";
    } else {
      this.sourceURL = legacySourceURL;
      this.backupPrefix = "relaydesk";
    }
  }

  async importIfPresent(repository: TeamRunRepository): Promise<TeamRunSnapshot | null> {
    if (!fs.existsSync(this.sourceURL)) return null;
    const data = fs.readFileSync(this.sourceURL);
    const snapshot = await repository.importLegacySnapshot(data, this.sourceURL);
    if (snapshot == null) return null;
    const backupURL = path.join(
      path.dirname(this.sourceURL),
      `last-session.json.${this.backupPrefix}.backup.${Math.floor(Date.now() / 1000)}`,
    );
    if (!fs.existsSync(backupURL)) {
      fs.copyFileSync(this.sourceURL, backupURL);
    }
    return snapshot;
  }
}
