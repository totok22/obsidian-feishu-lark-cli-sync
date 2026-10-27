import assert from "node:assert/strict";
import esbuild from "esbuild";

// A small native-control DOM model: no Obsidian runtime or browser dependency.
const stub = `
export class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attributes = {}; this.classes = new Set(); this.textContent = ''; }
  createEl(tag, options = {}) { const el = new Element(tag); el.textContent = options.text || ''; if (options.cls) el.addClass(options.cls); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  empty() { this.children = []; this.textContent = ''; }
  setText(text) { this.textContent = text; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addClass(value) { this.classes.add(value); }
  toggleClass(value, enabled) { if (enabled) this.classes.add(value); else this.classes.delete(value); }
  focus() { globalThis.__ui.focused = this; }
}
export class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.contentEl = new Element(); this.titleEl = new Element(); }
  open() { globalThis.__ui.modals.push(this); this.onOpen(); }
  close() { this.closed = true; this.onClose(); }
}
export class ButtonComponent {
  constructor(parent) { this.buttonEl = parent.createEl('button'); }
  setButtonText(value) { this.buttonEl.setText(value); return this; }
  setDisabled(value) { this.buttonEl.disabled = value; return this; }
  setIcon(value) { this.icon = value; return this; }
  setTooltip(value) { this.tooltip = value; return this; }
  setDestructive() { this.warning = true; return this; }
  setCta() { return this; }
  onClick(callback) { this.callback = callback; return this; }
  // Native buttons support Enter/Space without custom keyboard listeners.
  activate(key = 'Enter') { if (!this.buttonEl.disabled && ['Enter', ' '].includes(key)) this.callback(); }
}
export class Menu {
  constructor() { this.items = []; }
  addSeparator() { return this; }
  addItem(callback) {
    const item = { buttonEl: { tag: 'menuitem' },
      setTitle(value) { this.buttonEl.textContent = value; return this; },
      setIcon() { return this; },
      setDisabled(value) { this.buttonEl.disabled = value; return this; },
      onClick(callback) { this.callback = callback; return this; },
      activate() { if (!this.buttonEl.disabled) this.callback(); }
    };
    callback(item); this.items.push(item); return this;
  }
  showAtMouseEvent() { globalThis.__ui.menu = this; }
}
export class TextComponent {
  constructor(parent) { this.inputEl = parent.createEl('input'); }
  setValue(value) { this.inputEl.value = value; return this; }
  setPlaceholder(value) { this.inputEl.placeholder = value; return this; }
  onChange(callback) { this.callback = callback; return this; }
  type(value) { this.inputEl.value = value; this.callback(value); }
}
export class Setting {
  constructor(parent) { this.settingEl = parent.createDiv(); this.nameEl = this.settingEl.createDiv(); this.descEl = this.settingEl.createDiv(); this.buttons = []; globalThis.__ui.settings.push(this); }
  setName(value) { this.nameEl.setText(value); return this; }
  setDesc(value) { this.descEl.setText(value); return this; }
  addButton(callback) { const button = new ButtonComponent(this.settingEl); this.buttons.push(button); callback(button); return this; }
  addSearch(callback) { this.search = new TextComponent(this.settingEl); callback(this.search); return this; }
  addText(callback) { this.text = new TextComponent(this.settingEl); callback(this.text); return this; }
}
`;

