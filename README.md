# MeshCentral SSB Config Plugin

MeshCentral plugin scaffold for editing a schema-governed config file and committing both config and uploaded assets directly to GitHub.

## What this scaffold does

- Loads config from:
  - repo: `os2borgerpc/sikker-selvbetjening-config`
  - file: `config/config.json`
- Loads schema and ui schema from:
  - repo: `os2borgerpc/sikker-selvbetjening`
  - paths:
    - `schemas/system_files/usr/share/sikker-selvbetjening/schemas/schema.json`
- Renders a form from JSON Schema via RJSF.
- Does not validate while editing.
- Validates only when Save is pressed.
- Maps config domains to MeshCentral domains on save.
- Stores assets per MeshCentral domain at `assets/<domain>/...`.
- Commits config and assets to GitHub in a single commit.
- Stores nothing in MeshCentral DB.

## Files

- `config.json` - MeshCentral plugin manifest
- `ssbconfig.js` - plugin backend + GitHub commit logic
- `views/admin.handlebars` - admin UI shell for the RJSF bundle

## Setup

1. Place plugin into your MeshCentral plugins folder.
2. Install optional YAML dependency if your config file is YAML:
   - `npm install`
3. Set plugin settings in MeshCentral config (recommended) or env vars.

Example MeshCentral settings snippet:

```json
{
  "settings": {
    "plugins": {
      "ssbconfig": {
        "githubToken": "<token>",
        "configRepoOwner": "os2borgerpc",
        "configRepoName": "sikker-selvbetjening-config",
        "configFilePath": "config/config.json",
        "schemaRepoOwner": "os2borgerpc",
        "schemaRepoName": "sikker-selvbetjening",
        "schemaPath": "schemas/system_files/usr/share/sikker-selvbetjening/schemas/schema.json",
        "targetBranch": "main"
      }
    }
  }
}
```

Environment variable fallback:

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `SSB_SCHEMA_GITHUB_OWNER`
- `SSB_SCHEMA_GITHUB_REPO`

## Notes

- Only full MeshCentral admins can access the panel in this scaffold.
- Save creates one commit with config + all selected assets.
- Asset paths are normalized and protected against path traversal.
- Uploaded assets are committed below `assets/<selected-mesh-domain>/`.
