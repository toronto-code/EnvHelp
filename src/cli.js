#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { decryptBundle, ensureAgeIdentity, encryptBundle, hasAge } from "./crypto-age.js";
import { ensureEnvIgnored, parseEnvFile, upsertEnvFile, writeEnvExample } from "./envfile.js";
import { copyText, formatLink, googleSearchUrl, openUrl } from "./links.js";
import {
  envVarClientSafe,
  isKnownProviderEnvVar,
  isLikelyCredentialEnvVar,
  loadProviders,
  providerByQuery,
  providerForEnvVar,
  providerTable
} from "./providers.js";
import { doctor, scanProject } from "./scanner.js";
import { canValidateEnvVar, validateEnvValue } from "./validators.js";

const cwd = process.cwd();
let pipedInputLines = null;
let pipedInputIndex = 0;

const commands = {
  start,
  init: start,
  setup: start,
  needs: needsCommand,
  scan: needsCommand,
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
  commands: commandsCommand,
  directory: commandsCommand,
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

try {
  await commands[command](args);
} finally {
  if (process.stdin.isTTY) process.stdin.pause();
}

async function start(argv = []) {
  banner();
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  const existing = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const enriched = enrichEnvVars(scan, providers).map((item) => ({
    ...item,
    status: existing[item.name] ? "set" : "missing"
  }));
  const setupCandidates = filterEnvRows(enriched, options);
  let setupItems = setupCandidates.filter((item) => item.status !== "set");

  if (scan.envVars.length === 0) {
    console.log("No env vars found. Add a .env.example or reference process.env.MY_KEY in code, then run again.");
    return;
  }

  const skipped = enriched.length - setupCandidates.length;
  const alreadySet = setupCandidates.length - setupItems.length;
  console.log(`Found ${enriched.length} env var(s).`);
  if (!options.all) {
    const scope = options.optional ? "required/optional credential" : "required setup value";
    console.log(`Missing ${setupItems.length} ${scope}(s); ${alreadySet} already set.`);
    if (skipped > 0) console.log(`Skipping ${skipped} optional/default/config value(s).`);
  }

  if (setupItems.length) {
    console.log("\nSetup queue:\n");
    for (const item of setupItems) {
      const label = item.provider ? item.provider.name : "Unknown provider";
      console.log(`- ${item.name} (${label})`);
    }
    printOptionalPreview(enriched, options, "start");
  } else {
    const optionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      shouldIncludeOptional(item, options)
    );
    const unknownOptionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      !item.provider
    ).length;
    const templateOptionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      item.provider &&
      isTemplateOnly(item)
    ).length;
    console.log("Nothing missing in the current setup scope.");
    if (!options.optional && !options.all && optionalMissing.length && process.stdin.isTTY) {
      printOptionalPreview(enriched, options, "start");
      const fillOptional = await promptYesNo("Fill optional credentials now? ");
      if (fillOptional) {
        options.optional = true;
        setupItems = filterEnvRows(enriched, options).filter((item) => item.status !== "set");
      }
    }
    if (setupItems.length) {
      console.log("\nSetup queue:\n");
      for (const item of setupItems) {
        const label = item.provider ? item.provider.name : "Unknown provider";
        console.log(`- ${item.name} (${label})`);
      }
    }
    if (!setupItems.length && optionalMissing.length) {
      console.log(`Found ${optionalMissing.length} optional missing credential(s). Run \`envhelper start --optional\` to fill them.`);
    }
    if (!setupItems.length && unknownOptionalMissing) {
      console.log(`Hidden: ${unknownOptionalMissing} unknown optional credential(s). Add \`--unknown\` if you really want those too.`);
    }
    if (!setupItems.length && templateOptionalMissing) {
      console.log(`Hidden: ${templateOptionalMissing} template-only optional credential(s). Add \`--template\` to include them.`);
    }
    if (!setupItems.length) console.log("Run `envhelper needs --all` to inspect optional/default/config values.");
  }

  await ensureEnvIgnored(cwd);
  const examplePath = path.join(cwd, ".env.example");
  if (!existsSync(examplePath)) {
    const created = await writeEnvExample(examplePath, setupItems.map((item) => item.name));
    if (created) console.log("Created .env.example with detected env vars.");
  }

  const updates = {};

  for (const item of setupItems) {
    if (existing[item.name]) continue;
    const provider = item.provider;
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

async function needsCommand(argv = []) {
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  const values = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const rows = scan.envVars.map((item) => {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const template = summarizeTemplates(item.templates || []);
    const kind = classifyEnvVar(item.name, provider, template);
    return {
      name: item.name,
      status: values[item.name] ? "set" : "missing",
      provider: provider?.name || null,
      providerId: provider?.id || null,
      kind,
      link: provider ? bestProviderUrl(provider) : kind.includes("credential") ? fallbackSearchUrl(item.name) : null,
      sources: item.sources
    };
  });
  const visibleRows = filterEnvRows(rows, options);
  const missingRows = visibleRows.filter((row) => row.status !== "set");
  const setRows = visibleRows.filter((row) => row.status === "set");
  const displayRows = options.showSet ? visibleRows : missingRows;

  if (options.json) {
    console.log(JSON.stringify(visibleRows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log("No env vars detected. Add a .env.example or run `envhelper add <provider>`.");
    return;
  }

  if (!visibleRows.length) {
    const optionalCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && shouldIncludeOptional(row, options)).length;
    console.log(`Found ${rows.length} env var(s), but none look required for setup.`);
    if (optionalCount) {
      console.log(`There are ${optionalCount} optional missing credential(s).`);
      printOptionalPreview(rows, options, "needs");
    }
    console.log("Run `envhelper needs --all` to show optional/default/config values too.");
    return;
  }

  const hidden = rows.length - visibleRows.length;
  console.log(needsHeading(options, displayRows.length, setRows.length));
  for (const row of displayRows) {
    printNeedsRow(row, options);
  }
  if (!options.showSet && setRows.length > 0) {
    console.log(`\nAlready set: ${setRows.length} hidden. Run \`envhelper needs ${needsFlagHint(options)}--show-set\` to include them.`);
  }
  if (!options.all && hidden > 0) {
    console.log(`\nSkipped ${hidden} optional/default/config value(s). Run \`envhelper needs --all\` to show them.`);
    printOptionalPreview(rows, options, "needs");
  }
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
  const options = parseArgs(argv);
  if (options.invite || options.out) return invite(argv);
  if (options.join) return join();

  const envPath = path.join(cwd, ".env");
  const bundlePath = path.join(cwd, ".env.team.enc");
  if (!existsSync(envPath) && existsSync(bundlePath)) return join();
  if (!existsSync(envPath) && !existsSync(bundlePath)) return invite(argv);

  if (!existsSync(envPath)) {
    console.error("No .env file found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }

  const recipients = await collectRecipients(argv, { interactive: options.interactive });
  if (!recipients.length) {
    await printShareNextStep(argv);
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

function commandsCommand() {
  banner();
  console.log(`Main commands:
  envhelper start       Set up this repo's .env locally
  envhelper needs       Show what env vars are needed and where to get them
  envhelper share       Share or receive an encrypted .env
  envhelper doctor      Check for missing docs and likely secret leaks
  envhelper link        Find a provider's API key page
  envhelper commands    Show this command directory

Useful extras:
  envhelper add <provider-or-env-var>
  envhelper providers
  envhelper validate

Explicit sharing aliases:
  envhelper invite --out alice.pub
  envhelper share --recipients-dir invites
  envhelper join
`);
}

async function version() {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  console.log(pkg.version);
}

function help() {
  commandsCommand();
}

function commandHelp(name) {
  const text = {
    start: "Usage: envhelper start [--optional|--all] [--unknown] [--template] [--validate|--no-validate]\n\nScan the repo and guide setup for required credentials. Use --optional for optional known-provider credentials that are referenced outside the template, --template for template-only optional credentials, --unknown to include unknown optional credentials, or --all for every variable.",
    init: "Usage: envhelper init [--optional|--all] [--validate|--no-validate]\n\nAlias for start.",
    setup: "Usage: envhelper setup [--optional|--all] [--validate|--no-validate]\n\nAlias for start.",
    needs: "Usage: envhelper needs [--optional|--all] [--unknown] [--template] [--show-set] [--verbose] [--json]\n\nShow missing required credentials and where to get them. Use --optional for optional known-provider credentials referenced outside the template, --template for template-only optional credentials, --unknown to include unknown optional credentials, --all for config values too, --show-set to include values already present in .env, or --verbose to show source files.",
    scan: "Usage: envhelper scan [--optional|--all] [--unknown] [--template] [--show-set] [--verbose] [--json]\n\nAlias for needs.",
    add: "Usage: envhelper add <provider-or-env-var> [--validate|--no-validate]\n\nAdd a provider or single env var to .env and .env.example.",
    link: "Usage: envhelper link <provider-or-env-var> [--copy] [--open]\n\nPrint, copy, or open a source-backed provider link. Unknown providers use Google search.",
    links: "Usage: envhelper links <provider-or-env-var> [--copy] [--open]\n\nAlias for link.",
    doctor: "Usage: envhelper doctor [--fix] [--history|--full]\n\nCheck .env hygiene, likely leaks, frontend exposure, and optional recent git history.",
    check: "Usage: envhelper check [--fix] [--history|--full]\n\nAlias for doctor.",
    example: "Usage: envhelper example\n\nGenerate .env.example from detected env vars.",
    validate: "Usage: envhelper validate\n\nValidate local .env values with providers after explicit consent.",
    invite: "Usage: envhelper invite [--out teammate.pub]\n\nCreate or reuse a local age identity and print the public invite code.",
    share: "Usage: envhelper share [--out teammate.pub] [--recipient age1...] [--recipients-file file] [--recipients-dir dir] [--interactive] [--join]\n\nSmart sharing command. Without recipients it explains the flow and prints your invite code. With recipient codes it encrypts .env. With .env.team.enc it decrypts locally.",
    rekey: "Usage: envhelper rekey [--recipient age1...] [--recipients-file file] [--recipients-dir dir]\n\nAlias for share; re-encrypts the current local .env to a fresh recipient set.",
    join: "Usage: envhelper join\n\nDecrypt .env.team.enc locally into .env.",
    providers: "Usage: envhelper providers [--json]\n\nList the built-in source-backed provider directory.",
    commands: "Usage: envhelper commands\n\nShow the simplified command directory.",
    directory: "Usage: envhelper directory\n\nAlias for commands.",
    version: "Usage: envhelper version\n\nPrint the EnvHelper version.",
    help: "Usage: envhelper help\n\nShow the main help."
  }[name];
  console.log(text || "Usage: envhelper help");
}

function banner() {
  console.log("EnvHelper - local-first .env setup and sharing\n");
}

async function printShareNextStep(argv = []) {
  console.log("Sharing needs one public invite code from each teammate.");
  console.log("Ask each teammate to run:");
  console.log("  envhelper invite");
  console.log("\nThen encrypt your .env with:");
  console.log("  envhelper share --recipient age1...");
  console.log("\nOr put teammate .pub files in ./invites and run:");
  console.log("  envhelper share");
  console.log("\nIf someone else is sharing with you, send them your invite code:");
  console.log("");
  await invite(argv);
}

async function collectRecipients(argv, options = {}) {
  const recipients = [];
  const parsed = parseArgs(argv);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--recipient" || argv[i] === "-r") {
      const value = argv[i + 1];
      if (value) {
        recipients.push(value.trim());
        i++;
      }
    }
  }
  if (parsed.recipientsFile) {
    recipients.push(...await readRecipientsFile(path.resolve(cwd, parsed.recipientsFile)));
  }
  if (parsed.recipientsDir) {
    recipients.push(...await readRecipientsDir(path.resolve(cwd, parsed.recipientsDir)));
  }
  if (!recipients.length && existsSync(path.join(cwd, "invites"))) {
    recipients.push(...await readRecipientsDir(path.join(cwd, "invites")));
  }
  if (recipients.length) return uniqueRecipients(recipients);
  if (!options.interactive) return [];

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
  await writeMetadataFile(root, metadata);
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
  await writeMetadataFile(root, metadata);
}

async function writeMetadataFile(root, metadata) {
  try {
    await fs.writeFile(path.join(root, ".envhelper.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    console.log("Wrote non-secret .envhelper.json metadata.");
  } catch (error) {
    console.log(`Skipped .envhelper.json metadata: ${error.code || error.message}`);
  }
}

function buildMetadata(root, names, providers, packageNames = []) {
  return {
    version: 1,
    generatedBy: "envhelper",
    project: path.basename(root),
    detected: [...new Set(names)].sort(),
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

function enrichEnvVars(scan, providers) {
  return scan.envVars.map((item) => {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const template = summarizeTemplates(item.templates || []);
    const kind = classifyEnvVar(item.name, provider, template);
    return {
      ...item,
      provider,
      template,
      kind,
      actionable: kind === "required credential"
    };
  });
}

function filterEnvRows(rows, options) {
  if (options.all) return rows;
  if (options.optional) {
    return rows.filter((row) =>
      row.kind === "required credential" ||
      (row.kind === "optional credential" && shouldIncludeOptional(row, options))
    );
  }
  return rows.filter((row) => row.kind === "required credential");
}

function shouldIncludeOptional(row, options) {
  if (!options.unknown && !row.provider) return false;
  if (!options.template && isTemplateOnly(row)) return false;
  return true;
}

function isTemplateOnly(row) {
  const sources = row.sources || [];
  return sources.length > 0 && sources.every((source) => source === ".env.example" || source === ".envhelper.json");
}

function printOptionalPreview(rows, options, command) {
  if (options.optional || options.all) return;
  const optional = rows
    .filter((row) => row.kind === "optional credential" && row.status !== "set" && shouldIncludeOptional(row, options))
    .sort((left, right) => providerRank(left) - providerRank(right) || left.name.localeCompare(right.name));
  if (!optional.length) return;
  const shown = optional.slice(0, 5);
  console.log("\nOptional credentials detected:");
  for (const row of shown) {
    console.log(`- ${row.name} (${providerLabel(row)})`);
  }
  if (optional.length > shown.length) console.log(`- ...and ${optional.length - shown.length} more`);
  console.log(`Run \`envhelper ${command} --optional\` to include these.`);
  const unknownCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && !row.provider).length;
  if (unknownCount) console.log(`Hidden: ${unknownCount} unknown optional credential(s). Add \`--unknown\` if you really want those too.`);
  const templateCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && row.provider && isTemplateOnly(row)).length;
  if (templateCount) console.log(`Hidden: ${templateCount} template-only optional credential(s). Add \`--template\` to include them.`);
}

function needsHeading(options, missingCount, setCount) {
  const scope = options.all ? "all categories" : options.optional ? "required/optional credentials" : "required setup values";
  if (missingCount) return `Missing ${scope}:`;
  if (options.showSet) return `No missing ${scope}. Showing ${setCount} already set value(s):`;
  return `No missing ${scope}.`;
}

function needsFlagHint(options) {
  if (options.all) return "--all ";
  if (options.optional) return "--optional ";
  return "";
}

function printNeedsRow(row, options) {
  const mark = row.status === "set" ? "✓" : "!";
  const provider = row.provider || "unknown";
  const detail = options.all || options.optional ? `${row.kind}, ${provider}` : provider;
  console.log(`${mark} ${row.name} (${detail})`);
  if (row.link) console.log(`  ${formatLink(row.provider ? "open key page" : "Google search", row.link)}`);
  if (options.verbose) console.log(`  found in: ${row.sources.join(", ")}`);
}

function providerLabel(row) {
  if (!row.provider) return "Unknown provider";
  if (typeof row.provider === "string") return row.provider;
  return row.provider.name || "Unknown provider";
}

function providerRank(row) {
  return providerLabel(row).toLowerCase().startsWith("unknown") ? 1 : 0;
}

function classifyEnvVar(name, provider, template = summarizeTemplates([])) {
  const credentialLike = isKnownProviderEnvVar(name, provider) || isLikelyCredentialEnvVar(name);
  if (!credentialLike) return "config";
  if (template.hasTemplate) {
    if (template.required) return "required credential";
    if (template.blankOptional) return "optional credential";
    return "defaulted credential";
  }
  return isKnownProviderEnvVar(name, provider) ? "required credential" : "optional credential";
}

function summarizeTemplates(templates) {
  const hasTemplate = templates.length > 0;
  const blankTemplates = templates.filter((template) => !template.hasDefault);
  const required = hasTemplate && blankTemplates.length > 0 && blankTemplates.every((template) => !template.optional);
  const blankOptional = hasTemplate && !required && blankTemplates.length > 0;
  return { hasTemplate, required, blankOptional };
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
    else if (arg === "--show-set") options.showSet = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--unknown") options.unknown = true;
    else if (arg === "--template") options.template = true;
    else if (arg === "--interactive") options.interactive = true;
    else if (arg === "--invite") options.invite = true;
    else if (arg === "--join") options.join = true;
    else if (arg === "--all" || arg === "-all") options.all = true;
    else if (arg === "--optional" || arg === "-optional") options.optional = true;
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
        process.stdin.pause();
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
