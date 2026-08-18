import { randomUUID } from "node:crypto";

export function randomReviewFindingID(): string {
  return randomUUID();
}
