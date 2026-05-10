# Provider Directory

EnvPack cannot hard-code every API provider. The provider system is layered so the common path is fast while uncommon providers still have a useful fallback.

## Resolution Order

1. Exact environment variable match, such as `OPENAI_API_KEY`.
2. Provider prefix or regex match, such as `^STRIPE_`.
3. Package-name hint, only for generic variable names like `API_KEY`.
4. Fallback search URL for unknown variables.

## Validation

Provider validation is optional. If a provider has a validator, EnvPack asks for consent before sending a value directly from the user's machine to that provider.

Validation can be:

- `url`: local URL parsing, no network request.
- `format`: local regex check, no network request.
- `http`: provider API request, with the secret sent only to that provider.

## Local Overrides

Projects can add `.envpack.providers.json` to define custom providers or override built-in links.

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
