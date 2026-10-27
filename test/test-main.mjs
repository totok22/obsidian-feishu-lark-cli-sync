import assert from "node:assert/strict";
import esbuild from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/main.ts"],
	format: "esm",
	outfile: "test/.tmp-main-test.mjs",
	platform: "node",
	target: "node20",
	plugins: [{
		name: "obsidian-test-stub",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: "obsidian",
				namespace: "obsidian-test-stub"
			}));
			build.onLoad({ filter: /.*/, namespace: "obsidian-test-stub" }, () => ({
				contents: `
					export const addIcon = () => {};
					export const loadPdfJs = async () => { throw new Error("PDF.js not stubbed"); };
					export const setIcon = () => {};
					export class ItemView {}
					export class App {}
					export class FileSystemAdapter {}
					export class Menu {}
					export class Modal {}
					export class ButtonComponent {}
					export class TextComponent {}
					export class TFolder {}
					export class Notice {
						constructor(message, timeout) {
							globalThis.__obsidianNotices?.push({ message, timeout });
						}
						setMessage(message) { globalThis.__obsidianNoticeUpdates?.push(message); return this; }
						hide() { globalThis.__obsidianNoticeHidden?.push(true); }
					}
					export class Plugin {}
					export class PluginSettingTab {}
					export class Setting {}
					export class TFile {}
					globalThis.__TFileClass = TFile;
					globalThis.__TFolderClass = TFolder;
				`
			}));
		}
	}]
});

const { default: LarkCliSyncPlugin } = await import("./.tmp-main-test.mjs");
const TestFile = globalThis.__TFileClass;
const TestFolder = globalThis.__TFolderClass;
delete globalThis.__TFolderClass;

function createPlugin() {
	const plugin = Object.create(LarkCliSyncPlugin.prototype);
	plugin.settings = {
		language: "zh-CN",
		updateFrontmatter: false,
		documentBindings: {},
		pendingDocumentCreates: {},
		pendingFolderCreates: {},
		disconnectedBindings: {},
		disconnectedFolders: {},
		pdfBindings: {},
		folderBindings: {},
		publishedFolders: {},
		targetTokenOrUrl: ""
	};
	plugin.saveData = async () => {};
	return plugin;
}

function installVaultTree(vault) {
	const buildTree = () => {
		const root = Object.assign(new TestFolder(), { path: "/", children: [] });
		const nodes = new Map([["", root], ["/", root]]);
		const files = new Map([...(vault.getFiles?.() || []), ...(vault.getMarkdownFiles?.() || [])]
			.map((file) => [file.path, file]));
		for (const file of files.values()) {
			const parts = file.path.split("/");
			let parent = root;
			for (let depth = 1; depth < parts.length; depth++) {
				const path = parts.slice(0, depth).join("/");
				if (!nodes.has(path)) {
					const folder = Object.assign(new TestFolder(), { path, children: [] });
					nodes.set(path, folder);
					parent.children.push(folder);
				}
				parent = nodes.get(path);
			}
			const node = Object.assign(new TestFile(), file);
			nodes.set(file.path, node);
			parent.children.push(node);
		}
		return nodes;
	};
	vault.getAbstractFileByPath = (path) => buildTree().get(path) || null;
	vault.getRoot = () => buildTree().get("/");
}

const policyPlugin = createPlugin();
assert.deepEqual(policyPlugin.getRemoteStateRefreshPolicy("save"), {
	attempts: 8,
	delayMs: 1500,
	allowTimeoutFallback: true
});

const diagnosticPlugin = createPlugin();
const diagnosticWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
	diagnosticWarnings.push(args);
};
try {
	diagnosticPlugin.logRemoteStateRefreshTimeout("doc-token", 8, 15, {
		rejectReason: "revision-lag",
		observedRevisionId: 14
	});

	const incompleteState = {
		doc: "doc-token",
		revisionId: 15,
		contentHash: "hash",
		units: [{
			stableId: "0:paragraph",
			kind: "paragraph",
			hash: "hash",
			blockId: ""
		}],
		updatedAt: "2026-08-13T00:00:00.000Z"
	};
	diagnosticPlugin.logRemoteStateRefreshTimeout(
		"doc-token",
		8,
		15,
		diagnosticPlugin.createBlockMappingDiagnostic(incompleteState)
	);
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(diagnosticWarnings[0][1], {
	doc: "doc-token",
	attempts: 8,
	expectedRevisionId: 15,
	observedRevisionId: 14,
	unitCount: undefined,
	missingBlockIdCount: undefined,
	rejectReason: "revision-lag"
});
assert.deepEqual(diagnosticWarnings[1][1], {
	doc: "doc-token",
	attempts: 8,
	expectedRevisionId: 15,
	observedRevisionId: 15,
	unitCount: 1,
	missingBlockIdCount: 1,
	rejectReason: "block-mapping-incomplete"
});

const retryPlugin = createPlugin();
let fetchCount = 0;
const sleepDelays = [];
let persistedState;
const confirmedState = {
	doc: "doc-token",
	revisionId: 15,
	contentHash: "hash",
	units: [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: "hash",
		blockId: "block-1"
	}],
	updatedAt: "2026-08-13T00:00:00.000Z"
};
retryPlugin.fetchRemoteDocumentStateAfterExpectedRevision = async () => {
	fetchCount += 1;
	return fetchCount < 8
		? undefined
		: confirmedState;
};
retryPlugin.sleep = async (delayMs) => {
	sleepDelays.push(delayMs);
};
retryPlugin.persistDocumentState = async (state) => {
	persistedState = state;
};
await retryPlugin.saveRemoteDocumentState("doc-token", [], {
	expectedRevisionId: 15,
	updateSubmitted: true,
	context: { mode: "save", path: "docs/a.md" },
	refreshPolicy: retryPlugin.getRemoteStateRefreshPolicy("save")
});
assert.equal(fetchCount, 8);
assert.deepEqual(sleepDelays, Array(7).fill(1500));
assert.equal(persistedState, confirmedState);

const wiringPlugin = createPlugin();
let confirmationOptions;
wiringPlugin.withTempMarkdown = async (_baseName, _content, callback) => {
	return await callback({ directory: "/tmp", fileName: "sync.md" });
};
wiringPlugin.runLarkCli = async () => ({
	ok: true,
	data: { document: { revision_id: 15 } }
});
wiringPlugin.saveRemoteDocumentState = async (_doc, _stateKeys, options) => {
	confirmationOptions = options;
};
await wiringPlugin.executeSyncPlan("doc-token", { content: "Body", images: [] }, {
	mode: "precise",
	commands: [{
		doc: "doc-token",
		command: "block_delete",
		blockId: "block-1"
	}],
	contentHash: "hash"
}, {
	mode: "save",
	path: "docs/a.md",
	stateKeys: []
});
assert.equal(confirmationOptions.expectedRevisionId, 15);
assert.equal(confirmationOptions.updateSubmitted, true);
assert.deepEqual(confirmationOptions.refreshPolicy, {
	attempts: 8,
	delayMs: 1500,
	allowTimeoutFallback: true
});

const createBindingPlugin = createPlugin();
createBindingPlugin.withTempMarkdown = async (_baseName, _content, callback) => {
	return await callback({ directory: "/tmp", fileName: "note.md" });
};
createBindingPlugin.resolveRemoteRootParent = async () => ({ token: "parent-token" });
createBindingPlugin.runLarkCli = async () => ({
	ok: true,
	data: { document: { document_id: "created-token", url: "https://example.com/docx/created-token" } }
});
createBindingPlugin.materializeLocalImages = async () => {
	throw new Error("image upload failed");
};
let provisionalBinding;
await assert.rejects(
	createBindingPlugin.createLarkDocument(
		{ basename: "Note", path: "Note.md" },
		{ content: "Body", images: [{}] },
		undefined,
		async (binding) => {
			provisionalBinding = binding;
		}
	),
	/image upload failed/
);
assert.deepEqual(provisionalBinding, {
	token: "created-token",
	url: "https://example.com/docx/created-token"
});

const stagedCreatePlugin = createPlugin();
const stagedCreateEvents = [];
const stagedTempContents = [];
const stagedBatchContents = [];
stagedCreatePlugin.withTempMarkdown = async (_baseName, content, callback) => {
	stagedTempContents.push(content);
	return await callback({ directory: "/tmp", fileName: "note.md" });
};
stagedCreatePlugin.writeTempMarkdown = async (_directory, _baseName, content) => {
	stagedBatchContents.push(content);
	return `batch-${stagedBatchContents.length}.md`;
};
stagedCreatePlugin.resolveRemoteRootParent = async () => ({ token: "parent-token" });
stagedCreatePlugin.runLarkCli = async (args) => {
	if (args[1] === "+create") {
		stagedCreateEvents.push("create");
		return {
			ok: true,
			data: { document: { document_id: "large-token", url: "https://example.com/docx/large-token" } }
		};
	}
	stagedCreateEvents.push("append");
	return {
		ok: true,
		data: { document: { revision_id: stagedCreateEvents.length } }
	};
};
stagedCreatePlugin.materializeLocalImages = async () => {};
const largeBodyUnits = Array.from({ length: 401 }, (_, index) => `Paragraph ${index}`).join("\n\n");
await stagedCreatePlugin.createLarkDocument(
	{ basename: "Large", path: "Large.md" },
	{ content: `# Large\n\n${largeBodyUnits}`, images: [] },
	undefined,
	async () => {
		stagedCreateEvents.push("bind");
	}
);
assert.equal(stagedTempContents[0], "");
assert.deepEqual(stagedCreateEvents.slice(0, 3), ["create", "bind", "append"]);
assert.equal(stagedBatchContents.length, 5);

const stagedResumePlugin = createPlugin();
stagedResumePlugin.findDocumentState = () => undefined;
stagedResumePlugin.fetchLarkDocumentMarkdown = async () => ({
	content: `# Large\n\n${Array.from({ length: 100 }, (_, index) => `Paragraph ${index}`).join("\n\n")}`,
	revisionId: 10
});
let resumedBatches;
stagedResumePlugin.appendStagedDocumentBatches = async (_doc, batches) => {
	resumedBatches = batches;
	return 20;
};
stagedResumePlugin.materializeLocalImages = async () => undefined;
let resumedBaseline;
stagedResumePlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision = async (
	_doc,
	_stateKeys,
	baselineMarkdown,
	expectedRevisionId
) => {
	resumedBaseline = { baselineMarkdown, expectedRevisionId };
};
const resumedDocument = await stagedResumePlugin.tryResumeStagedDocumentPublish(
	"large-token",
	{ content: `# Large\n\n${largeBodyUnits}`, images: [] },
	{ mode: "manual", path: "large.md", stateKeys: [] }
);
assert.equal(resumedDocument.revisionId, 20);
assert.equal(resumedBatches.length, 4);
assert.deepEqual(resumedBaseline, {
	baselineMarkdown: `# Large\n\n${largeBodyUnits}`,
	expectedRevisionId: 20
});

const bindingWriterPlugin = createPlugin();
bindingWriterPlugin.settings.updateFrontmatter = true;
const writtenFrontmatter = {
	lark_doc_token: "legacy-token"
};
bindingWriterPlugin.selfWrittenPaths = new Map();
bindingWriterPlugin.getBinding = () => null;
bindingWriterPlugin.app = {
	vault: {
		read: async () => "Body",
		modify: async () => {}
	},
	fileManager: {
		processFrontMatter: async (_file, update) => update(writtenFrontmatter)
	}
};
await bindingWriterPlugin.writeBinding({ path: "note.md" }, {
	token: "created-token",
	url: "https://example.com/wiki/wiki-node"
});
assert.deepEqual(writtenFrontmatter, {
	lark_doc_url: "https://example.com/wiki/wiki-node"
});

const aliasBootstrapPlugin = createPlugin();
const reusableState = {
	doc: "doc-token",
	revisionId: 4,
	contentHash: "previous-hash",
	units: [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: "body-hash",
		blockId: "block-1"
	}],
	updatedAt: "2026-08-16T00:00:00.000Z"
};
aliasBootstrapPlugin.syncState = {
	version: 1,
	documents: { "doc-token": reusableState }
};
aliasBootstrapPlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: "doc-token",
	content: "# Note\n\nBody",
	revisionId: 4
});
aliasBootstrapPlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<title id=\"doc-token\">Note</title><p id=\"block-1\">Body</p>",
	revisionId: 4
});
let persistedAliasState;
aliasBootstrapPlugin.persistDocumentState = async (state) => {
	persistedAliasState = state;
};
const bootstrappedAliasState = await aliasBootstrapPlugin.tryBootstrapPreciseSyncState(
	"https://example.com/wiki/wiki-node",
	["https://example.com/wiki/wiki-node"],
	"# Note\n\nBody\n\nFEISHU_LARK_LOCAL_IMAGE_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);
assert.equal(bootstrappedAliasState, reusableState);
assert.equal(persistedAliasState, reusableState);

const timeoutPlugin = createPlugin();
timeoutPlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<p id=\"block-1\">Body</p>",
	revisionId: 14
});
const timeoutDiagnostics = [];
timeoutPlugin.logRemoteStateRefreshTimeout = (...args) => {
	timeoutDiagnostics.push(args);
};
timeoutPlugin.sleep = async () => {};
const warnings = [];
console.warn = (...args) => {
	warnings.push(args);
};
let timeoutError;
try {
	await timeoutPlugin.saveRemoteDocumentState("doc-token", [], {
		expectedMarkdown: "Body",
		expectedRevisionId: 15,
		updateSubmitted: true,
		context: { mode: "save", path: "docs/a.md" },
		refreshPolicy: timeoutPlugin.getRemoteStateRefreshPolicy("save")
	});
} catch (error) {
	timeoutError = error;
} finally {
	console.warn = originalWarn;
}
assert.equal(timeoutError?.updateSubmitted, true);
assert.equal(warnings.length, 0);
assert.deepEqual(timeoutDiagnostics, [["doc-token", 8, 15, {
	rejectReason: "revision-lag",
	observedRevisionId: 14
}]]);

const overwritePlugin = createPlugin();
overwritePlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<p id=\"block-1\">Body</p>",
	revisionId: 15
});
overwritePlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: "doc-token",
	content: "stale",
	revisionId: 15
});
overwritePlugin.isRemoteMarkdownContentEquivalent = async () => false;
overwritePlugin.sleep = async () => {};
const overwriteDiagnostics = [];
overwritePlugin.logRemoteStateRefreshTimeout = (...args) => {
	overwriteDiagnostics.push(args);
};
let overwriteError;
try {
	await overwritePlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
		"doc-token",
		[],
		"Body",
		15,
		{ mode: "save", path: "docs/a.md" }
	);
} catch (error) {
	overwriteError = error;
}
assert.equal(overwriteError?.updateSubmitted, true);
assert.deepEqual(overwriteDiagnostics, [["doc-token", 8, 15, {
	rejectReason: "content-not-equivalent",
	observedRevisionId: 15
}]]);

const roundTripPlugin = createPlugin();
const roundTripBaseline = '# Note\n\n# Original heading\n\nSee <cite type="doc" doc-id="linkedDoc"></cite>.\n\n[Video\\_guide](https://example.com/?id=Ab%2BC%3D%3D&share_id=first_value)';
roundTripPlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: '<title id="doc-token">Note</title><h1 id="redundant-title">Note</h1><h1 id="heading">Original heading</h1><p id="reference">See <cite doc-id="linkedDoc" file-type="docx" title="Linked_note" type="doc"></cite>.</p><p id="video"><a href="https://example.com/?id=Ab+C==&amp;share_id=first_value">Video_guide</a></p>',
	revisionId: 16
});
roundTripPlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: "doc-token",
	content: '# Note\n\n# Original heading\n\nSee <cite doc-id="linkedDoc" file-type="docx" title="Linked_note" type="doc"></cite>.\n\n[Video\\_guide](https://example.com/?id=Ab+C==&share_id=first_value)',
	revisionId: 16
});
let roundTripState;
roundTripPlugin.persistDocumentState = async (state) => { roundTripState = state; };
roundTripPlugin.sleep = async () => { throw new Error("equivalent content should confirm immediately"); };
await roundTripPlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
	"doc-token", [], roundTripBaseline, 16, { mode: "save", path: "docs/note.md" }
);
assert.equal(roundTripState.revisionId, 16);
assert.deepEqual(roundTripState.units.map((unit) => unit.blockId), ["heading", "reference", "video"]);

