import { spawnSync } from "node:child_process";

export function googleSearchUrl(name) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${name} API key env var`)}`;
}

export function formatLink(label, url) {
  const linked = terminalLink(label, url);
  return linked === url ? url : `${linked} (${url})`;
}

export function terminalLink(label, url) {
  if (!supportsHyperlinks()) return url;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function copyText(text) {
  const command = clipboardCommand();
  if (!command) return false;
  const result = spawnSync(command.cmd, command.args, {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"]
  });
  return result.status === 0;
}

export function openUrl(url) {
  const command = openCommand(url);
  if (!command) return false;
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    stdio: "ignore"
  });
  return result.status === 0;
}

function supportsHyperlinks() {
  if (!process.stdout.isTTY) return false;
  if (process.env.FORCE_HYPERLINK === "1") return true;
  if (process.env.FORCE_HYPERLINK === "0") return false;
  const termProgram = process.env.TERM_PROGRAM || "";
  return ["iTerm.app", "WezTerm", "vscode", "Apple_Terminal", "Tabby"].includes(termProgram) ||
    Boolean(process.env.WT_SESSION);
}

function clipboardCommand() {
  if (process.platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (process.platform === "win32") return { cmd: "clip", args: [] };
  if (commandExists("wl-copy")) return { cmd: "wl-copy", args: [] };
  if (commandExists("xclip")) return { cmd: "xclip", args: ["-selection", "clipboard"] };
  if (commandExists("xsel")) return { cmd: "xsel", args: ["--clipboard", "--input"] };
  return null;
}

function openCommand(url) {
  if (process.platform === "darwin") return { cmd: "open", args: [url] };
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (commandExists("xdg-open")) return { cmd: "xdg-open", args: [url] };
  return null;
}

function commandExists(cmd) {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}
