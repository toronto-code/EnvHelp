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

For teams, one command handles the sharing lifecycle:

```bash
npx envhelper share
```

If you do not have `.env` yet, this creates a local `age` identity and prints a public invite code. Public invite codes are safe to send to a teammate.

If you do have `.env` but have not provided teammate invite codes yet, EnvHelper explains the flow and prints your own invite code instead of dropping into an unexplained prompt.

```bash
npx envhelper share --recipients-dir invites
```

If you have `.env`, this encrypts it to teammate invite codes and creates:

```txt
.env.team.enc
```

If you have `.env.team.enc`, this decrypts it locally:

```bash
npx envhelper share
```

## Commands

The main command surface is intentionally small:

```bash
envhelper start      # set up .env locally
envhelper needs      # see likely API keys/secrets and where to get them
envhelper share      # invite, encrypt, or decrypt depending on the repo state
envhelper doctor     # check for leaks and setup mistakes
envhelper link       # find an API key page
envhelper commands   # show the command directory
```

```bash
envhelper start
```

Scan the project, choose a setup profile, guide local `.env` setup, write non-secret `.envhelper.json` metadata, and make sure `.env` is ignored. In an interactive terminal, EnvHelper shows a one-screen summary with actions like fill values, show links, share `.env`, save decisions, or exit.

Skip the profile picker when you already know the mode:

```bash
envhelper start --profile local-demo
envhelper start --profile real-ai
envhelper start --profile integrations
```

When you save decisions, EnvHelper writes `.envhelper.lock`, which contains env var names and setup profiles only, never values.

```bash
envhelper needs
envhelper needs --profile integrations
envhelper needs --optional
envhelper needs --all
```

Show required credentials, whether each one is set locally, the likely provider, the source files, and the best known key link.

By default, EnvHelper hides values that are already set and only shows what still needs action. If `.envhelper.lock` exists, `needs` uses its default profile. Use `--show-set` to include already-set values and `--optional` to include blank known-provider credentials that are referenced outside the template. Add `--template` for optional values that only appear in `.env.example`, and `--unknown` when you also want unknown optional credentials. Use `--all` to include ordinary config values like ports, feature flags, defaults, and internal URLs. Add `--verbose` when you want source-file detail. `-optional` and `-all` are accepted as forgiving aliases.

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

Explicit alias for the invite side of `envhelper share`. Generates a local `age` identity and prints an invite code such as `age1...`.

```bash
envhelper invite --out alice.pub
```

Write the public invite code to a file that can be sent to a team lead.

```bash
envhelper share
```

In a terminal, open a role-based sharing wizard:

```txt
1. I want to receive a shared .env
2. I want to share my .env with teammates
3. I received .env.team.enc and want to decrypt it
```

With no recipients in non-interactive mode, explain the sharing flow and print your own invite code. With recipients, encrypt `.env` to one or more `age1...` invite codes using the `age` CLI.

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

Explicit alias for the receive side of `envhelper share`. Decrypts `.env.team.enc` locally into `.env`.

```bash
envhelper commands
```

Show the simplified command directory.

```bash
envhelper providers
envhelper providers --json
```

Show the built-in provider directory in human-readable or JSON form.

## Provider Links

There are too many API providers to hard-code perfectly, so EnvHelper uses a layered provider directory:

1. Built-in curated providers for 51 common services like Stripe, Supabase, Anthropic, OpenAI, Clerk, Resend, Twilio, Firebase, GitHub, Google Maps, AWS, Cloudflare, Vercel, Neon, Pinecone, MongoDB Atlas, Groq, Replicate, Deepgram, Slack, Discord, Plaid, Square, and PayPal.
2. Env var and package-name patterns to infer providers from names like `STRIPE_SECRET_KEY` or dependencies like `stripe`.
3. A Google search URL when EnvHelper cannot identify a provider.

Built-in providers require a `sourceUrl` pointing to official docs or an official dashboard. The provider audit rejects duplicate env vars, generic mappings like `DATABASE_URL`, invalid URLs, and guessed search-result sources.

Provider metadata is intentionally non-secret:

```json
{
  "id": "stripe",
  "name": "Stripe",
  "keyUrl": "https://dashboard.stripe.com/apikeys",
  "docsUrl": "https://docs.stripe.com/keys",
  "sourceUrl": "https://docs.stripe.com/keys",
  "env": ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"],
  "clientSafe": false,
  "validation": {
    "env": ["STRIPE_SECRET_KEY"],
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
