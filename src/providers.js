import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const providerPath = fileURLToPath(new URL("../providers/providers.json", import.meta.url));

export async function loadProviders() {
  const raw = await fs.readFile(providerPath, "utf8");
  const builtIn = JSON.parse(raw).providers;
  const localPath = path.join(process.cwd(), ".envhelper.providers.json");
  try {
    const local = JSON.parse(await fs.readFile(localPath, "utf8"));
    return mergeProviders(builtIn, local.providers || []);
  } catch {
    return builtIn;
  }
}

export function providerTable(providers) {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    env: provider.env || [],
    keyUrl: provider.keyUrl
  }));
}

export function providerByQuery(query, providers) {
  const normalized = query.toLowerCase();
  return providers.find((provider) =>
    provider.id.toLowerCase() === normalized ||
    provider.name.toLowerCase() === normalized ||
    (provider.aliases || []).some((alias) => alias.toLowerCase() === normalized)
  ) || null;
}

export function providerForEnvVar(name, providers, packageNames = []) {
  const upper = name.toUpperCase();
  const exact = providers.find((provider) => (provider.env || []).includes(upper));
  if (exact) return exact;

  const byPattern = providers.find((provider) =>
    (provider.envPatterns || []).some((pattern) => new RegExp(pattern, "i").test(name))
  );
  if (byPattern) return byPattern;

  if (isGenericEnvName(upper)) {
    const packageMatches = providers.filter((provider) =>
      (provider.packages || []).some((pkg) => packageNames.includes(pkg))
    );
    if (packageMatches.length === 1) return packageMatches[0];
  }

  return null;
}

export function envVarClientSafe(name, provider) {
  if (!provider) return null;
  const upper = name.toUpperCase();
  if (provider.envSafety && upper in provider.envSafety) return provider.envSafety[upper].clientSafe;
  if (upper.includes("SECRET") || upper.includes("PRIVATE") || upper.includes("SERVICE_ROLE")) return false;
  if (upper.startsWith("NEXT_PUBLIC_") || upper.startsWith("VITE_") || upper.startsWith("PUBLIC_")) return true;
  return provider.clientSafe ?? null;
}

function mergeProviders(builtIn, local) {
  const byId = new Map(builtIn.map((provider) => [provider.id, provider]));
  for (const provider of local) {
    byId.set(provider.id, { ...(byId.get(provider.id) || {}), ...provider });
  }
  return [...byId.values()];
}

function isGenericEnvName(name) {
  return ["API_KEY", "SECRET_KEY", "TOKEN", "ACCESS_TOKEN", "AUTH_TOKEN"].includes(name);
}
