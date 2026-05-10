#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { decryptBundle, ensureAgeIdentity, encryptBundle, hasAge } from "./crypto-age.js";
import { ensureEnvIgnored, parseEnvFile, upsertEnvFile } from "./envfile.js";
import { envVarClientSafe, loadProviders, providerForEnvVar, providerTable } from "./providers.js";
import { doctor, scanProject } from "./scanner.js";

const cwd = process.cwd();

const commands = {
  start,
  doctor: doctorCommand,
  invite,
  share,
  join,
  providers: providersCommand,
  help
};

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  help();
  process.exit(1);
}

await commands[command](args);

async function start() {
  banner();
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);

  if (scan.envVars.length === 0) {
    console.log("No env vars found. Add a .env.example or reference process.env.MY_KEY in code, then run again.");
    return;
  }

  console.log("Detected env vars:\n");
  for (const item of scan.envVars) {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const label = provider ? provider.name : "Unknown provider";
    console.log(`- ${item.name} (${label})`);
  }

  await ensureEnvIgnored(cwd);

  const envPath = path.join(cwd, ".env");
  const existing = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const updates = {};

  for (const item of scan.envVars) {
    if (existing[item.name]) continue;
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    console.log("");
    console.log(item.name);
    if (provider) {
      console.log(`Provider: ${provider.name}`);
      if (provider.keyUrl) console.log(`Create/find key: ${provider.keyUrl}`);
      if (provider.docsUrl) console.log(`Docs: ${provider.docsUrl}`);
      if (envVarClientSafe(item.name, provider) === false && looksFrontendPublic(item.name)) {
        console.log("Warning: this looks frontend-exposed, but the provider marks it as secret.");
      }
      if (provider.notes?.length) {
        for (const note of provider.notes) console.log(`Note: ${note}`);
      }
    } else {
      console.log(`Provider: unknown`);
      console.log(`Search: ${fallbackSearchUrl(item.name)}`);
    }

    const value = await promptSecret(`Paste value for ${item.name}, or leave blank to skip: `);
    if (value.trim()) updates[item.name] = value.trim();
  }

  if (Object.keys(updates).length) {
    await upsertEnvFile(envPath, updates);
    console.log(`\nSaved ${Object.keys(updates).length} value(s) to .env`);
  } else {
    console.log("\nNo new values saved.");
  }

  await writeMetadata(cwd, scan, providers);
  console.log("Wrote non-secret .envpack.json metadata.");
  console.log("\nNext: run `envpack doctor` to check for leaks, or `envpack share` to encrypt for teammates.");
}

async function doctorCommand() {
  const providers = await loadProviders();
  const result = await doctor(cwd, providers);
  for (const check of result.checks) {
    const icon = check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✗";
    console.log(`${icon} ${check.message}`);
  }
  if (result.findings.length) {
    console.log("\nFindings:");
    for (const finding of result.findings) {
      console.log(`- ${finding.file}:${finding.line} ${finding.message}`);
    }
  }
  if (result.exitCode) process.exitCode = result.exitCode;
}

async function invite() {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const identity = await ensureAgeIdentity();
  console.log("Your EnvPack invite code:\n");
  console.log(identity.publicKey);
  console.log("\nSend this public code to your team lead. Keep the private identity file secret:");
  console.log(identity.identityPath);
}

async function share() {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env file found. Run `envpack start` first.");
    process.exitCode = 1;
    return;
  }

  const recipients = await collectRecipients(args);
  if (!recipients.length) {
    console.error("No invite codes provided.");
    process.exitCode = 1;
    return;
  }

  const outPath = path.join(cwd, ".env.team.enc");
  await encryptBundle({ inputPath: envPath, outputPath: outPath, recipients });
  console.log(`Created ${path.basename(outPath)} encrypted for ${recipients.length} recipient(s).`);
  console.log("Safe to share as ciphertext. Rotate upstream keys if a recipient should lose access later.");
}

async function join() {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const identity = await ensureAgeIdentity({ create: false });
  if (!identity) {
    console.error("No EnvPack identity found. Run `envpack invite` first.");
    process.exitCode = 1;
    return;
  }
  const inputPath = path.join(cwd, ".env.team.enc");
  if (!existsSync(inputPath)) {
    console.error("No .env.team.enc found in this directory.");
    process.exitCode = 1;
    return;
  }
  const outputPath = path.join(cwd, ".env");
  if (existsSync(outputPath)) {
    const ok = await promptYesNo(".env already exists. Overwrite it? ");
    if (!ok) return;
  }
  await decryptBundle({ inputPath, outputPath, identityPath: identity.identityPath });
  await ensureEnvIgnored(cwd);
  console.log("Decrypted locally and wrote .env");
}

async function providersCommand() {
  const providers = await loadProviders();
  const table = providerTable(providers);
  for (const row of table) {
    console.log(`${row.name}`);
    console.log(`  id: ${row.id}`);
    console.log(`  env: ${row.env.join(", ") || "(patterns only)"}`);
    console.log(`  key: ${row.keyUrl || "(none)"}`);
  }
}

function help() {
  banner();
  console.log(`Usage: envpack <command>

Commands:
  start       Scan project and guide local .env setup
  doctor      Check env hygiene and likely secret leaks
  invite      Create local age identity and print public invite code
  share       Encrypt .env to teammate invite codes
  join        Decrypt .env.team.enc locally into .env
  providers   List built-in provider links
  help        Show this help

Examples:
  envpack start
  envpack invite
  envpack share --recipient age1...
  envpack join
`);
}

function banner() {
  console.log("EnvPack - local-first .env setup and sharing\n");
}

async function collectRecipients(argv) {
  const recipients = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--recipient" || argv[i] === "-r") {
      const value = argv[i + 1];
      if (value) {
        recipients.push(value.trim());
        i++;
      }
    }
  }
  if (recipients.length) return recipients;

  console.log("Paste teammate invite codes, one per line. Blank line to finish.");
  while (true) {
    const value = await prompt("> ");
    if (!value.trim()) break;
    recipients.push(value.trim());
  }
  return recipients;
}

async function writeMetadata(root, scan, providers) {
  const metadata = {
    version: 1,
    project: path.basename(root),
    required: scan.envVars.map((item) => item.name),
    providers: Object.fromEntries(
      scan.envVars.map((item) => {
        const provider = providerForEnvVar(item.name, providers, scan.packageNames);
        return [item.name, provider?.id || null];
      })
    )
  };
  await fs.writeFile(path.join(root, ".envpack.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function looksFrontendPublic(name) {
  return name.startsWith("NEXT_PUBLIC_") || name.startsWith("VITE_") || name.startsWith("PUBLIC_");
}

function fallbackSearchUrl(name) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`${name} API key env var`)}`;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function promptSecret(question) {
  if (!process.stdin.isTTY) return prompt(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let value = "";
  return await new Promise((resolve) => {
    const onData = (char) => {
      if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u007f") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    process.stdin.on("data", onData);
  });
}

async function promptYesNo(question) {
  const answer = await prompt(`${question}[y/N] `);
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

function printAgeInstall() {
  console.error("EnvPack sharing requires the `age` CLI.");
  console.error("Install from https://age-encryption.org/ or with Homebrew: brew install age");
}
