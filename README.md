# EnvHelper

Stop sending `.env` files in chat.

EnvHelper is a local-first CLI for setting up, checking, and safely sharing environment variables. It helps solo developers figure out what keys a project needs and where to get them, then adds an encrypted sharing flow for teams.

No accounts. No hosted vault. No plaintext secret sharing.

## What It Does

```bash
npx envhelper start
```

EnvHelper scans the current repo for environment variables from `.env.example`, README snippets, JavaScript/TypeScript, Python, Ruby, and common framework patterns like `import.meta.env.X`.

Maintainers can also commit non-secret metadata:

```json
{
  "version": 1,
  "required": ["STRIPE_SECRET_KEY", "SUPABASE_URL", "RESEND_API_KEY"]
}
```

It then guides you through missing values:

```txt
STRIPE_SECRET_KEY
Provider: Stripe
Create key: https://dashboard.stripe.com/apikeys
Paste locally: ********
Validate with Stripe? This sends the value directly to Stripe. [y/N]
Saved to .env
```

For teams:

```bash
npx envhelper invite
```

This creates a local `age` identity and prints a public invite code. Public invite codes are safe to send to a teammate.

```bash
npx envhelper share
```

The team lead encrypts `.env` to teammate invite codes and creates:

```txt
.env.team.enc
```

Teammates decrypt locally:

```bash
npx envhelper join
```

## Commands

```bash
envhelper start
```

Scan the project, guide local `.env` setup, write non-secret `.envhelper.json` metadata, and make sure `.env` is ignored.

```bash
envhelper add stripe
envhelper add ACME_API_KEY
```

Bootstrap a provider or a single environment variable before the project has anything useful to scan. This is the solo-builder path for fresh projects.

```bash
envhelper link stripe
envhelper link ACME_API_KEY --copy
envhelper link ACME_API_KEY --open
```

Print a clickable provider key link when the terminal supports it. Unknown providers get a Google search link. Use `--copy` to copy the URL to your clipboard or `--open` to open it in your browser.

```bash
envhelper doctor
```

Check `.env` hygiene, missing docs, likely leaked secrets, unsafe frontend usage, and encrypted bundle presence.

Use safe auto-fixes:

```bash
envhelper doctor --fix
```

This ensures `.env` ignore rules and creates `.env.example` from detected variables when possible.

```bash
envhelper validate
```

Validate local `.env` values with providers after explicit consent. EnvHelper never validates silently.

```bash
envhelper invite
```

Generate a local `age` identity and print an invite code such as `age1...`.

```bash
envhelper invite --out alice.pub
```

Write the public invite code to a file that can be sent to a team lead.

```bash
envhelper share
```

Encrypt `.env` to one or more `age1...` invite codes using the `age` CLI.

```bash
envhelper share --recipients-dir invites
```

Encrypt to every `.pub` invite file in a directory. This supports an async team flow where teammates send public invite files whenever they are ready.

```bash
envhelper rekey
```

Re-encrypt `.env.team.enc` to a fresh recipient set. This does not remove old bundles from git history or rotate upstream provider keys.

```bash
envhelper join
```

Decrypt `.env.team.enc` locally into `.env`.

```bash
envhelper providers
```

Show the built-in provider directory.

## Provider Links

There are too many API providers to hard-code perfectly, so EnvHelper uses a layered provider directory:

1. Built-in curated providers for common services like Stripe, Supabase, Anthropic, OpenAI, Clerk, Resend, Twilio, Firebase, GitHub, and Google Maps.
2. Env var and package-name patterns to infer providers from names like `STRIPE_SECRET_KEY` or dependencies like `stripe`.
3. Project-local overrides in `.envhelper.providers.json`.
4. A Google search URL when EnvHelper cannot identify a provider.

Provider metadata is intentionally non-secret:

```json
{
  "id": "stripe",
  "name": "Stripe",
  "keyUrl": "https://dashboard.stripe.com/apikeys",
  "docsUrl": "https://docs.stripe.com/keys",
  "env": ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"],
  "clientSafe": false,
  "validation": {
    "type": "http",
    "method": "GET",
    "url": "https://api.stripe.com/v1/balance"
  }
}
```

## Security Model

EnvHelper does not run a server and does not receive your secrets.

Secrets are entered locally, written locally, encrypted locally, and decrypted locally. Team sharing uses [`age`](https://age-encryption.org/) instead of custom crypto.

Provider validation is optional and consent-based. When you validate a key, EnvHelper sends that value directly from your machine to the selected provider, such as Stripe, Supabase, Anthropic, OpenAI, or Resend, and never to EnvHelper.

Honest limitation:

> Once a teammate decrypts the bundle, they have the real API key. EnvHelper prevents accidental leaking during setup and sharing; it cannot stop a trusted teammate from intentionally copying the key.

Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the design rules.
