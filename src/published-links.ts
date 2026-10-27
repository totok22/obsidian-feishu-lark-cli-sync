import { App, ButtonComponent, Menu, Modal, Setting, TextComponent } from "obsidian";

export type PublishedLinkKind = "markdown" | "pdf" | "folder";

/** The host resolves plugin settings bindings and supplies a stable settings key. */
export interface PublishedLinkEntry {
	id: string;
	path: string;
	kind: PublishedLinkKind;
	url: string;
	token?: string;
	name?: string;
}

type MaybePromise<T> = T | Promise<T>;

/** The host validates URLs and persists documentBindings/pdfBindings/folder settings without editing notes. */
export interface PublishedLinksHost {
	getLanguage(): "zh-CN" | "en";
	listEntries(): MaybePromise<PublishedLinkEntry[]>;
	saveBindingUrl(entry: PublishedLinkEntry, url: string): MaybePromise<void>;
	/** Remove local binding metadata, including descendants for folders. Never edit notes or delete remote files. */
	removeBinding(entry: PublishedLinkEntry): MaybePromise<void>;
	openLocalFile?(entry: PublishedLinkEntry): MaybePromise<void>;
	/** `report` receives short progress lines (for example the current step) while a long sync runs. */
	sync?(entry: PublishedLinkEntry, report?: (message: string) => void): MaybePromise<void>;
	openUrl?(url: string): MaybePromise<void>;
	copyUrl?(url: string): MaybePromise<void>;
	/** Read existing remote children and save unique matches in local settings; never create remote content. */
	recoverBindings?(folderPath: string): MaybePromise<string>;
	/** Open the page where files and folders are chosen to be left out of sync, scoped to a folder when given. */
	openSyncIgnore?(folderPath: string): void;
}

const MESSAGES = {
	en: {
		title: "Published files",
		localOnly: "Remove this saved link? Local files and Feishu files will be kept.",
		folderLocalOnly: "Remove saved links for this folder and all its subfolders, notes, and PDFs? Local files and Feishu files will be kept.",
		search: "Search", searchHint: "Search files or links", scope: "Folder",
		all: "All folders", refresh: "Refresh", loading: "Loading…",
		recover: "Find existing links", recovering: "Finding existing links…",
		recoveryHint: "Find matching filenames in Feishu. If several files match, set the link manually.",
		ignoreRules: "Sync ignore", ignoreRulesHint: "Choose files and folders to leave out of sync",
		empty: "No published files yet.", noMatches: "No matching files.",
		count: (visible: number, total: number) => visible === total ? `${total} items` : `${visible} of ${total} items`,
		markdown: "Note", pdf: "PDF", folder: "Folder", open: "Open in Feishu", copy: "Copy link", more: "More",
		copied: "Link copied.", edit: "Set link", local: "Open local file", sync: "Sync",
		synced: (name: string) => `Synced "${name}".`, disconnect: "Remove saved link", cancel: "Cancel", save: "Save",
		editTitle: "Set Feishu link", url: "Feishu/Lark link",
		urlHint: "Paste the link to this file or folder.",
		editHelp: "Future syncs will update the file at this link.",
		folderEditHelp: "Future folder syncs will upload here.",
		saving: "Saving…", removing: "Removing…", working: "Working…",
		syncing: (name: string) => `Syncing "${name}" to Feishu…`,
		syncingFolder: (name: string) => `Syncing folder "${name}" to Feishu… This can take a few minutes for many files. Closing this window does not stop it; progress also shows in the notification at the top right.`,
		noUrl: "Link not set", invalidUrl: "The link must use HTTP or HTTPS.",
		failed: "Action failed. Please try again.", previous: "Previous", next: "Next",
		page: (page: number, pages: number) => `Page ${page} of ${pages}`
	},
	"zh-CN": {
		title: "已发布文件",
		localOnly: "移除此链接记录？本地文件和飞书文件都会保留。",
		folderLocalOnly: "移除此目录及其全部子目录、笔记和 PDF 的链接记录？本地文件和飞书文件都会保留。",
		search: "搜索", searchHint: "搜索文件或链接", scope: "文件夹",
		all: "所有文件夹", refresh: "刷新", loading: "正在加载…",
		recover: "查找已有链接", recovering: "正在查找已有链接…",
		recoveryHint: "在飞书中查找同名文件。如有多个同名文件，请手动设置链接。",
		ignoreRules: "同步忽略", ignoreRulesHint: "选择同步时要忽略的文件和文件夹",
		empty: "还没有已发布文件。", noMatches: "没有找到匹配的文件。",
		count: (visible: number, total: number) => visible === total ? `共 ${total} 项` : `${visible} / ${total} 项`,
		markdown: "笔记", pdf: "PDF", folder: "文件夹", open: "在飞书打开", copy: "复制链接", more: "更多",
		copied: "已复制链接。", edit: "设置链接", local: "打开本地文件", sync: "同步",
		synced: (name: string) => `已同步「${name}」。`, disconnect: "移除链接记录", cancel: "取消", save: "保存",
		editTitle: "设置飞书链接", url: "飞书链接",
		urlHint: "粘贴此文件或文件夹的飞书链接。",
		editHelp: "后续同步会更新此链接对应的文件。",
		folderEditHelp: "后续目录同步会上传到这里。",
		saving: "正在保存…", removing: "正在移除…", working: "正在处理…",
		syncing: (name: string) => `正在把「${name}」同步到飞书…`,
		syncingFolder: (name: string) => `正在把文件夹「${name}」同步到飞书…文件较多时可能需要几分钟。关闭这个窗口不会中断同步，进度也会显示在右上角的通知里。`,
		noUrl: "未设置链接", invalidUrl: "链接必须以 HTTP 或 HTTPS 开头。",
		failed: "操作失败，请重试。", previous: "上一页", next: "下一页",
		page: (page: number, pages: number) => `第 ${page} / ${pages} 页`
	}
};

