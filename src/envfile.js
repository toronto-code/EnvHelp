import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function parseEnvFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function upsertEnvFile(filePath, updates) {
  const lines = existsSync(filePath) ? (await fs.readFile(filePath, "utf8")).split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${quoteEnv(updates[key])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${quoteEnv(value)}`);
  }
  const content = next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

export async function ensureEnvIgnored(root) {
  const gitignorePath = path.join(root, ".gitignore");
  const needed = [".env", ".env.*", "!.env.example", "!.env.team.enc"];
  let content = "";
  if (existsSync(gitignorePath)) content = await fs.readFile(gitignorePath, "utf8");
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = needed.filter((line) => !lines.has(line));
  if (!missing.length) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${content}${prefix}${missing.join("\n")}\n`, "utf8");
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