const headingImagePlugin = createPlugin();
headingImagePlugin.settings.titleSource = 'file-name';
headingImagePlugin.app = { vault: { read: async () => '# <img src="https://example.com/logo.png" height="32" /> Guide\n\nBody\n\n- Repositories: <https://example.com/repos>' } };
const headingImagePrepared = await headingImagePlugin.readNoteForLark({ basename: 'Note', path: 'Note.md' });
assert.equal(headingImagePrepared.content, '# Note\n\n# Guide\n\n<img src="https://example.com/logo.png" height="32" />\n\nBody\n\n- Repositories: <https://example.com/repos>');
assert.deepEqual(headingImagePrepared.images, [], 'external images should be imported directly');
headingImagePlugin.fetchLarkDocumentWithIds = async () => ({
	doc: 'doc-token', revisionId: 17,
	content: '<title id="doc-token">Note</title><h1 id="guide">Guide</h1><img id="logo" src="rehosted"/><p id="body">Body</p><ul><li id="repos">Repositories: <a href="https://example.com/repos">https://example.com/repos</a></li></ul>'
});
headingImagePlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: 'doc-token', revisionId: 17,
	content: '# Note\n\n# Guide\n\n![](https://feishu.cn/file/rehosted)\n\nBody\n\n- Repositories: [https://example.com/repos](https://example.com/repos)'
});
let headingImageState;
headingImagePlugin.persistDocumentState = async (state) => { headingImageState = state; };
headingImagePlugin.sleep = async () => { throw new Error('rehosted external images should confirm immediately'); };
await headingImagePlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision('doc-token', [], headingImagePrepared.content, 17, { mode: 'save', path: 'Note.md' });
assert.deepEqual(headingImageState.units.map((unit) => unit.blockId), ['guide', 'logo', 'body', 'repos']);

const noticePlugin = createPlugin();
noticePlugin.autoSyncRunningPaths = new Set();
noticePlugin.autoSyncPendingPaths = new Set();
noticePlugin.syncFileInternal = async () => {
	throw timeoutError;
};
globalThis.__obsidianNotices = [];
console.warn = () => {};
try {
	await noticePlugin.runSaveAutoSync({ path: "docs/a.md" });
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "内容已提交，但远端状态确认超时：docs/a.md\n请稍后检查飞书文档。",
	timeout: 10000
}]);
delete globalThis.__obsidianNotices;

const deletedRemotePlugin = createPlugin();
deletedRemotePlugin.autoSyncRunningPaths = new Set();
deletedRemotePlugin.autoSyncPendingPaths = new Set();
deletedRemotePlugin.selfWrittenPaths = new Map();
deletedRemotePlugin.syncStateChangedKeys = new Set();
deletedRemotePlugin.syncStateRemovedKeys = new Set();
deletedRemotePlugin.syncState = {
	version: 1,
	documents: {
		"deleted-token": {
			doc: "deleted-token",
			contentHash: "hash",
			units: [],
			updatedAt: "2026-08-27T00:00:00.000Z"
		}
	}
};
const deletedRemoteBinding = {
	token: "deleted-token",
	url: "https://example.feishu.cn/docx/deleted-token"
};
deletedRemotePlugin.getBinding = () => deletedRemoteBinding;
deletedRemotePlugin.syncFileInternal = async () => {
	throw new Error('{"code":3380003,"message":"Document page has been deleted"}');
};
deletedRemotePlugin.settings.updateFrontmatter = true;
const deletedRemoteFrontmatter = {
	lark_doc: "legacy",
	lark_doc_url: deletedRemoteBinding.url,
	lark_doc_token: deletedRemoteBinding.token,
	lark_doc_synced_at: "2026-08-27",
	remoteRoot: "root",
	remoteParentPath: "path",
	tags: ["sync"]
};
deletedRemotePlugin.app = {
	metadataCache: { getFileCache: () => ({ frontmatter: deletedRemoteFrontmatter }) },
	vault: {
		getAbstractFileByPath: () => ({ path: "docs/deleted-remote.md" })
	},
	fileManager: {
		processFrontMatter: async (_file, update) => update(deletedRemoteFrontmatter)
	}
};
let deletedRemoteStateSaved = false;
deletedRemotePlugin.saveLarkSyncState = async () => {
	deletedRemoteStateSaved = true;
};
const deletedRemoteWarnings = [];
globalThis.__obsidianNotices = [];
console.warn = (...args) => {
	deletedRemoteWarnings.push(args);
};
try {
	await deletedRemotePlugin.runSaveAutoSync({ path: "docs/deleted-remote.md" });
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(deletedRemoteFrontmatter, { tags: ["sync"] });
assert.equal(deletedRemotePlugin.syncState.documents["deleted-token"], undefined);
assert.equal(deletedRemoteStateSaved, true);
assert.equal(deletedRemoteWarnings.length, 1);
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "飞书文档远端已删除，已自动解绑：docs/deleted-remote.md\n如需重新发布，请再次执行“同步到飞书”。",
	timeout: 10000
}]);
delete globalThis.__obsidianNotices;

const deletedNotePlugin = createPlugin();
deletedNotePlugin.autoSyncRunningPaths = new Set();
deletedNotePlugin.autoSyncPendingPaths = new Set();
deletedNotePlugin.app = {
	vault: {
		getAbstractFileByPath: () => null
	}
};
deletedNotePlugin.syncFileInternal = async () => {
	const error = new Error("ENOENT: no such file or directory");
	error.code = "ENOENT";
	throw error;
};
const autoSyncErrors = [];
const originalError = console.error;
globalThis.__obsidianNotices = [];
console.error = (...args) => {
	autoSyncErrors.push(args);
};
try {
	await deletedNotePlugin.runSaveAutoSync({ path: "docs/deleted.md" });
} finally {
	console.error = originalError;
}
assert.deepEqual(globalThis.__obsidianNotices, []);
assert.deepEqual(autoSyncErrors, []);
delete globalThis.__obsidianNotices;

deletedNotePlugin.app.vault.getAbstractFileByPath = () => ({ path: "docs/existing.md" });
const existingNoteErrors = [];
globalThis.__obsidianNotices = [];
console.error = (...args) => {
	existingNoteErrors.push(args);
};
try {
	await deletedNotePlugin.runSaveAutoSync({ path: "docs/existing.md" });
} finally {
	console.error = originalError;
}
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "自动同步失败：docs/existing.md\nENOENT: no such file or directory",
	timeout: 10000
}]);
assert.equal(existingNoteErrors.length, 1);
delete globalThis.__obsidianNotices;


// First publish without frontmatter remains bound through metadata lag and failed post-write work.
function createPublishingPlugin() {
	const plugin = createPlugin();
	plugin.settings.openAfterSync = false;
	plugin.settings.titleSource = "file-name";
	plugin.selfWrittenPaths = new Map();
	plugin.syncState = { version: 1, documents: {} };
	plugin.syncStateChangedKeys = new Set();
	plugin.syncStateRemovedKeys = new Set();
	plugin.saveLarkSyncState = async () => {};
	plugin.app = {
		metadataCache: { getFileCache: () => null },
		vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null,
			read: async () => "# Note\n\nBody" },
		fileManager: { processFrontMatter: async () => { throw new Error("Unexpected frontmatter write"); } }
	};
	installVaultTree(plugin.app.vault);
	plugin.readNoteForLark = async () => ({ content: "# Note\n\nBody", images: [] });
	plugin.resolvePublishedFolderParentForFile = async () => null;
	plugin.resolveRemoteRootParent = async () => ({ kind: "my_library", token: "" });
	plugin.withTempMarkdown = async (_name, _content, callback) => callback({ directory: "/tmp", fileName: "note.md" });
	plugin.materializeLocalImages = async () => {};
	plugin.saveCreatedDocumentStateFromBaseline = async () => {};
	return plugin;
}

// Folder collection must stay in the selected subtree, without a global vault listing.
const scopedPlugin = createPublishingPlugin();
const scopedNote = Object.assign(new TestFile(), { path: "Root/Note.md", extension: "md" });
const nestedNote = Object.assign(new TestFile(), { path: "Root/Sub/Deep.md", extension: "md" });
const scopedPdf = Object.assign(new TestFile(), { path: "Root/Sub/Scan.pdf", extension: "pdf" });
const outsideNote = Object.assign(new TestFile(), { path: "Root-other/Private.md", extension: "md" });
const subFolder = Object.assign(new TestFolder(), { path: "Root/Sub", children: [scopedPdf, nestedNote] });
const selectedFolder = Object.assign(new TestFolder(), { path: "Root", children: [scopedNote, subFolder] });
let outsideVisits = 0;
const outsideFolder = Object.assign(new TestFolder(), { path: "Root-other" });
Object.defineProperty(outsideFolder, "children", { get: () => { outsideVisits++; return [outsideNote]; } });
const vaultRoot = Object.assign(new TestFolder(), { path: "/", children: [selectedFolder, outsideFolder] });
const scopedNodes = new Map([["Root", selectedFolder], ["Root/Sub", subFolder], ["Root/Note.md", scopedNote], ["/", vaultRoot]]);
scopedPlugin.app.vault = {
	getAbstractFileByPath: (path) => scopedNodes.get(path) || null,
	getRoot: () => vaultRoot,
	getFiles: () => assert.fail("Folder collection must not enumerate the vault"),
	getMarkdownFiles: () => assert.fail("Folder collection must not enumerate all Markdown")
};
assert.deepEqual(scopedPlugin.collectFolderFiles("Root").map((file) => file.path).sort(),
	["Root/Note.md", "Root/Sub/Deep.md", "Root/Sub/Scan.pdf"]);
assert.deepEqual(scopedPlugin.collectMarkdownFiles("Root").map((file) => file.path), ["Root/Note.md", "Root/Sub/Deep.md"]);
assert.deepEqual(scopedPlugin.collectFolderFiles("Missing"), []);
assert.deepEqual(scopedPlugin.collectFolderFiles("Root/Note.md"), []);
assert.equal(outsideVisits, 0, "sibling folders are never visited");
assert.equal(scopedPlugin.collectFolderFiles("").length, 4, "the vault root can still be selected explicitly");
assert.equal(scopedPlugin.collectFolderFiles("/").length, 4);

// Image changes read only bound notes through Obsidian, including legacy frontmatter bindings.
const referencePlugin = createPublishingPlugin();
const referenceNotes = ["Linked.md", "Unrelated.md", "Unbound.md", "Disconnected.md", "Legacy.md", "Missing.md"]
	.map((path) => ({ path, extension: "md" }));
referencePlugin.settings.documentBindings = Object.fromEntries(["Linked.md", "Unrelated.md", "Disconnected.md", "Missing.md"]
	.map((path) => [path, { token: path, url: "" }]));
referencePlugin.settings.disconnectedBindings = { "Disconnected.md": true };
referencePlugin.app.metadataCache.getFileCache = (file) => file.path === "Legacy.md"
	? { frontmatter: { lark_doc_url: "https://example.feishu.cn/docx/legacy" } } : null;
referencePlugin.app.vault.getMarkdownFiles = () => referenceNotes;
const referenceReads = [], referenceQueued = [];
referencePlugin.app.vault.read = async (file) => {
	referenceReads.push(file.path);
	if (file.path === "Missing.md") throw new Error("File was deleted");
	return file.path === "Unrelated.md" ? "![[other.png]]" : "![[photo.png]]";
};
referencePlugin.getVaultRoot = () => "/nonexistent-reference-test-vault";
referencePlugin.queueSaveAutoSync = (file) => referenceQueued.push(file.path);
await referencePlugin.queueImageReferenceAutoSync(["photo.png"]);
assert.deepEqual(referenceReads, ["Linked.md", "Unrelated.md", "Legacy.md", "Missing.md"]);
assert.deepEqual(referenceQueued, ["Legacy.md", "Linked.md"]);

// A note with a video must use the Vault media index, while the gallery stays image-only.
const mediaVault = await mkdtemp(join(tmpdir(), "vault-video-index-"));
try {
	await writeFile(join(mediaVault, "clip.mp4"), "video-content");
	const mediaNote = { path: "Note.md", basename: "Note", name: "Note.md", extension: "md" };
	const mediaPlugin = createPlugin();
	mediaPlugin.app = { vault: {
		read: async () => "![[clip.mp4]]",
		getFiles: () => [mediaNote, { path: "clip.mp4" }, { path: "image.png" }]
	} };
	mediaPlugin.getVaultRoot = () => mediaVault;
	const preparedMedia = await mediaPlugin.readNoteForLark(mediaNote);
	assert.equal(preparedMedia.images.length, 1);
	assert.equal(preparedMedia.images[0].mediaType, "video");
	assert.equal(preparedMedia.images[0].vaultPath, "clip.mp4");
	assert.deepEqual([...mediaPlugin.buildVaultImageIndex().paths], ["image.png"]);
} finally {
	await rm(mediaVault, { recursive: true, force: true });
}

const publishOptions = { allowCreate: true, openAfterSync: false, showSuccess: false,
	showRemoteDeletedNotice: false, updateFrontmatter: false, mode: "manual" };
const fakeNote = { path: "docs/Note.md", basename: "Note", name: "Note.md", extension: "md" };
const canonicalBinding = { token: "remote-doc", url: "https://example.feishu.cn/docx/remote-doc" };
const concurrentPlugin = createPublishingPlugin();
let createdCount = 0, updatedCount = 0;
const savedSnapshots = [];
concurrentPlugin.saveData = async (settings) => { savedSnapshots.push(settings); };
concurrentPlugin.runLarkCli = async () => {
	createdCount++;
	await new Promise((resolve) => setTimeout(resolve, 5));
	return { ok: true, data: { document: { document_id: canonicalBinding.token, url: canonicalBinding.url } } };
};
concurrentPlugin.updateLarkDocument = async () => { updatedCount++; return {}; };
await Promise.all([
	concurrentPlugin.syncFileInternal(fakeNote, publishOptions),
	concurrentPlugin.syncFileInternal(fakeNote, publishOptions),
	concurrentPlugin.syncFileInternal(fakeNote, { ...publishOptions, mode: "save", allowCreate: false })
]);
assert.equal(createdCount, 1, "overlapping manual/save publishes must create only once");
assert.equal(updatedCount, 2);
assert.equal(concurrentPlugin.getBinding(fakeNote).token, canonicalBinding.token);
assert.ok(savedSnapshots.some((data) => data.documentBindings[fakeNote.path]?.token === canonicalBinding.token));
const restartPlugin = createPublishingPlugin();
restartPlugin.settings = JSON.parse(JSON.stringify(savedSnapshots.at(-1)));
assert.equal(restartPlugin.getBinding(fakeNote).token, canonicalBinding.token, "binding survives a plugin restart without frontmatter");

const partialPublishPlugin = createPublishingPlugin();
let partialCreates = 0;
partialPublishPlugin.runLarkCli = async () => { partialCreates++; return {
	ok: true, data: { document: { document_id: canonicalBinding.token, url: canonicalBinding.url } }
}; };
partialPublishPlugin.materializeLocalImages = async () => { throw new Error("image upload failed after creation"); };
await assert.rejects(partialPublishPlugin.syncFileInternal(fakeNote, publishOptions), /image upload failed/);
assert.equal(partialPublishPlugin.getBinding(fakeNote).token, canonicalBinding.token);
partialPublishPlugin.updateLarkDocument = async () => ({});
await partialPublishPlugin.syncFileInternal(fakeNote, publishOptions);
assert.equal(partialCreates, 1, "retry after image failure must reuse the created document");

const ambiguousFailurePlugin = createPublishingPlugin();
ambiguousFailurePlugin.updateLarkDocument = async () => { throw new Error("block not found"); };
ambiguousFailurePlugin.createLarkDocument = async () => { throw new Error("Must not recreate on missing blocks"); };
await assert.rejects(ambiguousFailurePlugin.syncOrRecreateDocument(fakeNote, canonicalBinding,
	{ content: "Body", images: [] }, undefined, { ...publishOptions, allowRecreate: true, path: fakeNote.path }), /block not found/);
assert.equal(ambiguousFailurePlugin.isRemoteDocumentDeletedError(new Error("image not exist")), false);
assert.equal(ambiguousFailurePlugin.isRemoteDocumentDeletedError(new Error("3380003 Document page has been deleted")), true);

const cacheLagPlugin = createPublishingPlugin();
cacheLagPlugin.settings.documentBindings[fakeNote.path] = canonicalBinding;
cacheLagPlugin.app.metadataCache.getFileCache = () => ({ frontmatter: { lark_doc_url: "https://example.feishu.cn/docx/stale" } });
assert.deepEqual(cacheLagPlugin.getBinding(fakeNote), canonicalBinding);
const legacyPlugin = createPublishingPlugin();
legacyPlugin.app.metadataCache.getFileCache = () => ({ frontmatter: { lark_doc_url: canonicalBinding.url } });
assert.equal(legacyPlugin.getBinding(fakeNote).url, canonicalBinding.url);

const renamedPlugin = createPublishingPlugin();
renamedPlugin.getVaultRoot = () => "/tmp/vault";
renamedPlugin.settings.documentBindings = { "docs/Note.md": canonicalBinding, "docs-other.md": { token: "other", url: "" } };
renamedPlugin.settings.publishedFolders = { docs: { rootParent: { kind: "my_library", token: "" }, remoteRoot: "docs" } };
await renamedPlugin.moveLocalBindings("docs", "renamed");
assert.equal(renamedPlugin.getBinding({ path: "renamed/Note.md" }).token, canonicalBinding.token);
assert.equal(renamedPlugin.settings.documentBindings["docs/Note.md"], undefined);
assert.equal(renamedPlugin.settings.documentBindings["docs-other.md"].token, "other");
assert.ok(renamedPlugin.settings.publishedFolders.renamed);
assert.equal(renamedPlugin.settings.publishedFolders.renamed.remoteRoot, "docs", "rename preserves the existing remote root");

