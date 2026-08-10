# Contributing

`pi-acp-client` is a generic stable-ACP v1 frontend. Keep agent-specific
discovery, domain objects, and transport assumptions out of this repository.

Before opening a pull request, run:

```sh
npm ci
npm run check
npm test
npm run smoke:loader
npm run pack:check
```

Behavior changes should include a fake-agent test. Protocol changes must cite
the corresponding stable ACP v1 schema or documentation; draft ACP surfaces
are out of scope.

Use Conventional Commits and keep executable profile definitions confined to
the trusted global configuration. Project configuration may select a profile
but must never introduce commands or environment variables.