const build = await esbuild.build({
	bundle: true, entryPoints: ["src/published-links.ts"], write: false,
	format: "esm", platform: "node", target: "node20",
	plugins: [{ name: "published-links-obsidian-stub", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
		builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub }));
	} }]
});
const { filterPublishedLinks, collapseNestedFolderEntries, PublishedLinksModal, PublishedLinkBindingModal } = await import(
	`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}`
);
globalThis.__ui = { settings: [], modals: [], focused: undefined };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const rows = (modal) => globalThis.__ui.settings.filter((setting) => modal.listEl.children.includes(setting.settingEl));
const action = (setting, label) => {
	let button = setting.buttons.find((control) => control.buttonEl.textContent === label);
  if (!button) {
    const more = setting.buttons.find((control) => control.icon === 'ellipsis');
    more?.activate();
    button = globalThis.__ui.menu?.items.find((item) => item.buttonEl.textContent === label);
  }
	assert.ok(button, `Missing button: ${label}`);
	assert.ok(["button", "menuitem"].includes(button.buttonEl.tag), "Actions use native buttons or menus");
	return button;
};
const entries = [
	{ id: "folder", kind: "folder", path: "docs", url: "https://example.com/wiki/folder" },
	{ id: "md", kind: "markdown", path: "docs/Alpha.md", name: "Alpha", url: "https://example.com/docx/alpha", token: "abc123" },
	{ id: "nested-folder", kind: "folder", path: "docs/nested", url: "https://example.com/wiki/nested" },
	{ id: "pdf", kind: "pdf", path: "docs/nested/manual.pdf", url: "" },
	{ id: "sibling", kind: "markdown", path: "docs-old/other.md", url: "https://example.com/docx/other" },
	{ id: "outside", kind: "markdown", path: "other/Outside.md", url: "https://example.com/docx/outside" }
];
const scopedEntries = filterPublishedLinks(entries, "", "/docs/");
assert.deepEqual(scopedEntries.map((entry) => entry.id), ["folder", "md", "nested-folder", "pdf"]);
assert.deepEqual(collapseNestedFolderEntries(scopedEntries).map((entry) => entry.id), ["folder"]);
assert.deepEqual(collapseNestedFolderEntries(filterPublishedLinks(entries)).map((entry) => entry.id), ["folder", "sibling", "outside"]);
assert.deepEqual(filterPublishedLinks(entries, "ALPHA abc123", "docs").map((entry) => entry.id), ["md"]);
assert.deepEqual(filterPublishedLinks(entries, "manual", "docs\\nested").map((entry) => entry.id), ["pdf"]);

let saved;
let removed = 0;
let refreshed = 0;
const host = {
	getLanguage: () => "en",
	listEntries: () => { refreshed += 1; return entries; },
	saveBindingUrl: (_entry, url) => {
		if (!url.startsWith("https://example.com/")) throw new Error("Host rejected the binding URL");
		saved = url;
	},
	removeBinding: () => { removed += 1; },
	copyUrl: () => { throw new Error("Clipboard permission denied"); }
};
const modal = new PublishedLinksModal({}, host, "docs");
modal.open();
await flush();
assert.equal(modal.titleEl.textContent, "Published files");
assert.equal(rows(modal).length, 1, "The unfiltered list keeps only the outermost folder");
assert.ok(rows(modal).every(row => row.buttons.length === 2), "Each row has open and more controls only");
assert.equal(rows(modal)[0].buttons[1].buttonEl.attributes["aria-haspopup"], "menu");
assert.equal(modal.countEl.textContent, "1 items");
const toolbarFor = (target) => globalThis.__ui.settings.find((setting) => target.contentEl.children.includes(setting.settingEl) && setting.nameEl.textContent === "Folder");
assert.equal(toolbarFor(modal).buttons.length, 1, "Recovery is hidden when the host does not provide it");
const search = globalThis.__ui.settings.find((setting) => setting.search).search;
assert.equal(search.inputEl.attributes["aria-label"], "Search files or links");
search.inputEl.focus();
search.type("ABC123");
assert.equal(rows(modal).length, 1);
assert.equal(globalThis.__ui.focused, search.inputEl, "Search preserves focus while updating results");
const copy = action(rows(modal)[0], "Copy link");
copy.activate(" ");
await flush();
assert.equal(modal.feedbackEl.textContent, "Clipboard permission denied");
assert.ok(modal.feedbackEl.classes.has("is-error"));
assert.equal(copy.buttonEl.disabled, false, "Failed actions become retryable");
search.type("absent");
assert.equal(modal.listEl.children[0].textContent, "No matching files.");
search.type("manual");
assert.equal(action(rows(modal)[0], "Open in Feishu").buttonEl.disabled, true);
assert.equal(action(rows(modal)[0], "Copy link").buttonEl.disabled, true);