const folderRegistryPlugin = createPublishingPlugin();
folderRegistryPlugin.settings.publishedFolders = { "notes/docs": { rootParent: { kind: "my_library", token: "" }, remoteRoot: "docs" } };
folderRegistryPlugin.settings.folderBindings = {
	"my_library|my_library||docs": { token: "root-node", url: "https://example.feishu.cn/wiki/root-node" },
	"my_library|my_library||docs/sub": { token: "sub-node", url: "https://example.feishu.cn/wiki/sub-node" },
	"my_library|my_library||docs-other": { token: "other-node", url: "https://example.feishu.cn/wiki/other-node" }
};
folderRegistryPlugin.settings.documentBindings["notes/docs/Note.md"] = canonicalBinding;
folderRegistryPlugin.settings.targetTokenOrUrl = "https://example.feishu.cn/wiki/new-default";
assert.equal(folderRegistryPlugin.getPublishedEntry("notes/docs/sub", "folder").token, "sub-node");
await folderRegistryPlugin.disconnectFolderBinding("notes/docs");
assert.equal(folderRegistryPlugin.settings.folderBindings["my_library|my_library||docs"], undefined);
assert.equal(folderRegistryPlugin.settings.folderBindings["my_library|my_library||docs/sub"], undefined);
assert.equal(folderRegistryPlugin.settings.folderBindings["my_library|my_library||docs-other"].token, "other-node");
assert.equal(folderRegistryPlugin.settings.documentBindings["notes/docs/Note.md"].token, "remote-doc");

// Removing a published folder forgets every descendant record, while changing its URL above preserves note links.
function createUnlinkTreePlugin() {
	const plugin = createPublishingPlugin();
	const files = ["Root/Sub/Legacy.md", "Root/Sub/Saved.md", "Root/Sibling.md", "Root/Sub-other/Keep.md"]
		.map((path) => Object.assign(new TestFile(), { path, extension: "md" }));
	plugin.app.vault.getMarkdownFiles = () => files;
	plugin.app.metadataCache.getFileCache = (file) => file.path.endsWith("Legacy.md")
		? { frontmatter: { lark_doc_url: "https://example.feishu.cn/docx/legacy-doc" } } : null;
	plugin.app.vault.read = plugin.app.vault.modify = () => assert.fail("Unlink must not read or edit note content");
	plugin.runLarkCli = () => assert.fail("Unlink must not touch remote files");
	plugin.settings.publishedFolders = {
		Root: { rootParent: { kind: "drive", token: "parent" }, remoteRoot: "Remote" },
		"Root/Sub/Separate": { rootParent: { kind: "wiki", token: "other-parent" }, remoteRoot: "Separate" }
	};
	plugin.settings.folderBindings = {
		"target|drive|parent|Remote": { token: "root", url: "" },
		"target|drive|parent|Remote/Sub": { token: "sub", url: "" },
		"target|drive|parent|Remote/Sub/Deep": { token: "deep", url: "" },
		"target|drive|parent|Remote/Sub-other": { token: "keep-folder", url: "" },
		"target|wiki|other-parent|Separate": { token: "separate", url: "" },
		"target|wiki|unrelated|Remote/Sub": { token: "unrelated-folder", url: "" }
	};
	plugin.settings.pendingFolderCreates = {
		"target|drive|parent|Remote/Sub/Pending": "Pending",
		"target|drive|parent|Remote/Sub-other/Pending": "Keep"
	};
	plugin.settings.documentBindings = {
		"Root/Sub/Saved.md": { token: "saved-doc", nodeToken: "saved-node", url: "https://example.feishu.cn/wiki/saved-node" },
		"Root/Sub/Missing.md": { token: "missing-doc", url: "" },
		"Root/Sibling.md": { token: "sibling-doc", url: "" },
		"Root/Sub-other/Keep.md": { token: "keep-doc", url: "" }
	};
	plugin.settings.pendingDocumentCreates = {
		"Root/Sub/Pending.md": { title: "Pending", startedAt: "now" },
		"Root/Sub-other/Pending.md": { title: "Keep", startedAt: "now" }
	};
	plugin.settings.pdfBindings = {
		"Root/Sub/Manual.pdf": { fileToken: "pdf" },
		"Root/Sub/Separate/Pending.pdf": { status: "pending" },
		"Root/Sub-other/Keep.pdf": { fileToken: "keep-pdf" }
	};
	for (const key of ["saved-doc", "saved-node", "https://example.feishu.cn/wiki/saved-node", "missing-doc", "legacy-doc", "keep-doc"]) {
		plugin.syncState.documents[key] = { doc: key, units: [] };
	}
	return plugin;
}
const cascadePlugin = createUnlinkTreePlugin();
await cascadePlugin.disconnectPublishedBinding({ path: "Root/Sub", kind: "folder" });
assert.deepEqual(Object.keys(cascadePlugin.settings.documentBindings).sort(), ["Root/Sibling.md", "Root/Sub-other/Keep.md"]);
assert.deepEqual(Object.keys(cascadePlugin.settings.pdfBindings), ["Root/Sub-other/Keep.pdf"]);
assert.deepEqual(Object.keys(cascadePlugin.settings.pendingDocumentCreates), ["Root/Sub-other/Pending.md"]);
assert.deepEqual(Object.keys(cascadePlugin.settings.pendingFolderCreates), ["target|drive|parent|Remote/Sub-other/Pending"]);
assert.deepEqual(Object.keys(cascadePlugin.settings.publishedFolders), ["Root"]);
assert.deepEqual(Object.keys(cascadePlugin.settings.folderBindings).sort(),
	["target|drive|parent|Remote", "target|drive|parent|Remote/Sub-other", "target|wiki|unrelated|Remote/Sub"].sort());
assert.deepEqual(Object.keys(cascadePlugin.syncState.documents), ["keep-doc"]);
assert.equal(cascadePlugin.settings.disconnectedFolders["Root/Sub"], true);
assert.equal(cascadePlugin.getBinding({ path: "Root/Sub/Legacy.md" }), null, "frontmatter cannot resurrect a removed child link");
assert.ok(!cascadePlugin.listPublishedEntries().some((entry) => entry.path.startsWith("Root/Sub/")));
assert.ok(cascadePlugin.listPublishedEntries().some((entry) => entry.path === "Root/Sub-other/Keep.md"));
await cascadePlugin.disconnectPublishedBinding({ path: "Root", kind: "folder" });
assert.deepEqual(cascadePlugin.settings.documentBindings, {});
assert.deepEqual(cascadePlugin.settings.pdfBindings, {});
assert.deepEqual(cascadePlugin.settings.pendingDocumentCreates, {});
assert.deepEqual(cascadePlugin.settings.pendingFolderCreates, {});
assert.deepEqual(cascadePlugin.settings.publishedFolders, {});
assert.deepEqual(cascadePlugin.listPublishedEntries(), []);

const legacyUnlinkPlugin = createUnlinkTreePlugin();
await legacyUnlinkPlugin.disconnectFolderBinding("Root/Sub");
legacyUnlinkPlugin.settings.disconnectedFolders["Root/Sub"] = true;
assert.ok(legacyUnlinkPlugin.listPublishedEntries().some((entry) => entry.path === "Root/Sub/Saved.md"));
await legacyUnlinkPlugin.cleanupDisconnectedFolderBindings();
assert.ok(!legacyUnlinkPlugin.listPublishedEntries().some((entry) => entry.path.startsWith("Root/Sub/")));
assert.equal(legacyUnlinkPlugin.settings.recursiveFolderUnlinkMigrated, true);
await legacyUnlinkPlugin.rememberDocumentBinding({ path: "Root/Sub/Saved.md" }, { token: "new-doc", url: "" });
await legacyUnlinkPlugin.cleanupDisconnectedFolderBindings();
assert.equal(legacyUnlinkPlugin.settings.documentBindings["Root/Sub/Saved.md"].token, "new-doc",
	"one-time migration must preserve links deliberately added after cleanup");

const localUnbindPlugin = createPublishingPlugin();
localUnbindPlugin.settings.documentBindings[fakeNote.path] = canonicalBinding;
await localUnbindPlugin.unbindDeletedRemoteDocument(fakeNote, canonicalBinding);
assert.equal(localUnbindPlugin.settings.documentBindings[fakeNote.path], undefined);

// Folder sync waits for an earlier manual operation; a failure releases the queue.
const queuedPlugin = createPublishingPlugin();
const orderedEvents = [];
queuedPlugin.syncFileUnlocked = async () => { orderedEvents.push("manual-start");
	await new Promise((resolve) => setTimeout(resolve, 5)); orderedEvents.push("manual-end"); throw new Error("manual failure"); };
queuedPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
queuedPlugin.ensureImageGalleryNotes = async () => 0;
queuedPlugin.collectMarkdownFiles = () => { orderedEvents.push("folder-start"); return []; };
queuedPlugin.app.vault.getFiles = () => [];
const orderedResults = await Promise.allSettled([
	queuedPlugin.syncFileInternal(fakeNote, publishOptions), queuedPlugin.publishFolderInternal("docs")
]);
assert.equal(orderedResults[0].status, "rejected");
assert.equal(orderedResults[1].status, "fulfilled");
assert.deepEqual(orderedEvents, ["manual-start", "manual-end", "folder-start"]);


const staleDestinationPlugin = createPublishingPlugin();
staleDestinationPlugin.syncState.documents.staleAlias = { doc: "oldDocument", units: [] };
assert.equal(staleDestinationPlugin.findDocumentState(["newDocument", "staleAlias"], "newDocument"), undefined);
const nestedRenamePlugin = createPublishingPlugin();
nestedRenamePlugin.settings.publishedFolders.Root = { rootParent: { kind: "my_library", token: "" }, remoteRoot: "Root" };
nestedRenamePlugin.settings.folderBindings = {
	"my_library|my_library||Root": { token: "root-node", url: "https://example.feishu.cn/wiki/root-node", containerKind: "my_library" },
	"my_library|my_library||Root/Sub": { token: "sub-node", url: "https://example.feishu.cn/wiki/sub-node", containerKind: "my_library" }
};
await nestedRenamePlugin.moveLocalBindings("Root/Sub", "Root/Renamed");
assert.equal(nestedRenamePlugin.getPublishedEntry("Root/Renamed", "folder").token, "sub-node");
assert.equal(nestedRenamePlugin.getPublishedEntry("Root/Sub", "folder"), undefined);
await nestedRenamePlugin.disconnectPublishedBinding({ path: "Root/Renamed", kind: "folder" });
assert.equal(nestedRenamePlugin.findPublishedFolderForFile({ path: "Root/Renamed/New.md" }), null);
assert.ok(nestedRenamePlugin.findPublishedFolderForFile({ path: "Root/Other/New.md" }));

const recoverPlugin = createPublishingPlugin();
recoverPlugin.listRemoteDocuments = async () => [{ title: "Note", token: "existing-note", url: "https://example.feishu.cn/docx/existing-note" }];
const parentsForRecovery = new Map([["Root", { kind: "my_library", token: "root-node" }]]);
const preparedForRecovery = () => ({ file: fakeNote, binding: null, remoteParentPath: "Root", preparedContent: {content: "# Note\n\nBody", images:[]} });
const recovered = preparedForRecovery();
assert.deepEqual(await recoverPlugin.recoverPreparedBindings([recovered], parentsForRecovery, true), {recovered:1,conflicts:0});
assert.equal(recovered.binding.token, "existing-note");
const duplicateLocalRecovery = createPublishingPlugin();
duplicateLocalRecovery.listRemoteDocuments = recoverPlugin.listRemoteDocuments;
const duplicatePrepared = preparedForRecovery();
const otherPrepared = { ...preparedForRecovery(), file: { ...fakeNote, path:"docs/Other.md" } };
await assert.rejects(duplicateLocalRecovery.recoverPreparedBindings([duplicatePrepared,otherPrepared], parentsForRecovery, true), /本地同级笔记的文档标题重复/);
assert.deepEqual(duplicateLocalRecovery.settings.documentBindings, {}, "local title ambiguity must bind neither note");
const legacyRecovery = createPublishingPlugin();
legacyRecovery.listRemoteDocuments = async () => [{title:"Note",token:"existing-note",nodeToken:"legacy-node",url:"https://example.feishu.cn/wiki/legacy-node"}];
const legacyNote = { ...fakeNote, path: "legacy.md" };
legacyRecovery.app.vault.getMarkdownFiles = () => [legacyNote];
legacyRecovery.app.metadataCache.getFileCache = () => ({frontmatter:{lark_doc_url:"https://example.feishu.cn/wiki/legacy-node"}});
legacyRecovery.runLarkCli = async () => ({ok:true,data:{token:"existing-note"}});
await assert.rejects(legacyRecovery.recoverPreparedBindings([preparedForRecovery()], parentsForRecovery, true), /legacy.md/);
assert.deepEqual(legacyRecovery.settings.documentBindings, {});
const duplicateRemoteRecovery = createPublishingPlugin();
duplicateRemoteRecovery.listRemoteDocuments = async () => [
	{title:"Note",token:"one",url:"https://example.feishu.cn/docx/one"},
	{title:"Note",token:"two",url:"https://example.feishu.cn/docx/two"}
];
assert.deepEqual(await duplicateRemoteRecovery.recoverPreparedBindings([preparedForRecovery()],parentsForRecovery,false),{recovered:0,conflicts:1});
assert.deepEqual(duplicateRemoteRecovery.settings.documentBindings, {});

const paginatedRecoveryPlugin = createPublishingPlugin();
const listingCalls = [];
paginatedRecoveryPlugin.runLarkCli = async (args) => {
	listingCalls.push(args);
	if (args[1] === "+node-get") return {ok:true,data:{space_id:"space-one"}};
	if (!args.includes("--page-token")) return {ok:true,data:{nodes:[{obj_type:"docx",obj_token:"one",title:"One"}],has_more:true,page_token:"next"}};
	return {ok:true,data:{nodes:[{obj_type:"docx",obj_token:"two",title:"Two"}],has_more:false}};
};
assert.deepEqual((await paginatedRecoveryPlugin.listRemoteDocuments({kind:"my_library",token:"parent"})).map(x=>x.token),["one","two"]);
assert.ok(listingCalls[1].includes("space-one"));
assert.ok(listingCalls[2].includes("next"));

const uncertainCreatePlugin = createPublishingPlugin();
let uncertainCreates = 0;
uncertainCreatePlugin.runLarkCli = async () => { uncertainCreates++; throw new Error("network timeout after commit"); };
await assert.rejects(uncertainCreatePlugin.syncFileInternal(fakeNote, publishOptions), /network timeout/);
await assert.rejects(uncertainCreatePlugin.syncFileInternal(fakeNote, publishOptions), /结果尚未确认/);
assert.equal(uncertainCreates, 1);
assert.ok(uncertainCreatePlugin.settings.pendingDocumentCreates[fakeNote.path]);
const undurableCreatePlugin = createPublishingPlugin();
let undurableRemoteCalls = 0;
undurableCreatePlugin.runLarkCli = async () => { undurableRemoteCalls++; return {}; };
undurableCreatePlugin.saveData = async () => { throw new Error("disk write failed"); };
await assert.rejects(undurableCreatePlugin.syncFileInternal(fakeNote, publishOptions), /disk write failed/);
assert.equal(undurableRemoteCalls,0,"creation must wait for a durable attempt marker");

const tombstonePlugin = createPublishingPlugin();
tombstonePlugin.app.metadataCache.getFileCache = () => ({frontmatter:{lark_doc_url:canonicalBinding.url}});
await tombstonePlugin.disconnectPublishedBinding({path:fakeNote.path,kind:"markdown"});
assert.equal(tombstonePlugin.getBinding(fakeNote),null,"local disconnect suppresses stale legacy bindings without editing the note");
await tombstonePlugin.rememberDocumentBinding(fakeNote,canonicalBinding);
assert.equal(tombstonePlugin.getBinding(fakeNote).token,canonicalBinding.token);

const manualPdfPlugin = createPublishingPlugin();
manualPdfPlugin.getVaultRoot = () => "/tmp/vault";
const fakePdf = Object.assign(new globalThis.__TFileClass(), {path:"Doc.pdf",name:"Doc.pdf",extension:"pdf"});
manualPdfPlugin.app.vault.getAbstractFileByPath = () => fakePdf;
manualPdfPlugin.settings.targetTokenOrUrl = "https://example.feishu.cn/wiki/some-wiki-target";
manualPdfPlugin.runLarkCli = async () => ({ok:true,data:{type:"file",token:"existing-pdf"}});
await manualPdfPlugin.savePublishedBinding({path:"Doc.pdf",kind:"pdf"},"https://example.feishu.cn/file/existing-pdf");
assert.deepEqual(manualPdfPlugin.settings.pdfBindings["Doc.pdf"].parent,{kind:"drive",token:""});
const unsavedPdfPlugin = createPublishingPlugin();
unsavedPdfPlugin.hasUnsavedSettings = true;
unsavedPdfPlugin.saveData = async () => { throw new Error("disk still unavailable"); };
await assert.rejects(unsavedPdfPlugin.syncPdfFileUnlocked(fakePdf),/disk still unavailable/);
assert.equal(unsavedPdfPlugin.hasUnsavedSettings,true,"failed post-upload durability must be retried before reporting success");