function messages(host: PublishedLinksHost) {
	return MESSAGES[host.getLanguage()] || MESSAGES["zh-CN"];
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Scope includes the folder itself and its descendants, not similarly named siblings. */
export function filterPublishedLinks(entries: readonly PublishedLinkEntry[], query = "", folderPath = ""): PublishedLinkEntry[] {
	const scope = normalizePath(folderPath);
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		const path = normalizePath(entry.path);
		if (scope && path !== scope && !path.startsWith(`${scope}/`)) return false;
		const haystack = [entry.path, entry.name || "", entry.url, entry.token || ""].join(" ").toLocaleLowerCase();
		return terms.every((term) => haystack.includes(term));
	}).sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
}

/** Keep only outermost folders and hide every entry contained by those folders. */
export function collapseNestedFolderEntries(entries: readonly PublishedLinkEntry[]): PublishedLinkEntry[] {
	const folderPaths = entries
		.filter((entry) => entry.kind === "folder")
		.map((entry) => normalizePath(entry.path))
		.filter(Boolean);
	const outermostFolderPaths = folderPaths.filter((path) =>
		!folderPaths.some((parentPath) => parentPath !== path && path.startsWith(parentPath + "/"))
	);

	return entries.filter((entry) => {
		const path = normalizePath(entry.path);
		if (entry.kind === "folder") return outermostFolderPaths.includes(path);
		return !outermostFolderPaths.some((folderPath) => path.startsWith(folderPath + "/"));
	});
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function createFeedback(container: HTMLElement): HTMLParagraphElement {
	const feedback = container.createEl("p", { cls: "feishu-lark-published-feedback" });
	feedback.setAttribute("role", "status");
	feedback.setAttribute("aria-live", "polite");
	feedback.setAttribute("aria-atomic", "true");
	return feedback;
}

/** A status line: plain, "busy" (with a spinner while work is under way), or an error. */
function showFeedback(element: HTMLElement, text: string, state: boolean | "busy" = false): void {
	element.setText(text);
	element.toggleClass("is-error", state === true);
	element.toggleClass("is-busy", state === "busy");
}

export class PublishedLinksModal extends Modal {
	private entries: PublishedLinkEntry[] = [];
	private query = "";
	private page = 0;
	private readonly pageSize = 50;
	private requestId = 0;
	private renderRevision = 0;
	private active = false;
	private loaded = false;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private feedbackEl!: HTMLElement;
	private refreshButton!: ButtonComponent;
	private recoveryButton?: ButtonComponent;
	private recovering = false;
	private readonly pending = new Set<string>();

	constructor(app: App, private readonly host: PublishedLinksHost, private readonly folderPath = "") {
		super(app);
	}

	onOpen(): void {
		this.active = true;
		const t = messages(this.host);
		this.modalEl.addClass("feishu-lark-published-modal");
		this.contentEl.empty();
		this.titleEl.setText(t.title);
		const toolbar = new Setting(this.contentEl).setName(t.scope).setDesc(normalizePath(this.folderPath) || t.all)
			.addButton((button) => {
				this.refreshButton = button.setButtonText(t.refresh).onClick(() => { void this.refresh(); });
			});
		if (this.host.recoverBindings) {
			toolbar.addButton((button) => {
				this.recoveryButton = button.setButtonText(t.recover).setTooltip(t.recoveryHint).onClick(() => { void this.recoverBindings(); });
				button.buttonEl.setAttribute("aria-label", t.recover);
			});
		}
		new Setting(this.contentEl).setName(t.search).addSearch((search) => {
			search.setPlaceholder(t.searchHint).setValue(this.query).onChange((value) => {
				this.query = value;
				this.page = 0;
				this.renderList();
			});
			search.inputEl.setAttribute("aria-label", t.searchHint);
		});
		if (this.host.openSyncIgnore) {
			toolbar.addButton((button) => {
				button.setButtonText(t.ignoreRules).setTooltip(t.ignoreRulesHint).onClick(() => {
					const folder = normalizePath(this.folderPath);
					this.close();
					this.host.openSyncIgnore?.(folder);
				});
				button.buttonEl.setAttribute("aria-label", t.ignoreRulesHint);
			});
		}
		toolbar.settingEl.addClass("feishu-lark-published-toolbar");
		this.feedbackEl = createFeedback(this.contentEl);
		this.countEl = this.contentEl.createDiv({ cls: "feishu-lark-published-count" });
		this.listEl = this.contentEl.createDiv({ cls: "feishu-lark-published-list" });
		void this.refresh();
	}

	onClose(): void {
		this.active = false;
		this.requestId += 1;
		this.contentEl.empty();
	}

	async refresh(successMessage = ""): Promise<void> {
		if (!this.active) return;
		const requestId = ++this.requestId;
		const t = messages(this.host);
		this.refreshButton.setDisabled(true);
		this.recoveryButton?.setDisabled(true);
		showFeedback(this.feedbackEl, t.loading, "busy");
		try {
			const entries = await this.host.listEntries();
			if (!this.active || requestId !== this.requestId) return;
			this.entries = entries;
			this.loaded = true;
			showFeedback(this.feedbackEl, successMessage);
			this.renderList();
		} catch (error) {
			if (this.active && requestId === this.requestId) {
				showFeedback(this.feedbackEl, [successMessage, errorMessage(error, t.failed)].filter(Boolean).join("\n"), true);
			}
		} finally {
			if (this.active && requestId === this.requestId) {
				this.refreshButton.setDisabled(this.recovering);
				this.recoveryButton?.setDisabled(this.recovering);
			}
		}
	}

	private async recoverBindings(): Promise<void> {
		if (!this.active || this.recovering || !this.host.recoverBindings) return;
		this.recovering = true;
		this.recoveryButton?.setDisabled(true);
		this.refreshButton.setDisabled(true);
		const t = messages(this.host);
		showFeedback(this.feedbackEl, t.recovering, "busy");
		try {
			const summary = await this.host.recoverBindings(normalizePath(this.folderPath));
			if (this.active) await this.refresh(summary);
		} catch (error) {
			if (this.active) showFeedback(this.feedbackEl, errorMessage(error, t.failed), true);
		} finally {
			this.recovering = false;
			if (this.active) {
				this.recoveryButton?.setDisabled(false);
				this.refreshButton.setDisabled(false);
			}
		}
	}

	private renderList(): void {
		if (!this.active || !this.loaded) return;
		this.renderRevision += 1;
		const t = messages(this.host);
		const scopedEntries = filterPublishedLinks(this.entries, "", this.folderPath);
		const scoped = this.query.trim() ? scopedEntries : collapseNestedFolderEntries(scopedEntries);
		const filtered = filterPublishedLinks(scoped, this.query);
		const pages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
		this.page = Math.min(this.page, pages - 1);
		this.countEl.setText(t.count(filtered.length, scoped.length));
		this.listEl.empty();
		if (!filtered.length) {
			this.listEl.createEl("p", { text: this.query.trim() ? t.noMatches : t.empty });
			return;
		}
		for (const entry of filtered.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize)) this.renderEntry(entry);
		if (pages > 1) {
			new Setting(this.listEl).setName(t.page(this.page + 1, pages))
				.addButton((button) => button.setButtonText(t.previous).setDisabled(this.page === 0).onClick(() => {
					this.page -= 1;
					this.renderList();
				}))
				.addButton((button) => button.setButtonText(t.next).setDisabled(this.page === pages - 1).onClick(() => {
					this.page += 1;
					this.renderList();
				}));
		}
	}

	private renderEntry(entry: PublishedLinkEntry): void {
		const t = messages(this.host);
		const controls: { button: ButtonComponent; disabled: boolean }[] = [];
		const setting = new Setting(this.listEl).setName(entry.name || entry.path.split("/").pop() || "/")
			.setDesc(`${t[entry.kind]} · ${entry.path || "/"}${entry.url ? "" : ` · ${t.noUrl}`}`);
		setting.settingEl.addClass("feishu-lark-published-entry");
		const actions: { label: string; icon: string; action: (report: (message: string) => void) => MaybePromise<void>; disabled: boolean; busy: string }[] = [];
		const addAction = (label: string, icon: string, action: (report: (message: string) => void) => MaybePromise<void>,
			disabled = false, busy = t.working): void => {
			actions.push({ label, icon, action, disabled, busy });
		};
		const displayName = entry.name || entry.path.split("/").pop() || "/";
		addAction(t.open, "external-link", async () => {
			const url = new URL(entry.url);
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(t.invalidUrl);
			if (this.host.openUrl) await this.host.openUrl(entry.url);
			else this.contentEl.ownerDocument.defaultView?.open(entry.url, "_blank", "noopener,noreferrer");
		}, !entry.url);
		addAction(t.copy, "copy", async () => {
			if (this.host.copyUrl) await this.host.copyUrl(entry.url);
			else {
				const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
				if (!clipboard) throw new Error(t.failed);
				await clipboard.writeText(entry.url);
			}
			if (this.active) showFeedback(this.feedbackEl, t.copied);
		}, !entry.url);
		addAction(t.edit, "link", () => {
			new PublishedLinkBindingModal(this.app, this.host, entry, () => this.refresh()).open();
		});
		if (this.host.openLocalFile && entry.kind !== "folder") addAction(t.local, "file", () => this.host.openLocalFile!(entry));
		if (this.host.sync) addAction(t.sync, "refresh-cw", async (report) => {
			await this.host.sync!(entry, report);
			await this.refresh();
			if (this.active) showFeedback(this.feedbackEl, t.synced(displayName));
		}, false, entry.kind === "folder" ? t.syncingFolder(displayName) : t.syncing(displayName));
		addAction(t.disconnect, "unlink", () => {
			new DisconnectPublishedLinkModal(this.app, this.host, entry, () => this.refresh()).open();
		});
		const open = actions[0]!;
		setting.addButton((button) => {
			controls.push({ button, disabled: open.disabled });
			button.setButtonText(open.label).setDisabled(open.disabled || this.pending.has(entry.id))
				.onClick(() => { void this.runAction(entry, open.action, controls, open.busy); });
		});
		setting.addButton((button) => {
			controls.push({ button, disabled: false });
			button.setIcon("ellipsis").setTooltip(t.more).setDisabled(this.pending.has(entry.id)).onClick((event) => {
				if (!this.active || this.pending.has(entry.id)) return;
				const menu = new Menu();
				for (const item of actions.slice(1)) {
					if (item.label === t.disconnect) menu.addSeparator();
					menu.addItem((menuItem) => menuItem.setTitle(item.label).setIcon(item.icon).setDisabled(item.disabled)
						.onClick(() => { if (this.active) void this.runAction(entry, item.action, controls, item.busy); }));
				}
				menu.showAtMouseEvent(event);
			});
			button.buttonEl.setAttribute("aria-label", `${t.more} · ${entry.name || entry.path}`);
			button.buttonEl.setAttribute("aria-haspopup", "menu");
		});
	}

	private async runAction(entry: PublishedLinkEntry, action: (report: (message: string) => void) => MaybePromise<void>,
		controls: { button: ButtonComponent; disabled: boolean }[], busy: string): Promise<void> {
		if (this.pending.has(entry.id)) return;
		const renderRevision = this.renderRevision;
		this.pending.add(entry.id);
		showFeedback(this.feedbackEl, busy, "busy");
		controls.forEach(({ button }) => { button.setDisabled(true); });
		// The current step goes under the main line, so the page never looks stuck during a long sync.
		const report = (message: string): void => {
			if (this.active && this.pending.has(entry.id)) showFeedback(this.feedbackEl, `${busy}\n${message}`, "busy");
		};
		try {
			await action(report);
			if (this.active && this.feedbackEl.textContent === busy) showFeedback(this.feedbackEl, "");
		} catch (error) {
			if (this.active) showFeedback(this.feedbackEl, errorMessage(error, messages(this.host).failed), true);
		} finally {
			this.pending.delete(entry.id);
			if (this.active) {
				if (renderRevision !== this.renderRevision) this.renderList();
				else controls.forEach(({ button, disabled }) => { button.setDisabled(disabled); });
			}
		}
	}
}