// Edit is also available for an unbound PDF; host errors preserve input and focus.
action(rows(modal)[0], "Set link").activate();
await flush();
const editor = globalThis.__ui.modals.at(-1);
assert.ok(editor instanceof PublishedLinkBindingModal);
const editorSettings = globalThis.__ui.settings.filter((setting) => editor.contentEl.children.includes(setting.settingEl));
const urlInput = editorSettings.find((setting) => setting.text).text;
assert.equal(globalThis.__ui.focused, urlInput.inputEl);
assert.equal(urlInput.inputEl.attributes["aria-label"], "Feishu/Lark link");
assert.equal(urlInput.inputEl.attributes["aria-describedby"], editor.feedbackEl.id);
urlInput.type("invalid-url");
const save = action(editorSettings.at(-1), "Save");
save.activate();
await flush();
assert.equal(editor.closed, undefined);
assert.equal(editor.feedbackEl.textContent, "Host rejected the binding URL");
assert.equal(urlInput.inputEl.value, "invalid-url");
assert.equal(urlInput.inputEl.attributes["aria-invalid"], "true");
assert.equal(globalThis.__ui.focused, urlInput.inputEl, "Validation errors return focus to the URL field");
assert.equal(save.buttonEl.disabled, false);
urlInput.type("  https://example.com/docx/new  ");
save.activate();
await flush();
assert.equal(saved, "https://example.com/docx/new");
assert.equal(editor.closed, true);
assert.ok(refreshed >= 2);

// Disconnect requires explicit local-only confirmation; cancel never calls the host.
search.type("Alpha");
action(rows(modal)[0], "Remove saved link").activate();
await flush();
let confirmation = globalThis.__ui.modals.at(-1);
assert.match(confirmation.contentEl.children[1].textContent, /Local files and Feishu files will be kept/);
let footer = globalThis.__ui.settings.findLast((setting) => confirmation.contentEl.children.includes(setting.settingEl));
action(footer, "Cancel").activate();
assert.equal(removed, 0);
action(rows(modal)[0], "Remove saved link").activate();
await flush();
confirmation = globalThis.__ui.modals.at(-1);
footer = globalThis.__ui.settings.findLast((setting) => confirmation.contentEl.children.includes(setting.settingEl));
const disconnect = action(footer, "Remove saved link");
assert.equal(disconnect.warning, true);
disconnect.activate();
disconnect.activate();
await flush();
assert.equal(removed, 1, "Duplicate activation cannot submit twice");

search.type("");
action(rows(modal)[0], "Remove saved link").activate();
await flush();
confirmation = globalThis.__ui.modals.at(-1);
assert.match(confirmation.contentEl.children[1].textContent, /folder and all its subfolders, notes, and PDFs/);
assert.match(confirmation.contentEl.children[1].textContent, /Local files and Feishu files will be kept/);
footer = globalThis.__ui.settings.findLast((setting) => confirmation.contentEl.children.includes(setting.settingEl));
action(footer, "Cancel").activate();
assert.equal(removed, 1, "canceling a recursive removal preserves every record");

// A refresh during sync must not leave newly rendered controls disabled.
let syncCount = 0;
let opened;
const syncModal = new PublishedLinksModal({}, {
	...host, openUrl: (url) => { opened = url; }, sync: () => { syncCount += 1; }
}, "docs");
syncModal.open();
await flush();
const syncSearch = globalThis.__ui.settings.find((setting) => syncModal.contentEl.children.includes(setting.settingEl) && setting.search).search;
syncSearch.type("Alpha");
let markdown = rows(syncModal).find((setting) => setting.nameEl.textContent === "Alpha");
action(markdown, "Open in Feishu").activate();
await flush();
assert.equal(opened, entries[1].url);
action(markdown, "Sync").activate();
await flush();
assert.equal(syncCount, 1);
markdown = rows(syncModal).find((setting) => setting.nameEl.textContent === "Alpha");
assert.equal(action(markdown, "Sync").buttonEl.disabled, false);
assert.equal(syncModal.feedbackEl.textContent, 'Synced "Alpha".');
assert.ok(!syncModal.feedbackEl.classes.has("is-busy"));
syncModal.close();

