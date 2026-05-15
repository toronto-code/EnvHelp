import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile } from "./envfile.js";
import { envVarClientSafe, isKnownProviderEnvVar, isLikelyCredentialEnvVar, providerForEnvVar } from "./providers.js";

const skipDirs = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  "__tests__",
  "test",
  "tests"
]);

const skipFiles = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.team.enc"
]);

const textExts = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".php",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".json",
  ".toml",
  ".env",
  ".example"
]);

const envPatterns = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /Deno\.env\.get\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g,
  /os\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /os\.getenv\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g,
  /ENV\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g
];

const ignoredEnvNames = new Set([
  "CI",
  "FORCE_COLOR",
  "FORCE_HYPERLINK",
  "GITHUB_ACTIONS",
  "HOME",
  "MY_KEY",
  "NO_COLOR",
  "NODE_ENV",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "USER",
  "USERNAME",
  "WT_SESSION",
  "X"
]);

const secretPatterns = [
  { id: "openai", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{32,}\b/g },
  { id: "stripe", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { id: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "generic", pattern: /\b[A-Za-z0-9_-]{32,}\b/g }
];

export async function scanProject(root, providers) {
  const files = await listFiles(root);
  const packageNames = await readPackageNames(root);
  const envVars = new Map();

  await collectEnvhelperMetadata(root, envVars);
  await collectEnvExample(root, envVars);

  for (const file of files) {
    const rel = path.relative(root, file);
    if (!isTextFile(file)) continue;
    const content = await safeRead(file);
    if (!content) continue;

    for (const pattern of envPatterns) {
      for (const match of content.matchAll(pattern)) {
        addEnv(envVars, match[1], rel);
      }
    }

    if (path.basename(file).toLowerCase().includes("readme")) {
      for (const match of content.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)) {
        addEnv(envVars, match[1], rel);
      }
    }
  }

  return {
    envVars: [...envVars.values()].sort((a, b) => a.name.localeCompare(b.name)),
    packageNames
  };
}

export async function doctor(root, providers, options = {}) {
  const checks = [];
  const findings = [];
  const scan = await scanProject(root, providers);
  const envPath = path.join(root, ".env");

  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    checks.push({ level: "fail", message: ".gitignore is missing" });
  } else {
    const gitignore = await fs.readFile(gitignorePath, "utf8");
    checks.push(gitignore.split(/\r?\n/).includes(".env")
      ? { level: "ok", message: ".env is ignored" }
      : { level: "fail", message: ".env is not ignored" });
  }

  checks.push(existsSync(path.join(root, ".env.example"))
    ? { level: "ok", message: ".env.example exists" }
    : scan.envVars.length
      ? { level: "warn", message: ".env.example is missing" }
      : { level: "ok", message: "No .env.example needed; no env vars detected" });

  if (existsSync(envPath)) {
    checks.push({ level: "ok", message: ".env exists locally" });
    if (isGitTracked(root, ".env")) {
      checks.push({ level: "fail", message: ".env is tracked by git" });
    }
    const values = await parseEnvFile(envPath);
    const missingSetup = scan.envVars.filter((item) => shouldDoctorRequire(item, providers, scan.packageNames) && !values[item.name]);
    const hidden = scan.envVars.filter((item) => !values[item.name]).length - missingSetup.length;
    checks.push(missingSetup.length
      ? {
          level: "warn",
          message: `.env is missing ${missingSetup.length} likely setup value(s): ${summarizeNames(missingSetup.map((item) => item.name))}${hidden > 0 ? ` (${hidden} optional/default/config value(s) hidden)` : ""}`
        }
      : hidden > 0
        ? { level: "ok", message: `.env has all likely setup values (${hidden} optional/default/config value(s) not set)` }
        : { level: "ok", message: ".env has all detected values" });
  } else if (scan.envVars.length) {
    checks.push({ level: "warn", message: ".env not found; run envhelper start" });
  } else {
    checks.push({ level: "ok", message: "No .env needed; no env vars detected" });
  }

  checks.push(existsSync(path.join(root, ".env.team.enc"))
    ? { level: "ok", message: ".env.team.enc exists" }
    : { level: "ok", message: "No team bundle found; sharing is optional" });

  checks.push(scan.envVars.length
    ? { level: "ok", message: `Detected ${scan.envVars.length} env var(s)` }
    : { level: "ok", message: "No env vars detected" });

  const files = await listFiles(root);
  for (const file of files) {
    if (!isTextFile(file)) continue;
    const rel = path.relative(root, file);
    const content = await safeRead(file);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const item of secretPatterns) {
        for (const match of line.matchAll(item.pattern)) {
          if (item.id === "generic" && (!isHighEntropy(match[0]) || !isGenericSecretCandidate(match[0]))) continue;
          findings.push({
            file: rel,
            line: idx + 1,
            message: `possible ${item.id} secret detected (redacted)`
          });
          break;
        }
      }
    });
  }

  if (options.history) {
    findings.push(...scanGitHistory(root));
  } else {
    checks.push({ level: "info", message: "Git history scan skipped; run envhelper doctor --history for a slower check" });
  }

  for (const env of scan.envVars) {
    const provider = providerForEnvVar(env.name, providers, scan.packageNames);
    const frontendSources = env.sources.filter((source) => isFrontendPath(source));
    if (provider && envVarClientSafe(env.name, provider) === false && frontendSources.length && env.sources.some((source) => isRuntimeSource(source))) {
      findings.push({
        file: frontendSources[0],
        line: 1,
        message: `${env.name} is referenced by frontend runtime code but ${provider.name} marks it secret`
      });
    }
  }

  const hasFailure = checks.some((check) => check.level === "fail") || findings.length > 0;
  return { checks, findings, exitCode: hasFailure ? 1 : 0 };
}

