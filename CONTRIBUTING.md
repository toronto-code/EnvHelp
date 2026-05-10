# Contributing

EnvHelper is intentionally small: local setup, provider links, encrypted `.env` sharing, and repo hygiene checks.

## Provider Links

Provider entries live in `providers/providers.json`.

Rules:

- Use official docs or official dashboard URLs only.
- Add a `sourceUrl` for every provider.
- Prefer documentation pages when dashboard routes are account-specific.
- Do not map generic names like `DATABASE_URL` to one provider.
- Mark client-safe values explicitly in `envSafety`.
- Add notes for values that are commonly confused, such as publishable keys versus secret keys.

Run:

```bash
npm run providers:audit
```

## Security

Do not add a hosted backend, telemetry, crash-report uploads, or custom cryptography. See `SECURITY.md` and `THREAT_MODEL.md` before changing secret-handling behavior.
