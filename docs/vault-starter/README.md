# Vault starter templates

Copy the contents of this folder into your Obsidian vault, which should live
**outside this repo** (this repo is public - your notes should not be).

Layout on disk:

```
~/Documents/TristansVault/
├── OPIUMO-/           <- this git repo (public)
└── Tristans Vault/    <- the Obsidian vault (private, never committed)
```

The vault is a **sibling** of the repo, never inside it. Open
`~/Documents/TristansVault/` as the folder in VS Code and Claude Code can
read and write both, with no plugin or MCP server needed.

> **The folder name contains a space.** Quote it in every shell command:
> `ls "../Tristans Vault"`. Unquoted, the path splits into two arguments and
> the vault appears not to exist - `ls: ../Tristans: No such file or
> directory` - which reads like a missing folder rather than a quoting bug.

To set it up:

```bash
# Note the quoting: ~ must stay OUTSIDE the quotes to expand,
# the space must stay INSIDE them.
cp -R ~/Documents/TristansVault/OPIUMO-/docs/vault-starter/ ~/Documents/TristansVault/"Tristans Vault"/
rm ~/Documents/TristansVault/"Tristans Vault"/README.md
```

Then in Obsidian: **Open folder as vault** -> pick
`~/Documents/TristansVault/Tristans Vault`.

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