async function collectEnvExample(root, envVars) {
  const candidates = [".env.example", ".env.sample", ".env.template"];
  for (const name of candidates) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const content = await fs.readFile(file, "utf8");
    for (const entry of parseEnvTemplate(content)) {
      addEnv(envVars, entry.name, name, { template: entry });
    }
  }
}

async function collectEnvhelperMetadata(root, envVars) {
  const name = ".envhelper.json";
  const file = path.join(root, name);
  if (!existsSync(file)) return;
  try {
    const metadata = JSON.parse(await fs.readFile(file, "utf8"));
    if (metadata.generatedBy === "envhelper" || metadata.providers) return;
    for (const key of metadata.required || []) addEnv(envVars, key, name);
  } catch {
    return;
  }
}

function addEnv(map, name, source, metadata = {}) {
  if (!name) return;
  const normalized = name.trim();
  if (ignoredEnvNames.has(normalized.toUpperCase())) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) return;
  const current = map.get(normalized) || { name: normalized, sources: [], templates: [] };
  if (!current.sources.includes(source)) current.sources.push(source);
  if (metadata.template) current.templates.push(metadata.template);
  map.set(normalized, current);
}

function parseEnvTemplate(content) {
  const entries = [];
  let comments = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      comments = [];
      continue;
    }
    if (line.startsWith("#")) {
      comments.push(line.replace(/^#+\s?/, "").trim());
      comments = comments.slice(-12);
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = stripInlineComment(match[2].trim());
    const context = comments.join(" ");
    entries.push({
      name: match[1],
      value,
      hasDefault: value.length > 0,
      optional: isOptionalTemplateContext(context),
      context
    });
  }
  return entries;
}

function stripInlineComment(value) {
  if (!value) return "";
  const hash = value.search(/\s+#/);
  return hash === -1 ? value : value.slice(0, hash).trim();
}

function isOptionalTemplateContext(context) {
  return /\b(optional|recommended|fallback|falls back|if unset|safe to leave blank|leave blank|leave empty|deprecated|no longer|not wired|not required|no .* required|simulated only|demo still works|observability|settings page)\b/i.test(context);
}

async function readPackageNames(root) {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return [];
  try {
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    return Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {})
    });
  } catch {
    return [];
  }
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (skipFiles.has(entry.name)) continue;
        if (isProbablyTestFile(entry.name)) continue;
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return out;
}

function isProbablyTestFile(name) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

async function safeRead(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 500_000) return "";
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function isTextFile(file) {
  const base = path.basename(file);
  if (base.startsWith(".env")) return true;
  const ext = path.extname(file);
  return textExts.has(ext);
}

function isFrontendPath(source) {
  if (isTemplateOrDocsSource(source)) return false;
  return /(^|\/)(src|app|pages|components|client|public)\//.test(source) ||
    /\.(jsx|tsx|vue|svelte)$/.test(source);
}

function isRuntimeSource(source) {
  if (isTemplateOrDocsSource(source)) return false;
  return /\.(jsx|tsx|js|ts|mjs|cjs|vue|svelte)$/.test(source);
}

function isTemplateOrDocsSource(source) {
  const base = path.basename(source).toLowerCase();
  return base.startsWith(".env") ||
    base === ".envhelper.json" ||
    /\.(md|mdx|txt)$/.test(source);
}

function shouldDoctorRequire(item, providers, packageNames = []) {
  const provider = providerForEnvVar(item.name, providers, packageNames);
  const template = summarizeTemplates(item.templates || []);
  const credentialLike = isKnownProviderEnvVar(item.name, provider) || isLikelyCredentialEnvVar(item.name);
  if (!credentialLike) return false;
  if (template.hasTemplate) return template.required;
  return Boolean(provider);
}

function summarizeTemplates(templates) {
  const hasTemplate = templates.length > 0;
  const blankTemplates = templates.filter((template) => !template.hasDefault);
  const required = hasTemplate && blankTemplates.length > 0 && blankTemplates.every((template) => !template.optional);
  return { hasTemplate, required };
}

function summarizeNames(names, limit = 12) {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")}, ...and ${names.length - limit} more`;
}

function isHighEntropy(value) {
  if (value.length < 32) return false;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3.5;
}

function isGenericSecretCandidate(value) {
  if (value.length < 40) return false;
  if (/^[A-Z0-9_]+$/.test(value)) return false;
  if (/^[a-z/-]+$/.test(value)) return false;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[_-]/.test(value)
  ].filter(Boolean).length;
  return classes >= 3;
}

function isGitTracked(root, file) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", file], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0;
}

function scanGitHistory(root) {
  const result = spawnSync("git", ["log", "-p", "-n", "50", "--", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || !result.stdout) return [];
  const findings = [];
  const lines = result.stdout.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.startsWith("+")) return;
    for (const item of secretPatterns) {
      for (const match of line.matchAll(item.pattern)) {
        if (item.id === "generic" && (!isHighEntropy(match[0]) || !isGenericSecretCandidate(match[0]))) continue;
        findings.push({
          file: "git history",
          line: index + 1,
          message: `possible ${item.id} secret in recent git history (redacted)`
        });
        break;
      }
    }
  });
  return findings.slice(0, 50);
}
