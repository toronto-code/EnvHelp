import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEnvFile } from "../src/envfile.js";
import { googleSearchUrl, terminalLink } from "../src/links.js";
import { envVarClientSafe, loadProviders, providerByQuery, providerForEnvVar } from "../src/providers.js";
import { doctor, scanProject } from "../src/scanner.js";
import { validateEnvValue } from "../src/validators.js";

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

test("provider metadata resolves common keys and safety flags", async () => {
  const providers = await loadProviders();
  const openai = providerForEnvVar("OPENAI_API_KEY", providers);
  const stripe = providerForEnvVar("STRIPE_PUBLISHABLE_KEY", providers);
  const supabase = providerForEnvVar("SUPABASE_SERVICE_ROLE_KEY", providers);

  assert.equal(openai.name, "OpenAI");
  assert.equal(providerByQuery("gpt", providers).name, "OpenAI");
  assert.equal(stripe.name, "Stripe");
  assert.equal(envVarClientSafe("STRIPE_PUBLISHABLE_KEY", stripe), true);
  assert.equal(envVarClientSafe("SUPABASE_SERVICE_ROLE_KEY", supabase), false);
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