const mediaEventsPlugin = createPlugin();
mediaEventsPlugin.settings.autoSyncMode = "save";
const vaultEvents = new Map();
const queuedMediaPaths = [];
mediaEventsPlugin.app = { vault: { on: (event, handler) => { vaultEvents.set(event, handler); } } };
mediaEventsPlugin.registerEvent = () => {};
mediaEventsPlugin.queueImageReferenceAutoSync = async (paths) => { queuedMediaPaths.push(paths); };
mediaEventsPlugin.registerSaveAutoSync();
for (const [event, path, oldPath] of [
	["modify", "assets/demo.mp4"],
	["create", "assets/demo.m4v"],
	["delete", "assets/demo.MOV"],
	["rename", "assets/demo.webm", "assets/old.webm"],
	["rename", "assets/renamed.bin", "assets/old.mp4"]
]) {
	const file = Object.assign(new globalThis.__TFileClass(), { path, extension: path.split(".").pop() });
	vaultEvents.get(event)(file, oldPath);
}
assert.deepEqual(queuedMediaPaths, [
	["assets/demo.mp4"], ["assets/demo.m4v"], ["assets/demo.MOV"],
	["assets/old.webm", "assets/demo.webm"], ["assets/old.mp4", "assets/renamed.bin"]
], "video attachment events must resync their referencing notes, including renames away from a video extension");
const unrelatedFile = Object.assign(new globalThis.__TFileClass(), { path: "assets/data.bin", extension: "bin" });
vaultEvents.get("modify")(unrelatedFile);
mediaEventsPlugin.settings.autoSyncMode = "manual";
vaultEvents.get("modify")(Object.assign(new globalThis.__TFileClass(), { path: "assets/demo.mp4", extension: "mp4" }));
assert.equal(queuedMediaPaths.length, 5, "unrelated attachments and manual mode must not trigger auto sync");
delete globalThis.__TFileClass;

const combinedFolderPlugin = createPublishingPlugin();
const folderNote = {...fakeNote,path:"Root/Note.md"};
const folderPdf = {path:"Root/Scan.pdf",name:"Scan.pdf",extension:"pdf"};
combinedFolderPlugin.app.vault.getMarkdownFiles = () => [folderNote];
combinedFolderPlugin.app.vault.getFiles = () => [folderNote,folderPdf];
combinedFolderPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
let directoryCreates=0,noteCreates=0,pageListInserts=0;
let folderPageXml = '<title id="root-title">Root</title>';
const pdfDestinations=[];
combinedFolderPlugin.runLarkCli = async (args) => {
	if (args[1] === "+node-create") { directoryCreates++; return {ok:true,data:{node_token:"root-node",url:"https://example.feishu.cn/wiki/root-node"}}; }
	if (args[1] === "+node-get") return {ok:true,data:{space_id:"my-space"}};
	if (args[1] === "+node-list") return {ok:true,data:{nodes:[],has_more:false}};
	if (args[1] === "+create") { noteCreates++; return {ok:true,data:{document:{document_id:"folder-note",url:"https://example.feishu.cn/docx/folder-note"}}}; }
	if (args[1] === "+inspect") return {ok:true,data:{token:args.includes("https://example.feishu.cn/wiki/root-node") ? "root-doc" : "folder-note",type:"docx"}};
	if (args[1] === "+fetch") return {ok:true,data:{document:{document_id:"root-doc",content:folderPageXml,revision_id:1 + pageListInserts}}};
	if (args[1] === "+update") {
		assert.equal(args[args.indexOf("--command") + 1], "block_insert_after");
		assert.equal(args[args.indexOf("--content") + 1], "<sub-page-list/>");
		pageListInserts++;
		folderPageXml += '<sub-page-list id="child-pages"/>';
		return {ok:true,data:{document:{revision_id:1 + pageListInserts}}};
	}
	throw new Error("Unexpected CLI command: "+args.join(" "));
};
combinedFolderPlugin.updateLarkDocument = async () => ({});
combinedFolderPlugin.syncPdfFileUnlocked = async (file,parent) => pdfDestinations.push({path:file.path,token:parent.token});
await Promise.all([combinedFolderPlugin.publishFolderInternal("Root"),combinedFolderPlugin.publishFolderInternal("Root")]);
assert.equal(directoryCreates,1);
assert.equal(noteCreates,1);
assert.equal(pageListInserts,1,"repeated folder sync reuses the native child-page list");
assert.deepEqual(pdfDestinations,[{path:"Root/Scan.pdf",token:"root-node"},{path:"Root/Scan.pdf",token:"root-node"}]);
const pdfOnlyPlugin = createPublishingPlugin();
pdfOnlyPlugin.app.vault.getFiles = () => [folderPdf];
pdfOnlyPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
pdfOnlyPlugin.runLarkCli = combinedFolderPlugin.runLarkCli;
let pdfOnlyUploaded=false;
pdfOnlyPlugin.syncPdfFileUnlocked = async () => {pdfOnlyUploaded=true;};
await pdfOnlyPlugin.publishFolderInternal("Root");
assert.equal(pdfOnlyUploaded,true,"PDF-only folders must create hierarchy and upload");

const reconnectedFolderPlugin = createPublishingPlugin();
reconnectedFolderPlugin.settings.disconnectedFolders = { Root: true, Other: true };
const childNote = { ...fakeNote, path: "Root/Child/Note.md" };
reconnectedFolderPlugin.app.vault.getMarkdownFiles = () => [childNote];
reconnectedFolderPlugin.app.vault.getFiles = () => [childNote];
reconnectedFolderPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
reconnectedFolderPlugin.readNoteForLark = async () => { throw new Error("reconnected folder reached note read"); };
await assert.rejects(reconnectedFolderPlugin.publishFolderInternal("Root/Child"), /reconnected folder reached note read/);
assert.equal(reconnectedFolderPlugin.settings.disconnectedFolders.Root, undefined,
	"an ancestor disconnect marker must not hide a newly bound child folder");
assert.equal(reconnectedFolderPlugin.settings.disconnectedFolders.Other, true,
	"unrelated disconnect markers must stay");

const pdfReferencePlugin = createPublishingPlugin();
const pdfCite = '<cite type="doc" doc-id="pdf-file" file-type="file"></cite>';
pdfReferencePlugin.settings.pdfBindings["Root/Scan.pdf"] = { status: "published", fileToken: "pdf-file" };
const pdfSource = "# Note\n\n[[Root/Scan.pdf]]\n\n![[Root/Scan.pdf#page=2]]";
pdfReferencePlugin.readNoteForLark = async () => ({ content: pdfSource, images: [] });
let firstPdfContent, firstPdfBaseline;
pdfReferencePlugin.withTempMarkdown = async (_name, content, callback) => {
	firstPdfContent = content;
	return callback({ directory: "/tmp", fileName: "note.md" });
};
pdfReferencePlugin.runLarkCli = async () => ({ok:true,data:{document:{document_id:canonicalBinding.token,url:canonicalBinding.url}}});
pdfReferencePlugin.saveCreatedDocumentStateFromBaseline = async (_binding, content) => { firstPdfBaseline = content; };
await pdfReferencePlugin.syncFileInternal(fakeNote, publishOptions);
assert.equal(firstPdfContent, `${pdfCite}\n\nScan.pdf · p.2 ${pdfCite}`, "first publish converts PDFs even outside a published folder");
assert.equal(firstPdfBaseline, `# Note\n\n${pdfCite}\n\nScan.pdf · p.2 ${pdfCite}`, "sync baseline uses the uploaded references");
let nextPdfContent;
pdfReferencePlugin.updateLarkDocument = async (_doc, prepared) => { nextPdfContent = prepared.content; return {}; };
await pdfReferencePlugin.syncFileInternal(fakeNote, { ...publishOptions, mode: "save", allowCreate: false });
assert.equal(nextPdfContent, firstPdfBaseline, "save sync preserves file references");
pdfReferencePlugin.settings.pdfBindings["Root/Scan.pdf"].status = "pending";
assert.match(pdfReferencePlugin.rewritePublishedPdfReferences(fakeNote, pdfSource), /Scan.pdf · p\.2（PDF 未发布或未绑定）/);
pdfReferencePlugin.settings.pdfBindings["Root/Scan.pdf"].status = "published";
pdfReferencePlugin.settings.disconnectedFolders.Root = true;
assert.match(pdfReferencePlugin.rewritePublishedPdfReferences(fakeNote, pdfSource), /Scan.pdf · p\.2（PDF 未发布或未绑定）/);
delete pdfReferencePlugin.settings.disconnectedFolders.Root;
pdfReferencePlugin.app.metadataCache.getFirstLinkpathDest = () => ({ path: "Unpublished/Scan.pdf" });
assert.equal(pdfReferencePlugin.rewritePublishedPdfReferences(fakeNote, "[[Scan.pdf]]"), "Scan.pdf（PDF 未发布或未绑定）");

const deletedPdfRoot = await mkdtemp(join(tmpdir(), "lark-deleted-pdf-test-"));
try {
	await writeFile(join(deletedPdfRoot, "Doc.pdf"), "%PDF-1.4\n% test\n");
	const deletedPdfPlugin = createPublishingPlugin();
	deletedPdfPlugin.getVaultRoot = () => deletedPdfRoot;
	deletedPdfPlugin.resolveExclusiveRemoteBinding = async () => {};
	const deletedPdfParent = { kind: "drive", token: "target-folder" };
	deletedPdfPlugin.settings.pdfBindings["Doc.pdf"] = {
		version: 1, key: "stale-key", scope: "user", vaultPath: "Doc.pdf",
		parent: { ...deletedPdfParent }, fileName: "Doc.pdf",
		contentHash: "0".repeat(64), size: 5, status: "published",
		fileToken: "deleted-file", url: "https://example.feishu.cn/file/deleted-file",
		updatedAt: new Date().toISOString()
	};
	deletedPdfPlugin.listRemoteDocuments = async () => [];
	let reuploaded = 0;
	deletedPdfPlugin.runLarkCli = async (args) => {
		if (args[1] === "+upload") {
			reuploaded++;
			return { ok: true, data: { file_token: "reuploaded-file", url: "https://example.feishu.cn/file/reuploaded-file" } };
		}
		throw new Error("Unexpected CLI command: " + args.join(" "));
	};
	await deletedPdfPlugin.syncPdfFileUnlocked(fakePdf, deletedPdfParent);
	assert.equal(reuploaded, 1, "a deleted remote PDF must be uploaded again");
	assert.equal(deletedPdfPlugin.settings.pdfBindings["Doc.pdf"].fileToken, "reuploaded-file");
} finally {
	await rm(deletedPdfRoot, { recursive: true, force: true });
}

const pdfFolderPlugin = createPublishingPlugin();
pdfFolderPlugin.app.vault.getMarkdownFiles = () => [folderNote];
pdfFolderPlugin.app.vault.getFiles = () => [folderNote, folderPdf];
pdfFolderPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
pdfFolderPlugin.runLarkCli = combinedFolderPlugin.runLarkCli;
pdfFolderPlugin.readNoteForLark = async () => ({ content: "# Note\n\n[[Scan.pdf]]\n\n![[Scan.pdf]]", images: [] });
const folderSequence = [];
pdfFolderPlugin.syncPdfFileUnlocked = async (file) => {
	folderSequence.push("upload");
	pdfFolderPlugin.settings.pdfBindings[file.path] = { status: "published", fileToken: "pdf-file" };
};
pdfFolderPlugin.updateLarkDocument = async (_doc, prepared) => {
	folderSequence.push("rewrite");
	assert.equal(prepared.content, `# Note\n\n${pdfCite}\n\n${pdfCite}`);
	return {};
};
await pdfFolderPlugin.publishFolderInternal("Root");
assert.deepEqual(folderSequence, ["upload", "rewrite"], "new folder references resolve after PDF bindings are durable");

const uncertainFolderPlugin = createPublishingPlugin();
let uncertainFolderCreates=0;
uncertainFolderPlugin.listRemoteWikiNodes = async () => [];
uncertainFolderPlugin.createRemoteFolderPage = async () => { uncertainFolderCreates++; throw new Error("folder create timeout"); };
await assert.rejects(uncertainFolderPlugin.ensureRemoteFolderPath({kind:"my_library",token:""},"Root"),/folder create timeout/);
await assert.rejects(uncertainFolderPlugin.ensureRemoteFolderPath({kind:"my_library",token:""},"Root"),/尚未确认/);
assert.equal(uncertainFolderCreates,1);

// Missing local directory records must not create a second remote directory.
const driveRoot = { kind: "drive", token: "drive-root" };
function folderCloudPlugin(children) {
	const plugin = createPublishingPlugin();
	const calls = [];
	plugin.runLarkCli = async (args) => {
		calls.push(args);
		const parent = args[args.indexOf("--folder-token") + 1];
		if (args[1] === "files" && args[2] === "list") {
			return { ok: true, data: { files: children.get(parent) || [], has_more: false } };
		}
		if (args[1] === "+create-folder") {
			const token = `created-${calls.length}`;
			children.set(parent, [...(children.get(parent) || []), {
				type: "folder", name: args[args.indexOf("--name") + 1], token
			}]);
			return { ok: true, data: { folder_token: token } };
		}
		throw new Error(`Unexpected folder command: ${args.join(" ")}`);
	};
	return { plugin, calls };
}
const oldFolder = { type: "folder", name: "原图资料", token: "original-folder", url: "https://example.feishu.cn/drive/folder/original-folder" };
const recoveredCloud = new Map([[driveRoot.token, [oldFolder]]]);
const { plugin: folderRecovery, calls: folderRecoveryCalls } = folderCloudPlugin(recoveredCloud);
let recoveredSettings;
folderRecovery.saveData = async (settings) => { recoveredSettings = structuredClone(settings); };
const restoredDirectory = await folderRecovery.ensureRemoteFolderPath(driveRoot, "原图资料");
assert.deepEqual(restoredDirectory, { parent: { kind: "drive", token: oldFolder.token }, createdBinding: true });
assert.equal(folderRecoveryCalls.length, 1, "restoring a directory only lists remote files");
assert.equal(recoveredCloud.get(driveRoot.token).length, 1);
assert.equal(Object.values(recoveredSettings.folderBindings)[0].containerToken, driveRoot.token);
const { plugin: restartedDirectory, calls: restartDirectoryCalls } = folderCloudPlugin(recoveredCloud);
restartedDirectory.settings = recoveredSettings;
restartedDirectory.settings.targetTokenOrUrl = "a different default target";
await restartedDirectory.ensureRemoteFolderPath(driveRoot, "原图资料");
assert.deepEqual(restartDirectoryCalls, [], "durable recovery survives restart and a changed default target");

const nestedCloud = new Map([
	[driveRoot.token, [oldFolder, { type: "docx", name: "Other", token: "ordinary-note" }]],
	[oldFolder.token, [{ type: "folder", name: "Child", token: "child-folder" }]],
	["unrelated-parent", [{ type: "folder", name: "New", token: "wrong-parent" }]]
]);
const { plugin: nestedRecovery, calls: nestedCalls } = folderCloudPlugin(nestedCloud);
const nestedDirectory = await nestedRecovery.ensureRemoteFolderPath(driveRoot, "原图资料/Child/New");
assert.equal(nestedDirectory.parent.kind, "drive");
assert.notEqual(nestedDirectory.parent.token, "wrong-parent", "same names in another parent are never reused");
assert.deepEqual(nestedCalls.map((args) => args[1]), ["files", "files", "files", "+create-folder"]);
assert.equal(nestedCalls.at(-1)[nestedCalls.at(-1).indexOf("--folder-token") + 1], "child-folder");

const { plugin: duplicateFolders, calls: duplicateFolderCalls } = folderCloudPlugin(new Map([
	[driveRoot.token, [oldFolder, { ...oldFolder, token: "second-folder" }]]
]));
await assert.rejects(duplicateFolders.ensureRemoteFolderPath(driveRoot, "原图资料"), /多个.*同名/);
assert.equal(duplicateFolderCalls.length, 1);
assert.deepEqual(duplicateFolders.settings.folderBindings, {});
assert.deepEqual(duplicateFolders.settings.pendingFolderCreates, {});

for (const owner of ["folder", "document", "legacy"]) {
	const { plugin: ownedFolder, calls } = folderCloudPlugin(new Map([[driveRoot.token, [oldFolder]]]));
	if (owner === "folder") ownedFolder.settings.folderBindings["old|drive|other-root|Other"] = { token: oldFolder.token, url: "" };
	if (owner === "document") ownedFolder.settings.documentBindings["Other.md"] = { token: oldFolder.token, url: "" };
	if (owner === "legacy") {
		ownedFolder.app.vault.getMarkdownFiles = () => [fakeNote];
		ownedFolder.app.metadataCache.getFileCache = () => ({ frontmatter: { lark_doc_url: oldFolder.url } });
	}
	await assert.rejects(ownedFolder.ensureRemoteFolderPath(driveRoot, "原图资料"), /已绑定其他本地路径/);
	assert.equal(calls.length, 1, "a remote folder bound elsewhere is neither reused nor duplicated");
}

