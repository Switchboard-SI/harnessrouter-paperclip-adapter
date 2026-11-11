# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-11

First public release as `@switchboard-si/harnessrouter-paperclip-adapter`.

### Added
- Paperclip `ServerAdapterModule` (type `harnessrouter`) that runs one Paperclip run as one UHP task.
- Conversation continuity through `previous_response_id`, cancellation, usage and error classification.
- Deterministic idempotency keys per run; retries only before the first task event.
- Stored-response recovery when the SSE stream drops.
- `testEnvironment()` probes: UHP discovery, authenticated harness listing, harness existence.
- API key from `apiKey`, `HARNESSROUTER_API_KEY`, or a key file (`apiKeyFile`,
  `HARNESSROUTER_API_KEY_FILE`, `~/.harnessrouter/api-key`).

### Changed
- Requires Node.js 20 or later.
