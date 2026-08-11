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

## Installation

After the first release is published:

```sh
pi install npm:@phynics/pi-acp-client
```

Until then, install the current repository version:

```sh
pi install git:github.com/phynics/pi-acp-client
```

## Configuration

Create `~/.pi/agent/acp-profiles.json`:

```json
{
  "version": 1,
  "profiles": [],
  "sources": [
    { "command": "gnostic", "args": ["acp", "profiles", "--json"] }
  ]
}
```

`PI_ACP_CONFIG` selects another trusted global file and `PI_ACP_PROFILE`
selects a profile. A project `.pi/acp.json` can select a profile but cannot
define executable commands. ACP sessions are resumed with `session/resume` and
never loaded as Pi context. Source profiles replace static profiles with the
same ID; two dynamic sources emitting the same ID are rejected.

## Development

```sh
npm test
npm run check
npm run smoke:loader
npm run pack:check
```

MIT licensed.
