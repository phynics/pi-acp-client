# pi-acp-client

Generic Pi frontend for stable Agent Client Protocol (ACP) agents.

The extension launches one configured ACP child per Pi runtime, keeps the Pi
transcript as a presentation mirror, and binds each Pi session to one ACP
session. ACP tool/progress updates stay in a transient panel, permission
requests use Pi's interactive selector, and remote tools are never registered
as Pi tools. It contains no Gnostic discovery or workspace-specific logic.

Configured profiles appear as `acp/<profile-id>` models. Use `/acp-status`,
`/acp-profiles`, `/acp-sessions`, `/acp-new`, and `/acp-use`. The latter two
create a new Pi session so an existing transcript is never silently rebound.

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
npm run smoke:loader
npm run pack:check
```

MIT licensed.
