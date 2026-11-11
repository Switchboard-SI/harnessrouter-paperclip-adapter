# Contributing

Thanks for helping. This adapter is deliberately small: it translates Paperclip's adapter contract
to HarnessRouter's Unified Harness Protocol (UHP) and nothing more, so it stays easy to audit.

## Getting started

```bash
git clone https://github.com/Switchboard-SI/harnessrouter-paperclip-adapter.git
cd harnessrouter-paperclip-adapter
npm install
npm test          # no network or Docker needed
npm run typecheck
npm run build
```

Node.js 20 or later.

## Making a change

1. Open an issue first for anything beyond a small fix, so we can agree on the approach.
2. Branch from `main` and keep the pull request focused on one change.
3. Add or update tests in `test/`. Tests drive the real `harnessrouterjs` client against the
   in-process UHP server in `test/mock-uhp.ts`; prefer extending it over mocking HTTP.
4. Run `npm run typecheck && npm test && npm run build` before pushing. CI runs the same on
   Node 20, 22 and 24.
5. Update `README.md` when behaviour or configuration changes, and add a line under
   "Unreleased" in `CHANGELOG.md`.

## Design rules

- Never log secrets or tool-call arguments.
- A failed request is not a failed task: never retry once any task event has been seen.
- Keep the mapping to what UHP and Paperclip actually guarantee; don't invent fields.

## Live testing (optional)

With a HarnessRouter instance and an API key, `npm run smoke -- <harnessId>` runs discovery,
`testEnvironment()` and one real task. See the README.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0.
