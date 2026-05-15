import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve("src", "cli.js");

test("cli prints command help without entering interactive prompts", () => {
  const output = runCli(["add", "stripe", "--help"]);
  assert.match(output, /Usage: envhelper add <provider-or-env-var>/);
});

test("cli prints version from package metadata", () => {
  const output = runCli(["--version"]);
  assert.match(output.trim(), /^\d+\.\d+\.\d+/);
});

test("cli link resolves known providers and falls back to Google", () => {
  assert.match(runCli(["link", "stripe"]), /https:\/\/dashboard\.stripe\.com\/apikeys/);
  assert.match(runCli(["link", "NOT_REAL_API_KEY"]), /https:\/\/www\.google\.com\/search\?q=NOT_REAL_API_KEY/);
});

test("cli needs reports missing and set env vars", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-cli-needs-"));
  await fs.writeFile(
    path.join(root, ".env.example"),
    [
      "STRIPE_SECRET_KEY=",
      "SUPABASE_URL=",
      "# OpenAI is optional. If unset, the app falls back to mock responses.",
      "OPENAI_API_KEY=",
      "# Optional. Falls back to local mode.",
      "ACME_API_KEY=",
      "API_URL=",
      "OPENAI_DEFAULT_MODEL="
    ].join("\n"),
    "utf8"
  );
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "app.js"), "process.env.OPENAI_API_KEY;\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "SUPABASE_URL=https://demo.supabase.co\nSLACK_TOKEN=xoxb-redacted\n", "utf8");

  const output = runCli(["needs"], { cwd: root });
  assert.match(output, /STRIPE_SECRET_KEY \(Stripe\)/);
  assert.match(output, /Already set: 2 hidden/);
  assert.doesNotMatch(output, /xoxb-redacted/);
  assert.doesNotMatch(output, /SUPABASE_URL - set/);
  assert.doesNotMatch(output, /API_URL - missing/);

  const showSet = runCli(["needs", "--show-set"], { cwd: root });
  assert.match(showSet, /SUPABASE_URL \(Supabase\)/);
  assert.match(showSet, /SLACK_TOKEN \(Slack\)/);
  assert.doesNotMatch(showSet, /xoxb-redacted/);

  const json = JSON.parse(runCli(["needs", "--json"], { cwd: root }));
  assert.equal(json.find((row) => row.name === "SUPABASE_URL").status, "set");
  assert.equal(json.find((row) => row.name === "STRIPE_SECRET_KEY").status, "missing");
  assert.equal(json.some((row) => row.name === "API_URL"), false);
  assert.equal(json.some((row) => row.name === "OPENAI_API_KEY"), false);

  const optional = runCli(["needs", "--optional"], { cwd: root });
  assert.match(optional, /OPENAI_API_KEY \(optional credential, OpenAI\)/);
  assert.doesNotMatch(optional, /ACME_API_KEY/);

  const optionalUnknown = runCli(["needs", "--optional", "--unknown", "--template"], { cwd: root });
  assert.match(optionalUnknown, /ACME_API_KEY \(optional credential, Unknown provider\)/);

  const all = runCli(["needs", "--all"], { cwd: root });
  assert.match(all, /API_URL \(config, Unknown provider\)/);
  assert.match(all, /OPENAI_DEFAULT_MODEL \(config, Unknown provider\)/);

  const allAlias = runCli(["needs", "-all"], { cwd: root });
  assert.match(allAlias, /API_URL \(config, Unknown provider\)/);
});

test("cli start can consume multiple piped prompt answers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-cli-start-"));
  await fs.writeFile(path.join(root, ".env.example"), "STRIPE_SECRET_KEY=\nSUPABASE_URL=\nUNKNOWN_VENDOR_TOKEN=\nAPI_URL=\n", "utf8");

  runCli(["start", "--no-validate"], {
    cwd: root,
    input: "sk_test_12345678901234567890\nhttps://demo.supabase.co\nunknown-secret-value\n"
  });

  const env = await fs.readFile(path.join(root, ".env"), "utf8");
  assert.match(env, /STRIPE_SECRET_KEY=sk_test_12345678901234567890/);
  assert.match(env, /SUPABASE_URL=https:\/\/demo\.supabase\.co/);
  assert.match(env, /UNKNOWN_VENDOR_TOKEN=unknown-secret-value/);
  assert.doesNotMatch(env, /API_URL=/);
});

test("cli needs uses .envhelper.lock default profile when present", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-cli-lock-"));
  await fs.writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=\nSTRIPE_SECRET_KEY=\n", "utf8");
  await fs.writeFile(
    path.join(root, ".envhelper.lock"),
    JSON.stringify({
      version: 1,
      generatedBy: "envhelper",
      defaultProfile: "real-ai",
      profiles: {
        "real-ai": {
          name: "Real AI mode",
          description: "AI keys only",
          env: ["OPENAI_API_KEY"]
        }
      }
    }),
    "utf8"
  );

  const output = runCli(["needs"], { cwd: root });

  assert.match(output, /OPENAI_API_KEY \(OpenAI\)/);
  assert.doesNotMatch(output, /STRIPE_SECRET_KEY/);
});

test("cli smart share encrypts and decrypts with age when available", async () => {
  if (!hasAge()) return;

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-share-test-"));
  const teammateHome = path.join(base, "teammate-home");
  const leadHome = path.join(base, "lead-home");
  const teammateRepo = path.join(base, "teammate-repo");
  const leadRepo = path.join(base, "lead-repo");
  await fs.mkdir(teammateHome, { recursive: true });
  await fs.mkdir(leadHome, { recursive: true });
  await fs.mkdir(teammateRepo, { recursive: true });
  await fs.mkdir(leadRepo, { recursive: true });

  runCli(["share", "--out", "alice.pub"], { cwd: teammateRepo, home: teammateHome });
  const publicKey = (await fs.readFile(path.join(teammateRepo, "alice.pub"), "utf8")).trim();
  assert.match(publicKey, /^age1/);

  const identityStat = await fs.stat(path.join(teammateHome, ".envhelper", "identity.txt"));
  assert.equal(identityStat.mode & 0o077, 0);

  await fs.writeFile(path.join(leadRepo, ".env"), "OPENAI_API_KEY=shared-openai-test\n", "utf8");
  runCli(["share", "--recipient", publicKey], { cwd: leadRepo, home: leadHome });

  const bundle = await fs.readFile(path.join(leadRepo, ".env.team.enc"), "utf8");
  assert.doesNotMatch(bundle, /shared-openai-test/);

  await fs.copyFile(path.join(leadRepo, ".env.team.enc"), path.join(teammateRepo, ".env.team.enc"));
  runCli(["share"], { cwd: teammateRepo, home: teammateHome });
  const decrypted = await fs.readFile(path.join(teammateRepo, ".env"), "utf8");
  assert.match(decrypted, /OPENAI_API_KEY=shared-openai-test/);
});

test("cli share without recipients explains invite flow and prints own invite", async () => {
  if (!hasAge()) return;

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-share-help-"));
  const home = path.join(base, "home");
  const repo = path.join(base, "repo");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, ".env"), "OPENAI_API_KEY=local-only\n", "utf8");

  const output = runCli(["share"], { cwd: repo, home });

  assert.match(output, /Sharing needs one public invite code/);
  assert.match(output, /envhelper invite/);
  assert.match(output, /^age1/m);
  await assert.rejects(fs.access(path.join(repo, ".env.team.enc")));
});

function hasAge() {
  return spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("age-keygen", ["--version"], { stdio: "ignore" }).status === 0;
}

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.home ? { HOME: options.home } : {}) },
    input: options.input || "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}
