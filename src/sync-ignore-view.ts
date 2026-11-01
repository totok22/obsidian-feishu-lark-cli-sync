import { ItemView, Notice, setIcon, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { confirmDeletion } from "./confirm-delete-modal";
import { collectIgnoreDirectories, IGNORE_FILE_NAME, IgnoreDecision, IgnoreRules, ignoreFilePath } from "./ignore-rules";
import {
	buildIgnoreTree,
	clearRuleLines,
	computeIgnoreStates,
	IgnoreEditContext,
	IgnoreState,
	IgnoreTreeNode,
	indexIgnoreTree,
	listRuleLines,
	setPathIgnored,
	VaultNodeLike
} from "./sync-ignore";

export const SYNC_IGNORE_VIEW_TYPE = "feishu-docs-publisher-sync-ignore";

export interface SyncIgnoreHost {
	getLanguage(): "zh-CN" | "en";
	getVaultRoot(): VaultNodeLike;
	/** Local folders that have been synced to Feishu before. */
	getPublishedFolders(): string[];
	/** Content of the rule file in each of these directories ("" is the vault root); directories without one are left out. */
	readIgnoreFiles(dirs: string[]): Promise<Map<string, string>>;
	/** Create or overwrite one directory's rule file. */
	writeIgnoreFile(dir: string, content: string): Promise<void>;
}

const MESSAGES = {
	en: {
		title: "Sync ignore",
		intro: `Pick a folder you sync, then uncheck the files or subfolders inside it to leave them out. The choices are saved in a ${IGNORE_FILE_NAME} file in that folder, written like .gitignore, so you can edit it, commit it, or copy it elsewhere. Folder sync, auto-sync on save, and the Git pre-push hook skip what it lists. Anything already in Feishu is kept, and syncing a single note by hand still works.`,
		searchFiles: "Search files and folders", searchFolders: "Search folders", refresh: "Refresh",
		folderLabel: "Sync folder", changeFolder: "Change folder", published: "Synced before",
		chooseFolder: "Choose the folder to sync", noFolders: "No folder contains notes, PDFs, or images yet.",
		ruleSummary: (path: string, count: number) => `${path}: ${count} ${count === 1 ? "rule" : "rules"}`,
		noRules: (path: string) => `No rules yet. Your choices will be saved to ${path}.`,
		coveredBy: (source: string) => `This folder is ignored by ${source}, so it is not synced. Change that rule to bring it back.`,
		clearRules: "Clear rules", ignoredBadge: "Ignored",
		empty: "No notes, PDFs, or images to sync in this folder.", noMatches: "No matching files or folders.",
		expand: "Expand", collapse: "Collapse",
		editRules: "Edit rules file", saveRules: "Save", cancel: "Cancel",
		editorHint: `One pattern per line, same syntax as .gitignore: * and ** wildcards, a trailing / for folders, ! to bring something back, # for comments. Copy this file to reuse the rules elsewhere.`,
		confirmTitle: "Clear the rules of this folder?",
		confirmBody: "These lines are removed from the rules file and the content syncs again. Rules in parent folders are not touched:",
		confirm: "Clear rules",
		cannotChange: (reason: string) => `This item cannot be changed here because of ${reason}. Edit the rules file instead.`,
		saveFailed: (message: string) => `Could not save the rules file: ${message}`
	},
	"zh-CN": {
		title: "同步忽略",
		intro: `选一个要同步的文件夹，再取消勾选其中不想同步的文件或子文件夹。你的选择会保存在该文件夹里的 ${IGNORE_FILE_NAME} 文件中，写法与 .gitignore 相同，可以直接编辑、提交到 Git 或复制到别处复用。目录同步、保存时自动同步和 Git pre-push 都会跳过其中列出的内容。已经在飞书里的内容不会被删除，手动同步单篇笔记也不受影响。`,
		searchFiles: "搜索文件和文件夹", searchFolders: "搜索文件夹", refresh: "刷新",
		folderLabel: "同步文件夹", changeFolder: "更换文件夹", published: "已发布过",
		chooseFolder: "选择要同步的文件夹", noFolders: "库里还没有包含笔记、PDF 或图片的文件夹。",
		ruleSummary: (path: string, count: number) => `${path}：${count} 条规则`,
		noRules: (path: string) => `还没有规则。你的选择会保存到 ${path}。`,
		coveredBy: (source: string) => `这个文件夹被 ${source} 忽略，目前不会同步。要恢复，请修改那条规则。`,
		clearRules: "清空规则", ignoredBadge: "已忽略",
		empty: "这个文件夹里没有可同步的笔记、PDF 或图片。", noMatches: "没有匹配的文件或文件夹。",
		expand: "展开", collapse: "收起",
		editRules: "编辑规则文件", saveRules: "保存", cancel: "取消",
		editorHint: "每行一条规则，写法与 .gitignore 相同：支持 * 和 ** 通配符，末尾加 / 只匹配文件夹，! 开头表示恢复，# 开头是注释。复制这个文件就能在别处复用这些规则。",
		confirmTitle: "清空这个文件夹的规则？",
		confirmBody: "下面这些行会从规则文件中删除，对应内容之后会正常同步。上级文件夹里的规则不受影响：",
		confirm: "清空规则",
		cannotChange: (reason: string) => `这一项受 ${reason} 影响，无法在这里修改。请直接编辑规则文件。`,
		saveFailed: (message: string) => `无法保存规则文件：${message}`
	}
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** A workspace tab for one sync folder: its notes, PDFs, and subfolders are checked to sync or unchecked to ignore. */
export class SyncIgnoreView extends ItemView {
	private folderScope = "";
	private query = "";
	private tree: IgnoreTreeNode | null = null;
	private index = new Map<string, IgnoreTreeNode>();
	private ruleTexts = new Map<string, string>();
	private states = new Map<string, IgnoreState>();
	private readonly expanded = new Set<string>();
	private editingRules = false;
	private initialized = false;
	private expandedFor = "";
	private saving = false;
	private reloadId = 0;
	private refreshTimer: number | null = null;
	private searchEl!: HTMLInputElement;
	private folderEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private listEl!: HTMLElement;
	private refreshButton!: HTMLButtonElement;
	private clearButton!: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, private readonly host: SyncIgnoreHost) {
		super(leaf);
	}

	private get t() {
		return MESSAGES[this.host.getLanguage()] || MESSAGES["zh-CN"];
	}

	getViewType(): string {
		return SYNC_IGNORE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.t.title;
	}

	override getIcon(): string {
		return "eye-off";
	}

	override getState(): Record<string, unknown> {
		return { folder: this.folderScope };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const folder = typeof state === "object" && state !== null && "folder" in state ? state.folder : undefined;
		this.folderScope = typeof folder === "string" ? folder.replace(/^\/+|\/+$/g, "") : "";
		await super.setState(state, result);
		if (this.listEl) await this.showFolder(this.folderScope);
	}

	override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("feishu-lark-ignore-view");
		const t = this.t;
		this.contentEl.createEl("h2", { text: t.title });
		this.contentEl.createEl("p", { text: t.intro, cls: "setting-item-description" });

		this.folderEl = this.contentEl.createDiv({ cls: "feishu-lark-ignore-folder" });
		const toolbar = this.contentEl.createDiv({ cls: "feishu-lark-ignore-toolbar" });
		this.searchEl = toolbar.createEl("input", { type: "search" });
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value;
			this.render();
		});
		this.refreshButton = toolbar.createEl("button", { text: t.refresh });
		this.refreshButton.addEventListener("click", () => { void this.reload(); });
		this.clearButton = toolbar.createEl("button", { text: t.clearRules });
		this.clearButton.addEventListener("click", () => { void this.clearRules(); });

		this.summaryEl = this.contentEl.createDiv({ cls: "feishu-lark-ignore-summary" });
		this.listEl = this.contentEl.createDiv({ cls: "feishu-lark-ignore-tree" });

		const scheduleReload = (): void => {
			if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(() => {
				this.refreshTimer = null;
				if (!this.editingRules) void this.reload();
			}, 300);
		};
		this.registerEvent(this.app.vault.on("create", scheduleReload));
		this.registerEvent(this.app.vault.on("delete", scheduleReload));
		this.registerEvent(this.app.vault.on("rename", scheduleReload));
		await this.reload();
	}

	override async onClose(): Promise<void> {
		this.reloadId += 1;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
		this.contentEl.empty();
	}

	private setQuery(query: string): void {
		this.query = query;
		this.searchEl.value = query;
	}

	/** Switch to a sync folder, or to the folder chooser with an empty path. */
	private async showFolder(path: string): Promise<void> {
		this.folderScope = path;
		this.editingRules = false;
		this.setQuery("");
		this.listEl.scrollTop = 0;
		await this.reload();
	}

	/** The vault tree is rebuilt, and the rule files of the sync folder and everything above and below it are read again. */
	private async reload(): Promise<void> {
		const reloadId = ++this.reloadId;
		this.tree = buildIgnoreTree(this.host.getVaultRoot());
		this.index = indexIgnoreTree(this.tree);
		if (!this.initialized) {
			this.initialized = true;
			// With no folder given, a single synced folder is the obvious choice.
			if (!this.folderScope) {
				const published = this.host.getPublishedFolders().filter((path) => this.index.get(path)?.isFolder);
				if (published.length === 1 && published[0]) this.folderScope = published[0];
			}
		}
		if (this.folderScope) {
			const root = this.scopeRoot();
			const folders = [...this.index.values()].filter((node) => node.isFolder && node.path.startsWith(`${this.folderScope}/`))
				.map((node) => `${node.path}/`);
			let texts: Map<string, string>;
			try {
				texts = await this.host.readIgnoreFiles(collectIgnoreDirectories([`${this.folderScope}/`, ...folders]));
			} catch (error) {
				texts = new Map();
				new Notice(this.t.saveFailed(error instanceof Error ? error.message : String(error)), 8000);
			}
			if (reloadId !== this.reloadId) return;
			this.ruleTexts = texts;
			this.states = computeIgnoreStates(this.buildRules(), root);
			if (this.expandedFor !== this.folderScope) {
				// Open every folder that already holds an ignored item so it is visible at a glance.
				this.expandedFor = this.folderScope;
				for (const [path, state] of this.states) {
					if (state === "partial" && this.index.get(path)?.isFolder) this.expanded.add(path);
				}
			}
		}
		this.render();
	}

	/** The sync folder as a tree root; a folder with nothing syncable is still a valid, empty root. */
	private scopeRoot(): IgnoreTreeNode {
		return this.index.get(this.folderScope)
			?? { path: this.folderScope, name: this.folderScope.split("/").pop() ?? "", isFolder: true, children: [] };
	}

	private buildRules(ownText?: string): IgnoreRules {
		const rules = new IgnoreRules();
		for (const [dir, text] of this.ruleTexts) rules.setFile(dir, dir === this.folderScope && ownText !== undefined ? ownText : text);
		if (ownText !== undefined && !this.ruleTexts.has(this.folderScope)) rules.setFile(this.folderScope, ownText);
		return rules;
	}

	private ownText(): string {
		return this.ruleTexts.get(this.folderScope) ?? "";
	}

	private describe(decision: IgnoreDecision): string {
		return `${ignoreFilePath(decision.dir ?? "")} (${decision.pattern ?? ""})`;
	}

	private render(): void {
		const t = this.t;
		const choosing = !this.folderScope;
		const scrollTop = this.listEl.scrollTop;

		this.searchEl.placeholder = choosing ? t.searchFolders : t.searchFiles;
		this.searchEl.setAttribute("aria-label", this.searchEl.placeholder);
		this.searchEl.hidden = this.editingRules;
		this.refreshButton.disabled = this.saving;
		this.clearButton.hidden = choosing || this.editingRules;
		this.listEl.setAttribute("role", choosing ? "list" : "tree");
		this.renderFolderBar(choosing);
		this.listEl.empty();
		if (choosing) {
			this.summaryEl.empty();
			this.renderFolderChoices();
		} else if (this.editingRules) {
			this.summaryEl.empty();
			this.renderRulesEditor();
		} else {
			this.renderTree();
		}
		this.listEl.scrollTop = scrollTop;
	}

	private renderFolderBar(choosing: boolean): void {
		const t = this.t;
		this.folderEl.empty();
		if (choosing) {
			this.folderEl.createSpan({ text: t.chooseFolder, cls: "feishu-lark-ignore-folder-title" });
			return;
		}
		this.folderEl.createSpan({ text: `${t.folderLabel}: ` });
		this.folderEl.createSpan({ text: this.folderScope, cls: "feishu-lark-ignore-folder-title" });
		const change = this.folderEl.createEl("button", { text: t.changeFolder });
		change.addEventListener("click", () => { void this.showFolder(""); });
		if (!this.editingRules) {
			const edit = this.folderEl.createEl("button", { text: t.editRules });
			edit.addEventListener("click", () => {
				this.editingRules = true;
				this.render();
			});
		}
	}

	/** Every folder that holds something syncable; the ones synced before come first. */
	private renderFolderChoices(): void {
		const t = this.t;
		const published = new Set(this.host.getPublishedFolders());
		const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const folders = [...this.index.values()]
			.filter((node) => node.isFolder && node !== this.tree)
			.map((node) => node.path)
			.filter((path) => terms.every((term) => path.toLocaleLowerCase().includes(term)))
			.sort((left, right) => Number(published.has(right)) - Number(published.has(left)) || left.localeCompare(right));
		if (folders.length === 0) {
			this.listEl.createEl("p", { text: terms.length ? t.noMatches : t.noFolders, cls: "feishu-lark-ignore-empty" });
			return;
		}
		for (const path of folders) {
			const option = this.listEl.createEl("button", { cls: "feishu-lark-ignore-option" });
			setIcon(option.createSpan({ cls: "feishu-lark-ignore-icon" }), "folder");
			option.createSpan({ text: path, cls: "feishu-lark-ignore-name" });
			if (published.has(path)) option.createSpan({ text: t.published, cls: "feishu-lark-ignore-badge" });
			option.addEventListener("click", () => { void this.showFolder(path); });
		}
	}

	/** The rule file as plain text, for patterns the checkboxes cannot express. */
	private renderRulesEditor(): void {
		const t = this.t;
		this.listEl.createEl("p", { text: ignoreFilePath(this.folderScope), cls: "feishu-lark-ignore-folder-title" });
		this.listEl.createEl("p", { text: t.editorHint, cls: "setting-item-description" });
		const editor = this.listEl.createEl("textarea", { cls: "feishu-lark-ignore-editor" });
		editor.value = this.ownText();
		editor.spellcheck = false;
		editor.setAttribute("aria-label", ignoreFilePath(this.folderScope));
		const actions = this.listEl.createDiv({ cls: "feishu-lark-ignore-actions" });
		const save = actions.createEl("button", { text: t.saveRules, cls: "mod-cta" });
		save.addEventListener("click", () => { void this.writeRules(editor.value, true); });
		const cancel = actions.createEl("button", { text: t.cancel });
		cancel.addEventListener("click", () => {
			this.editingRules = false;
			this.render();
		});
		editor.focus();
	}

	private renderTree(): void {
		const t = this.t;
		const ruleCount = listRuleLines(this.ownText()).length;
		const outer = this.buildRules().explain(this.folderScope, true);
		this.summaryEl.setText(outer.ignored ? t.coveredBy(this.describe(outer))
			: ruleCount > 0 ? t.ruleSummary(ignoreFilePath(this.folderScope), ruleCount) : t.noRules(ignoreFilePath(this.folderScope)));
		this.clearButton.disabled = ruleCount === 0 || this.saving;

		const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const rows = this.collectRows(this.scopeRoot(), terms);
		if (rows.length === 0) {
			this.listEl.createEl("p", { text: terms.length ? t.noMatches : t.empty, cls: "feishu-lark-ignore-empty" });
			return;
		}
		for (const row of rows) this.renderRow(row.node, row.depth);
	}

	/** Flatten the visible part of the tree. A search keeps matches and their parents, matching on the path below the sync folder. */
	private collectRows(root: IgnoreTreeNode, terms: string[]): { node: IgnoreTreeNode; depth: number }[] {
		const rows: { node: IgnoreTreeNode; depth: number }[] = [];
		const matches = (relativePath: string): boolean => {
			const haystack = relativePath.toLocaleLowerCase();
			return terms.every((term) => haystack.includes(term));
		};
		const hasMatch = (node: IgnoreTreeNode, relativePath: string): boolean =>
			matches(relativePath) || node.children.some((child) => hasMatch(child, `${relativePath}/${child.name}`));
		const visit = (node: IgnoreTreeNode, depth: number, relativePath: string): void => {
			if (terms.length > 0 && !hasMatch(node, relativePath)) return;
			rows.push({ node, depth });
			if (!node.isFolder || (terms.length === 0 && !this.expanded.has(node.path))) return;
			for (const child of node.children) visit(child, depth + 1, `${relativePath}/${child.name}`);
		};
		for (const child of root.children) visit(child, 0, child.name);
		return rows;
	}

	private renderRow(node: IgnoreTreeNode, depth: number): void {
		const t = this.t;
		const state = this.states.get(node.path) ?? "included";
		const row = this.listEl.createDiv({ cls: "feishu-lark-ignore-row" });
		row.setCssProps({ "--feishu-lark-depth": String(depth) });
		row.toggleClass("is-ignored", state === "ignored");
		row.setAttribute("role", "treeitem");
		row.setAttribute("aria-level", String(depth + 1));
		const searching = this.query.trim() !== "";
		const open = node.isFolder && (searching || this.expanded.has(node.path));
		if (node.isFolder) row.setAttribute("aria-expanded", String(open));

		const toggle = row.createEl("button", { cls: "feishu-lark-ignore-toggle clickable-icon" });
		if (node.isFolder) {
			setIcon(toggle, open ? "chevron-down" : "chevron-right");
			toggle.setAttribute("aria-label", open ? t.collapse : t.expand);
			toggle.disabled = searching;
			toggle.addEventListener("click", () => {
				if (open) this.expanded.delete(node.path);
				else this.expanded.add(node.path);
				this.render();
			});
		} else {
			toggle.addClass("is-placeholder");
			toggle.disabled = true;
		}

		const label = row.createEl("label", { cls: "feishu-lark-ignore-label" });
		const checkbox = label.createEl("input", { type: "checkbox" });
		checkbox.checked = state === "included";
		checkbox.indeterminate = state === "partial";
		checkbox.disabled = this.saving;
		checkbox.addEventListener("change", () => { void this.toggle(node, !checkbox.checked); });
		setIcon(label.createSpan({ cls: "feishu-lark-ignore-icon" }), this.iconFor(node));
		label.createSpan({ text: node.name, cls: "feishu-lark-ignore-name" });
		if (state === "ignored") row.createSpan({ text: t.ignoredBadge, cls: "feishu-lark-ignore-badge" });
	}

	private iconFor(node: IgnoreTreeNode): string {
		if (node.isFolder) return "folder";
		const extension = node.name.slice(node.name.lastIndexOf(".") + 1).toLowerCase();
		return IMAGE_EXTENSIONS.has(extension) ? "image" : "file-text";
	}

	/** Rule paths are relative to the sync folder, the rest of the plugin works with vault paths. */
	private editContext(): IgnoreEditContext {
		const prefix = `${this.folderScope}/`;
		const vaultPath = (path: string): string => path ? `${prefix}${path}` : this.folderScope;
		return {
			isIgnored: (text, path, isFolder) => this.buildRules(text).isIgnored(vaultPath(path), isFolder),
			explain: (text, path, isFolder) => this.describe(this.buildRules(text).explain(vaultPath(path), isFolder)),
			listChildren: (path) => (this.index.get(vaultPath(path))?.children ?? [])
				.map((child) => ({ path: child.path.slice(prefix.length), isFolder: child.isFolder }))
		};
	}

	private async toggle(node: IgnoreTreeNode, ignore: boolean): Promise<void> {
		const result = setPathIgnored(this.ownText(), node.path.slice(this.folderScope.length + 1), node.isFolder, ignore, this.editContext());
		if (!result.ok) {
			new Notice(this.t.cannotChange(result.reason), 8000);
			this.render();
			return;
		}
		await this.writeRules(result.text, false);
	}

	/** Clears the rules of this sync folder's own file; comments stay and parent folders' files are untouched. */
	private async clearRules(): Promise<void> {
		const lines = listRuleLines(this.ownText());
		if (lines.length === 0) return;
		const t = this.t;
		const confirmed = await confirmDeletion(this.app,
			{ title: t.confirmTitle, body: t.confirmBody, confirm: t.confirm, cancel: t.cancel }, lines);
		if (confirmed) await this.writeRules(clearRuleLines(this.ownText()), false);
	}

	private async writeRules(text: string, leaveEditor: boolean): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.render();
		try {
			await this.host.writeIgnoreFile(this.folderScope, text);
			if (leaveEditor) this.editingRules = false;
		} catch (error) {
			new Notice(this.t.saveFailed(error instanceof Error ? error.message : String(error)), 8000);
		} finally {
			this.saving = false;
		}
		await this.reload();
	}
}
