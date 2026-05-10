# Security Policy

EnvPack is designed around absence: there is no hosted backend that can receive, store, proxy, log, or transmit user secrets.

## Rules

- No hosted backend by default.
- No telemetry containing secret values.
- No crash reports containing process environments.
- No website where users paste API keys.
- No API proxy where requests pass through EnvPack.
- No custom cryptography.
- Secret values are redacted in terminal output.
- Encryption and decryption happen locally.
- Provider validation, when added, must send secrets only to the provider the user selected and only after explicit consent.

## Encryption

Team sharing uses `age`, a small file encryption tool built around modern primitives. EnvPack shells out to the official `age` CLI with arguments, not through a shell string.

Each teammate has a local identity file:

```txt
~/.envpack/identity.txt
```

EnvPack creates this file with owner-only permissions where the OS supports it.

## Committing Encrypted Bundles

Committing `.env.team.enc` can be reasonable because it is encrypted ciphertext. It still has a rotation tradeoff:

> If a teammate's private key is compromised later, old committed encrypted bundles that include that teammate may become readable.

If this happens, rotate the upstream API keys and re-run:

```bash
envpack share
```

A future `envpack rekey` command should automate re-encryption and rotation guidance.

## Supply Chain Note

For a tool that handles secrets, repeatedly running an unpinned `npx envpack` has supply-chain risk. Prefer a pinned version once EnvPack is published:

```bash
npm install -g envpack@0.1.0
```

For team projects, document the expected EnvPack version in your repo.
