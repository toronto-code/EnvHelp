import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEnvFile } from "../src/envfile.js";
import { googleSearchUrl, terminalLink } from "../src/links.js";
import { envVarClientSafe, loadProviders, providerByQuery, providerForEnvVar } from "../src/providers.js";
import { doctor, scanProject } from "../src/scanner.js";
import { canValidateEnvVar, validateEnvValue } from "../src/validators.js";

test("scanProject detects env vars from common project sources", async () => {
  const root = await tempProject();
  await fs.writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=\nSUPABASE_URL=\n", "utf8");
  await fs.writeFile(path.join(root, ".envhelper.json"), JSON.stringify({ required: ["STRIPE_SECRET_KEY"] }), "utf8");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    "process.env.RESEND_API_KEY; import.meta.env.VITE_FIREBASE_API_KEY;",
    "utf8"
  );
  await fs.writeFile(path.join(root, "app.py"), "os.environ['ANTHROPIC_API_KEY']\n", "utf8");

  const providers = await loadProviders();
  const scan = await scanProject(root, providers);
  const names = scan.envVars.map((item) => item.name);

  assert.deepEqual(names, [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "SUPABASE_URL",
    "VITE_FIREBASE_API_KEY"
  ]);
});

test("scanProject ignores EnvHelper-generated metadata as a source of requirements", async () => {
  const root = await tempProject();
  await fs.writeFile(
    path.join(root, ".envhelper.json"),
    JSON.stringify({
      version: 1,
      generatedBy: "envhelper",
      detected: ["OPENAI_API_KEY"],
      providers: {
        OPENAI_API_KEY: "openai"
      }
    }),
    "utf8"
  );

  const providers = await loadProviders();
  const scan = await scanProject(root, providers);

  assert.deepEqual(scan.envVars.map((item) => item.name), []);
});

test("scanProject keeps hand-authored EnvHelper requirements", async () => {
  const root = await tempProject();
  await fs.writeFile(path.join(root, ".envhelper.json"), JSON.stringify({ required: ["OPENAI_API_KEY"] }), "utf8");

  const providers = await loadProviders();
  const scan = await scanProject(root, providers);

  assert.deepEqual(scan.envVars.map((item) => item.name), ["OPENAI_API_KEY"]);
});

test("scanProject ignores common terminal and documentation placeholder env vars", async () => {
  const root = await tempProject();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "terminal.js"),
    "process.env.TERM_PROGRAM; process.env.FORCE_HYPERLINK; process.env.WT_SESSION; process.env.REAL_API_KEY;",
    "utf8"
  );
  await fs.writeFile(path.join(root, "README.md"), "Example: process.env.MY_KEY and import.meta.env.X\n", "utf8");

  const providers = await loadProviders();
  const scan = await scanProject(root, providers);
  assert.deepEqual(scan.envVars.map((item) => item.name), ["REAL_API_KEY"]);
});

test("provider metadata resolves common keys and safety flags", async () => {
  const providers = await loadProviders();
  const openai = providerForEnvVar("OPENAI_API_KEY", providers);
  const stripe = providerForEnvVar("STRIPE_PUBLISHABLE_KEY", providers);
  const supabase = providerForEnvVar("SUPABASE_SERVICE_ROLE_KEY", providers);
  const groq = providerForEnvVar("GROQ_API_KEY", providers);

  assert.equal(openai.name, "OpenAI");
  assert.equal(providerByQuery("gpt", providers).name, "OpenAI");
  assert.equal(stripe.name, "Stripe");
  assert.equal(groq.name, "Groq");
  assert.equal(providerForEnvVar("OPENAI_DEFAULT_MODEL", providers), null);
  assert.equal(providerForEnvVar("GITHUB_ALLOWED_WRITE_PATHS", providers), null);
  assert.equal(providerForEnvVar("GITHUB_WEBHOOK_SECRET", providers).name, "GitHub");
  assert.equal(envVarClientSafe("STRIPE_PUBLISHABLE_KEY", stripe), true);
  assert.equal(envVarClientSafe("SUPABASE_SERVICE_ROLE_KEY", supabase), false);
  assert.equal(canValidateEnvVar("STRIPE_SECRET_KEY", stripe), true);
  assert.equal(canValidateEnvVar("STRIPE_PUBLISHABLE_KEY", stripe), false);
});

test("provider directory includes source-backed common providers", async () => {
  const providers = await loadProviders();
  const ids = new Set(providers.map((provider) => provider.id));

  assert.ok(providers.length >= 50);
  for (const id of ["stripe", "openai", "anthropic", "groq", "replicate", "slack", "discord", "paypal"]) {
    assert.ok(ids.has(id), `${id} should be in the provider directory`);
  }
  assert.ok(providers.every((provider) => provider.sourceUrl?.startsWith("https://")));
});

test("doctor reports missing local env values without printing secrets", async () => {
  const root = await tempProject();
  await fs.writeFile(path.join(root, ".gitignore"), ".env\n", "utf8");
  await fs.writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=\nSTRIPE_SECRET_KEY=\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "OPENAI_API_KEY=sk-test-not-real\n", "utf8");

  const providers = await loadProviders();
  const result = await doctor(root, providers);
  const messages = result.checks.map((check) => check.message).join("\n");

  assert.match(messages, /missing 1 detected value/);
  assert.doesNotMatch(messages, /sk-test-not-real/);
});

test("doctor does not ask for .env files when no env vars are detected", async () => {
  const root = await tempProject();
  await fs.writeFile(path.join(root, ".gitignore"), ".env\n", "utf8");

  const providers = await loadProviders();
  const result = await doctor(root, providers);
  const messages = result.checks.map((check) => check.message).join("\n");

  assert.match(messages, /No \.env\.example needed/);
  assert.match(messages, /No \.env needed/);
  assert.equal(result.exitCode, 0);
});

test("url validators work without contacting a provider", async () => {
  const provider = {
    name: "Example",
    envSafety: {
      SUPABASE_URL: {
        validation: {
          type: "url",
          protocol: "https:"
        }
      }
    }
  };

  assert.equal((await validateEnvValue("SUPABASE_URL", "https://example.supabase.co", provider)).ok, true);
  assert.equal((await validateEnvValue("SUPABASE_URL", "not-a-url", provider)).ok, false);
});

test("parseEnvFile handles quoted values", async () => {
  const root = await tempProject();
  const file = path.join(root, ".env");
  await fs.writeFile(file, "A=plain\nB=\"two words\"\nC='three words'\n", "utf8");

  assert.deepEqual(await parseEnvFile(file), {
    A: "plain",
    B: "two words",
    C: "three words"
  });
});

test("unknown provider fallback uses Google search", () => {
  assert.equal(
    googleSearchUrl("ACME_API_KEY"),
    "https://www.google.com/search?q=ACME_API_KEY%20API%20key%20env%20var"
  );
  assert.equal(terminalLink("label", "https://example.com"), "https://example.com");
});

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "envhelper-"));
}
