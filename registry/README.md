# STS2 Mod Registry

A community-curated registry of known Slay the Spire 2 mods. This registry is used by the STS2 Mod Manager to discover mods and check for updates.

## Files

- **`registry.json`** — The curated list of known mods with metadata and source links.
- **`latest_versions.json`** — Auto-generated file containing the latest release version for each mod (updated daily by GitHub Actions).

## How to Add a Mod

1. Fork this repository.
2. Edit `registry.json` and add your mod entry to the `mods` array.
3. Submit a Pull Request.

### Mod Entry Schema

Each entry in `registry.json` follows this schema:

| Field         | Type              | Required | Description                                        |
|---------------|-------------------|----------|----------------------------------------------------|
| `name`        | `string`          | Yes      | Display name of the mod                            |
| `description` | `string`          | Yes      | Short description of what the mod does             |
| `github`      | `string \| null`  | Yes      | GitHub repository in `owner/repo` format, or null  |
| `nexus_id`    | `number \| null`  | Yes      | Nexus Mods ID, or null if not on Nexus             |
| `category`    | `string`          | Yes      | One of: `framework`, `qol`, `content`, `cosmetic`, `development`, `other` |
| `tags`        | `string[]`        | Yes      | Array of descriptive tags                          |

### Example Entry

```json
{
  "name": "My Cool Mod",
  "description": "Adds cool features to STS2",
  "github": "myuser/my-cool-mod",
  "nexus_id": null,
  "category": "content",
  "tags": ["gameplay", "cards"]
}
```

## Version Tracking

The `latest_versions.json` file is automatically updated daily by a GitHub Actions workflow. For each mod with a GitHub source, the workflow fetches the latest release tag and records:

| Field          | Type     | Description                              |
|----------------|----------|------------------------------------------|
| `tag`          | `string` | Latest release tag name                  |
| `published_at` | `string` | ISO 8601 timestamp of the release        |
| `download_url` | `string` | URL to the latest release page           |

## Categories

| Category      | Description                                    |
|---------------|------------------------------------------------|
| `framework`   | Core libraries and modding frameworks          |
| `qol`         | Quality of life improvements                   |
| `content`     | New gameplay content (cards, characters, etc.)  |
| `cosmetic`    | Visual or audio modifications                  |
| `development` | Tools and templates for mod developers         |
| `other`       | Everything else                                |
