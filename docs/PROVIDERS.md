# Provider Directory

EnvHelper cannot hard-code every API provider. The provider system is layered so the common path is fast while uncommon providers still have a useful fallback.

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
```

Known providers resolve to their key page. Unknown variables resolve to a Google search for that env var plus "API key env var".

## Validation

Provider validation is optional. If a provider has a validator, EnvHelper asks for consent before sending a value directly from the user's machine to that provider.

Validation can be:

- `url`: local URL parsing, no network request.
- `format`: local regex check, no network request.
- `http`: provider API request, with the secret sent only to that provider.

## Local Overrides

Projects can add `.envhelper.providers.json` to define custom providers or override built-in links.

```json
{
  "providers": [
    {
      "id": "my-provider",
      "name": "My Provider",
      "keyUrl": "https://example.com/dashboard/api-keys",
      "docsUrl": "https://example.com/docs",
      "env": ["MY_PROVIDER_API_KEY"],
      "envPatterns": ["^MY_PROVIDER_"],
      "packages": ["my-provider-sdk"],
      "clientSafe": false,
      "validation": {
        "type": "http",
        "method": "GET",
        "url": "https://example.com/v1/me",
        "headers": {
          "Authorization": "Bearer {value}"
        },
        "okStatus": [200],
        "success": "My Provider accepted the key."
      },
      "envSafety": {
        "MY_PROVIDER_API_KEY": { "clientSafe": false }
      },
      "notes": ["Keep server-side."]
    }
  ]
}
```

This keeps the MVP useful for thousands of services without pretending the built-in list can be complete on day one.