// A running sync says what is being synced and which step it is on, and the status line shows it as busy.
let release;
const gate = new Promise((resolve) => { release = resolve; });
let reportStep;
const progressModal = new PublishedLinksModal({}, {
	...host, sync: async (_entry, report) => { reportStep = report; report("Reading 3 notes…"); await gate; }
}, "docs");
progressModal.open();
await flush();
const folderRow = rows(progressModal)[0];
action(folderRow, "Sync").activate();
await flush();
assert.match(progressModal.feedbackEl.textContent, /^Syncing folder "docs" to Feishu…/);
assert.match(progressModal.feedbackEl.textContent, /progress also shows in the notification at the top right/);
assert.match(progressModal.feedbackEl.textContent, /\nReading 3 notes…$/, "the current step sits under the main line");
assert.ok(progressModal.feedbackEl.classes.has("is-busy"));
reportStep("Uploading PDF 1/2: manual.pdf");
assert.match(progressModal.feedbackEl.textContent, /\nUploading PDF 1\/2: manual\.pdf$/, "a newer step replaces the older one");
release();
await flush();
await flush();
assert.equal(progressModal.feedbackEl.textContent, 'Synced "docs".');
assert.ok(!progressModal.feedbackEl.classes.has("is-busy"));
reportStep("late step");
assert.equal(progressModal.feedbackEl.textContent, 'Synced "docs".', "a step reported after the sync finished is ignored");
progressModal.close();
let releaseFile;
const fileGate = new Promise((resolve) => { releaseFile = resolve; });
const fileProgress = new PublishedLinksModal({}, { ...host, sync: async () => { await fileGate; } }, "docs");
fileProgress.open();
await flush();
fileProgress.query = "Alpha";
fileProgress.renderList();
action(rows(fileProgress).find((setting) => setting.nameEl.textContent === "Alpha"), "Sync").activate();
await flush();
assert.equal(fileProgress.feedbackEl.textContent, 'Syncing "Alpha" to Feishu…');
releaseFile();
await flush();
fileProgress.close();

// Stored links with active-content schemes cannot reach the browser callback.
const unsafeModal = new PublishedLinksModal({}, {
	...host, listEntries: () => [{ ...entries[1], url: "javascript:alert(1)" }],
	openUrl: () => { assert.fail("Unsafe URL reached the host"); }
});
unsafeModal.open();
await flush();
action(rows(unsafeModal)[0], "Open in Feishu").activate();
await flush();
assert.equal(unsafeModal.feedbackEl.textContent, "The link must use HTTP or HTTPS.");
unsafeModal.close();

// Bound lists stay small, with keyboard-operable pagination.
const many = Array.from({ length: 51 }, (_, index) => ({ ...entries[1], id: String(index), path: `docs/${String(index).padStart(2, "0")}.md` }));
const pagedModal = new PublishedLinksModal({}, { ...host, listEntries: () => many });
pagedModal.open();
await flush();
assert.equal(rows(pagedModal).length, 51, "50 records and one pagination setting");
let pager = rows(pagedModal).at(-1);
assert.equal(action(pager, "Previous").buttonEl.disabled, true);
action(pager, "Next").activate();
assert.equal(rows(pagedModal).length, 2);
pager = rows(pagedModal).at(-1);
assert.equal(pager.nameEl.textContent, "Page 2 of 2");
assert.equal(action(pager, "Next").buttonEl.disabled, true);
pagedModal.close();