const pendingKey = "old-default|drive|drive-root|原图资料";
const { plugin: recoveredPending, calls: pendingCalls } = folderCloudPlugin(new Map([[driveRoot.token, [oldFolder]]]));
recoveredPending.settings.pendingFolderCreates[pendingKey] = oldFolder.name;
recoveredPending.settings.targetTokenOrUrl = "new-default";
await recoveredPending.ensureRemoteFolderPath(driveRoot, "原图资料");
assert.equal(recoveredPending.settings.folderBindings[pendingKey].token, oldFolder.token);
assert.deepEqual(recoveredPending.settings.pendingFolderCreates, {});
assert.equal(pendingCalls.length, 1, "a timed-out Drive create can recover its unique remote folder");
const { plugin: unresolvedPending, calls: unresolvedCalls } = folderCloudPlugin(new Map());
unresolvedPending.settings.pendingFolderCreates[pendingKey] = oldFolder.name;
unresolvedPending.settings.targetTokenOrUrl = "new-default";
await assert.rejects(unresolvedPending.ensureRemoteFolderPath(driveRoot, "原图资料"), /尚未确认/);
assert.equal(unresolvedCalls.length, 1, "changing the default must not bypass an uncertain create");
assert.ok(unresolvedPending.settings.pendingFolderCreates[pendingKey]);

const { plugin: failedRecovery } = folderCloudPlugin(new Map([[driveRoot.token, [oldFolder]]]));
failedRecovery.saveData = async () => { throw new Error("recovery disk full"); };
await assert.rejects(failedRecovery.ensureRemoteFolderPath(driveRoot, "原图资料"), /recovery disk full/);
await assert.rejects(failedRecovery.ensureRemoteFolderPath(driveRoot, "原图资料"), /recovery disk full/);
assert.equal(failedRecovery.hasUnsavedSettings, true, "unsaved recovery must not report success on retry");

const { plugin: concurrentDirectory, calls: concurrentDirectoryCalls } = folderCloudPlugin(new Map());
const concurrentDirectories = await Promise.all([
	concurrentDirectory.ensureRemoteFolderPath(driveRoot, "New"),
	concurrentDirectory.ensureRemoteFolderPath(driveRoot, "New")
]);
assert.deepEqual(concurrentDirectories[0].parent, concurrentDirectories[1].parent);
assert.equal(concurrentDirectoryCalls.filter((args) => args[1] === "+create-folder").length, 1);

// Inspect every page before accepting a name match; listing failures never permit creation.
for (const listingCase of ["later-match", "later-duplicate", "missing-cursor", "repeated-cursor", "permission", "malformed", "invalid-token"]) {
	const plugin = createPublishingPlugin();
	const calls = [];
	plugin.runLarkCli = async (args) => {
		calls.push(args);
		assert.equal(args[1], "files", "unsafe listings must not fall through to creation");
		if (listingCase === "permission") throw new Error("permission denied");
		if (listingCase === "malformed") return { ok: true, data: {} };
		if (listingCase === "invalid-token") return { ok: true, data: { files: [{ type: "folder", name: oldFolder.name }] } };
		const secondPage = args.includes("--page-token");
		return { ok: true, data: {
			files: listingCase === "later-duplicate" || secondPage ? [{ ...oldFolder, token: secondPage ? "later-folder" : oldFolder.token }] : [],
			has_more: !secondPage || listingCase === "repeated-cursor",
			page_token: listingCase === "missing-cursor" ? "" : "next-page"
		} };
	};
	if (listingCase === "later-match") {
		assert.equal((await plugin.ensureRemoteFolderPath(driveRoot, oldFolder.name)).parent.token, "later-folder");
		assert.equal(calls.length, 2);
	} else {
		await assert.rejects(plugin.ensureRemoteFolderPath(driveRoot, oldFolder.name), /多个|Incomplete|permission|Invalid/);
		assert.deepEqual(plugin.settings.folderBindings, {});
		assert.deepEqual(plugin.settings.pendingFolderCreates, {});
	}
}

const wikiTitleConflict = createPublishingPlugin();
wikiTitleConflict.listRemoteWikiNodes = async () => [{ title: "Root", obj_type: "docx", node_token: "ordinary-page", obj_token: "ordinary-doc" }];
wikiTitleConflict.createRemoteFolderPage = async () => { throw new Error("must not create on a Wiki title conflict"); };
await assert.rejects(wikiTitleConflict.ensureRemoteFolderPath({ kind: "wiki", token: "wiki-root" }, "Root"), /同名的页面/);
const unknownFolderParent = createPublishingPlugin();
await assert.rejects(unknownFolderParent.ensureRemoteFolderPath({ kind: "unknown", token: "raw-token" }, "Root"), /文件夹链接/);
assert.match(folderRecovery.t("progressFolderPdf", { current: "1", total: "2", name: "test.pdf" }), /检查并同步 PDF 1\/2/);

// Native lists are inserted without rebuilding the parent page or managing links.
const pageListPlugin = createPublishingPlugin();
const pageListCommands = [];
let pageListContent = '<title id="title">Parent</title><p id="body">Manual content</p><p id="manual-ref"><cite type="doc" doc-id="manual-doc"></cite></p>';
const originalPageListContent = pageListContent;
pageListPlugin.fetchLarkDocumentWithIds = async () => ({ doc: "parent-doc", content: pageListContent, revisionId: 9 });
pageListPlugin.runLarkCli = async (args) => {
	pageListCommands.push(args);
	pageListContent += '<sub-page-list id="native-list"></sub-page-list>';
	return { ok: true, data: { document: { revision_id: 9 } } };
};
const pageListBinding = { token: "parent-node", url: "https://example.feishu.cn/wiki/parent-node" };
await pageListPlugin.ensureFolderPageList(pageListBinding, "Root");
await pageListPlugin.ensureFolderPageList(pageListBinding, "Root");
assert.equal(pageListCommands.length, 1);
assert.deepEqual(pageListCommands[0], ["docs", "+update", "--api-version", "v2", "--as", "user",
	"--doc", "parent-doc", "--command", "block_insert_after", "--block-id", "-1",
	"--doc-format", "xml", "--content", "<sub-page-list/>", "--revision-id", "9", "--json"]);
assert.equal(pageListContent, originalPageListContent + '<sub-page-list id="native-list"></sub-page-list>');

const scopedPageLists = createPublishingPlugin();
scopedPageLists.settings.folderBindings = {
	"target|wiki|wiki-root|Root": { token: "root-page", url: "", containerKind: "wiki" },
	"target|wiki|wiki-root|Root/Sub": { token: "sub-page", url: "", containerKind: "wiki" },
	"target|wiki|wiki-root|Root/Sub/Deep": { token: "deep-page", url: "", containerKind: "wiki" },
	"target|wiki|wiki-root|Root/Disconnected": { token: "disconnected", url: "", containerKind: "wiki" },
	"target|wiki|wiki-root|Root-other": { token: "outside", url: "", containerKind: "wiki" },
	"target|wiki|different-root|Root": { token: "different-root", url: "", containerKind: "wiki" },
	"target|drive|drive-root|Root": { token: "drive-folder", url: "", containerKind: "drive" }
};
scopedPageLists.settings.disconnectedFolders = { "Notes/Root/Disconnected": true };
const indexedPages = [];
scopedPageLists.ensureFolderPageList = async (binding, path) => indexedPages.push({ token: binding.token, path });
await scopedPageLists.syncFolderPageLists("Notes/Root", "Root", { kind: "wiki", token: "wiki-root" });
assert.deepEqual(indexedPages, [
	{ token: "root-page", path: "Notes/Root" },
	{ token: "sub-page", path: "Notes/Root/Sub" },
	{ token: "deep-page", path: "Notes/Root/Sub/Deep" }
]);
await scopedPageLists.syncFolderPageLists("Notes/Root", "Root", { kind: "drive", token: "drive-root" });
assert.equal(indexedPages.length, 3, "Drive folders have no document body to index");
scopedPageLists.settings.folderBindings["target|wiki|bound-root|"] = { token: "bound-page", url: "", containerKind: "wiki" };
await scopedPageLists.syncFolderPageLists("Bound", "", { kind: "wiki", token: "bound-root" });
assert.deepEqual(indexedPages.at(-1), { token: "bound-page", path: "Bound" }, "explicit folder bindings index the bound wiki page itself");

const delayedPageList = createPublishingPlugin();
let listFetches = 0, listWrites = 0;
const listSleeps = [];
delayedPageList.fetchLarkDocumentWithIds = async () => {
	listFetches++;
	return { doc: "parent-doc", content: listFetches === 1 ? '<title>Parent</title>' : '<sub-page-list id="native-list"/>',
		revisionId: listFetches < 3 ? 9 : 10 };
};
delayedPageList.runLarkCli = async () => { listWrites++; return { ok: true, data: { document: { revision_id: 10 } } }; };
delayedPageList.sleep = async (ms) => listSleeps.push(ms);
await delayedPageList.ensureFolderPageList(pageListBinding, "Root");
assert.equal(listWrites, 1, "confirmation retries only fetch, never insert another list");
assert.deepEqual(listSleeps, [1500]);

const unconfirmedPageList = createPublishingPlugin();
unconfirmedPageList.fetchLarkDocumentWithIds = async () => ({ doc: "parent-doc", content: '<title>Parent</title>', revisionId: 9 });
unconfirmedPageList.runLarkCli = async () => ({ ok: true, data: { document: { revision_id: 10 } } });
unconfirmedPageList.sleep = async () => {};
await assert.rejects(unconfirmedPageList.ensureFolderPageList(pageListBinding, "Root"), /远端更新尚未可见/);

const aliasMismatchPlugin = createPublishingPlugin();
aliasMismatchPlugin.syncState.documents["https://example.feishu.cn/wiki/alias"] = {...reusableState,doc:"oldDoc"};
aliasMismatchPlugin.fetchLarkDocumentMarkdown = async () => ({doc:"newDoc",content:"# Note\n\nBody",revisionId:4});
aliasMismatchPlugin.fetchLarkDocumentWithIds = async () => ({doc:"newDoc",content:'<title id="newDoc">Note</title><p id="block-new">Body</p>',revisionId:4});
let bootstrappedCanonical;
aliasMismatchPlugin.persistDocumentState = async(state) => {bootstrappedCanonical=state;};
const canonicalBootstrap = await aliasMismatchPlugin.tryBootstrapPreciseSyncState("newDoc",["https://example.feishu.cn/wiki/alias"],"# Note\n\nBody");
assert.equal(canonicalBootstrap.doc,"newDoc");
assert.equal(bootstrappedCanonical.doc,"newDoc","bootstrap must not restore a stale alias for another document at the same revision");
// Explicit overwrite adopts one stable target, confirms its write, then cleans siblings.
function createOverwritePlugin(boundToken) {
	const plugin = createPublishingPlugin();
	const parent = { kind: "drive", token: "same-parent" };
	const remote = [
		{ token: "z-copy", url: "https://example.feishu.cn/docx/z-copy", title: "Note" },
		{ token: "a-keep", url: "https://example.feishu.cn/docx/a-keep", title: "Note" },
		{ token: "unrelated", url: "https://example.feishu.cn/docx/unrelated", title: "Other" }
	];
	const events = [];
	plugin.app.vault.getMarkdownFiles = () => [fakeNote];
	plugin.resolveRemoteRootParent = async () => parent;
	plugin.listRemoteDocuments = async (destination) => { assert.deepEqual(destination, parent); return [...remote]; };
	plugin.createLarkDocument = async () => assert.fail("Overwrite must adopt an existing match, not create another duplicate");
	plugin.updateLarkDocument = async (doc, prepared, context) => {
		assert.equal(context.strategy, "overwrite");
		assert.equal(prepared.content, "# Note\n\nBody");
		assert.equal(plugin.settings.documentBindings[fakeNote.path].token, doc, "keeper must be durable before overwrite");
		events.push(`write:${doc}`);
		return {};
	};
	plugin.runLarkCli = async (args) => {
		assert.equal(args[1], "+delete");
		assert.ok(args.includes("--yes"));
		assert.equal(args[args.indexOf("--type") + 1], "docx");
		const token = args[args.indexOf("--file-token") + 1];
		events.push(`delete:${token}`);
		remote.splice(remote.findIndex((document) => document.token === token), 1);
		return { ok: true, data: {} };
	};
	if (boundToken) plugin.settings.documentBindings[fakeNote.path] = {
		...remote.find((document) => document.token === boundToken), containerKind: "drive", containerToken: parent.token
	};
	return { plugin, parent, remote, events };
}
const overwriteOptions = { ...publishOptions, strategy: "overwrite" };
const dedup = createOverwritePlugin();
await dedup.plugin.syncFileInternal(fakeNote, overwriteOptions);
assert.deepEqual(dedup.events, ["write:a-keep", "delete:z-copy"]);
assert.deepEqual(dedup.remote.map((document) => document.token), ["a-keep", "unrelated"]);
await dedup.plugin.syncFileInternal(fakeNote, overwriteOptions);
assert.deepEqual(dedup.events, ["write:a-keep", "delete:z-copy", "write:a-keep"], "repeat overwrite retains the same target");

const boundDedup = createOverwritePlugin("z-copy");
await boundDedup.plugin.syncFileInternal(fakeNote, overwriteOptions);
assert.deepEqual(boundDedup.events, ["write:z-copy", "delete:a-keep"], "an existing binding wins over sorted candidates");

const failedWriteDedup = createOverwritePlugin();
failedWriteDedup.plugin.updateLarkDocument = async () => { throw new Error("write confirmation failed"); };
await assert.rejects(failedWriteDedup.plugin.syncFileInternal(fakeNote, overwriteOptions), /write confirmation failed/);
assert.equal(failedWriteDedup.remote.length, 3, "no duplicate is deleted before the keeper write is confirmed");
assert.deepEqual(failedWriteDedup.events, []);

const failedDeleteDedup = createOverwritePlugin();
const deleteAfterRetry = failedDeleteDedup.plugin.runLarkCli;
failedDeleteDedup.plugin.runLarkCli = async () => { throw new Error("delete denied"); };
await assert.rejects(failedDeleteDedup.plugin.syncFileInternal(fakeNote, overwriteOptions), /delete denied/);
assert.equal(failedDeleteDedup.plugin.settings.documentBindings[fakeNote.path].token, "a-keep");
failedDeleteDedup.plugin.runLarkCli = deleteAfterRetry;
await failedDeleteDedup.plugin.syncFileInternal(fakeNote, overwriteOptions);
assert.deepEqual(failedDeleteDedup.events, ["write:a-keep", "write:a-keep", "delete:z-copy"]);

const protectedDuplicate = createOverwritePlugin("a-keep");
protectedDuplicate.plugin.settings.documentBindings["different-local.md"] = { token: "z-copy", url: "https://example.feishu.cn/docx/z-copy" };
await assert.rejects(protectedDuplicate.plugin.syncFileInternal(fakeNote, overwriteOptions), /different-local.md/);
assert.ok(!protectedDuplicate.events.some((event) => event.startsWith("delete:")));

const missingKeeper = createOverwritePlugin();
await assert.rejects(missingKeeper.plugin.cleanupRemoteDuplicates(fakeNote.path, "Note", missingKeeper.parent,
	{ token: "outside-parent", url: "https://example.feishu.cn/docx/outside-parent" }), /确认保留文档/);
assert.deepEqual(missingKeeper.events, []);

const sameWikiObject = createPublishingPlugin();
sameWikiObject.listRemoteDocuments = async () => [
	{ token: "one-document", nodeToken: "origin-node", url: "", title: "Note" },
	{ token: "one-document", nodeToken: "shortcut-node", url: "", title: "Note" }
];
sameWikiObject.runLarkCli = async () => assert.fail("An alias of the kept document must never delete its origin");
assert.equal(await sameWikiObject.cleanupRemoteDuplicates(fakeNote.path, "Note", { kind: "wiki", token: "parent" },
	{ token: "one-document", nodeToken: "origin-node", url: "" }), 0);

const partialListing = createOverwritePlugin();
delete partialListing.plugin.listRemoteDocuments;
partialListing.plugin.runLarkCli = async () => ({ ok: true, data: { files: [
	{ token: "a-keep", type: "docx", name: "Note", url: "https://example.feishu.cn/docx/a-keep" }
], has_more: true } });
await assert.rejects(partialListing.plugin.syncFileInternal(fakeNote, overwriteOptions), /Incomplete remote folder listing/);
assert.deepEqual(partialListing.events, [], "incomplete listings cannot select or delete a candidate");

const folderOverwrite = createOverwritePlugin();
folderOverwrite.plugin.app.vault.getFiles = () => [fakeNote];
folderOverwrite.plugin.withDeferredLarkSyncStateSave = async (callback) => callback();
folderOverwrite.plugin.resolveFolderParents = async () => new Map([["docs", folderOverwrite.parent]]);
const folderOriginalCli = folderOverwrite.plugin.runLarkCli;
folderOverwrite.plugin.runLarkCli = async (args) => args[1] === "+inspect"
	? { ok: true, data: { token: "a-keep", type: "docx" } } : folderOriginalCli(args);
await folderOverwrite.plugin.publishFolderInternal("docs", true);
assert.deepEqual(folderOverwrite.events, ["write:a-keep", "delete:z-copy"], "folder overwrite forces content replacement and cleans duplicates");

const ambiguousLocal = createOverwritePlugin();
ambiguousLocal.plugin.app.vault.getMarkdownFiles = () => [fakeNote, { ...fakeNote, path: "docs/Other.md" }];
await assert.rejects(ambiguousLocal.plugin.syncFileInternal(fakeNote, overwriteOptions), /本地笔记的文档标题相同/);
assert.deepEqual(ambiguousLocal.events, []);

