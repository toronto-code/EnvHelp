# Threat Model

## Goals

EnvHelper aims to prevent common accidental leaks:

- Sending `.env` files in chat.
- Committing plaintext `.env` files.
- Pasting secret keys into READMEs or frontend code.
- Losing time because required environment variables are undocumented.
- Sharing a team `.env` without encryption.

## Non-Goals

EnvHelper cannot prevent every possible secret exposure.

- It cannot stop a trusted teammate from copying a key after decrypting it.
- It cannot protect keys from malware on a user's machine.
- It cannot protect an API key that is already leaked to git history or public logs.
- It is not a hosted vault, secrets manager, or access-control system.
- It is not a replacement for rotating compromised provider keys.

## Trust Boundaries

```txt
User machine
  reads/pastes secrets
  writes .env
  encrypts/decrypts .env.team.enc

Git/chat/cloud storage
  may carry .env.team.enc ciphertext
  must never carry plaintext .env

EnvHelper project
  ships CLI code and non-secret provider metadata
  does not receive user secrets
```

## Primary Risks

### Compromised npm Package

If the published EnvHelper package is compromised, malicious code could read local secrets. This is true for any CLI run on secrets. Prefer pinned versions and review changelogs for serious use.

### Compromised Teammate Identity

If a teammate's `age` private key is stolen, encrypted bundles for that recipient may be decrypted. Rotate upstream API keys and create a fresh encrypted bundle.

### Old Encrypted Bundles in Git

Git keeps old versions. Removing a recipient from the latest bundle does not erase older encrypted bundles from history. Rotate upstream API keys when removing a teammate from a sensitive project.

### False Positives and Misses

The scanner is a guardrail, not a proof. It can miss secrets and it can flag harmless strings. Treat `envhelper doctor` as a safety check, not a complete audit.