// Recovery is useful with no durable document records; only the host writes bindings.
let recoveredEntries = [];
let recoveryScope;
let recoveryCalls = 0;
let completeRecovery;
const recoveryHost = {
	...host, listEntries: () => recoveredEntries,
	recoverBindings: (folderPath) => {
		recoveryScope = folderPath;
		recoveryCalls += 1;
		return new Promise((resolve) => { completeRecovery = resolve; });
	}
};
const recoveryModal = new PublishedLinksModal({}, recoveryHost, "/docs/");
recoveryModal.open();
await flush();
assert.equal(recoveryModal.listEl.children[0].textContent, "No published files yet.");
assert.match(action(toolbarFor(recoveryModal), "Find existing links").tooltip, /matching filenames.*several files/);
const recover = action(toolbarFor(recoveryModal), "Find existing links");
recover.activate();
recover.activate(" ");
assert.equal(recoveryCalls, 1);
assert.equal(recoveryScope, "docs");
assert.equal(recover.buttonEl.disabled, true);
assert.equal(action(toolbarFor(recoveryModal), "Refresh").buttonEl.disabled, true);
assert.equal(recoveryModal.feedbackEl.textContent, "Finding existing links…");
recoveredEntries = [entries[1]];
completeRecovery("Recovered 1 binding; 2 ambiguous matches need manual binding.");
await flush();
assert.equal(rows(recoveryModal).length, 1, "Recovered settings are refreshed into the list");
assert.equal(recoveryModal.feedbackEl.textContent, "Recovered 1 binding; 2 ambiguous matches need manual binding.");
assert.equal(recover.buttonEl.disabled, false);

recoveryHost.recoverBindings = () => { throw new Error("Remote folder listing failed"); };
recover.activate();
await flush();
assert.equal(recoveryModal.feedbackEl.textContent, "Remote folder listing failed");
assert.ok(recoveryModal.feedbackEl.classes.has("is-error"));
assert.equal(recover.buttonEl.disabled, false, "Failed recovery can be retried");
assert.equal(rows(recoveryModal).length, 1, "Failed recovery retains the existing list");

recoveryHost.recoverBindings = () => "Recovered 1 binding.";
recoveryHost.listEntries = () => { throw new Error("Settings refresh failed"); };
recover.activate();
await flush();
assert.equal(recoveryModal.feedbackEl.textContent, "Recovered 1 binding.\nSettings refresh failed", "Refresh failure keeps the recovery summary visible");
recoveryModal.close();

let rootScope;
const chineseRecovery = new PublishedLinksModal({}, {
	...host, getLanguage: () => "zh-CN", listEntries: () => [],
	recoverBindings: (folderPath) => { rootScope = folderPath; return "已恢复 0 个绑定。"; }
});
chineseRecovery.open();
await flush();
const chineseToolbar = globalThis.__ui.settings.find((setting) => chineseRecovery.contentEl.children.includes(setting.settingEl) && setting.nameEl.textContent === "文件夹");
assert.match(action(chineseToolbar, "查找已有链接").tooltip, /多个同名文件.*手动设置链接/);
action(chineseToolbar, "查找已有链接").activate();
await flush();
assert.equal(rootScope, "", "The unscoped manager asks the host to recover all mapped folders");
assert.equal(chineseRecovery.feedbackEl.textContent, "已恢复 0 个绑定。");
chineseRecovery.close();

// Refresh failures retain the useful list; stale completion cannot reopen a closed UI.
host.listEntries = () => { throw new Error("Could not load settings"); };
await modal.refresh();
assert.equal(modal.feedbackEl.textContent, "Could not load settings");
assert.equal(rows(modal).length, 1);
let finish;
host.listEntries = () => new Promise((resolve) => { finish = resolve; });
const lateRefresh = modal.refresh();
modal.close();
finish(entries);
await lateRefresh;
assert.equal(modal.contentEl.children.length, 0);

const chinese = new PublishedLinksModal({}, { ...host, getLanguage: () => "zh-CN", listEntries: () => [] });
chinese.open();
await flush();
assert.equal(chinese.titleEl.textContent, "已发布文件");
assert.equal(chinese.listEl.children[0].textContent, "还没有已发布文件。");
chinese.close();
delete globalThis.__ui;
console.log("Published files UI tests passed");