const overwriteRecovery = createPublishingPlugin();
overwriteRecovery.listRemoteDocuments = async () => [
	{ token: "z-copy", url: "https://example.feishu.cn/docx/z-copy", title: "Note" },
	{ token: "a-keep", url: "https://example.feishu.cn/docx/a-keep", title: "Note" }
];
const overwritePrepared = preparedForRecovery();
await overwriteRecovery.recoverPreparedBindings([overwritePrepared], parentsForRecovery, true, undefined, true);
assert.equal(overwritePrepared.binding.token, "a-keep", "folder overwrite resolves remote name ambiguity without creating a third copy");

const wikiDedup = createPublishingPlugin();
const wikiEvents = [];
let wikiChildren = [{ node_token: "child-node", obj_type: "docx", obj_token: "child-doc", title: "Child" }];
wikiDedup.settings.documentBindings["Child.md"] = { token: "child-doc", url: "", containerKind: "wiki", containerToken: "duplicate-node" };
wikiDedup.listRemoteWikiNodes = async (parent) => { assert.equal(parent.token, "duplicate-node"); return [...wikiChildren]; };
wikiDedup.runLarkCli = async (args) => {
	if (args[1] === "+node-get") return { ok: true, data: { node: { node_token: "duplicate-node", obj_token: "duplicate-doc",
		obj_type: "docx", title: "Note", parent_node_token: "wiki-parent", space_id: "space" } } };
	if (args[1] === "+move") {
		assert.equal(args[args.indexOf("--target-parent-token") + 1], "keep-node");
		wikiEvents.push("move-child"); wikiChildren = []; return { ok: true, data: {} };
	}
	assert.equal(args[1], "+node-delete");
	assert.ok(args.includes("--include-children=false"));
	assert.ok(args.includes("--yes"));
	assert.equal(wikiChildren.length, 0);
	wikiEvents.push("delete-parent");
	return { ok: true, data: {} };
};
await wikiDedup.removeWikiDuplicate({ kind: "wiki", token: "wiki-parent" }, { token: "duplicate-doc", nodeToken: "duplicate-node", url: "", title: "Note" },
	{ token: "keep-doc", nodeToken: "keep-node", url: "" });
assert.deepEqual(wikiEvents, ["move-child", "delete-parent"]);
assert.equal(wikiDedup.settings.documentBindings["Child.md"].containerToken, "keep-node");
wikiChildren = [{ node_token: "child-node" }];
wikiDedup.runLarkCli = async (args) => {
	if (args[1] === "+node-get") return { ok: true, data: { node: { node_token: "duplicate-node", obj_token: "duplicate-doc",
		obj_type: "docx", title: "Note", parent_node_token: "wiki-parent", space_id: "space" } } };
	if (args[1] === "+move") throw new Error("child move denied");
	assert.fail("A failed child move must not delete its parent");
};
await assert.rejects(wikiDedup.removeWikiDuplicate({ kind: "wiki", token: "wiki-parent" },
	{ token: "duplicate-doc", nodeToken: "duplicate-node", url: "", title: "Note" }, { token: "keep-doc", nodeToken: "keep-node", url: "" }), /child move denied/);

wikiDedup.runLarkCli = async (args) => {
	assert.equal(args[1], "+node-get");
	return { ok: true, data: { node: { node_token: "duplicate-node", obj_token: "duplicate-doc", obj_type: "docx", title: "Renamed",
		parent_node_token: "different-parent", space_id: "space" } } };
};
await assert.rejects(wikiDedup.removeWikiDuplicate({ kind: "wiki", token: "wiki-parent" },
	{ token: "duplicate-doc", nodeToken: "duplicate-node", url: "", title: "Note" }, { token: "keep-doc", nodeToken: "keep-node", url: "" }), /位置或标题已变化/);

const resetFolderBody = createPublishingPlugin();
const resetCommands = [];
let resetXml = '<title id="title">Old</title><p id="manual">Remote-only content</p><sub-page-list id="existing"/>';
resetFolderBody.fetchLarkDocumentWithIds = async () => ({ doc: "folder-doc", content: resetXml, revisionId: 2 });
resetFolderBody.runLarkCli = async (args) => {
	resetCommands.push(args);
	assert.equal(args[args.indexOf("--command") + 1], "overwrite");
	resetXml = args[args.indexOf("--content") + 1];
	return { ok: true, data: { document: { revision_id: 2 } } };
};
await resetFolderBody.ensureFolderPageList({ token: "folder-node", url: "https://example.feishu.cn/wiki/folder-node" }, "Root/Sub & docs", true);
assert.equal(resetXml, '<title>Sub &amp; docs</title><sub-page-list/>');
assert.equal(resetCommands.length, 1, "folder overwrite rebuilds the native index from local hierarchy");

const folderConsolidation = createPublishingPlugin();
folderConsolidation.settings.publishedFolders.Root = { remoteRoot: "Root", rootParent: { kind: "wiki", token: "space-root" } };
folderConsolidation.settings.folderBindings = {
	"target|wiki|space-root|Root/Sub": { token: "sub-node", url: "", containerKind: "wiki", containerToken: "root-node" },
	"target|wiki|space-root|Root": { token: "root-node", url: "", containerKind: "wiki", containerToken: "space-root" }
};
const consolidatedPages = [];
folderConsolidation.cleanupRemoteDuplicates = async (path, title, parent, keep) => {
	consolidatedPages.push({ path, title, parent: parent.token, keep: keep.token }); return 1;
};
assert.equal(await folderConsolidation.consolidateOverwriteFolderPages("Root", "Root", { kind: "wiki", token: "space-root" }), 2);
assert.deepEqual(consolidatedPages, [
	{ path: "Root", title: "Root", parent: "space-root", keep: "root-node" },
	{ path: "Root/Sub", title: "Sub", parent: "root-node", keep: "sub-node" }
], "duplicate Wiki folders are merged from parent to child before recovering document bindings");

const sharedSetting = createPublishingPlugin();
sharedSetting.settings.documentBindings["Other.md"] = canonicalBinding;
sharedSetting.runLarkCli = async () => ({ ok: true, data: { token: canonicalBinding.token, type: "docx" } });
const beforeSharedSetting = JSON.stringify(sharedSetting.settings);
await assert.rejects(sharedSetting.savePublishedBinding({ id: "markdown:New.md", path: "New.md", kind: "markdown", url: "" }, canonicalBinding.url), /Other.md/);
assert.equal(JSON.stringify(sharedSetting.settings), beforeSharedSetting, "a conflicting link assignment must not alter existing bindings");

// Shared bindings fail before any Markdown/PDF write, including legacy frontmatter.
const sharedBinding = createPublishingPlugin();
sharedBinding.settings.documentBindings = { [fakeNote.path]: canonicalBinding, "Other.md": canonicalBinding };
sharedBinding.updateLarkDocument = async () => assert.fail("Shared documents must not be updated");
await assert.rejects(sharedBinding.syncFileInternal(fakeNote, publishOptions), /Other.md/);
await assert.rejects(sharedBinding.syncFileInternal(fakeNote, overwriteOptions), /Other.md/);
await assert.rejects(sharedBinding.rememberDocumentBinding({ ...fakeNote, path: "New.md" }, canonicalBinding), /已绑定本地文件/);
assert.equal(sharedBinding.settings.documentBindings["New.md"], undefined);

const frontmatterConflict = createPublishingPlugin();
frontmatterConflict.app.vault.getMarkdownFiles = () => [{ ...fakeNote, path: "Legacy.md" }];
frontmatterConflict.app.metadataCache.getFileCache = () => ({ frontmatter: { lark_doc_url: canonicalBinding.url } });
await assert.rejects(frontmatterConflict.rememberDocumentBinding(fakeNote, canonicalBinding), /Legacy.md/);

const wikiAliasConflict = createPublishingPlugin();
wikiAliasConflict.settings.documentBindings["Legacy.md"] = { token: "", url: "https://example.feishu.cn/wiki/shared-node" };
wikiAliasConflict.runLarkCli = async () => ({ ok: true, data: { type: "docx", token: "shared-doc", wiki_node: { node_token: "shared-node" } } });
wikiAliasConflict.updateLarkDocument = async () => assert.fail("Different URL forms for a shared document must be rejected before writes");
await assert.rejects(wikiAliasConflict.syncOrRecreateDocument(fakeNote, { token: "shared-doc", url: "https://example.feishu.cn/docx/shared-doc" },
	{ content: "# Note\n\nBody", images: [] }, undefined, { ...publishOptions, path: fakeNote.path }), /Legacy.md/);

const wikiShortcutConflict = createPublishingPlugin();
wikiShortcutConflict.settings.documentBindings['Legacy.md'] = { token: 'other-node', url: 'https://example.feishu.cn/wiki/other-node' };
const shortcutInspections = [];
wikiShortcutConflict.runLarkCli = async (args) => {
	assert.deepEqual(args.slice(0, 2), ['drive', '+inspect'], 'only read-only alias resolution is allowed');
	const url = args[args.indexOf('--url') + 1];
	shortcutInspections.push(url);
	return { ok: true, data: { type: 'docx', token: 'shared-doc', wiki_node: { node_token: url.split('/').at(-1) } } };
};
wikiShortcutConflict.updateLarkDocument = async () => assert.fail('Wiki shortcuts sharing the same document must fail before writes');
await assert.rejects(wikiShortcutConflict.syncOrRecreateDocument(fakeNote,
	{ token: 'current-node', url: 'https://example.feishu.cn/wiki/current-node' },
	{ content: '# Note\n\nBody', images: [] }, undefined, { ...publishOptions, path: fakeNote.path }), /Legacy.md/);
assert.equal(shortcutInspections.length, 2);
assert.equal(wikiShortcutConflict.settings.documentBindings['Legacy.md'].token, 'other-node', 'a rejected check must leave saved bindings intact');
await assert.rejects(wikiShortcutConflict.savePublishedBinding({ path: 'New.md', kind: 'markdown' }, 'https://example.feishu.cn/docx/shared-doc'), /Legacy.md/);
assert.equal(wikiShortcutConflict.settings.documentBindings['New.md'], undefined);

const legacyProtectedDuplicate = createPublishingPlugin();
legacyProtectedDuplicate.settings.documentBindings['Legacy.md'] = { token: '', url: 'https://example.feishu.cn/wiki/legacy-shortcut' };
legacyProtectedDuplicate.listRemoteDocuments = async () => [
	{ title: 'Note', token: 'keep-doc', nodeToken: 'keep-node', url: 'https://example.feishu.cn/wiki/keep-node' },
	{ title: 'Note', token: 'duplicate-doc', nodeToken: 'duplicate-node', url: 'https://example.feishu.cn/wiki/duplicate-node' }
];
legacyProtectedDuplicate.runLarkCli = async (args) => {
	assert.deepEqual(args.slice(0, 2), ['drive', '+inspect'], 'a legacy-bound duplicate must never be deleted');
	return { ok: true, data: { type: 'docx', token: 'duplicate-doc', wiki_node: { node_token: 'legacy-shortcut' } } };
};
await assert.rejects(legacyProtectedDuplicate.cleanupRemoteDuplicates(fakeNote.path, 'Note', { kind: 'wiki', token: 'parent' },
	{ token: 'keep-doc', nodeToken: 'keep-node', url: 'https://example.feishu.cn/wiki/keep-node' }), /Legacy.md/);

const sharedPdf = createPublishingPlugin();
sharedPdf.settings.pdfBindings = { "One.pdf": { fileToken: "same-pdf" }, "Two.pdf": { fileToken: "same-pdf" } };
sharedPdf.runLarkCli = async () => assert.fail("Shared PDFs must not be uploaded");
await assert.rejects(sharedPdf.syncPdfFileUnlocked({ path: "One.pdf" }), /Two.pdf/);
assert.equal(sharedPdf.t("menuOverwriteSyncToLark"), "Lark: 覆盖同步到飞书");

const cliStatusPlugin = createPlugin();
cliStatusPlugin.probeLarkCliVersion = async () => ({ installed: true, version: "1.0.54", error: "" });
cliStatusPlugin.getNpmToolStatus = async () => ({ available: true, version: "10.9.0", path: "/opt/homebrew/bin/npm", error: "" });
cliStatusPlugin.getLatestLarkCliVersion = async () => ({ version: "1.0.98", error: "" });
cliStatusPlugin.runLarkCliCapture = async (args) => {
	if (args[0] === "auth" && args[1] === "list") {
		return { ok: true, stdout: JSON.stringify([{ userName: "Alex", userOpenId: "ou_1", tokenStatus: "valid" }]), stderr: "", error: "", launchError: false };
	}
	if (args[0] === "auth" && args[1] === "status") {
		return { ok: true, stdout: JSON.stringify({ appId: "cli_1", brand: "feishu", identity: "user", identities: { user: {
			available: true, userName: "Alex", tokenStatus: "valid"
		} } }), stderr: "", error: "", launchError: false };
	}
	assert.fail(`Unexpected management command: ${args.join(" ")}`);
};
const cliStatus = await cliStatusPlugin.getLarkCliManagementStatus();
assert.equal(cliStatus.installed, true);
assert.equal(cliStatus.supported, true);
assert.equal(cliStatus.updateAvailable, true);
assert.equal(cliStatus.auth.configured, true);
assert.equal(cliStatus.authStatus.userName, "Alex");

const unconfiguredCliPlugin = createPlugin();
unconfiguredCliPlugin.probeLarkCliVersion = async () => ({ installed: true, version: "1.0.98", error: "" });
unconfiguredCliPlugin.getNpmToolStatus = async () => ({ available: true, version: "10.9.0", path: "npm", error: "" });
unconfiguredCliPlugin.getLatestLarkCliVersion = async () => ({ version: "1.0.98", error: "" });
unconfiguredCliPlugin.runLarkCliCapture = async (args) => args[1] === "list"
	? { ok: true, stdout: '{"ok":true,"users":[],"reason":"not_configured"}', stderr: "", error: "", launchError: false }
	: { ok: false, stdout: "", stderr: "not configured", error: "not configured", launchError: false };
const unconfiguredStatus = await unconfiguredCliPlugin.getLarkCliManagementStatus();
assert.equal(unconfiguredStatus.auth.configured, false);
assert.equal(unconfiguredStatus.authError, "", "a deliberate not-configured result is not a status-check failure");

const loginPlugin = createPlugin();
let loginPollStarted = false;
let openedLoginUrl = "";
loginPlugin.runLarkCliCapture = async (args) => {
	assert.deepEqual(args.slice(0, 3), ["auth", "login", "--recommend"]);
	assert.ok(args.includes("--no-wait"));
	return { ok: true, stdout: JSON.stringify({
		verification_url: "https://open.feishu.cn/page/cli?user_code=ABCD",
		device_code: "device-code",
		expires_in: 600
	}), stderr: "", error: "", launchError: false };
};
loginPlugin.openAuthorizationUrl = (url) => { openedLoginUrl = url; };
loginPlugin.startLarkCliLoginPolling = () => { loginPollStarted = true; };
const pendingLogin = await loginPlugin.startLarkCliLogin();
assert.equal(pendingLogin.kind, "login");
assert.equal(pendingLogin.deviceCode, "device-code");
assert.equal(openedLoginUrl, "https://open.feishu.cn/page/cli?user_code=ABCD");
assert.equal(loginPollStarted, true);
assert.equal(loginPlugin.getPendingLarkCliAuthorization().kind, "login");
loginPlugin.cancelLarkCliAuthorization();
assert.equal(loginPlugin.getPendingLarkCliAuthorization(), null);

const upgradePlugin = createPlugin();
const upgradeCommands = [];
upgradePlugin.getNpmToolStatus = async () => ({ available: true, version: "10.9.0", path: "npm", error: "" });
upgradePlugin.probeLarkCliVersion = async () => ({ installed: false, version: "", error: "missing" });
upgradePlugin.runNpmCapture = async (args) => {
	upgradeCommands.push(args);
	return { ok: true, stdout: "added 1 package", stderr: "", error: "", launchError: false };
};
upgradePlugin.getLarkCliManagementStatus = async () => ({ ...cliStatus, installed: true, version: "1.0.98", updateAvailable: false });
await upgradePlugin.installOrUpgradeLarkCli();
assert.deepEqual(upgradeCommands, [["install", "-g", "@larksuite/cli@latest", "--no-audit", "--no-fund"]]);

