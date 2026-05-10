# Security Policy

EnvHelper is designed around absence: there is no hosted backend that can receive, store, proxy, log, or transmit user secrets.

## Rules

- No hosted backend by default.
- No telemetry containing secret values.
- No crash reports containing process environments.
- No website where users paste API keys.
- No API proxy where requests pass through EnvHelper.
- No custom cryptography.
- Secret values are redacted in terminal output.
- Encryption and decryption happen locally.
- Provider validation sends secrets only to the provider the user selected and only after explicit consent.

## Encryption

Team sharing uses `age`, a small file encryption tool built around modern primitives. EnvHelper shells out to the official `age` CLI with arguments, not through a shell string.

Each teammate has a local identity file:

```txt
~/.envhelper/identity.txt
```

EnvHelper creates this file with owner-only permissions where the OS supports it.

## Committing Encrypted Bundles

Committing `.env.team.enc` can be reasonable because it is encrypted ciphertext. It still has a rotation tradeoff:

> If a teammate's private key is compromised later, old committed encrypted bundles that include that teammate may become readable.

If this happens, rotate the upstream API keys and re-run:

```bash
envhelper share
```

`envhelper rekey` re-encrypts the current local `.env` to a fresh recipient set. It does not rewrite git history or rotate upstream provider keys for you.

## Supply Chain Note

For a tool that handles secrets, repeatedly running an unpinned `npx envhelper` has supply-chain risk. Prefer a pinned version once EnvHelper is published:

```bash
npm install -g envhelper@0.1.0
```

For team projects, document the expected EnvHelper version in your repo.
