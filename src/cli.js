#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { decryptBundle, ensureAgeIdentity, encryptBundle, hasAge } from "./crypto-age.js";
import { ensureEnvIgnored, parseEnvFile, upsertEnvFile, writeEnvExample } from "./envfile.js";
import { copyText, formatLink, googleSearchUrl, openUrl } from "./links.js";
import { envVarClientSafe, loadProviders, providerByQuery, providerForEnvVar, providerTable } from "./providers.js";
import { doctor, scanProject } from "./scanner.js";
import { canValidateEnvVar, validateEnvValue } from "./validators.js";

const cwd = process.cwd();
let pipedInputLines = null;
let pipedInputIndex = 0;

const commands = {
  start,
  init: start,
  setup: start,
  add,
  link,
  links: link,
  doctor: doctorCommand,
  check: doctorCommand,
  example,
  validate: validateCommand,
  invite,
  share,
  rekey: share,
  join,
  providers: providersCommand,
  version,
  help
};

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

if (command === "--help" || command === "-h") {
  help();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  await version();
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  help();
  process.exit(1);
}

if (args.includes("--help") || args.includes("-h")) {
  commandHelp(command);
  process.exit(0);
}

await commands[command](args);

async function start(argv = []) {
  banner();
  const options = parseArgs(argv);
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
  const examplePath = path.join(cwd, ".env.example");
  if (!existsSync(examplePath)) {
    const created = await writeEnvExample(examplePath, scan.envVars.map((item) => item.name));
    if (created) console.log("Created .env.example with detected env vars.");
  }

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
      const keyUrl = bestProviderUrl(provider);
      if (keyUrl) console.log(`Create/find key: ${formatLink("open key page", keyUrl)}`);
      if (provider.docsUrl) console.log(`Docs: ${formatLink("open docs", provider.docsUrl)}`);
      if (envVarClientSafe(item.name, provider) === false && looksFrontendPublic(item.name)) {
        console.log("Warning: this looks frontend-exposed, but the provider marks it as secret.");
      }
      if (provider.notes?.length) {
        for (const note of provider.notes) console.log(`Note: ${note}`);
      }
    } else {
      console.log(`Provider: unknown`);
      console.log(`Search: ${formatLink("Google search", fallbackSearchUrl(item.name))}`);
    }

    const value = await promptSecret(`Paste value for ${item.name}, or leave blank to skip: `);
    if (value.trim()) {
      const trimmed = value.trim();
      if (shouldValidate(options, item.name, provider)) {
        const save = await maybeValidateValue(item.name, trimmed, provider, options);
        if (!save) continue;
      }
      updates[item.name] = trimmed;
    }
  }

  if (Object.keys(updates).length) {
    await upsertEnvFile(envPath, updates);
    console.log(`\nSaved ${Object.keys(updates).length} value(s) to .env`);
  } else {
    console.log("\nNo new values saved.");
  }

  await writeMetadata(cwd, scan, providers);
  console.log("Wrote non-secret .envhelper.json metadata.");
  console.log("\nNext: run `envhelper doctor` to check for leaks, or `envhelper share` to encrypt for teammates.");
}

