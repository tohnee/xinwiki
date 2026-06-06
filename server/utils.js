import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function slugifyFileName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/[^\p{L}\p{N}\-._]/gu, "");
}

export function wikiFileName(title) {
  const base = slugifyFileName(title.replaceAll("/", "-"));
  return base || "untitled";
}

export function uploadFileName(originalName) {
  const stamp = Date.now();
  const ext = path.extname(originalName);
  const base = slugifyFileName(path.basename(originalName, ext)) || "upload";
  return `${base}-${stamp}${ext}`;
}
