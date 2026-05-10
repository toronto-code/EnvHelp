# Provider Directory

EnvPack cannot hard-code every API provider. The provider system is layered so the common path is fast while uncommon providers still have a useful fallback.

## Resolution Order

1. Exact environment variable match, such as `OPENAI_API_KEY`.
2. Provider prefix or regex match, such as `^STRIPE_`.
3. Package-name hint, only for generic variable names like `API_KEY`.
4. Fallback search URL for unknown variables.

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
      "envSafety": {
        "MY_PROVIDER_API_KEY": { "clientSafe": false }
      },
      "notes": ["Keep server-side."]
    }
  ]
}
```

This keeps the MVP useful for thousands of services without pretending the built-in list can be complete on day one.
