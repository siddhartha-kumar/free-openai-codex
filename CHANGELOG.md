# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Single-file architecture.** The gateway is now one flat `proxy.mjs` at the
  repository root (small named functions, no classes), mirroring the maintainer's
  `claude-universal-custom-proxy` layout. The previous modular `src/` tree was
  collapsed.
- **`.env` loading via `dotenv`.** Replaced the bespoke dotenv parser with the
  `dotenv` package. `config.yaml` is still parsed with `yaml`.

### Added

- **Modal provider** (`https://api.us-west-2.modal.direct/v1`) with the
  `modal-glm-5.1-fp8` alias (upstream `zai-org/GLM-5.1-FP8`).
- **`start.sh`** POSIX launcher (`start`/`stop`/`restart`/`status`/`foreground`)
  with PID and log files, plus `scripts/ensure-node.sh` for Node bootstrap.
- **`.gitattributes`** enforcing LF line endings across the tree.
- Richer CI: JSON validation, shell-script syntax checks (`sh -n`), and
  `node --check` alongside the test run.
- `CONTRIBUTING.md` (branch model, signed commits, code style) and a threat-model
  `SECURITY.md`.

## [0.1.0] — 2026-05-23

### Added

- OpenAI-compatible HTTP gateway for Codex CLI and Codex Desktop exposing
  `/health`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and
  `/v1/images/generations`.
- Declarative `config.yaml`: providers, prefix/regex/alias routing, a static
  model catalog, and a 190+ entry alias catalog (Ollama Cloud, Hugging Face
  Router, NVIDIA NIM).
- Responses API ⇄ Chat Completions translation (Codex uses `wire_api =
  "responses"`), including SSE serialization.
- Local Ollama translation between OpenAI chat and the native `/api/chat` API.
- Streaming pass-through for OpenAI-compatible upstreams.
- Node test runner coverage for routing, translation, and full-gateway behaviour,
  plus a Codex CLI end-to-end script (`npm run test:codex`).

[Unreleased]: https://github.com/Siddhartha-Kumar/free-openai-codex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Siddhartha-Kumar/free-openai-codex/releases/tag/v0.1.0
