# Contributing to free-openai-codex

Thanks for considering a contribution. This project follows a small set of
conventions that keep the codebase stable and the `main` branch
enterprise-auditable.

## Branch model

- **`main`** — protected, signed-commit-only, always green CI. Every commit
  must reach `main` through a fast-forward merge from `dev`.
- **`dev`** — integration branch. PRs target `dev`. CI must pass before
  a merge to `main`.
- **`feature/*`, `fix/*`** — short-lived topic branches off `dev`. Squash or
  rebase before merging.

## Commit signing

All commits on `main` and `dev` are signed. SSH-signing is preferred;
configure it once:

```sh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global gpg.format ssh
git config --global commit.gpgsign true
```

Add the public key to GitHub at Settings → SSH and GPG keys → New SSH key →
key type **Signing Key**. Maintain `~/.ssh/allowed_signers` so local
verification works:

```sh
echo "you@example.com $(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
```

Unsigned commits are rejected on `main`.

## Commit messages

Imperative mood, conventional structure:

```
<short subject — under 70 chars>

<wrapped body, 72 chars per line, explaining the why>

<optional trailers, e.g. Fixes #123>
```

Do **not** add `Co-Authored-By` lines for automated tooling. Keep authorship to
the human who reviewed and approved the change.

## Development loop

```sh
npm install
npm test                 # mechanics + e2e routing (no network, no credits)
node --check proxy.mjs   # syntax check
```

Optional smoke checks against the running proxy:

```sh
npm start &
curl http://127.0.0.1:8080/health
curl -H "Authorization: Bearer $GATEWAY_API_KEY" http://127.0.0.1:8080/v1/models

# Drive Codex CLI through the gateway against a mock upstream:
npm run test:codex
```

## Adding a new provider

No source edits are required — providers are declared in `config.yaml`:

1. Add the provider under `providers:` with `type` (`openai_compatible` or
   `ollama`), `base_url`, `api_key_env`, and optionally `chat_path`,
   `images_path`, `models_path`.
2. Route to it under `routing:` (a `prefixes:` entry, a `patterns:` regex, or a
   `model_aliases:` mapping) and/or `default_provider`.
3. Add a route/translation test in `test/proxy.test.mjs` or
   `test/e2e-routing.test.mjs` modelled on the existing cases.
4. Update `.env.example`, the README provider table, and `CHANGELOG.md`.

## Adding / refreshing models

The catalog lives in `config.yaml` under `model_aliases:` (exact alias →
`{provider, upstream}`) and `static_models:` (extra ids surfaced by
`GET /v1/models`). Aliases are automatically advertised in `/v1/models`, so a
clean id such as `modal-glm-5.1-fp8` is both routable and discoverable in the
Codex Desktop model picker. For one-off overrides, set `CONFIG_PATH` to point at
an alternate `config.yaml`.

## Versioning

Semantic Versioning. Each released change bumps the `package.json` `version` and
the `SERVER_VERSION` constant in `proxy.mjs`; they must stay in sync.

## Pull request checklist

- [ ] CI passes (`npm test`, all syntax checks).
- [ ] `CHANGELOG.md` updated under an `[Unreleased]` (or version-bumped)
      section.
- [ ] README updated if user-visible behaviour changes.
- [ ] No secrets, no `.env` files, no build artefacts in the diff.
- [ ] Commits are signed (run `git log --show-signature -3` to verify).
- [ ] PR description references any issue it fixes.

## Code style

- Vanilla ES modules, no TypeScript, no transpiler.
- No runtime dependencies beyond what's already in `package.json`
  (`dotenv`, `yaml`).
- Use the `node:` prefix on built-in imports.
- Keep `proxy.mjs` flat: small named functions, no classes, no implicit
  globals.
- Prefer early returns over deep conditional nesting.

## License

By submitting a contribution, you agree it will be licensed under the project's
MIT License.
