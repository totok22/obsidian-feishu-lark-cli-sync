# Feishu Docs Publisher

English | [简体中文](./README_ZH.md)

Publish Markdown notes, folders, and PDFs from Obsidian to Feishu/Lark Docs through the local `lark-cli`, and keep them in sync.

Obsidian stays the source of truth, and Feishu/Lark is where your team reads and comments. Sync is one-way. After the first publish a note is bound to its document, and later syncs update that document in place.

You need Obsidian 1.13.0 or later (desktop only), a Feishu or Lark account, and Node.js with npm. The plugin installs `lark-cli` for you. Notes are uploaded through `lark-cli`; see [Network & Third-Party Account Disclosures](#network--third-party-account-disclosures).

[Getting started](#getting-started) · [Using the plugin](#using-the-plugin) · [Settings](#settings) · [How sync works](#how-sync-works) · [Troubleshooting](#troubleshooting) · [Migrating](#migrating-from-feishu-lark-cli-sync) · [Contributing](#contributing-and-releases)

---

## Getting started

### 1. Install the plugin

If you used the old "Feishu Lark CLI Sync" plugin, read [Migrating](#migrating-from-feishu-lark-cli-sync) first.

**Community plugins** (once the plugin is listed): open **Settings → Community plugins**, turn off Restricted mode, click **Browse**, search for `Feishu Docs Publisher`, then **Install** and **Enable**.

**From a release**: download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/totok22/feishu-docs-publisher/releases), put them in `<vault>/.obsidian/plugins/feishu-docs-publisher/`, then reload community plugins and enable the plugin. The Git hook scripts are embedded in `main.js`, so nothing else is needed.

**From source**:

```bash
git clone https://github.com/totok22/feishu-docs-publisher.git
cd feishu-docs-publisher
npm install
npm run build
./install.sh "/path/to/your/vault"
```

The script copies the build into the vault's plugin folder, and refreshes the hook helper scripts if this plugin already installed a hook there. Restart Obsidian and enable the plugin.

### 2. Connect your account

Open **Settings → Feishu Docs Publisher → CLI & authorization**. No terminal is needed.

1. If npm is missing, click **Download Node.js**, install it, then click **Check again**.
2. Click **Install lark-cli**. The same button upgrades it later.
3. First time only: under **CLI app configuration**, choose Feishu or Lark, click **Create app**, and finish the flow in your browser.
4. Click **Sign in / reauthorize** and approve the permissions in your browser. To switch accounts, sign out and sign in again.

`lark-cli` must be newer than 1.0.53. Older versions can create documents titled `Untitled` or fail while syncing, and settings offer an upgrade when that happens. If the executable is not detected, enter its absolute path under **lark-cli path**.

Behind a proxy? **Network proxy** inherits `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` by default. You can also enter a custom HTTP proxy (for example `127.0.0.1` and `7890`) or turn proxies off. It only applies to the `lark-cli`, npm, and Git `pre-push` processes this plugin starts, and no proxy credentials are stored.

### 3. Publish your first note

1. Optional: set **Settings → General → Default target** to a Wiki URL, wiki node token, or folder token. Left blank, documents go to your personal library.
2. Right-click a note and choose **Lark: Sync to Feishu/Lark**. The command palette has the same `Sync to Feishu/Lark` for the open note.
3. The new document opens in your browser. Its title is the file name unless you change **Title source**.
4. Edit the note and sync again to update the same document. By default a saved note also syncs on its own after about 15 seconds; see [Auto sync](#auto-sync).

---

## Using the plugin

### Quick reference

Right-click a note, PDF, or folder. Sync, overwrite, open link, published files, and choose files to ignore are also in the command palette.

| I want to… | Do this |
| --- | --- |
| Publish or update a note | Right-click the note → `Lark: Sync to Feishu/Lark` |
| Publish a folder and keep its structure | Right-click the folder → `Lark: Sync to Feishu/Lark` |
| Upload a PDF | Right-click the PDF → `Lark: Sync to Feishu/Lark` |
| Make the remote copy match local and remove same-name duplicates | `Lark: Overwrite sync to Feishu/Lark` |
| Attach a note, PDF, or folder to an existing document | `Lark: Set Feishu/Lark link` |
| Open the Feishu/Lark page of a file | `Lark: Open Feishu/Lark link` |
| Find or copy published links | Paper-plane icon in the left ribbon → **Published files** |
| Keep some files out of a folder sync | Right-click the folder → `Lark: Choose files to ignore` |
| Sync automatically after editing | **Settings → Sync → Auto sync mode** |

### Sync and overwrite

Sync publishes a note the first time and updates it afterwards. Overwrite rewrites the remote copy from the local content and deletes other same-name documents in the same remote folder. Both work on notes, PDFs, and folders.

The first publish binds the note to its document, and the binding is saved in plugin data. If you turn on **Write binding to frontmatter** (off by default; an upgrade keeps your saved choice), the URL is also written into the note:

```yaml
---
lark_doc_url: "https://example.feishu.cn/docx/xxxx"
---
```

A remote file can be bound to only one local file. Setting a link, recovering a binding, and syncing all check this, so fix any shared binding before you sync.

Overwrite works like this:

- It keeps the bound document. With no binding, it picks one existing same-name document, saves the binding, confirms the local content was written, and only then deletes the other same-name documents in that remote folder.
- Normal sync, save-triggered sync, and Git hooks never delete duplicates. A document bound to another local file is never deleted.
- A duplicate wiki document with child pages has its children moved under the kept document first.
- Folder overwrite goes through every Markdown note and PDF and resets folder pages to a sub-page list. If two notes in the same folder produce the same document title, it stops and asks you to rename one.

### Images and videos

Local images and videos are uploaded with the note.

```md
![[diagram.png]]
![[diagram.png|600]]
![[diagram.png|600x400]]
![Architecture](../assets/diagram.png)
![Architecture|600](../assets/diagram.png)
![Architecture|600x400](../assets/diagram.png)
![[clip.mp4]]
![Demo](../assets/clip.mp4)
```

- Images: PNG, JPEG/JPG, GIF, WebP, and BMP. They must be inside the vault. HTTP(S) images go through the normal Markdown import.
- For local images, `|600` sets a width of 600 pixels and preserves the aspect ratio; `|600x400` sets both dimensions. The `×` separator is also accepted. Size suffixes are removed from captions: `![Architecture|600](...)` has the caption “Architecture”.
- Videos: MP4, M4V, MOV, and WebM, shown as inline file previews. Playback depends on the codec and the Feishu/Lark client; H.264/AAC MP4 and MOV have been tested. Remote video URLs and ordinary links are not uploaded. Unchanged videos are reused.
- If only a referenced image or video changes, save-triggered sync and the `pre-push` hook still sync the bound note.

### Callout folding and research colors

Enable **Settings → Content → Native Callout folding** (off by default) to export Callouts as native parent/child blocks. Nested Callouts, code, and local media stay inside their parent. `-` starts folded and `+` starts expanded. Unconverted notes use readable quote titles while the setting is off.

```md
> [!note]- Experiment details
> Parameters
>
> ![[diagram.png|320]]
```

**The first conversion of an existing document rebuilds its body.** The document URL stays, but block comments and deep links may become invalid. Precise sync blocks this conversion. Merge remote edits first, then use Auto sync strategy to migrate. Turning the setting off keeps already converted documents on native sync to avoid flattening them.

Later syncs keep matching leading and trailing top-level subtrees. Editing content inside a Callout replaces its containing top-level subtree. Reader fold changes are preserved; remote content edits stop synchronization. Only the title background is colored, rather than reproducing Obsidian's entire Callout border.

**Research label colors** is a separate switch, also off by default. In native exports it colors bold labels before a colon red on yellow, such as `**Conclusion**: stable results`. Ordinary bold text and code stay unchanged. Native export needs the `docx:document.block:convert` scope, rejects remote images, and stops when a changed range exceeds 1,000 blocks. See [native export details](./docs/native-export.md).

### Sync a folder

Right-click a folder and choose `Lark: Sync to Feishu/Lark`. The plugin creates the matching remote hierarchy, syncs the Markdown notes and PDFs, and rewrites links between notes so they point to the remote documents. Your local notes are not changed.

```md
Detailed design: 02-database.md
[Component design](03-components.md#section)
[[04-api|API design]]
```

In a wiki (`/wiki/...`) or personal library, each folder is a document, and the plugin inserts Feishu/Lark's native sub-page list into it at every level. Feishu/Lark maintains the links in that list. Normal folder sync keeps an existing list and the rest of the page; folder overwrite resets the page to the list. Drive folders (`/drive/folder/...`) are ordinary folders and get no list.

An image that no note embeds would never be uploaded. Folder sync collects these into a generated note named `<folder> images.md`, saved next to the images, and publishes it like any other note. It is refreshed on every folder sync. You can rename it; a hidden comment on its first line is how the plugin recognizes it.

To also clean up files you deleted or moved, turn on **Delete remote files missing locally** (off by default). After a folder sync, the plugin lists the documents and PDFs it published from that folder whose local file is gone, and deletes them once you confirm.

- Only files with a publish record are touched. Documents you made by hand in Feishu/Lark are safe.
- A note moved outside Obsidian is kept while another note still links to the same document. A wiki document that still has child pages is skipped.
- Git history covers the local side. The plugin cannot restore a deleted remote file.

### PDFs

Folder sync uploads PDFs as native files into the matching Drive folders or wiki nodes. You can also right-click a single PDF to upload it. With a blank default target it goes to the Drive root.

Notes can reference PDFs like this:

```md
[[papers/report.pdf]]
![[papers/report.pdf]]
[[report.pdf|Read the report]]
![[report.pdf#page=2]]
[Read the report](papers/report.pdf)
```

After the upload, folder sync rewrites these into native Feishu/Lark file references. Publishing a single note for the first time, manual sync, and save-triggered sync reuse existing PDF bindings. If the PDF is outside the synced folder, upload it first or bind its remote URL.

Ordinary PDF links become native file references with readable aliases, file names, and page numbers. Unpublished or unbound PDFs show a readable explanation and a warning to publish or bind them. Code examples stay unchanged. Duplicate file names resolve the way Obsidian links do; exact text-selection navigation is not retained.

Page embeds and PDF++ region embeds render as images with page captions and requested dimensions. Examples: `![[report.pdf#page=2|600]]` and `![[report.pdf#page=2&rect=10,20,110,70|300]]`. Obsidian uses its bundled PDF.js. Git hooks require Poppler (`pdfinfo` and `pdftoppm`); publish rotated pages from Obsidian. Source PDFs remain unchanged.

- Unchanged PDFs are skipped, based on the binding and a content hash. A changed PDF overwrites the same remote file, so its link stays valid. Renaming a PDF locally keeps the binding and the remote name.
- PDFs update through manual sync and folder sync only, not through save-triggered sync or Git hooks.
- Overwrite re-uploads even an unchanged PDF. Without a binding it first reuses a same-name file, and after a successful upload it removes other same-name PDFs in that remote folder.
- Git hooks rewrite references written with a vault path or a path relative to the note. A bare file name in another folder needs Obsidian's resolver, so write the path when you rely on a hook.

If an upload times out, the plugin keeps a pending record and does not retry on its own. Check the existing remote file in `Lark: Set Feishu/Lark link` before trying again. If no remote file was created, disconnect the pending record and upload again.

### Ignore files and folders

To keep notes, PDFs, or subfolders out of Feishu/Lark, open the **Sync ignore** page: right-click the folder and choose `Lark: Choose files to ignore`. It is also reachable from the **Published files** window, the command palette, and **Settings → Sync → Sync ignore**.

The page shows the folder as a tree. Uncheck an item to ignore it and check it again to sync it. Unchecking a folder ignores everything inside, including files added later, and a folder with some items unchecked shows a partial mark. `Edit rules file` shows the raw text, `Change folder` switches folder, and `Clear rules` empties the current folder's rules.

The choices are saved in a `.feishuignore` file in that folder, and you can also write it by hand. The syntax is the same as `.gitignore`: one pattern per line, `*` and `**` wildcards, a trailing `/` for folders, `!` to bring something back, and `#` for comments. Patterns are relative to the file's folder. A deeper file overrides a higher one, and a `.feishuignore` in the vault root applies everywhere. It is a normal file, so you can commit it or copy it to another vault.

```gitignore
# Projects/Alpha/.feishuignore
/Drafts/
*.draft.md
!/Drafts/keep.md
```

Ignored items are skipped by folder sync, save-triggered sync, and the `pre-push` hook. What is already in Feishu/Lark stays, and an image embedded only by an ignored note is not uploaded. Syncing a single note by hand still works. If a `.feishuignore` cannot be read, sync stops instead of publishing without it. Obsidian hides dotfiles, so edit the file from this page or an external editor.

### Auto sync

Auto sync updates notes that are already bound and never publishes new ones. Publish a note once by hand, then pick a mode under **Settings → Sync → Auto sync mode**.

| Mode | When it syncs | Notes |
| --- | --- | --- |
| `Off` | Only when you sync by hand | |
| `Sync after save` (default) | About 15 seconds after you save a bound note (**Save sync delay**) | Obsidian must be running. Edits from another editor count while Obsidian has the vault open. |
| `Git pre-push hook` | Before each `git push` | The vault must be a Git repository, and you install the hook under **Settings → Git Hook**. Obsidian does not need to be running. If the sync fails, the push is blocked. |

Auto sync covers Markdown notes and the images and videos they reference. PDFs need manual or folder sync. Ignored items are skipped.

### Published files

Click the paper-plane icon in the left ribbon, or run `Published files` from the command palette. Each row shows the file name and local path. **Open in Feishu** opens the remote file. **More** offers copy link, open local file, sync, set link, and remove saved link (both the local and the remote file are kept).

Removing a folder link also removes saved links for all its subfolders, notes, and PDFs, and clears the notes' incremental sync cache. Descendant records left behind by older folder removals are cleaned up when the plugin loads. Source frontmatter is kept, and its old links do not automatically restore bindings.

Older versions did not record links when frontmatter was off. **Find existing links** matches note file names against the linked Feishu/Lark folders and never creates files. If several files match, set the link by hand.

---

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `Language` | Language of settings, menus, and notices (中文 or English) | 中文 |
| `Default target` | Where new documents go: Wiki URL, wiki node token, or folder token. Blank means your personal library | Blank |
| CLI & authorization | Install or upgrade `lark-cli`, create the CLI app, sign in or out, set the path. See [step 2](#2-connect-your-account) | |
| `Network proxy` | System environment, custom HTTP proxy, or no proxy | System environment |
| `Title source` | First Markdown heading or file name | File name |
| `Native Callout folding` | Export real folded parent/child blocks. First conversion rebuilds existing content; converted documents keep native sync when disabled | Off |
| `Research label colors` | Color bold labels before a colon red on yellow in native exports | Off |
| `Write binding to frontmatter` | Also store the URL as `lark_doc_url`. The binding in plugin data is kept either way | Off |
| `Open after sync` | Open the document in your browser after publish or sync | On |
| `Sync strategy` | `Auto (recommended)`: small edits update only the changed blocks, large or complex ones fall back to a full overwrite. `Safe precise sync`: never overwrites, reports an error instead. `Overwrite sync`: rewrites the remote document every time | Auto |
| `Auto sync mode` | `Off`, `Sync after save`, or `Git pre-push hook`. See [Auto sync](#auto-sync) | Sync after save |
| `Save sync delay` | Seconds to wait after a save, so continuous edits become one sync | 15 |
| `Sync ignore` | Opens the [Sync ignore](#ignore-files-and-folders) page | |
| `Delete remote files missing locally` | Offer to delete remote files whose local file is gone, after a folder sync | Off |
| `Sync state cache` | How many document states are kept for incremental sync | 100 |
| `Install hook` | Installs the `pre-push` hook into the vault's `.git/hooks` | |

---

## How sync works

The plugin splits Markdown into top-level blocks and records their Feishu/Lark block ids. Later syncs update only the blocks that changed, such as a replaced, inserted, or deleted paragraph, so Feishu/Lark keeps the matching history. The whole document is rewritten only on overwrite, or when the Auto strategy judges a change too large or too complex.

![Remote history](./docs/images/lark-history.png)

Local Markdown is the source. If someone edits the remote document, merge those edits into the Markdown first, or a later sync can replace them.

The plugin keeps its data in `.obsidian/plugins/feishu-docs-publisher/`. `data.json` holds settings, bindings, native export state, and pending records, and is not affected by cache trimming. `lark-sync-state.json` holds the incremental sync state.

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| New documents are titled `Untitled`, or sync fails right away | `lark-cli` is too old. Upgrade it in **Settings → CLI & authorization**. |
| `lark-cli` is not found | Click **Check again**, or enter the absolute path under **lark-cli path**. Without npm, install Node.js first. |
| Installing or syncing cannot connect | Check **Network proxy**. |
| "Default upload target is invalid or inaccessible" | **Default target** must be a Wiki URL, wiki node token, or folder token your account can open. |
| Auto sync does nothing | The note must be published first. Also check that **Auto sync mode** is not `Off`, that Obsidian is running in save mode, and that `.feishuignore` does not skip the note. |
| `git push` is blocked | The `pre-push` sync failed. Fix the error it reports, or switch **Auto sync mode** to another option. |

---

## Migrating from Feishu Lark CLI Sync

The plugin ID changed from `feishu-lark-cli-sync` to `feishu-docs-publisher`, so Obsidian uses a new data folder. On desktop startup, if `.obsidian/plugins/feishu-docs-publisher/data.json` does not exist yet, the plugin copies `data.json` and `lark-sync-state.json` from `.obsidian/plugins/feishu-lark-cli-sync/` when they exist. The old folder is left untouched.

1. Enable this plugin and disable the archived one, so the two do not sync the same notes.
2. If you use the `pre-push` hook, open Obsidian once. That refreshes the hook scripts when this plugin or its predecessor installed the hook. If **Git Hook** does not show as installed, install it again. The hook reads the new folder when it has a `data.json`, and falls back to the old folder otherwise.

To copy the files before opening Obsidian:

```bash
mkdir -p "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher"
cp "/path/to/your/vault/.obsidian/plugins/feishu-lark-cli-sync/data.json" \
  "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher/data.json"
cp "/path/to/your/vault/.obsidian/plugins/feishu-lark-cli-sync/lark-sync-state.json" \
  "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher/lark-sync-state.json"
```

Skip a file that does not exist. A file already in the new folder is not overwritten.

---

## Network & Third-Party Account Disclosures

- **Third-Party Account**: Sync requires a Feishu or Lark account. Sign-in, sign-out, and reauthorization are available in the plugin's **CLI & authorization** settings. The plugin calls the local [`lark-cli`](https://github.com/larksuite/cli) and does not collect app secrets.
- **Network Access**: Installing or upgrading `lark-cli` runs the local npm client against the npm Registry, and the `@larksuite/cli` installer downloads the matching official program. Publish, sync, overwrite, link lookup, and version checks run `lark-cli`, which sends HTTPS requests to the official Feishu/Lark Open APIs (`open.feishu.cn` for Feishu accounts, `open.larksuite.com` for Lark accounts). Requests run when you sync or publish, and also from save-triggered sync and the Git `pre-push` hook when those modes are enabled. There is no separate telemetry channel.
- **Credential Storage**: Login credentials stay in the local `lark-cli` auth store. This plugin does not write app secrets or access tokens into notes, `data.json`, or logs. Document URLs and bindings are stored in plugin data, and also in note frontmatter when that setting is enabled.

---

## Origin & Credits

Forked from [wanghuan9/obsidian-feishu-lark-cli-sync](https://github.com/wanghuan9/obsidian-feishu-lark-cli-sync) by huan.wang (wanghuan) under the MIT License. The original repository and the author's GitHub account are no longer available, and the original "Feishu Lark CLI Sync" plugin was archived in the Obsidian community directory. This project continues from 0.1.26 under the new plugin ID `feishu-docs-publisher`, maintained by [totok22](https://github.com/totok22), with published-link management, PDF sync and dedup, and related sync fixes added. It is not officially affiliated with the original author, and it is unrelated to [zktww/feishu-lark-sync](https://github.com/zktww/feishu-lark-sync) ("Feishu Lark Sync"), an independent codebase. The original copyright is retained in `LICENSE`.

---

## Contributing and releases

```bash
npm install
npm test
npm run build
```

`npm test` typechecks and runs the tests. `npm run build` writes `main.js`, which is gitignored. `npm run check` runs both.

Release history is in [CHANGELOG.md](./CHANGELOG.md), and each GitHub release uses the matching file in [`release-notes/`](./release-notes/). To publish a release:

1. Add the version to `CHANGELOG.md` and create `release-notes/<version>.md`, starting with `# <version>`.
2. Run `npm version <version> --no-git-tag-version`. It updates `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.
3. Run `npm run check` and `npm run release:check`.
4. Commit and push, then push a tag that matches the version exactly, with no `v` prefix, for example `0.3.0`.
5. `.github/workflows/release.yml` verifies the tag and notes, runs the tests and production build, attests the three plugin assets, and opens a draft release. Review it and publish.

You can also dispatch the release workflow manually in GitHub Actions with an existing tag. Version and release-note checks still apply, and the workflow creates a draft release.

Native Callouts, PDF crops, and research colors are adapted from [HeShiLie’s fork](https://github.com/HeShiLie/feishu-docs-publisher), with opt-in settings and video compatibility added here.

## License

MIT License. Copyright (c) 2026 huan.wang, totok22, and HeShiLie. See `LICENSE`.