/** Shared modal keeps errors beside the form and prevents duplicate submissions. */
abstract class PublishedLinkActionModal extends Modal {
	protected feedbackEl!: HTMLElement;
	protected buttons: ButtonComponent[] = [];
	protected active = false;
	private busy = false;
	protected onActionError(): void {}

	constructor(app: App, protected readonly host: PublishedLinksHost, protected readonly entry: PublishedLinkEntry,
		private readonly onSaved: () => MaybePromise<void> = () => {}) {
		super(app);
	}

	protected addActions(label: string, busyLabel: string, action: () => MaybePromise<void>, warning = false): void {
		const t = messages(this.host);
		this.feedbackEl = createFeedback(this.contentEl);
		new Setting(this.contentEl).addButton((button) => {
			this.buttons.push(button.setButtonText(t.cancel).onClick(() => this.close()));
		}).addButton((button) => {
			this.buttons.push(button.setButtonText(label));
			if (warning) button.setDestructive();
			else button.setCta();
			button.onClick(() => { void this.submit(button, label, busyLabel, action); });
		});
	}

	private async submit(button: ButtonComponent, label: string, busyLabel: string, action: () => MaybePromise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.buttons.forEach((control) => { control.setDisabled(true); });
		button.setButtonText(busyLabel);
		showFeedback(this.feedbackEl, "");
		try {
			await action();
			this.close();
			await this.onSaved();
		} catch (error) {
			if (this.active) {
				showFeedback(this.feedbackEl, errorMessage(error, messages(this.host).failed), true);
				this.onActionError();
			}
		} finally {
			this.busy = false;
			if (this.active) {
				this.buttons.forEach((control) => { control.setDisabled(false); });
				button.setButtonText(label);
			}
		}
	}

