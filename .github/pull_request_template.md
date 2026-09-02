## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## How it was verified

<!-- Tests added? Ran against a real truck? Forced a sweep and watched the board? -->

- [ ] `npm run typecheck` clean
- [ ] `npm test` passing
- [ ] New/changed scheduling behaviour has a test covering it
- [ ] If a board changed: `GET /admin/verify` run and clean
- [ ] No secrets, tokens or auth codes in the diff

## Anything a reviewer should be careful about

<!-- Especially: does this touch the engine's purity, the claim-before-create
     ordering, the odometer trust rules, or the webhook ack path? Those are
     load-bearing — see CONTRIBUTING.md. Delete this section if not. -->
