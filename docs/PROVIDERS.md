# Provider Directory

EnvHelper cannot hard-code every API provider. The provider system is layered so the common path is fast while uncommon providers still get a useful Google search fallback.

## Resolution Order

1. Exact environment variable match, such as `STRIPE_SECRET_KEY`.
2. Provider prefix or regex match, such as `^STRIPE_`.
3. Package-name hint, only for generic variable names like `API_KEY`.
4. Google search URL for unknown variables.

## Links

EnvHelper prints terminal-clickable links where supported. If the terminal does not support hyperlinks, EnvHelper prints the raw URL.

```bash
envhelper link stripe
envhelper link ACME_API_KEY --copy
envhelper link ACME_API_KEY --open
envhelper providers --json
```

Known providers resolve to their key page. Unknown variables resolve to a Google search for that env var plus "API key env var".

## Source Policy

Built-in provider links must be source-backed. Every provider entry needs a `sourceUrl` pointing to official docs or an official dashboard, and `npm run providers:audit` enforces the basics:

- no guessed `example.com` or search-result sources,
- no duplicate exact env var mappings,
- no generic exact mappings like `DATABASE_URL`,
- valid HTTPS URLs,
- valid env var names and regex patterns.

When EnvHelper does not know a provider, it should not pretend. It prints a Google search URL instead.

## Validation

Provider validation is optional. If a provider has a validator, EnvHelper asks for consent before sending a value directly from the user's machine to that provider.

Validation can be:

- `url`: local URL parsing, no network request.
- `format`: local regex check, no network request.
- `http`: provider API request, with the secret sent only to that provider.

HTTP validators must be scoped to exact env vars with `validation.env`, so a public key is never checked against a secret-key endpoint.

## Adding Providers

Add providers by editing `providers/providers.json` and running:

```bash
npm run providers:audit
```

Prefer official documentation URLs over unauthenticated dashboards when the dashboard path may vary by account or organization.