	onClose(): void {
		this.active = false;
		this.buttons = [];
		this.contentEl.empty();
	}
}

export class PublishedLinkBindingModal extends PublishedLinkActionModal {
	private input?: TextComponent;

	protected onActionError(): void {
		this.input?.inputEl.setAttribute("aria-invalid", "true");
		this.input?.inputEl.focus();
	}

	onOpen(): void {
		this.active = true;
		const t = messages(this.host);
		this.titleEl.setText(t.editTitle);
		this.contentEl.createEl("p", { text: this.entry.path || "/", cls: "feishu-lark-published-path" });
		this.contentEl.createEl("p", { text: this.entry.kind === "folder" ? t.folderEditHelp : t.editHelp, cls: "setting-item-description" });
		let url = this.entry.url;
		let input: TextComponent | undefined;
		const urlSetting = new Setting(this.contentEl).setName(t.url).setDesc(t.urlHint).addText((text) => {
			this.input = input = text;
			text.setValue(url).setPlaceholder("HTTPS://…").onChange((value) => {
				url = value;
				text.inputEl.setAttribute("aria-invalid", "false");
			});
			text.inputEl.setAttribute("aria-label", t.url);
			text.inputEl.type = "url";
		});
		urlSetting.settingEl.addClass("feishu-lark-published-url");
		this.addActions(t.save, t.saving, () => this.host.saveBindingUrl(this.entry, url.trim()));
		if (input) {
			input.inputEl.setAttribute("aria-describedby", this.feedbackEl.id = `published-link-error-${Date.now()}`);
			input.inputEl.focus();
		}
	}
}

class DisconnectPublishedLinkModal extends PublishedLinkActionModal {
	onOpen(): void {
		this.active = true;
		const t = messages(this.host);
		this.titleEl.setText(t.disconnect);
		this.contentEl.createEl("p", { text: this.entry.path || "/", cls: "feishu-lark-published-path" });
		this.contentEl.createEl("p", { text: this.entry.kind === "folder" ? t.folderLocalOnly : t.localOnly });
		this.addActions(t.disconnect, t.removing, () => this.host.removeBinding(this.entry), true);
	}
}
