// Feedback typed into the app. It goes to a file beside the undo journal, not the
// vault, so it causes no commits. See "Feedback from the app" in CLAUDE.md.

import { appendFile, mkdir } from "node:fs/promises";
import { APP_DIR } from "./config";

export const FEEDBACK_MAX = 5000;
const CONTEXT_MAX = 300;

export interface FeedbackEntry {
  id: string; // ISO timestamp of when it arrived
  text: string;
  screen?: string; // the mode the app was in
  task?: string; // scan | backlog | library, when in a session
  item?: string; // the page or compass object on screen
}

const short = (v: unknown) => (typeof v === "string" && v ? v.slice(0, CONTEXT_MAX) : undefined);

/** The fields worth keeping from a request body, or null if it has no usable text. */
export function parseFeedback(body: unknown): Omit<FeedbackEntry, "id"> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.text !== "string") return null;
  const text = b.text.trim();
  if (!text || text.length > FEEDBACK_MAX) return null;
  return { text, screen: short(b.screen), task: short(b.task), item: short(b.item) };
}

export async function appendFeedback(fb: Omit<FeedbackEntry, "id">, dir = APP_DIR): Promise<FeedbackEntry> {
  const entry = { id: new Date().toISOString(), ...fb };
  await mkdir(dir, { recursive: true });
  await appendFile(`${dir}/feedback.jsonl`, JSON.stringify(entry) + "\n");
  return entry;
}
