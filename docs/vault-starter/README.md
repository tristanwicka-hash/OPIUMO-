# Vault starter templates

Copy the contents of this folder into your Obsidian vault, which should live
**outside this repo** (this repo is public - your notes should not be).

Recommended layout on disk:

```
~/Desktop/opiumo/
├── bot/      <- this git repo (public)
└── vault/    <- your Obsidian vault (private, never committed)
```

Open `~/Desktop/opiumo/` as the folder in VS Code and Claude Code can read
and write both, with no plugin or MCP server needed.

To set it up:

```bash
cp -R ~/Desktop/opiumo/bot/docs/vault-starter/ ~/Desktop/opiumo/vault/
rm ~/Desktop/opiumo/vault/README.md
```

Then in Obsidian: **Open folder as vault** -> pick `~/Desktop/opiumo/vault`.

## What goes where

| Folder | What belongs in it |
|---|---|
| `00-Index.md` | Map of Content. The front door - links to everything else. |
| `01-Project/` | Decisions and their reasoning. Config reference. |
| `02-Strategy/` | The strategy specs and why each threshold is what it is. |
| `03-Journal/` | One note per session/day the bot runs. The feedback loop. |
| `04-Research/` | Competitor findings, technical research, links. |
| `05-Sessions/` | Handoff notes so a fresh Claude Code session has context. |

Keep notes short and linked (`[[Like This]]`) rather than long and nested.
Folders answer "where does this live", links and tags answer "what is this
about".
