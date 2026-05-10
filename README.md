# EnvPack

Stop sending `.env` files in chat.

EnvPack is a local-first CLI for setting up, checking, and safely sharing environment variables. It helps solo developers figure out what keys a project needs and where to get them, then adds an encrypted sharing flow for teams.

No accounts. No hosted vault. No plaintext secret sharing.

## What It Does

```bash
npx envpack start
```

EnvPack scans the current repo for environment variables from `.env.example`, README snippets, JavaScript/TypeScript, Python, Ruby, and common framework patterns like `import.meta.env.X`.

Maintainers can also commit non-secret metadata:

```json
{
  "version": 1,
  "required": ["OPENAI_API_KEY", "SUPABASE_URL"]
}
```

It then guides you through missing values:

```txt
OPENAI_API_KEY
Provider: OpenAI
Create key: https://platform.openai.com/api-keys
Paste locally: ********
Validate with OpenAI? This sends the value directly to OpenAI. [y/N]
Saved to .env
```

For teams:

```bash
npx envpack invite
```

This creates a local `age` identity and prints a public invite code. Public invite codes are safe to send to a teammate.

```bash
npx envpack share
```

The team lead encrypts `.env` to teammate invite codes and creates:

```txt
.env.team.enc
```

Teammates decrypt locally:

```bash
npx envpack join
```

## Commands

```bash
envpack start
```

Scan the project, guide local `.env` setup, write non-secret `.envpack.json` metadata, and make sure `.env` is ignored.

```bash
envpack add openai
envpack add OPENAI_API_KEY
```

Bootstrap a provider or a single environment variable before the project has anything useful to scan. This is the solo-builder path for fresh projects.

```bash
envpack doctor
```

Check `.env` hygiene, missing docs, likely leaked secrets, unsafe frontend usage, and encrypted bundle presence.

Use safe auto-fixes:

```bash
envpack doctor --fix
```

This ensures `.env` ignore rules and creates `.env.example` from detected variables when possible.

```bash
envpack validate
```

Validate local `.env` values with providers after explicit consent. EnvPack never validates silently.

```bash
envpack invite
```

Generate a local `age` identity and print an invite code such as `age1...`.

```bash
envpack invite --out alice.pub
```

Write the public invite code to a file that can be sent to a team lead.

```bash
envpack share
```

Encrypt `.env` to one or more `age1...` invite codes using the `age` CLI.

```bash
envpack share --recipients-dir invites
```

Encrypt to every `.pub` invite file in a directory. This supports an async team flow where teammates send public invite files whenever they are ready.

```bash
envpack rekey
```

Re-encrypt `.env.team.enc` to a fresh recipient set. This does not remove old bundles from git history or rotate upstream provider keys.

```bash
envpack join
```

Decrypt `.env.team.enc` locally into `.env`.

```bash
envpack providers
```

Show the built-in provider directory.

## Provider Links

There are too many API providers to hard-code perfectly, so EnvPack uses a layered provider directory:

1. Built-in curated providers for common services like OpenAI, Stripe, Supabase, Anthropic, Clerk, Resend, Twilio, Firebase, GitHub, and Google Maps.
2. Env var and package-name patterns to infer providers from names like `OPENAI_API_KEY` or dependencies like `stripe`.
3. Project-local overrides in `.envpack.providers.json`.
4. A fallback search URL when EnvPack cannot identify a provider.

Provider metadata is intentionally non-secret:

```json
{
  "id": "openai",
  "name": "OpenAI",
  "keyUrl": "https://platform.openai.com/api-keys",
  "docsUrl": "https://platform.openai.com/docs",
  "env": ["OPENAI_API_KEY"],
  "clientSafe": false,
  "validation": {
    "type": "http",
    "method": "GET",
    "url": "https://api.openai.com/v1/models"
  }
}
```

## Security Model

EnvPack does not run a server and does not receive your secrets.

Secrets are entered locally, written locally, encrypted locally, and decrypted locally. Team sharing uses [`age`](https://age-encryption.org/) instead of custom crypto.

Provider validation is optional and consent-based. When you validate a key, EnvPack sends that value directly from your machine to the provider, such as OpenAI or Stripe, and never to EnvPack.

Honest limitation:

> Once a teammate decrypts the bundle, they have the real API key. EnvPack prevents accidental leaking during setup and sharing; it cannot stop a trusted teammate from intentionally copying the key.

Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the design rules.