// Deleting remote files whose local file is gone is opt-in, confirmed, and limited to published files.
function createCleanupPlugin() {
	const plugin = createPublishingPlugin();
	plugin.settings.deleteMissingRemote = true;
	const pdf = (fileToken) => ({ version: 1, key: "k", vaultPath: "Team/Scan.pdf", parent: { kind: "drive", token: "" },
		scope: "user", fileName: "Scan.pdf", contentHash: "", size: 1, status: "published", fileToken,
		url: `https://example.feishu.cn/file/${fileToken}`, updatedAt: "" });
	plugin.settings.documentBindings = {
		"Team/Old.md": { token: "doc-old", url: "https://example.feishu.cn/docx/doc-old", containerKind: "drive" },
		"Team/Kept.md": { token: "doc-kept", url: "https://example.feishu.cn/docx/doc-kept" },
		"Team/Moved.md": { token: "doc-moved", url: "https://example.feishu.cn/docx/doc-moved" },
		"Team/Was.md": { token: "doc-moved", url: "https://example.feishu.cn/docx/doc-moved" },
		"Team/Wiki.md": { token: "wiki-doc", url: "https://example.feishu.cn/wiki/node1", nodeToken: "node1", containerKind: "wiki" },
		"Team/Parent.md": { token: "parent-doc", url: "https://example.feishu.cn/wiki/node2", nodeToken: "node2", containerKind: "wiki" },
		"Other/Out.md": { token: "doc-out", url: "https://example.feishu.cn/docx/doc-out" }
	};
	plugin.settings.pdfBindings = { "Team/Scan.pdf": pdf("pdf-1") };
	const existing = new Set(["Team/Kept.md", "Team/Moved.md"]);
	plugin.app.vault = {
		getMarkdownFiles: () => [...existing].map((path) => ({ path, extension: "md" })),
		getAbstractFileByPath: (path) => existing.has(path) ? { path } : null
	};
	plugin.calls = [];
	plugin.confirmed = [];
	plugin.confirmAnswer = true;
	plugin.confirmDeleteMissingRemote = async (missing) => { plugin.confirmed.push(missing.map((file) => file.path)); return plugin.confirmAnswer; };
	plugin.listRemoteWikiNodes = async (parent) => parent.token === "node2" ? [{ node_token: "child" }] : [];
	plugin.runLarkCli = async (args) => {
		plugin.calls.push(args.join(" "));
		if (args[0] === "wiki" && args[1] === "+node-get") {
			const token = args[args.indexOf("--node-token") + 1];
			const objToken = token === "node1" ? "wiki-doc" : "parent-doc";
			return { ok: true, data: { node: { node_token: token, obj_token: objToken, obj_type: "docx", space_id: "space" } } };
		}
		if (plugin.failDeleteOf && args.includes(plugin.failDeleteOf)) throw new Error(plugin.deleteError);
		return { ok: true, data: { deleted: true } };
	};
	return plugin;
}

const offPlugin = createCleanupPlugin();
offPlugin.settings.deleteMissingRemote = false;
await offPlugin.cleanupMissingRemoteFiles("Team");
assert.deepEqual([offPlugin.confirmed, offPlugin.calls], [[], []], "the option is off by default");

const declinePlugin = createCleanupPlugin();
declinePlugin.confirmAnswer = false;
await declinePlugin.cleanupMissingRemoteFiles("Team");
assert.deepEqual(declinePlugin.confirmed, [["Team/Old.md", "Team/Parent.md", "Team/Scan.pdf", "Team/Wiki.md"]],
	"only published files missing locally are offered; moved, existing and out-of-folder files are not");
assert.deepEqual(declinePlugin.calls, []);
assert.ok(declinePlugin.settings.documentBindings["Team/Old.md"], "declining keeps every binding");

const deletePlugin = createCleanupPlugin();
globalThis.__obsidianNotices = [];
await deletePlugin.cleanupMissingRemoteFiles("Team");
assert.deepEqual(deletePlugin.calls, [
	"drive +delete --as user --file-token doc-old --type docx --yes --json",
	"wiki +node-get --as user --node-token node2 --json",
	"drive +delete --as user --file-token pdf-1 --type file --yes --json",
	"wiki +node-get --as user --node-token node1 --json",
	"wiki +node-delete --as user --node-token node1 --obj-type wiki --include-children=false --yes --json"
]);
assert.deepEqual(Object.keys(deletePlugin.settings.documentBindings).sort(),
	["Other/Out.md", "Team/Kept.md", "Team/Moved.md", "Team/Parent.md", "Team/Was.md"],
	"deleted files lose their binding; a wiki doc with child pages, the moved note and others stay");
assert.deepEqual(Object.keys(deletePlugin.settings.pdfBindings), []);
assert.deepEqual(globalThis.__obsidianNotices.map((notice) => notice.message).filter((message) => !message.startsWith("正在")), [
	"已删除 3 个本地已不存在的飞书文件。",
	"有 1 个飞书文档下还有子页面，已跳过未删除。"
]);
delete globalThis.__obsidianNotices;

// A file already deleted by hand only needs its stale binding cleared; other failures keep the binding.
const gonePlugin = createCleanupPlugin();
gonePlugin.failDeleteOf = "doc-old";
gonePlugin.deleteError = "file has been delete.";
await gonePlugin.cleanupMissingRemoteFiles("Team");
assert.equal(gonePlugin.settings.documentBindings["Team/Old.md"], undefined);
const failPlugin = createCleanupPlugin();
failPlugin.failDeleteOf = "doc-old";
failPlugin.deleteError = "permission denied";
globalThis.__obsidianNotices = [];
await failPlugin.cleanupMissingRemoteFiles("Team");
assert.ok(failPlugin.settings.documentBindings["Team/Old.md"], "a failed delete keeps the binding for the next attempt");
assert.equal(failPlugin.settings.pdfBindings["Team/Scan.pdf"], undefined, "other files are still deleted");
assert.ok(globalThis.__obsidianNotices.some((notice) => notice.message.includes("Team/Old.md: permission denied")));
delete globalThis.__obsidianNotices;

// A wiki node whose type or token no longer matches is never deleted.
const changedPlugin = createCleanupPlugin();
const baseRunLarkCli = changedPlugin.runLarkCli;
changedPlugin.runLarkCli = async (args) => {
	if (args[1] === "+node-get") return { ok: true, data: { node: { node_token: "node1", obj_token: "someone-else", obj_type: "docx", space_id: "space" } } };
	return baseRunLarkCli(args);
};
await changedPlugin.cleanupMissingRemoteFiles("Team");
assert.ok(!changedPlugin.calls.some((call) => call.includes("+node-delete")));
assert.ok(changedPlugin.settings.documentBindings["Team/Wiki.md"]);

// Both folder-sync entry points clean up only after a successful sync.
for (const entryPoint of ["context-menu", "published-files"]) {
	for (const [syncOk, expected] of [[true, 1], [false, 0]]) {
		const syncPlugin = createCleanupPlugin();
		globalThis.__obsidianNotices = [];
		syncPlugin.publishFolderInternal = async () => { if (!syncOk) throw new Error("sync failed"); };
		const sync = () => entryPoint === "context-menu" ? syncPlugin.publishFolder("Team")
			: syncPlugin.publishedLinksHost().sync({ id: "folder:Team", kind: "folder", path: "Team", url: "" });
		if (!syncOk && entryPoint === "published-files") await assert.rejects(sync(), /sync failed/);
		else await sync();
		assert.equal(syncPlugin.confirmed.length, expected, entryPoint);
		delete globalThis.__obsidianNotices;
	}
}

// Sync ignore: what a .feishuignore lists is skipped by folder sync, auto-sync and remote cleanup.
const ignoredNote = { ...fakeNote, path: "Root/Kept.md" };
const privateNote = { ...fakeNote, path: "Root/Private/Secret.md" };
const draftNote = { ...fakeNote, path: "Root/draft.md" };
const privatePdf = { path: "Root/Private/Scan.pdf", extension: "pdf" };
const useIgnoreFiles = (plugin, files) => {
	plugin.app.vault.adapter = { exists: async (path) => Object.hasOwn(files, path), read: async (path) => files[path] };
};
const ignorePlugin = createPublishingPlugin();
useIgnoreFiles(ignorePlugin, { "Root/.feishuignore": "Private/\n/draft.md\n" });
await ignorePlugin.refreshIgnoreRules(["Root/Private/a.md", "Root/Privates/a.md", "Root/draft.md", "Other/draft.md"]);
assert.equal(ignorePlugin.isSyncIgnored("Root/Private/a.md"), true);
assert.equal(ignorePlugin.isSyncIgnored("Root/Privates/a.md"), false);
assert.equal(ignorePlugin.isSyncIgnored("Root/draft.md"), true);
assert.equal(ignorePlugin.isSyncIgnored("Other/draft.md"), false, "a rule file only reaches its own folder");
assert.equal(createPlugin().isSyncIgnored("Root/draft.md"), false, "no rule file, nothing ignored");

// Directory-only rules protect the folder page itself from writes and duplicate deletion.
const ignoredPagesPlugin = createPublishingPlugin();
useIgnoreFiles(ignoredPagesPlugin, { "Root/.feishuignore": "/Private/\n" });
await ignoredPagesPlugin.refreshIgnoreRules(["Root/Private/", "Root/Visible/"]);
const pageRoot = { kind: "wiki", token: "parent" };
ignoredPagesPlugin.settings.folderBindings = Object.fromEntries(["", "/Private", "/Private/Child", "/Visible"].map((suffix) => [
	`target|wiki|parent|Remote${suffix}`, { token: `doc${suffix}`, url: `https://example.feishu.cn/wiki/node${suffix}`, containerKind: "wiki" }
]));
const pageWrites = [], duplicateChecks = [];
ignoredPagesPlugin.ensureFolderPageList = async (_binding, path) => { pageWrites.push(path); };
ignoredPagesPlugin.assertRemoteBindingExclusive = () => {};
ignoredPagesPlugin.cleanupRemoteDuplicates = async (path) => { duplicateChecks.push(path); return 0; };
for (const overwrite of [false, true]) {
	pageWrites.length = 0;
	await ignoredPagesPlugin.syncFolderPageLists("Root", "Remote", pageRoot, overwrite);
	assert.deepEqual(pageWrites, ["Root", "Root/Visible"], "ignored folder pages and descendants are untouched");
}
await ignoredPagesPlugin.consolidateOverwriteFolderPages("Root", "Remote", pageRoot);
assert.deepEqual(duplicateChecks, ["Root", "Root/Visible"]);
useIgnoreFiles(ignoredPagesPlugin, { ".feishuignore": "/Root/\n" });
await ignoredPagesPlugin.refreshIgnoreRules(["Root/"]);
pageWrites.length = 0;
duplicateChecks.length = 0;
await ignoredPagesPlugin.syncFolderPageLists("Root", "Remote", pageRoot, true);
await ignoredPagesPlugin.consolidateOverwriteFolderPages("Root", "Remote", pageRoot);
assert.deepEqual([pageWrites, duplicateChecks], [[], []], "an ignored sync root protects its own page too");

// A rule file is looked up in the file's folder and every folder above it, including the vault root.
const stackedPlugin = createPublishingPlugin();
useIgnoreFiles(stackedPlugin, { ".feishuignore": "*.tmp.md\n", "Root/Deep/.feishuignore": "!keep.tmp.md\n/skip.md\n" });
await stackedPlugin.refreshIgnoreRules(["Root/Deep/keep.tmp.md", "Root/Deep/skip.md", "Root/Deep/x.tmp.md", "Root/a.tmp.md"]);
assert.deepEqual(["Root/Deep/keep.tmp.md", "Root/Deep/skip.md", "Root/Deep/x.tmp.md", "Root/a.tmp.md"].map((path) => stackedPlugin.isSyncIgnored(path)),
	[false, true, true, true]);
// Deleting the rule file takes effect on the next refresh.
useIgnoreFiles(stackedPlugin, {});
await stackedPlugin.refreshIgnoreRules(["Root/a.tmp.md"]);
assert.equal(stackedPlugin.isSyncIgnored("Root/a.tmp.md"), false);

// A rule file that cannot be read stops the operation instead of syncing everything.
const unreadablePlugin = createPublishingPlugin();
unreadablePlugin.app.vault.adapter = { exists: async () => true, read: async () => { throw new Error("EACCES"); } };
await assert.rejects(unreadablePlugin.refreshIgnoreRules(["Root/a.md"]), /EACCES/);

const readPaths = [];
ignorePlugin.app.vault.getMarkdownFiles = () => [ignoredNote, privateNote, draftNote];
ignorePlugin.app.vault.getFiles = () => [ignoredNote, privateNote, draftNote, privatePdf];
ignorePlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
ignorePlugin.readNoteForLark = async (file) => { readPaths.push(file.path); throw new Error("stop after read"); };
const folderProgress = [];
await assert.rejects(ignorePlugin.publishFolderInternal("Root", false, (message) => folderProgress.push(message)), /stop after read/);
assert.deepEqual(readPaths, ["Root/Kept.md"], "folder sync reads only notes that are not ignored");
assert.deepEqual(folderProgress, ["正在检查文件夹里的笔记、PDF 和图片…", "共 1 个文件待同步，3 个被 .feishuignore 忽略。", "正在读取 1 篇笔记，并检查飞书上的目录…"],
	"progress says what will be synced and how many files the rules left out");

const allIgnoredPlugin = createPublishingPlugin();
useIgnoreFiles(allIgnoredPlugin, { ".feishuignore": "/Root/\n" });
allIgnoredPlugin.app.vault.getMarkdownFiles = () => [ignoredNote];
allIgnoredPlugin.app.vault.getFiles = () => [ignoredNote];
allIgnoredPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
allIgnoredPlugin.readNoteForLark = async () => { throw new Error("an ignored note must not be read"); };
globalThis.__obsidianNotices = [];
await allIgnoredPlugin.publishFolderInternal("Root");
assert.match(globalThis.__obsidianNotices[0].message, /忽略/, "an all-ignored folder explains why nothing was synced");
const emptyFolderPlugin = createPublishingPlugin();
emptyFolderPlugin.app.vault.getFiles = () => [];
emptyFolderPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
globalThis.__obsidianNotices = [];
await emptyFolderPlugin.publishFolderInternal("Root");
assert.doesNotMatch(globalThis.__obsidianNotices[0].message, /忽略/, "a folder with no files keeps the original notice");
globalThis.__obsidianNotices = undefined;

const originalWindow = globalThis.window;
globalThis.window = { setTimeout: (_callback, delay) => delay, clearTimeout: () => {} };
try {
	const createAutoPlugin = (files) => {
		const plugin = createPublishingPlugin();
		plugin.autoSyncTimers = new Map();
		plugin.autoSyncRunningPaths = new Set();
		plugin.autoSyncPendingPaths = new Set();
		plugin.settings.autoSyncDelaySeconds = 5;
		plugin.settings.documentBindings = { "Root/Kept.md": canonicalBinding, "Root/draft.md": canonicalBinding };
		useIgnoreFiles(plugin, files);
		return plugin;
	};
	const autoPlugin = createAutoPlugin({ "Root/.feishuignore": "/draft.md\n" });
	const synced = [];
	autoPlugin.syncFileInternal = async (file) => { synced.push(file.path); };
	await autoPlugin.runSaveAutoSync(draftNote);
	assert.deepEqual(synced, [], "saving an ignored note does not sync it");
	await autoPlugin.runSaveAutoSync(ignoredNote);
	assert.deepEqual(synced, ["Root/Kept.md"], "other notes still auto-sync");

	// Ignoring happens when the timer fires, so a rule added after the save but before the sync still holds.
	const lateRules = { "Root/.feishuignore": "" };
	const latePlugin = createAutoPlugin(lateRules);
	latePlugin.syncFileInternal = async () => { throw new Error("an ignored note must not auto-sync"); };
	latePlugin.queueSaveAutoSync(draftNote);
	assert.deepEqual([...latePlugin.autoSyncTimers.keys()], ["Root/draft.md"]);
	lateRules["Root/.feishuignore"] = "/draft.md\n";
	await latePlugin.runSaveAutoSync(draftNote);

	// An unreadable rule file is reported and nothing is synced.
	const brokenPlugin = createAutoPlugin({});
	brokenPlugin.app.vault.adapter = { exists: async () => true, read: async () => { throw new Error("EACCES"); } };
	brokenPlugin.syncFileInternal = async () => { throw new Error("must not sync without knowing the rules"); };
	globalThis.__obsidianNotices = [];
	await brokenPlugin.runSaveAutoSync(ignoredNote);
	assert.match(globalThis.__obsidianNotices[0].message, /EACCES/);
	globalThis.__obsidianNotices = undefined;
} finally {
	globalThis.window = originalWindow;
}

const cleanupPlugin = createPublishingPlugin();
cleanupPlugin.settings.documentBindings = {
	"Root/Gone.md": { token: "gone", url: "https://example.feishu.cn/docx/gone" },
	"Root/Private/Gone.md": { token: "private-gone", url: "https://example.feishu.cn/docx/private-gone" }
};
useIgnoreFiles(cleanupPlugin, { "Root/.feishuignore": "Private/\n" });
await cleanupPlugin.refreshIgnoreRules(cleanupPlugin.publishedPathsWithin("Root"));
assert.deepEqual(cleanupPlugin.findMissingRemoteFiles("Root").map((file) => file.path), ["Root/Gone.md"],
	"remote files under an ignored path are never offered for deletion");

// The ignore page reads and writes the same files.
const hostWrites = [];
const hostPlugin = createPublishingPlugin();
hostPlugin.app.vault.adapter = {
	exists: async (path) => path === "Root/.feishuignore",
	read: async () => "/a.md\n",
	write: async (path, content) => { hostWrites.push({ path, content }); }
};
const ignoreHost = hostPlugin.syncIgnoreHost();
assert.deepEqual([...(await ignoreHost.readIgnoreFiles(["", "Root", "Root/Sub"])).entries()], [["Root", "/a.md\n"]]);
await ignoreHost.writeIgnoreFile("Root/Sub", "/b.md\n");
await ignoreHost.writeIgnoreFile("", "/c.md\n");
assert.deepEqual(hostWrites, [{ path: "Root/Sub/.feishuignore", content: "/b.md\n" }, { path: ".feishuignore", content: "/c.md\n" }]);


