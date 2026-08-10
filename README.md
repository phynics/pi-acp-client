# pi-acp-client

Generic Pi frontend for stable Agent Client Protocol (ACP) agents.

The extension launches one configured ACP child per Pi runtime, keeps the Pi
transcript as a presentation mirror, and binds each Pi session to one ACP
session. It contains no Gnostic discovery or workspace-specific logic.

## Configuration

Create `~/.pi/agent/acp-profiles.json`:

```json
{
  "version": 1,
  "defaultProfile": "gnostic-local",
  "profiles": [
    {
      "id": "gnostic-local",
      "name": "Gnostic Ascendant",
      "command": "gnostic",
      "args": ["acp", "--ascendant", "<uuid>"],
      "env": {}
    }
  ],
  "sources": [
    { "command": "gnostic", "args": ["acp", "profiles", "--json"] }
  ]
}
```

`PI_ACP_CONFIG` selects another trusted global file and `PI_ACP_PROFILE`
selects a profile. A project `.pi/acp.json` can select a profile but cannot
define executable commands. ACP sessions are resumed with `session/resume` and
never loaded as Pi context.

## Development

```sh
npm test
npm run check
npm run pack:check
```

MIT licensed.