async function add(argv = []) {
  const target = argv[0];
  if (!target) {
    console.error("Usage: envhelper add <provider-or-env-var>");
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(argv.slice(1));
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const provider = providerByQuery(target, providers) || providerForEnvVar(target, providers, scan.packageNames);
  const names = provider && !looksEnvVar(target)
    ? await chooseProviderVars(provider)
    : [target.toUpperCase()];

  if (!names.length) return;
  await ensureEnvIgnored(cwd);

  const envPath = path.join(cwd, ".env");
  const updates = {};

  for (const name of names) {
    const resolvedProvider = providerForEnvVar(name, providers, scan.packageNames) || provider;
    console.log("");
    console.log(name);
    if (resolvedProvider) {
      console.log(`Provider: ${resolvedProvider.name}`);
      const keyUrl = bestProviderUrl(resolvedProvider);
      if (keyUrl) console.log(`Create/find key: ${formatLink("open key page", keyUrl)}`);
      if (resolvedProvider.docsUrl) console.log(`Docs: ${formatLink("open docs", resolvedProvider.docsUrl)}`);
    } else {
      console.log(`Search: ${formatLink("Google search", fallbackSearchUrl(name))}`);
    }
    const value = await promptSecret(`Paste value for ${name}, or leave blank to skip: `);
    if (!value.trim()) continue;
    const trimmed = value.trim();
    if (shouldValidate(options, name, resolvedProvider)) {
      const save = await maybeValidateValue(name, trimmed, resolvedProvider, options);
      if (!save) continue;
    }
    updates[name] = trimmed;
  }

  if (!Object.keys(updates).length) {
    console.log("No values saved.");
    return;
  }

  await upsertEnvFile(envPath, updates);
  await writeEnvExample(path.join(cwd, ".env.example"), Object.keys(updates));
  await mergeMetadata(cwd, Object.keys(updates), providers, scan.packageNames);
  console.log(`\nSaved ${Object.keys(updates).length} value(s), updated .env.example, and wrote .envhelper.json metadata.`);
}

async function link(argv = []) {
  const target = argv[0];
  if (!target) {
    console.error("Usage: envhelper link <provider-or-env-var> [--copy] [--open]");
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(argv.slice(1));
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const provider = providerByQuery(target, providers) || providerForEnvVar(target, providers, scan.packageNames);
  const url = provider ? bestProviderUrl(provider) : fallbackSearchUrl(target);
  const label = provider ? `${provider.name} key page` : `Google search for ${target}`;

  console.log(formatLink(label, url));

  if (options.copy) {
    console.log(copyText(url) ? "Copied link to clipboard." : "Could not copy link on this system.");
  }
  if (options.open) {
    console.log(openUrl(url) ? "Opened link in browser." : "Could not open link on this system.");
  }
}

async function doctorCommand(argv = []) {
  const providers = await loadProviders();
  if (argv.includes("--fix")) {
    const scan = await scanProject(cwd, providers);
    await ensureEnvIgnored(cwd);
    await writeEnvExample(path.join(cwd, ".env.example"), scan.envVars.map((item) => item.name));
    console.log("Applied safe fixes: ensured .env ignore rules and .env.example where possible.\n");
  }
  const result = await doctor(cwd, providers, { history: argv.includes("--history") || argv.includes("--full") });
  for (const check of result.checks) {
    const icon = check.level === "ok" ? "✓" : check.level === "warn" ? "!" : check.level === "info" ? "i" : "✗";
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

async function example() {
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  if (!scan.envVars.length) {
    console.log("No env vars detected. Add references or .envhelper.json first.");
    return;
  }
  const created = await writeEnvExample(path.join(cwd, ".env.example"), scan.envVars.map((item) => item.name));
  console.log(created ? "Created .env.example" : ".env.example already exists");
}

async function validateCommand() {
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }
  const values = await parseEnvFile(envPath);
  let failures = 0;
  for (const item of scan.envVars) {
    if (!values[item.name]) continue;
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    if (!canValidateEnvVar(item.name, provider)) {
      console.log(`! ${item.name}: no validator available`);
      continue;
    }
    const ok = await promptYesNo(`Validate ${item.name} with ${provider.name}? This sends the value directly to the provider. `);
    if (!ok) continue;
    const result = await validateEnvValue(item.name, values[item.name], provider);
    const icon = result.ok === true ? "✓" : result.ok === false ? "✗" : "!";
    console.log(`${icon} ${item.name}: ${result.message}`);
    if (result.ok === false) failures++;
  }
  if (failures) process.exitCode = 1;
}

async function invite(argv = []) {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const identity = await ensureAgeIdentity();
  console.log("Your EnvHelper invite code:\n");
  console.log(identity.publicKey);
  console.log("\nSend this public code to your team lead. Keep the private identity file secret:");
  console.log(identity.identityPath);
  const options = parseArgs(argv);
  if (options.out) {
    await fs.writeFile(path.resolve(cwd, options.out), `${identity.publicKey}\n`, "utf8");
    console.log(`\nWrote public invite file: ${options.out}`);
  }
}

async function share(argv = []) {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env file found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }

  const recipients = await collectRecipients(argv);
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
    console.error("No EnvHelper identity found. Run `envhelper invite` first.");
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

async function providersCommand(argv = []) {
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const table = providerTable(providers);
  if (options.json) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  for (const row of table) {
    console.log(`${row.name}`);
    console.log(`  id: ${row.id}`);
    console.log(`  env: ${row.env.join(", ") || "(patterns only)"}`);
    console.log(`  key: ${row.keyUrl || row.docsUrl || "(none)"}`);
    console.log(`  source: ${row.sourceUrl || row.docsUrl || "(none)"}`);
  }
}

async function version() {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  console.log(pkg.version);
}

function help() {
  banner();
  console.log(`Usage: envhelper <command>

Commands:
  start       Scan project and guide local .env setup
  setup       Alias for start
  add         Add one provider or env var to local setup
  link        Print, copy, or open a provider key link
  doctor      Check env hygiene and likely secret leaks
  check       Alias for doctor
  invite      Create local age identity and print public invite code
  share       Encrypt .env to teammate invite codes
  rekey       Re-encrypt .env.team.enc to a fresh recipient set
  join        Decrypt .env.team.enc locally into .env
  example     Generate .env.example from detected env vars
  validate    Validate local .env values with providers after consent
  providers   List built-in provider links
  version     Print the EnvHelper version
  help        Show this help

Examples:
  envhelper start
  envhelper add stripe
  envhelper add ACME_API_KEY
  envhelper link stripe --copy
  envhelper link ACME_API_KEY --open
  envhelper doctor --fix
  envhelper invite
  envhelper invite --out alice.pub
  envhelper share --recipient age1...
  envhelper share --recipients-dir invites
  envhelper join
  envhelper providers --json
  envhelper --version
`);
}

function commandHelp(name) {
  const text = {
    start: "Usage: envhelper start [--validate|--no-validate]\n\nScan the repo, guide local .env setup, and write non-secret .envhelper.json metadata.",
    init: "Usage: envhelper init [--validate|--no-validate]\n\nAlias for start.",
    setup: "Usage: envhelper setup [--validate|--no-validate]\n\nAlias for start.",
    add: "Usage: envhelper add <provider-or-env-var> [--validate|--no-validate]\n\nAdd a provider or single env var to .env and .env.example.",
    link: "Usage: envhelper link <provider-or-env-var> [--copy] [--open]\n\nPrint, copy, or open a source-backed provider link. Unknown providers use Google search.",
    links: "Usage: envhelper links <provider-or-env-var> [--copy] [--open]\n\nAlias for link.",
    doctor: "Usage: envhelper doctor [--fix] [--history|--full]\n\nCheck .env hygiene, likely leaks, frontend exposure, and optional recent git history.",
    check: "Usage: envhelper check [--fix] [--history|--full]\n\nAlias for doctor.",
    example: "Usage: envhelper example\n\nGenerate .env.example from detected env vars.",
    validate: "Usage: envhelper validate\n\nValidate local .env values with providers after explicit consent.",
    invite: "Usage: envhelper invite [--out teammate.pub]\n\nCreate or reuse a local age identity and print the public invite code.",
    share: "Usage: envhelper share [--recipient age1...] [--recipients-file file] [--recipients-dir dir]\n\nEncrypt .env to teammate invite codes using age.",
    rekey: "Usage: envhelper rekey [--recipient age1...] [--recipients-file file] [--recipients-dir dir]\n\nAlias for share; re-encrypts the current local .env to a fresh recipient set.",
    join: "Usage: envhelper join\n\nDecrypt .env.team.enc locally into .env.",
    providers: "Usage: envhelper providers [--json]\n\nList the built-in source-backed provider directory.",
    version: "Usage: envhelper version\n\nPrint the EnvHelper version.",
    help: "Usage: envhelper help\n\nShow the main help."
  }[name];
  console.log(text || "Usage: envhelper help");
}

function banner() {
  console.log("EnvHelper - local-first .env setup and sharing\n");
}

async function collectRecipients(argv) {
  const recipients = [];
  const options = parseArgs(argv);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--recipient" || argv[i] === "-r") {
      const value = argv[i + 1];
      if (value) {
        recipients.push(value.trim());
        i++;
      }
    }
  }
  if (options.recipientsFile) {
    recipients.push(...await readRecipientsFile(path.resolve(cwd, options.recipientsFile)));
  }
  if (options.recipientsDir) {
    recipients.push(...await readRecipientsDir(path.resolve(cwd, options.recipientsDir)));
  }
  if (!recipients.length && existsSync(path.join(cwd, "invites"))) {
    recipients.push(...await readRecipientsDir(path.join(cwd, "invites")));
  }
  if (recipients.length) return uniqueRecipients(recipients);

  console.log("Paste teammate invite codes, one per line. Blank line to finish.");
  while (true) {
    const value = await prompt("> ");
    if (!value.trim()) break;
    recipients.push(value.trim());
  }
  return uniqueRecipients(recipients);
}

async function writeMetadata(root, scan, providers) {
  const names = scan.envVars.map((item) => item.name);
  const metadata = buildMetadata(root, names, providers, scan.packageNames);
  await fs.writeFile(path.join(root, ".envhelper.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function mergeMetadata(root, names, providers, packageNames = []) {
  const file = path.join(root, ".envhelper.json");
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    existing = {};
  }
  const required = [...new Set([...(existing.required || []), ...names])].sort();
  const metadata = buildMetadata(root, required, providers, packageNames);
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function buildMetadata(root, names, providers, packageNames = []) {
  return {
    version: 1,
    project: path.basename(root),
    required: [...new Set(names)].sort(),
    providers: Object.fromEntries(
      [...new Set(names)].sort().map((name) => {
        const provider = providerForEnvVar(name, providers, packageNames);
        return [name, provider?.id || null];
      })
    )
  };
}

function looksFrontendPublic(name) {
  return name.startsWith("NEXT_PUBLIC_") || name.startsWith("VITE_") || name.startsWith("PUBLIC_");
}

function fallbackSearchUrl(name) {
  return googleSearchUrl(name);
}

function bestProviderUrl(provider) {
  return provider?.keyUrl || provider?.docsUrl || provider?.sourceUrl || null;
}

function looksEnvVar(value) {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

async function chooseProviderVars(provider) {
  const names = provider.env || [];
  if (names.length <= 1) return names;
  console.log(`${provider.name} has multiple known env vars:`);
  names.forEach((name, index) => console.log(`${index + 1}. ${name}`));
  const answer = await prompt("Choose numbers separated by commas, or press enter for all: ");
  if (!answer.trim()) return names;
  const selected = answer
    .split(",")
    .map((part) => Number(part.trim()) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < names.length);
  return [...new Set(selected.map((index) => names[index]))];
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--validate") options.validate = true;
    else if (arg === "--no-validate") options.noValidate = true;
    else if (arg === "--copy") options.copy = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--recipients-file") options.recipientsFile = argv[++i];
    else if (arg === "--recipients-dir") options.recipientsDir = argv[++i];
    else options._.push(arg);
  }
  return options;
}

function shouldValidate(options, name, provider) {
  if (options.noValidate) return false;
  if (options.validate) return true;
  return canValidateEnvVar(name, provider);
}

async function maybeValidateValue(name, value, provider, options) {
  if (!canValidateEnvVar(name, provider)) return true;
  const allowed = options.validate || await promptYesNo(`Validate ${name} with ${provider.name}? This sends the value directly to ${provider.name}. `);
  if (!allowed) return true;
  const result = await validateEnvValue(name, value, provider);
  const icon = result.ok === true ? "✓" : result.ok === false ? "✗" : "!";
  console.log(`${icon} ${result.message}`);
  if (result.ok === false) {
    const saveAnyway = await promptYesNo(`Save ${name} anyway? `);
    if (!saveAnyway) return false;
  }
  return true;
}

async function readRecipientsFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return parseRecipientLines(content);
}

async function readRecipientsDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const recipients = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".pub")) continue;
    recipients.push(...await readRecipientsFile(path.join(dirPath, entry.name)));
  }
  return recipients;
}

function parseRecipientLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => line.startsWith("age1"));
}

function uniqueRecipients(recipients) {
  return [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))];
}

async function prompt(question) {
  if (!process.stdin.isTTY) return readPipedLine(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

function readPipedLine(question) {
  process.stdout.write(question);
  if (!pipedInputLines) pipedInputLines = readFileSync(0, "utf8").split(/\r?\n/);
  return pipedInputLines[pipedInputIndex++] ?? "";
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
  console.error("EnvHelper sharing requires the `age` CLI.");
  console.error("Install from https://age-encryption.org/ or with Homebrew: brew install age");
}