// Long operations keep a notice at the top right, report their steps there and in the window, and still surface failures.
const longOpPlugin = createPlugin();
globalThis.__obsidianNotices = [];
globalThis.__obsidianNoticeHidden = [];
assert.equal(await longOpPlugin.runWithProgressNotice("working", async () => "done"), "done");
await assert.rejects(longOpPlugin.runWithProgressNotice("working", async () => { throw new Error("boom"); }), /boom/);
assert.deepEqual(globalThis.__obsidianNotices.map((notice) => notice.timeout), [0, 0, 10000], "a persistent notice, then a lasting error notice");
assert.match(globalThis.__obsidianNotices[2].message, /boom/);
assert.equal(globalThis.__obsidianNoticeHidden.length, 2, "the progress notice is hidden on success and on failure");
assert.equal(await longOpPlugin.runWithNotice("working", async () => {}), true);
assert.equal(await longOpPlugin.runWithNotice("working", async () => { throw new Error("boom"); }), false);

const syncHostPlugin = createPlugin();
syncHostPlugin.publishFolderInternal = async (_folder, _overwrite, onProgress) => { onProgress("step A"); onProgress("step B"); };
globalThis.__obsidianNotices = [];
globalThis.__obsidianNoticeUpdates = [];
globalThis.__obsidianNoticeHidden = [];
const reportedSteps = [];
await syncHostPlugin.publishedLinksHost().sync({ id: "folder:Root", kind: "folder", path: "Root", url: "" }, (message) => reportedSteps.push(message));
assert.deepEqual(reportedSteps, ["step A", "step B"], "the window gets every step");
assert.deepEqual(globalThis.__obsidianNoticeUpdates, ["正在发布目录到飞书...\nstep A", "正在发布目录到飞书...\nstep B"], "so does the notice");
assert.deepEqual(globalThis.__obsidianNotices.map((notice) => notice.timeout), [0]);
assert.equal(globalThis.__obsidianNoticeHidden.length, 1);

// The right-click folder sync shows the same steps in its notice.
const menuSyncPlugin = createPlugin();
menuSyncPlugin.publishFolderInternal = async (_folder, _overwrite, onProgress) => { onProgress("step A"); };
menuSyncPlugin.cleanupMissingRemoteFiles = async () => {};
globalThis.__obsidianNoticeUpdates = [];
await menuSyncPlugin.publishFolder("Root");
await menuSyncPlugin.publishFolder("Root", true);
assert.deepEqual(globalThis.__obsidianNoticeUpdates, ["正在发布目录到飞书...\nstep A", "正在覆盖同步到飞书...\nstep A"]);
globalThis.__obsidianNotices = undefined;
globalThis.__obsidianNoticeUpdates = undefined;
globalThis.__obsidianNoticeHidden = undefined;

const galleryRoot = await mkdtemp(join(tmpdir(), "image-gallery-main-"));
try {
	await mkdir(join(galleryRoot, "Root", "Shots"), { recursive: true });
	await mkdir(join(galleryRoot, "Root", "Notes"), { recursive: true });
	await mkdir(join(galleryRoot, "Hidden"), { recursive: true });
	const imagePaths = ["Root/Shots/b.png", "Root/Shots/a.png", "Root/Notes/used.png", "Root/Notes/spare.png", "Hidden/x.png"];
	for (const path of imagePaths) await writeFile(join(galleryRoot, path), "x");
	const contents = new Map([["Root/Notes/Readme.md", "![[used.png]]\n"]]);
	const writes = [];
	const createGalleryPlugin = () => {
		const plugin = createPublishingPlugin();
		plugin.getVaultRoot = () => galleryRoot;
		plugin.settings.disconnectedFolders = { Hidden: true };
		plugin.app.vault = {
			getName: () => "Vault",
			getFiles: () => imagePaths.map((path) => ({ path, extension: "png" })),
			getMarkdownFiles: () => Array.from(contents.keys()).map((path) => ({ path, extension: "md" })),
			read: async (file) => contents.get(file.path),
			create: async (path, content) => { writes.push({ kind: "create", path }); contents.set(path, content); },
			modify: async (file, content) => { writes.push({ kind: "modify", path: file.path }); contents.set(file.path, content); }
		};
		installVaultTree(plugin.app.vault);
		return plugin;
	};

	// Unreferenced images are collected per folder, including folders that also hold notes.
	const galleryPlugin = createGalleryPlugin();
	assert.equal(await galleryPlugin.ensureImageGalleryNotes("Root"), 2);
	assert.deepEqual(writes, [{ kind: "create", path: "Root/Notes/Notes 图片.md" }, { kind: "create", path: "Root/Shots/Shots 图片.md" }]);
	assert.match(contents.get("Root/Notes/Notes 图片.md"), /^<!-- feishu-docs-publisher:image-gallery -->\n\n!\[\[Root\/Notes\/spare\.png\]\]\n$/);
	assert.match(contents.get("Root/Shots/Shots 图片.md"), /!\[\[Root\/Shots\/a\.png\]\]\n\n!\[\[Root\/Shots\/b\.png\]\]\n$/);
	assert.equal(contents.has("Hidden/Hidden 图片.md"), false, "disconnected folders are skipped");

	// Running again leaves unchanged galleries alone, and picks up new images while keeping the binding.
	writes.length = 0;
	assert.equal(await galleryPlugin.ensureImageGalleryNotes("Root"), 0);
	assert.deepEqual(writes, []);
	contents.set("Root/Shots/Shots 图片.md", `---\nlark_url: https://example.feishu.cn/docx/shots\n---\n${contents.get("Root/Shots/Shots 图片.md")}`);
	imagePaths.push("Root/Shots/c.png");
	await writeFile(join(galleryRoot, "Root/Shots/c.png"), "x");
	assert.equal(await galleryPlugin.ensureImageGalleryNotes("Root"), 0);
	assert.deepEqual(writes, [{ kind: "modify", path: "Root/Shots/Shots 图片.md" }]);
	assert.match(contents.get("Root/Shots/Shots 图片.md"), /^---\nlark_url: https:\/\/example\.feishu\.cn\/docx\/shots\n---\n\n<!-- feishu-docs-publisher:image-gallery -->/);
	assert.match(contents.get("Root/Shots/Shots 图片.md"), /c\.png\]\]\n$/);

	// Ignored images and folders are not collected; images embedded by an ignored note stay out too.
	contents.clear();
	contents.set("Root/Notes/Readme.md", "![[used.png]]\n");
	contents.set("Root/Notes/Secret.md", "![[spare.png]]\n");
	writes.length = 0;
	const ignoredGalleryPlugin = createGalleryPlugin();
	const galleryPaths = [...imagePaths, ...contents.keys()];
	useIgnoreFiles(ignoredGalleryPlugin, { "Root/.feishuignore": "/Notes/Secret.md\nb.png\n" });
	await ignoredGalleryPlugin.refreshIgnoreRules(galleryPaths);
	assert.equal(await ignoredGalleryPlugin.ensureImageGalleryNotes("Root"), 1);
	assert.deepEqual(writes, [{ kind: "create", path: "Root/Shots/Shots 图片.md" }]);
	assert.doesNotMatch(contents.get("Root/Shots/Shots 图片.md"), /b\.png/);
	assert.match(contents.get("Root/Shots/Shots 图片.md"), /a\.png.*c\.png/s);

	contents.clear();
	contents.set("Root/Notes/Readme.md", "![[used.png]]\n");
	writes.length = 0;
	useIgnoreFiles(ignoredGalleryPlugin, { "Root/.feishuignore": "/Shots/\n" });
	await ignoredGalleryPlugin.refreshIgnoreRules(galleryPaths);
	assert.equal(await ignoredGalleryPlugin.ensureImageGalleryNotes("Root"), 1);
	assert.deepEqual(writes, [{ kind: "create", path: "Root/Notes/Notes 图片.md" }], "an ignored folder gets no gallery");

	// An ignored gallery note is left exactly as it is, and still reserves its path.
	const staleGallery = "<!-- feishu-docs-publisher:image-gallery -->\n\n![[Root/Shots/old.png]]\n";
	contents.set("Root/Shots/Shots 图片.md", staleGallery);
	writes.length = 0;
	useIgnoreFiles(ignoredGalleryPlugin, { "Root/.feishuignore": "/Shots/Shots 图片.md\n" });
	await ignoredGalleryPlugin.refreshIgnoreRules([...galleryPaths, "Root/Shots/Shots 图片.md"]);
	await ignoredGalleryPlugin.ensureImageGalleryNotes("Root");
	assert.equal(contents.get("Root/Shots/Shots 图片.md"), staleGallery);
	assert.equal(writes.some((write) => write.path === "Root/Shots/Shots 图片.md"), false);

	// A folder with nothing but images no longer stops at "no files": the gallery note is published.
	contents.clear();
	const imageOnlyPlugin = createGalleryPlugin();
	imageOnlyPlugin.withDeferredLarkSyncStateSave = async (callback) => callback();
	imageOnlyPlugin.readNoteForLark = async (file) => { throw new Error(`reached ${file.path}`); };
	await assert.rejects(imageOnlyPlugin.publishFolderInternal("Root/Shots"), /reached Root\/Shots\/Shots 图片\.md/);

	// Empty galleries are refreshed even when no eligible images remain anywhere in the scope.
	for (const mode of ["deleted", "ignored", "ignored-gallery"]) {
		contents.clear();
		const galleryPath = "Root/Shots/Shots 图片.md";
		const original = "---\nlark_url: https://example.feishu.cn/docx/shots\n---\n\n<!-- feishu-docs-publisher:image-gallery -->\n\n![[Root/Shots/a.png]]\n";
		contents.set(galleryPath, original);
		writes.length = 0;
		const emptyGalleryPlugin = createGalleryPlugin();
		const remainingImages = mode === "deleted" ? [] : [{ path: "Root/Shots/a.png", extension: "png" }];
		emptyGalleryPlugin.app.vault.getFiles = () => remainingImages;
		useIgnoreFiles(emptyGalleryPlugin, { "Root/.feishuignore": mode === "ignored-gallery" ? "*.png\n*.md\n" : "*.png\n" });
		await emptyGalleryPlugin.refreshIgnoreRules([galleryPath]);
		await emptyGalleryPlugin.ensureImageGalleryNotes("Root");
		if (mode === "ignored-gallery") {
			assert.equal(contents.get(galleryPath), original, "an ignored gallery is never rewritten");
			assert.deepEqual(writes, []);
		} else {
			assert.deepEqual(writes, [{ kind: "modify", path: galleryPath }]);
			assert.equal(contents.get(galleryPath), "---\nlark_url: https://example.feishu.cn/docx/shots\n---\n\n<!-- feishu-docs-publisher:image-gallery -->\n");
		}
	}
} finally {
	await rm(galleryRoot, { force: true, recursive: true });
}

// The plugin writes a durable upload record before deleting the placeholder;
// a new instance can resume through the document's URL/token aliases.
const mediaRoot = await mkdtemp(join(tmpdir(), "image-recovery-main-"));
try {
	const image = {
		placeholder: `FEISHU_LARK_LOCAL_IMAGE_${"a".repeat(64)}`,
		absolutePath: join(mediaRoot, "photo.png"), vaultPath: "new/photo.png"
	};
	const placeholderBlock = `<p id="placeholder">${image.placeholder}</p>`;
	const uploadedBlock = '<img id="new-upload" name="photo.png"/>';
	let remoteXml = `${placeholderBlock}<img id="existing" name="photo.png"/>`;
	let uploads = 0, moves = 0, failDeletion = true;
	const createRecoveryPlugin = () => {
		const plugin = createPlugin();
		plugin.getPluginDirectoryPath = () => mediaRoot;
		plugin.fetchLarkDocumentWithIds = async () => ({ doc: "doc-token", content: remoteXml, revisionId: 1 });
		plugin.runLarkCli = async (args) => {
			if (args.includes("+media-insert")) {
				uploads++;
				remoteXml += uploadedBlock;
				return { data: { block_id: "new-upload" } };
			}
			const command = args[args.indexOf("--command") + 1];
			if (command === "block_move_after") {
				moves++;
				remoteXml = remoteXml.replace(uploadedBlock, "").replace(placeholderBlock, placeholderBlock + uploadedBlock);
			} else if (command === "block_delete") {
				if (failDeletion) throw new Error("interrupted before deleting placeholder");
				remoteXml = remoteXml.replace(placeholderBlock, "");
			} else assert.fail(`Unexpected media command: ${args.join(" ")}`);
			return { data: {} };
		};
		return plugin;
	};
	await assert.rejects(createRecoveryPlugin().materializeLocalImages("https://example.feishu.cn/docx/doc-token", [image]),
		/interrupted before deleting placeholder/);
	failDeletion = false;
	await createRecoveryPlugin().materializeLocalImages("doc-token", [image]);
	assert.equal(uploads, 1, "a new plugin instance reuses the recorded block id");
	assert.equal(moves, 1, "an already placed upload is never moved again");
	assert.equal(remoteXml, `${uploadedBlock}<img id="existing" name="photo.png"/>`);
} finally {
	await rm(mediaRoot, { recursive: true, force: true });
}

console.log("main plugin tests passed");

// Native conversion is opt-in, and converted documents retain their native route.
const nativePlugin = createPublishingPlugin();
nativePlugin.settings.nativeCalloutExport = true;
const nativeSource = '# Note\n\nMain\n\n> [!note]- Details\n> Body\n\nTail';
nativePlugin.readNoteForLark = async () => ({content:nativeSource,images:[]});
let nativeCalls=0,nativeCreates=0,initialNativeBody;
nativePlugin.syncNativePreparedDocument = async (_doc,prepared) => {
 nativeCalls++;assert.equal(prepared.content,nativeSource);
 nativePlugin.settings.nativeCalloutStates = {[canonicalBinding.token]:{version:1,sourceHash:'native',units:[]}};
};
nativePlugin.withTempMarkdown = async (_name,content,callback) => {
 initialNativeBody=content;return callback({directory:'/tmp',fileName:'native.md'});
};
nativePlugin.runLarkCli = async args => {
 assert.ok(args.includes('+create'));nativeCreates++;
 return {ok:true,data:{document:{document_id:canonicalBinding.token,url:canonicalBinding.url}}};
};
await nativePlugin.syncFileInternal(fakeNote,publishOptions);
assert.equal(initialNativeBody,'');assert.equal(nativeCalls,1);
nativePlugin.settings.nativeCalloutExport=false;
await nativePlugin.syncFileInternal(fakeNote,{...publishOptions,allowCreate:false,mode:'save'});
assert.equal(nativeCalls,2,'turning the setting off must not flatten existing native documents');
assert.equal(nativeCreates,1);
assert.equal(nativePlugin.hasNativeCallouts('```md\n> [!note]- Example\n```'),false);
const defaultPlugin=createPlugin();defaultPlugin.loadData=async()=>null;await defaultPlugin.loadSettings();
assert.equal(defaultPlugin.settings.nativeCalloutExport,false);
assert.equal(defaultPlugin.settings.researchLabelColors,false);
assert.equal(defaultPlugin.settings.updateFrontmatter,false);
const classicPlugin=createPublishingPlugin();
classicPlugin.app.vault.read=async()=>'> [!note]- Details\n> Body';
const classicPrepared=await LarkCliSyncPlugin.prototype.readNoteForLark.call(classicPlugin,fakeNote);
assert.match(classicPrepared.content,/📝 NOTE/);assert.doesNotMatch(classicPrepared.content,/\[!note\]/);
classicPlugin.settings.nativeCalloutExport=true;
const nativePrepared=await LarkCliSyncPlugin.prototype.readNoteForLark.call(classicPlugin,fakeNote);
assert.match(nativePrepared.content,/> \[!note\]- Details/);
classicPlugin.settings.nativeCalloutExport=false;
classicPlugin.settings.documentBindings[fakeNote.path]=canonicalBinding;
classicPlugin.settings.nativeCalloutStates={[canonicalBinding.token]:{version:1,sourceHash:'native',units:[]}};
assert.match((await LarkCliSyncPlugin.prototype.readNoteForLark.call(classicPlugin,fakeNote)).content,/> \[!note\]- Details/);
console.log('Native Callout opt-in, persistent routing, and default settings tests passed');

const readOnlyUnbind=createPublishingPlugin();
readOnlyUnbind.settings.documentBindings[fakeNote.path]=canonicalBinding;
readOnlyUnbind.app.fileManager.processFrontMatter=async()=>{throw new Error('disabled frontmatter must remain read-only');};
readOnlyUnbind.app.metadataCache.getFileCache=()=>({frontmatter:{lark_doc_url:canonicalBinding.url}});
await readOnlyUnbind.unbindDeletedRemoteDocument(fakeNote,canonicalBinding);
assert.equal(readOnlyUnbind.settings.documentBindings[fakeNote.path],undefined);
assert.equal(readOnlyUnbind.settings.disconnectedBindings[fakeNote.path],true);
console.log('Read-only unbinding preserves source notes and blocks stale bindings');
