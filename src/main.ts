import { preparePdfCropImages, scanPdfCropReferences } from "./pdf-crops";
import { prepareNativeCallouts } from "./native-callout";
import { NativeState, syncNativeDocument } from "./native-sync";
import {
	addIcon,
	loadPdfJs,
	App,
	ButtonComponent,
	FileSystemAdapter,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	SettingGroupItem,
	TFile,
	TFolder
} from "obsidian";
import { ChildProcess, execFile, spawn } from "child_process";
import { constants } from "fs";
import { access, chmod, copyFile, mkdir, readFile, rename, stat } from "fs/promises";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import process from "process";
import { promisify } from "util";
import {
	clearDisconnectedFolderPaths,
	getRemoteParentPath as getSelectedRemoteParentPath,
	getSelectedFolderName as getSelectedRemoteRootName
} from "./folder-path";
import {
	buildFolderLinkMap as createFolderLinkMap,
	FolderLinkMapEntry,
	LinkTarget,
	mayContainInternalLinks,
	normalizeLinkPath,
	parentPath,
	resolveInternalLink,
	rewriteInternalLinks
} from "./link-rewrite";
import {
	buildSyncPlan,
	buildUpdateCommandArgs,
	createDocumentSyncStateFromRemote,
	createEmptySyncStateFile,
	createIncompleteDocumentSyncStateFromMarkdown,
	createStagedMarkdownPublishPlan,
	createSyncContentSignature,
	extractDocumentToken,
	extractTitle,
	formatSyncFailureMessage,
	getDocumentStateKey,
	getDocumentStateKeys,
	FRONTMATTER_TOKEN_KEY,
	FRONTMATTER_URL_KEY,
	isDocumentStateContentEquivalent,
	isDocumentStateBlockMappingAcceptable,
	invalidateLocalImageSyncState,
	isRemoteMarkdownContentEquivalent as isExportedMarkdownContentEquivalent,
	isRemoteXmlContentEquivalent,
	isSyncContentSignatureEquivalent,
	LEGACY_FRONTMATTER_SYNCED_AT_KEY,
	LarkSyncStateFile,
	mergeSyncStateFiles,
	normalizeStateCacheRetainLimit,
	prepareNoteContentForLark,
	prepareOverwriteMarkdownContent,
	removeBindingOnlyFrontmatterBeforeNextFrontmatter,
	removeLarkBinding,
	stripPreparedMarkdownTitle,
	SyncFailureReason,
	SyncMode,
	SyncPlan,
	SyncStrategy,
	TitleSource,
	touchDocumentSyncState,
	trimSyncStateCache
} from "./lark-sync-core";
import {
	buildCommandEnvironment as buildLarkCommandEnvironment,
	formatMissingLarkCli,
	formatUnsupportedLarkCliVersion,
	isSupportedLarkCliVersion,
	MIN_EXCLUSIVE_LARK_CLI_VERSION,
	parseLarkCliVersion,
	resolveLarkCliInvocation,
	resolveLarkCliPathFromSetting,
	uniquePathEntries,
	withDocsApiVersion
} from "./lark-cli-command";
import {
	applyProxyEnvironment,
	buildProxyUrl,
	DEFAULT_PROXY_HOST,
	DEFAULT_PROXY_PORT,
	detectProxyEnvironment,
	extractLarkCliVerificationUrl,
	isLarkCliVersionNewer,
	LarkCliAuthList,
	LarkCliAuthStatus,
	LarkCliBrand,
	LARK_CLI_NPM_PACKAGE,
	LarkCliProxyMode,
	LarkCliUpdateCheck,
	NODE_DOWNLOAD_URL,
	normalizeLarkCliBrand,
	normalizeProxyHost,
	normalizeProxyMode,
	normalizeProxyPort,
	parseLarkCliAuthList,
	parseLarkCliAuthStatus,
	parseLarkCliDeviceAuthorization,
	parseLarkCliError,
	parseLarkCliUpdateCheck,
	parseNpmVersionOutput
} from "./lark-cli-management";
import {
	EMBEDDED_LARK_CLI_COMMAND_SCRIPT,
	EMBEDDED_PRE_PUSH_CORE_SCRIPT,
	EMBEDDED_PRE_PUSH_SCRIPT
} from "./embedded-helpers";
import {
	buildLocalImageFileIndexFromPaths,
	buildLocalMediaFileIndexFromPaths,
	collectReferencedLocalImagePaths,
	containsLocalImagePlaceholders,
	findReferencingMarkdownFiles,
	isSupportedImagePath,
	LocalImageFileIndex,
	isSupportedLocalMediaPath,
	LocalImageResource,
	prepareLocalImages,
	scanLocalImageReferences
} from "./local-image";
import {
	buildMediaInsertArgs,
	buildMediaMoveArgs,
	buildPlaceholderRemoveArgs,
	materializeLocalImages as materializePreparedLocalImages
} from "./media-sync-orchestrator";
import { createMediaUploadJournal } from "./media-upload-journal";

import {
	buildImageGalleryBody,
	isImageGalleryContent,
	planImageGalleries,
	replaceImageGalleryBody
} from "./image-gallery";
import { confirmDeletion } from "./confirm-delete-modal";
import { findMissingRemoteFiles, MissingRemoteFile } from "./remote-cleanup";
import { PublishedLinkBindingModal, PublishedLinkEntry, PublishedLinksHost, PublishedLinksModal } from "./published-links";
import { createPdfBindingKey, PdfBinding, PdfPublishParent, publishPdf } from "./pdf-publish";
import { buildPublishedPdfTargets, rewritePublishedPdfLinks } from "./pdf-links";
import { SyncQueue } from "./sync-queue";
import { collectIgnoreDirectories, IgnoreRules, ignoreFilePath } from "./ignore-rules";
import { VaultNodeLike } from "./sync-ignore";
import { SYNC_IGNORE_VIEW_TYPE, SyncIgnoreHost, SyncIgnoreView } from "./sync-ignore-view";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: LarkCliSyncSettings = {
	language: "zh-CN",
	larkCliPath: "lark-cli",
	targetTokenOrUrl: "",
	documentBindings: {},
	pendingDocumentCreates: {},
	pendingFolderCreates: {},
	disconnectedBindings: {},
	disconnectedFolders: {},
	pdfBindings: {},
	folderBindings: {},
	publishedFolders: {},
	titleSource: "file-name",
	openAfterSync: true,
	updateFrontmatter: false,
	nativeCalloutExport: false,
	researchLabelColors: false,
	autoSyncMode: "save",
	autoSyncDelaySeconds: 15,
	syncStrategy: "auto",
	stateCacheRetainLimit: 100,
	deleteMissingRemote: false,
	proxyMode: "system",
	proxyHost: DEFAULT_PROXY_HOST,
	proxyPort: DEFAULT_PROXY_PORT,
	larkCliBrand: "feishu"
};

const FRONTMATTER_REMOTE_ROOT_KEY = "remoteRoot";
const FRONTMATTER_REMOTE_PARENT_PATH_KEY = "remoteParentPath";
const MAX_STDERR_LENGTH = 1600;
const MAX_NOTICE_ERROR_DETAIL_LENGTH = 260;
const NODE_COMMAND = "node";
const PRE_PUSH_SCRIPT_NAME = "sync-pre-push.mjs";
const PRE_PUSH_CORE_SCRIPT_NAME = "lark-sync-core.mjs";
const LARK_CLI_COMMAND_SCRIPT_NAME = "lark-cli-command.mjs";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";
const PRE_PUSH_HOOK_MARKER = "Feishu Docs Publisher";
const LEGACY_PRE_PUSH_HOOK_MARKER = "Feishu Lark CLI Sync";
// Archived plugin id: copy its vault data forward and keep recognizing its Git hook.
const LEGACY_PLUGIN_ID = "feishu-lark-cli-sync";
const LARK_RIBBON_ICON_ID = "feishu-docs-publisher-ribbon";
const LARK_RIBBON_ICON_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
	stroke-linecap="round" stroke-linejoin="round">
	<path d="M4 12.5 20 5l-5.2 14-3.3-5.1L4 12.5z"/>
	<path d="m11.5 13.9 3.9-4.4"/>
	<path d="M5 18h6"/>
	<path d="M7 21h4"/>
</svg>`;
const AUTO_SYNC_WRITE_IGNORE_MS = 5000;
const DEFAULT_AUTO_SYNC_DELAY_SECONDS = 15;
const DEFAULT_STATE_CACHE_RETAIN_LIMIT = 100;
const SAVE_REMOTE_STATE_REFRESH_ATTEMPTS = 8;
const SAVE_REMOTE_STATE_REFRESH_DELAY_MS = 1500;
const STRICT_REMOTE_STATE_REFRESH_ATTEMPTS = 8;
const STRICT_REMOTE_STATE_REFRESH_DELAY_MS = 1500;
const FOLDER_SYNC_PARALLEL_LIMIT = 3;
const LARK_CLI_MAX_CONCURRENT_REQUESTS = 3;
const LARK_CLI_REQUEST_INTERVAL_MS = 350;
const LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS = [3000, 6000, 12000];
const LARK_CLI_VERSION_ARGS = [["-version"], ["-v"]];
const LARK_CLI_STATUS_TIMEOUT_MS = 20_000;
const LARK_CLI_INSTALL_TIMEOUT_MS = 10 * 60_000;
const LARK_CLI_LOGIN_TIMEOUT_MS = 12 * 60_000;
const LARK_CLI_CONFIGURATION_TIMEOUT_MS = 12 * 60_000;
const FALLBACK_LOGIN_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const STAGED_PUBLISH_THRESHOLD_BYTES = 100 * 1024;
const STAGED_PUBLISH_THRESHOLD_UNITS = 400;
const STAGED_PUBLISH_MAX_BATCH_BYTES = 60 * 1024;
const STAGED_PUBLISH_MAX_BATCH_UNITS = 100;
const DOCUMENT_END_BLOCK_ID = "-1";

type Language = "zh-CN" | "en";
type AutoSyncMode = "manual" | "save" | "pre-push";
type PrePushHookStatus = "installed" | "not-installed" | "not-git-repository" | "unavailable" | "unknown";
type RemoteParentKind = "wiki" | "drive" | "my_library" | "unknown";
type LarkCliAuthorizationKind = "login" | "app-configuration";

interface LarkCliSyncSettings {
	nativeCalloutExport: boolean;
	researchLabelColors: boolean;
	nativeCalloutStates?: Record<string, NativeState>;
	language: Language;
	larkCliPath: string;
	larkCliVersionCheck?: LarkCliVersionCheck;
	targetTokenOrUrl: string;
	documentBindings: Record<string, BoundLarkDocument>;
	pendingDocumentCreates: Record<string, { title: string; startedAt: string }>;
	pendingFolderCreates: Record<string, string>;
	disconnectedBindings: Record<string, boolean>;
	disconnectedFolders: Record<string, boolean>;
	recursiveFolderUnlinkMigrated?: boolean;
	pdfBindings: Record<string, PdfBinding>;
	folderBindings: Record<string, BoundLarkDocument>;
	publishedFolders: Record<string, PublishedFolderBinding>;
	titleSource: TitleSource;
	openAfterSync: boolean;
	updateFrontmatter: boolean;
	autoSyncMode: AutoSyncMode;
	autoSyncDelaySeconds: number;
	syncStrategy: SyncStrategy;
	stateCacheRetainLimit: number;
	deleteMissingRemote: boolean;
	proxyMode: LarkCliProxyMode;
	proxyHost: string;
	proxyPort: number;
	larkCliBrand: LarkCliBrand;
}

interface LarkCliVersionCheck {
	executable: string;
	version: string;
}

interface LarkCliToolStatus {
	available: boolean;
	version: string;
	path: string;
	error: string;
}

interface LarkCliManagementStatus {
	installed: boolean;
	version: string;
	versionError: string;
	supported: boolean;
	npm: LarkCliToolStatus;
	latestVersion: string;
	updateAvailable: boolean;
	updateError: string;
	auth: LarkCliAuthList;
	authStatus: LarkCliAuthStatus | null;
	authError: string;
}

interface RawCommandCapture {
	stdout: string;
	stderr: string;
}

interface RawCommandResult extends RawCommandCapture {
	ok: boolean;
	error: string;
	launchError: boolean;
}

interface PendingLarkCliAuthorization {
	kind: LarkCliAuthorizationKind;
	verificationUrl: string;
	startedAt: string;
	deviceCode?: string;
}

interface BoundLarkDocument {
	token: string;
	url: string;
	nodeToken?: string;
	containerToken?: string;
	containerKind?: RemoteParentKind;
	remoteParentPath?: string;
	remoteRoot?: string;
}

interface PublishedFolderBinding {
	rootParent: RemoteParent;
	remoteRoot: string;
}

interface LarkDocumentUpdateResult extends Partial<BoundLarkDocument> {
	revisionId?: number;
}

interface LarkCommandDocument {
	document_id?: string;
	url?: string;
	revision_id?: number;
	content?: string;
	new_blocks?: Array<{ block_id?: string }>;
}

interface LarkCommandNode {
	node_token?: string;
	obj_token?: string;
	url?: string;
	space_id?: string;
	parent_node_token?: string;
	obj_type?: string;
	title?: string;
}

interface LarkCommandResult {
	ok: boolean;
	data?: {
		token?: string;
		space_id?: string;
		parent_node_token?: string;
		obj_type?: string;
		nodes?: LarkCommandNode[];
		files?: Array<{ token: string; type: string; name: string; url?: string }>;
		has_more?: boolean;
		page_token?: string;
		next_page_token?: string;
		type?: string;
		file_token?: string;
		folder_token?: string;
		comment_id?: string;
		reply_id?: string;
		block_id?: string;
		"document"?: LarkCommandDocument;
		node?: LarkCommandNode;
		node_token?: string;
		obj_token?: string;
		url?: string;
		wiki_node?: {
			node_token?: string;
			obj_token?: string;
			obj_type?: string;
			parent_node_token?: string;
		};
	};
	error?: {
		message?: string;
		hint?: string;
	};
}

interface LarkCommandOptions {
	cwd?: string;
}

// Obsidian exposes loadPdfJs() as Promise<any>; describe the renderer surface we use.
interface PdfJs {
	getDocument(options: { data: Uint8Array; isEvalSupported: boolean }): {
		promise: Promise<{
			getPage(pageNumber: number): Promise<{
				getViewport(options: { scale: number }): PdfViewport;
				render(options: {
					canvasContext: CanvasRenderingContext2D;
					viewport: PdfViewport;
					transform: number[];
					background: string;
				}): { promise: Promise<void> };
			}>;
			destroy(): Promise<void>;
		}>;
	};
}

interface PdfViewport {
	width: number;
	height: number;
	convertToViewportRectangle(rect: [number, number, number, number]): [number, number, number, number];
}

interface PreparedNoteContent {
	content: string;
	images: LocalImageResource[];
}

interface FolderPublishEntry {
	file: TFile;
	preparedContent: PreparedNoteContent;
	binding?: BoundLarkDocument;
	parent: RemoteParent;
	remoteParentPath: string;
	isNewDocument: boolean;
}

interface FolderPreparedFile {
	file: TFile;
	preparedContent: PreparedNoteContent;
	binding: BoundLarkDocument | null;
	remoteParentPath: string;
}

interface IndexedFolderPreparedFile {
	preparedFile: FolderPreparedFile;
	index: number;
}

interface RemoteParent {
	token: string;
	kind: RemoteParentKind;
	spaceId?: string;
}

interface RemoteFolderPathResolution {
	parent: RemoteParent;
	createdBinding: boolean;
}

interface PublishedFolderResolution {
	folderPath: string;
	binding: PublishedFolderBinding;
	inferred: boolean;
}

interface FolderDocumentParent {
	parent: RemoteParent;
	remoteRoot: string;
	remoteParentPath: string;
}

interface SyncFileOptions {
	allowCreate: boolean;
	openAfterSync: boolean;
	showSuccess: boolean;
	showRemoteDeletedNotice: boolean;
	updateFrontmatter: boolean;
	mode: SyncMode;
	strategy?: SyncStrategy;
	successMessageKey?: MessageKey;
}

interface SyncOrRecreateOptions {
	allowRecreate: boolean;
	showRemoteDeletedNotice: boolean;
	updateFrontmatter: boolean;
	mode: SyncMode;
	path: string;
	strategy?: SyncStrategy;
	stateKeys?: string[];
}

interface RemoteStateRefreshPolicy {
	attempts: number;
	delayMs: number;
	allowTimeoutFallback: boolean;
}

type RemoteStateRefreshRejectReason =
	| "revision-lag"
	| "content-not-equivalent"
	| "block-mapping-incomplete"
	| "state-not-accepted";

interface RemoteStateRefreshDiagnostic {
	rejectReason: RemoteStateRefreshRejectReason;
	observedRevisionId?: number;
	unitCount?: number;
	missingBlockIdCount?: number;
}

const SAVE_REMOTE_STATE_REFRESH_POLICY: RemoteStateRefreshPolicy = {
	attempts: SAVE_REMOTE_STATE_REFRESH_ATTEMPTS,
	delayMs: SAVE_REMOTE_STATE_REFRESH_DELAY_MS,
	allowTimeoutFallback: true
};

const STRICT_REMOTE_STATE_REFRESH_POLICY: RemoteStateRefreshPolicy = {
	attempts: STRICT_REMOTE_STATE_REFRESH_ATTEMPTS,
	delayMs: STRICT_REMOTE_STATE_REFRESH_DELAY_MS,
	allowTimeoutFallback: false
};

class LocalizedSyncError extends Error {
}

class RemoteStateRefreshError extends LocalizedSyncError {
	readonly updateSubmitted: boolean;

	constructor(message: string, updateSubmitted: boolean) {
		super(message);
		this.updateSubmitted = updateSubmitted;
	}
}

const MESSAGES = {
	"zh-CN": {
		menuManagePublishedLinks: "已发布文件",
		menuOpenPublishedLink: "打开飞书链接",
		menuEditPublishedLink: "设置飞书链接",
		menuSyncIgnore: "选择忽略的文件",
		commandOpenSyncIgnore: "选择同步时忽略的文件",
		invalidPublishedLink: "请输入此文件或文件夹的飞书链接。",
		commandSyncCurrentNote: "同步到飞书",
		commandOverwriteCurrentNote: "覆盖同步到飞书",
		menuSyncToLark: "Lark: 同步到飞书",
		menuOverwriteSyncToLark: "Lark: 覆盖同步到飞书",
		noticeRemovedDuplicates: "已清理 {count} 个远端同名文档。",
		ribbonSyncCurrentNote: "同步到飞书",
		noticeNoActiveMarkdownNote: "当前没有打开 Markdown 笔记。",
		noticeSyncingToLark: "正在同步到飞书...",
		noticeOverwriteSyncingToLark: "正在覆盖同步到飞书...",
		noticePublishingFolderToLark: "正在发布目录到飞书...",
		noticeNoMarkdownFilesInFolder: "该目录下没有 Markdown、PDF 或图片文件。",
		noticeAllFilesIgnoredInFolder: "该目录下的文件都被设为忽略，没有可同步的内容。",
		progressFolderScan: "正在检查文件夹里的笔记、PDF 和图片…",
		progressFolderFiles: "共 {count} 个文件待同步。",
		progressFolderFilesIgnored: "共 {count} 个文件待同步，{ignored} 个被 .feishuignore 忽略。",
		progressFolderRead: "正在读取 {count} 篇笔记，并检查飞书上的目录…",
		progressFolderDocs: "正在创建或匹配 {count} 篇笔记对应的飞书文档…",
		progressFolderPdf: "正在检查并同步 PDF {current}/{total}：{name}",
		progressFolderContent: "正在同步 {count} 篇笔记的内容…",
		progressFolderPages: "正在整理目录页…",
		noticeDeletingMissingRemote: "正在删除本地已不存在的飞书文件...",
		noticeDeletedMissingRemote: "已删除 {count} 个本地已不存在的飞书文件。",
		noticeSkippedMissingRemote: "有 {count} 个飞书文档下还有子页面，已跳过未删除。",
		noticeDeleteMissingRemoteFailed: "删除飞书文件失败：{message}",
		confirmDeleteMissingRemoteTitle: "删除飞书上的旧文件",
		confirmDeleteMissingRemoteBody: "以下 {count} 个文件在本地已不存在，确认后将从飞书删除：",
		confirmDeleteMissingRemoteButton: "删除",
		confirmDeleteMissingRemoteCancel: "取消",
		noticeImageGalleryCreated: "已生成 {count} 篇图片汇总笔记，收录未被文档引用的图片。",
		imageGalleryNoteName: "{name} 图片",
		noticePublishedToLark: "已发布到飞书",
		noticeSyncedToLark: "已同步到飞书",
		noticeOverwriteSyncedToLark: "已覆盖同步到飞书",
		noticePublishedFolderToLark: "已同步 {count} 个 Markdown / PDF 文件到飞书。",
		noticeSyncFailed: "飞书同步失败：{message}",
		noticeRemoteDeletedRecreate: "远端文档已删除，正在重新创建...",
		noticeRemoteDeletedUnbound: "飞书文档远端已删除，已自动解绑：{path}\n如需重新发布，请再次执行“同步到飞书”。",
		noticeGitHookInstalled: "已安装 pre-push hook。选择 pre-push 模式后，git push 前会同步已绑定文档。",
		noticeGitHookInstallFailed: "安装 pre-push hook 失败：{message}",
		noticeNoDesktopVaultPath: "当前环境无法获取本地仓库路径，不能安装 Git hook。",
		noticeNoGitRepository: "当前 Obsidian 仓库不是 Git 仓库，未找到 .git 目录。",
		noticeExistingGitHookBackedUp: "检测到已有 pre-push hook，已备份并在新 hook 中继续调用：{path}",
		noticeAutoSyncFailed: "自动同步失败：{path}\n{message}",
		noticeAutoSyncConfirmationTimedOut: "内容已提交，但远端状态确认超时：{path}\n请稍后检查飞书文档。",
		errorNoDocumentToken: "lark-cli 没有返回文档 token 或 URL。",
		errorInvalidDefaultTarget: "默认上传位置无效或当前飞书账号无权访问。\n请检查插件设置中的“默认上传位置”：{target}\n底层原因：{detail}",
		settingsTitle: "Feishu Docs Publisher",
		settingsSectionGeneral: "常规",
		settingsSectionCli: "CLI 与授权",
		settingsSectionNetwork: "网络代理",
		settingsSectionContent: "内容",
		settingsSectionSync: "同步",
		settingsSectionGitHook: "Git Hook",
		settingLanguageName: "语言",
		settingLanguageDesc: "切换插件设置、菜单和通知的显示语言。",
		languageChinese: "中文",
		languageEnglish: "English",
		settingLarkCliPathName: "lark-cli 路径",
		settingLarkCliPathDesc: "通常保持默认值即可；自动探测失败时，填写 lark-cli 可执行文件、npm 生成的 lark-cli.cmd 或原生 lark-cli.exe 的绝对路径。",
		settingLarkCliStatusName: "lark-cli 状态",
		settingLarkCliStatusDesc: "安装和升级由插件调用 npm 完成，不需要手动打开终端。",
		cliStatusChecking: "正在检测 lark-cli...",
		cliStatusMissing: "未安装。可以通过右侧按钮安装，或先安装 Node.js。",
		cliStatusNpmMissing: "未找到 npm；请先安装 Node.js 和 npm。",
		cliStatusNpmReady: "npm {version} 已就绪。",
		cliStatusInstalled: "已安装 {version}。",
		cliStatusUnsupported: "版本 {version} 低于最低要求 {minimum}，请升级。",
		cliStatusVersionUnknown: "已找到 lark-cli，但无法读取版本。",
		cliStatusUpToDate: "已是最新版本。",
		cliStatusUpdateAvailable: "最新版本为 {version}。",
		cliStatusUpdateUnknown: "暂时无法检查最新版本。",
		installCliButton: "安装 lark-cli",
		upgradeCliButton: "升级 lark-cli",
		upgradeCliVersionButton: "升级到 {version}",
		reinstallCliButton: "重新安装 lark-cli",
		installNodeButton: "下载 Node.js",
		recheckCliButton: "重新检测",
		installingCli: "正在安装...",
		upgradingCli: "正在升级...",
		noticeCliInstalled: "lark-cli 已安装：{version}",
		noticeCliUpgraded: "lark-cli 已更新：{version}",
		noticeCliInstallFailed: "lark-cli 安装或升级失败：{message}",
		errorCliInstallRequiresNode: "安装 lark-cli 需要 Node.js 与 npm。请先安装 Node.js，然后回到设置页重新检测。",
		errorCliInstallNotDetected: "安装已结束，但插件仍未找到 lark-cli。请检查 npm 全局可执行目录，或在“lark-cli 路径”中填写绝对路径。",
		errorCliUpgradeNotApplied: "安装已结束，但当前 lark-cli 版本仍不是最新版。请检查“lark-cli 路径”是否指向刚刚安装的文件。",
		errorCliOperationPending: "已有 CLI 授权或配置操作正在进行，请等待它完成。",
		settingLarkCliAccountName: "飞书 / Lark 账号",
		settingLarkCliAccountDesc: "登录凭据保存在本机 lark-cli 中；插件不会保存 access token 或应用密钥。",
		cliAccountChecking: "正在检查登录状态...",
		cliAccountNotConfigured: "尚未配置 CLI 应用，请先在下方创建应用。",
		cliAccountLoggedIn: "已登录：{user}（{brand}）",
		cliAccountLoggedOut: "CLI 应用已配置，但还没有登录用户。",
		cliAccountError: "无法读取登录状态：{message}",
		loginCliButton: "登录 / 重新授权",
		loginCliOpening: "正在获取授权链接...",
		loginCliOpenButton: "打开授权页面",
		loginCliWaitingButton: "等待授权...",
		cancelCliOperationButton: "取消",
		loginCliWaiting: "已获得授权链接，请在浏览器中确认。完成后状态会自动更新。",
		logoutCliButton: "退出登录",
		loginCliSuccess: "飞书 / Lark 登录成功。",
		loginCliFailed: "登录失败：{message}",
		loginCliScopeWarning: "已登录，但部分权限未授予：{message}",
		logoutCliSuccess: "已退出飞书 / Lark 登录。",
		logoutCliFailed: "退出登录失败：{message}",
		cliAppSetupName: "CLI 应用配置",
		cliAppSetupDesc: "首次使用需要通过浏览器创建并授权一个 CLI 应用。创建过程使用飞书 / Lark 官方流程，插件不会保存应用密钥。",
		brandFeishu: "飞书",
		brandLark: "Lark",
		createCliAppButton: "创建应用",
		cliAppSetupStarting: "正在创建应用...",
		cliAppSetupWaiting: "请在浏览器完成应用创建；链接出现后也可以点击“打开授权页面”。",
		cliAppSetupSuccess: "CLI 应用配置完成。现在可以登录飞书 / Lark 账号。",
		cliAppSetupFailed: "CLI 应用配置失败：{message}",
		settingProxyModeName: "网络代理",
		settingProxyModeDesc: "只影响插件启动的 lark-cli 和 npm 进程，不修改系统代理或 lark-cli 全局配置。",
		proxyModeSystem: "继承系统环境变量（推荐）",
		proxyModeCustom: "使用自定义 HTTP 代理",
		proxyModeOff: "不使用代理",
		proxySystemDetected: "当前检测到 {key}={value}。",
		proxySystemNotDetected: "当前没有检测到代理环境变量。",
		proxyHostName: "代理主机",
		proxyHostDesc: "默认 127.0.0.1，适用于 Clash、Surge 等本机代理。",
		proxyPortName: "代理端口",
		proxyPortDesc: "填写本机代理的 HTTP 端口，例如 7890。",
		proxyCustomStatus: "插件启动的 CLI/npm 将使用 {url}。",
		settingDefaultTargetName: "默认上传位置",
		settingDefaultTargetDesc: "填写 Wiki URL、Wiki 节点 token、文件夹 token；留空则上传到个人文档库。",
		settingTitleSourceName: "标题来源",
		settingTitleSourceDesc: "可使用第一个 Markdown 标题，或始终使用文件名。",
		titleSourceFirstHeading: "第一个标题",
		titleSourceFileName: "文件名",
		settingNativeCalloutName: "原生 Callout 折叠",
		settingNativeCalloutDesc: "将 Callout 转为飞书可折叠块。已有文档首次转换会重建正文，块评论和定位链接可能失效。关闭后，已转换文档仍按原生结构同步；安全增量模式不自动转换已有文档。",
		settingResearchColorsName: "科研标签配色",
		settingResearchColorsDesc: "在原生导出中，将冒号前的加粗标签设为红字、黄色背景。",
		settingWriteBindingName: "写入 frontmatter 绑定信息",
		settingWriteBindingDesc: "发布后额外写入笔记 frontmatter；关闭后，绑定仍保存在插件数据中。",
		settingOpenAfterSyncName: "同步后打开文档",
		settingOpenAfterSyncDesc: "发布或同步成功后，在浏览器中打开飞书文档。",
		settingAutoSyncModeName: "自动同步方式",
		settingAutoSyncModeDesc: "自动同步只处理已绑定的 Markdown 文档。保存后同步依赖 Obsidian；pre-push hook 可脱离 Obsidian 独立运行。",
		settingSyncStrategyName: "同步策略",
		settingSyncStrategyDesc: "自动（推荐）：小改动只更新变动块；改动较大、结构复杂或无法安全增量时，会自动全量覆盖远端。安全增量：只做增量，失败时提示，不覆盖。全量覆盖：每次都重写远端文档。",
		syncStrategyAuto: "自动（推荐）",
		syncStrategyPrecise: "安全增量同步",
		syncStrategyOverwrite: "全量覆盖同步",
		autoSyncModeManual: "关闭",
		autoSyncModeSave: "保存后同步",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "保存后同步延迟",
		settingAutoSyncDelayDesc: "文件保存后等待多少秒再同步，用于合并连续编辑。",
		settingSyncIgnoreName: "同步忽略",
		settingSyncIgnoreDesc: "选一个同步文件夹，再选择其中要跳过的文件或子文件夹。选择会保存在该文件夹的 .feishuignore 文件中（写法同 .gitignore）。目录同步、保存时自动同步和 Git pre-push 都会跳过它们，已在飞书上的内容不会被删除。",
		openSyncIgnoreButton: "选择…",
		settingDeleteMissingRemoteName: "删除本地已不存在的飞书文件",
		settingDeleteMissingRemoteDesc: "同步目录后，把本插件发布过、但本地文件已不存在的飞书文档和 PDF 删除，删除前会列出清单让你确认。只处理有发布记录的文件，不会动你在飞书里手动创建的内容。",
		settingStateCacheName: "同步状态缓存",
		settingStateCacheDesc: "设置最多保留多少篇文档状态；超过保留数的 1.5 倍时自动裁剪旧状态。老文档下次同步会重新建立块映射。",
		settingInstallPrePushHookName: "安装 Git pre-push hook",
		settingInstallPrePushHookDesc: "把 hook 安装到当前 Obsidian 仓库的 .git/hooks/pre-push。hook 会读取插件设置，只有选择 Git pre-push hook 时才同步。",
		prePushHookStatusInstalled: "状态：hook 已安装。",
		prePushHookStatusMissing: "状态：已选择 Git pre-push hook，但当前仓库尚未安装 hook。",
		prePushHookStatusMissingInactive: "状态：当前仓库尚未安装 hook。",
		prePushHookStatusUnavailable: "状态：当前环境无法检查本地 Git hook。",
		prePushHookStatusNotGitRepository: "状态：当前 Obsidian 仓库不是 Git 仓库，无法安装 hook。",
		prePushHookStatusChecking: "状态：正在检查 hook 安装状态...",
		installPrePushHookButton: "安装 hook"
	},
	en: {
		menuManagePublishedLinks: "Published files",
		menuOpenPublishedLink: "Open Feishu/Lark link",
		menuEditPublishedLink: "Set Feishu/Lark link",
		menuSyncIgnore: "Choose files to ignore",
		commandOpenSyncIgnore: "Choose files to ignore when syncing",
		invalidPublishedLink: "Enter the matching Feishu/Lark document, PDF, or folder URL.",
		commandSyncCurrentNote: "Sync to Feishu/Lark",
		commandOverwriteCurrentNote: "Overwrite sync to Feishu/Lark",
		menuSyncToLark: "Lark: Sync to Feishu/Lark",
		menuOverwriteSyncToLark: "Lark: Overwrite sync to Feishu/Lark",
		noticeRemovedDuplicates: "Removed {count} remote documents with duplicate names.",
		ribbonSyncCurrentNote: "Sync to Feishu/Lark",
		noticeNoActiveMarkdownNote: "No active Markdown note.",
		noticeSyncingToLark: "Syncing to Lark...",
		noticeOverwriteSyncingToLark: "Overwriting to Lark...",
		noticePublishingFolderToLark: "Publishing folder to Lark...",
		noticeNoMarkdownFilesInFolder: "No Markdown, PDF, or image files found in this folder.",
		noticeAllFilesIgnoredInFolder: "Every file in this folder is ignored, so there is nothing to sync.",
		progressFolderScan: "Checking the notes, PDFs, and images in the folder…",
		progressFolderFiles: "{count} files to sync.",
		progressFolderFilesIgnored: "{count} files to sync, {ignored} ignored by .feishuignore.",
		progressFolderRead: "Reading {count} notes and checking the folders in Feishu…",
		progressFolderDocs: "Creating or matching Feishu documents for {count} notes…",
		progressFolderPdf: "Checking and syncing PDF {current}/{total}: {name}",
		progressFolderContent: "Syncing the content of {count} notes…",
		progressFolderPages: "Updating folder pages…",
		noticeDeletingMissingRemote: "Deleting Feishu/Lark files that no longer exist locally...",
		noticeDeletedMissingRemote: "Deleted {count} Feishu/Lark files that no longer exist locally.",
		noticeSkippedMissingRemote: "Skipped {count} documents that still have child pages.",
		noticeDeleteMissingRemoteFailed: "Failed to delete a Feishu/Lark file: {message}",
		confirmDeleteMissingRemoteTitle: "Delete old Feishu/Lark files",
		confirmDeleteMissingRemoteBody: "These {count} files no longer exist locally and will be deleted from Feishu/Lark if you confirm:",
		confirmDeleteMissingRemoteButton: "Delete",
		confirmDeleteMissingRemoteCancel: "Cancel",
		noticeImageGalleryCreated: "Created {count} image gallery notes for images no document references.",
		imageGalleryNoteName: "{name} images",
		noticePublishedToLark: "Published to Feishu/Lark",
		noticeSyncedToLark: "Synced to Feishu/Lark",
		noticeOverwriteSyncedToLark: "Overwritten to Feishu/Lark",
		noticePublishedFolderToLark: "Synced {count} Markdown/PDF files to Feishu/Lark.",
		noticeSyncFailed: "Feishu/Lark sync failed: {message}",
		noticeRemoteDeletedRecreate: "Remote document was deleted. Creating a new document...",
		noticeRemoteDeletedUnbound: "The remote Feishu/Lark document was deleted and has been unbound: {path}\nRun Sync to Lark again to publish a new document.",
		noticeGitHookInstalled: "Installed the pre-push hook. When pre-push mode is selected, bound notes sync before git push.",
		noticeGitHookInstallFailed: "Failed to install pre-push hook: {message}",
		noticeNoDesktopVaultPath: "Cannot resolve the local vault path in this environment, so Git hook cannot be installed.",
		noticeNoGitRepository: "The current Obsidian vault is not a Git repository. No .git directory was found.",
		noticeExistingGitHookBackedUp: "Existing pre-push hook detected. It was backed up and will still be called by the new hook: {path}",
		noticeAutoSyncFailed: "Auto sync failed: {path}\n{message}",
		noticeAutoSyncConfirmationTimedOut: "Content was submitted, but remote confirmation timed out: {path}\nCheck the Lark document shortly.",
		errorNoDocumentToken: "lark-cli did not return a document token or URL.",
		errorInvalidDefaultTarget: "Default upload target is invalid or inaccessible.\nCheck the Default target setting: {target}\nCause: {detail}",
		settingsTitle: "Feishu Docs Publisher",
		settingsSectionGeneral: "General",
		settingsSectionCli: "CLI & authorization",
		settingsSectionNetwork: "Network proxy",
		settingsSectionContent: "Content",
		settingsSectionSync: "Sync",
		settingsSectionGitHook: "Git Hook",
		settingLanguageName: "Language",
		settingLanguageDesc: "Switch the display language for settings, menus, and notices.",
		languageChinese: "中文",
		languageEnglish: "English",
		settingLarkCliPathName: "lark-cli path",
		settingLarkCliPathDesc: "Keep the default for auto-detection. If detection fails, enter the absolute path to lark-cli, the npm-generated lark-cli.cmd, or native lark-cli.exe.",
		settingLarkCliStatusName: "lark-cli status",
		settingLarkCliStatusDesc: "The plugin installs and upgrades lark-cli through npm. You do not need to open a terminal.",
		cliStatusChecking: "Checking lark-cli...",
		cliStatusMissing: "Not installed. Use the action in this row, or install Node.js first.",
		cliStatusNpmMissing: "npm was not found. Install Node.js and npm first.",
		cliStatusNpmReady: "npm {version} is ready.",
		cliStatusInstalled: "Installed {version}.",
		cliStatusUnsupported: "Version {version} is below the required minimum {minimum}. Upgrade it.",
		cliStatusVersionUnknown: "lark-cli was found, but its version could not be read.",
		cliStatusUpToDate: "You have the latest version.",
		cliStatusUpdateAvailable: "Latest version: {version}.",
		cliStatusUpdateUnknown: "The latest version could not be checked.",
		installCliButton: "Install lark-cli",
		upgradeCliButton: "Upgrade lark-cli",
		upgradeCliVersionButton: "Upgrade to {version}",
		reinstallCliButton: "Reinstall lark-cli",
		installNodeButton: "Download Node.js",
		recheckCliButton: "Check again",
		installingCli: "Installing...",
		upgradingCli: "Upgrading...",
		noticeCliInstalled: "lark-cli installed: {version}",
		noticeCliUpgraded: "lark-cli updated: {version}",
		noticeCliInstallFailed: "lark-cli install or upgrade failed: {message}",
		errorCliInstallRequiresNode: "Installing lark-cli requires Node.js and npm. Install Node.js, then return to settings and check again.",
		errorCliInstallNotDetected: "Installation finished, but the plugin still cannot find lark-cli. Check the npm global executable directory, or enter its absolute path under lark-cli path.",
		errorCliUpgradeNotApplied: "Installation finished, but the configured lark-cli is not the latest version. Check whether lark-cli path points to the file that was just installed.",
		errorCliOperationPending: "Another CLI authorization or configuration step is already running. Wait for it to finish.",
		settingLarkCliAccountName: "Feishu / Lark account",
		settingLarkCliAccountDesc: "Login credentials stay in the local lark-cli store. The plugin does not save access tokens or app secrets.",
		cliAccountChecking: "Checking login status...",
		cliAccountNotConfigured: "No CLI app is configured. Create one below first.",
		cliAccountLoggedIn: "Signed in as {user} ({brand}).",
		cliAccountLoggedOut: "The CLI app is configured, but no user is signed in.",
		cliAccountError: "Could not read login status: {message}",
		loginCliButton: "Sign in / reauthorize",
		loginCliOpening: "Requesting an authorization link...",
		loginCliOpenButton: "Open authorization page",
		loginCliWaitingButton: "Waiting for authorization...",
		cancelCliOperationButton: "Cancel",
		loginCliWaiting: "Authorization started. Confirm it in your browser; this status updates automatically.",
		logoutCliButton: "Sign out",
		loginCliSuccess: "Signed in to Feishu/Lark.",
		loginCliFailed: "Sign-in failed: {message}",
		loginCliScopeWarning: "Signed in, but some permissions were not granted: {message}",
		logoutCliSuccess: "Signed out of Feishu/Lark.",
		logoutCliFailed: "Sign-out failed: {message}",
		cliAppSetupName: "CLI app configuration",
		cliAppSetupDesc: "First-time setup creates and authorizes a CLI app in your browser through the official Feishu/Lark flow. The plugin does not save the app secret.",
		brandFeishu: "Feishu",
		brandLark: "Lark",
		createCliAppButton: "Create app",
		cliAppSetupStarting: "Creating the app...",
		cliAppSetupWaiting: "Finish app creation in your browser. When a link appears, you can also use Open authorization page.",
		cliAppSetupSuccess: "CLI app configuration completed. You can now sign in to your Feishu/Lark account.",
		cliAppSetupFailed: "CLI app configuration failed: {message}",
		settingProxyModeName: "Network proxy",
		settingProxyModeDesc: "Affects only lark-cli and npm processes started by this plugin. It does not change system proxy settings or global lark-cli configuration.",
		proxyModeSystem: "Use system environment (recommended)",
		proxyModeCustom: "Use a custom HTTP proxy",
		proxyModeOff: "Do not use a proxy",
		proxySystemDetected: "Detected {key}={value}.",
		proxySystemNotDetected: "No proxy environment variable was detected.",
		proxyHostName: "Proxy host",
		proxyHostDesc: "Defaults to 127.0.0.1, suitable for local proxies such as Clash or Surge.",
		proxyPortName: "Proxy port",
		proxyPortDesc: "Enter the local proxy's HTTP port, for example 7890.",
		proxyCustomStatus: "CLI/npm processes started by the plugin will use {url}.",
		settingDefaultTargetName: "Default target",
		settingDefaultTargetDesc: "Wiki URL, wiki node token, folder token, or blank for personal library.",
		settingTitleSourceName: "Title source",
		settingTitleSourceDesc: "Use the first Markdown heading when available, or always use the file name.",
		titleSourceFirstHeading: "First heading",
		titleSourceFileName: "File name",
		settingNativeCalloutName: "Native Callout folding",
		settingNativeCalloutDesc: "Export Callouts as native foldable blocks. First conversion rebuilds existing content and may invalidate block comments and links. Converted documents keep native sync when disabled. Precise mode blocks conversion of existing documents.",
		settingResearchColorsName: "Research label colors",
		settingResearchColorsDesc: "In native exports, color bold labels before a colon red on yellow.",
		settingWriteBindingName: "Write binding to frontmatter",
		settingWriteBindingDesc: "Additionally store the URL in note frontmatter. Bindings remain in plugin data when disabled.",
		settingOpenAfterSyncName: "Open after sync",
		settingOpenAfterSyncDesc: "Open the Lark document in your browser after publish or sync succeeds.",
		settingAutoSyncModeName: "Auto sync mode",
		settingAutoSyncModeDesc: "Auto sync only handles bound Markdown notes. Save sync depends on Obsidian; the pre-push hook can run without Obsidian.",
		settingSyncStrategyName: "Sync strategy",
		settingSyncStrategyDesc: "Auto (recommended): updates only changed blocks for small edits; overwrites when changes are large, structurally complex, or unsafe for precise sync. Safe precise never overwrites. Overwrite rewrites the remote doc every time.",
		syncStrategyAuto: "Auto (recommended)",
		syncStrategyPrecise: "Safe precise sync",
		syncStrategyOverwrite: "Overwrite sync",
		autoSyncModeManual: "Off",
		autoSyncModeSave: "Sync after save",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "Save sync delay",
		settingAutoSyncDelayDesc: "Seconds to wait after a save before syncing, used to merge continuous edits.",
		settingSyncIgnoreName: "Sync ignore",
		settingSyncIgnoreDesc: "Pick a sync folder, then choose the files and subfolders inside it to skip. Choices are saved to a .feishuignore file in that folder, written like .gitignore. Folder sync, auto-sync on save, and the Git pre-push hook leave them out; content already in Feishu/Lark is not deleted.",
		openSyncIgnoreButton: "Choose…",
		settingDeleteMissingRemoteName: "Delete remote files missing locally",
		settingDeleteMissingRemoteDesc: "After a folder sync, delete Feishu/Lark documents and PDFs this plugin published whose local file no longer exists. You confirm a list first. Only files with a publish record are touched; content you created by hand in Feishu/Lark is never deleted.",
		settingStateCacheName: "Sync state cache",
		settingStateCacheDesc: "Maximum document states to keep. Old states are trimmed after the cache exceeds 1.5x this value. Old documents rebuild block mapping on next sync.",
		settingInstallPrePushHookName: "Install Git pre-push hook",
		settingInstallPrePushHookDesc: "Install the hook into .git/hooks/pre-push of the current Obsidian vault. The hook reads plugin settings and syncs only when Git pre-push hook mode is selected.",
		prePushHookStatusInstalled: "Status: hook is installed.",
		prePushHookStatusMissing: "Status: Git pre-push hook is selected, but this repository has no installed hook yet.",
		prePushHookStatusMissingInactive: "Status: this repository has no installed hook yet.",
		prePushHookStatusUnavailable: "Status: cannot check the local Git hook in this environment.",
		prePushHookStatusNotGitRepository: "Status: the current Obsidian vault is not a Git repository, so hook cannot be installed.",
		prePushHookStatusChecking: "Status: checking hook installation...",
		installPrePushHookButton: "Install hook"
	}
} as const;

type MessageKey = keyof typeof MESSAGES.en;

export default class LarkCliSyncPlugin extends Plugin {
	settings!: LarkCliSyncSettings;
	private readonly autoSyncTimers = new Map<string, number>();
	private readonly autoSyncRunningPaths = new Set<string>();
	private readonly autoSyncPendingPaths = new Set<string>();
	private readonly selfWrittenPaths = new Map<string, number>();
	private syncStateSaveQueue: Promise<void> = Promise.resolve();
	private deferredSyncStateSaveDepth = 0;
	private hasDeferredSyncStateSave = false;
	private cachedLarkCliPath: string | null = null;
	private cachedLarkCliPathSetting = "";
	private pendingLarkCliPath: Promise<string> | null = null;
	private cachedCommandEnvironment: Record<string, string | undefined> | null = null;
	private cachedCommandEnvironmentExecutable = "";
	private cachedCommandEnvironmentShellPath = "";
	private cachedLoginShellPath: string | null = null;
	private pendingLoginShellPath: Promise<string> | null = null;
	private checkedLarkCliVersionExecutable = "";
	private pendingLarkCliVersionExecutable = "";
	private pendingLarkCliVersionCheck: Promise<void> | null = null;
	private pendingLarkCliAuthorization: PendingLarkCliAuthorization | null = null;
	private pendingLarkCliChild: ChildProcess | null = null;
	private pendingLarkCliTask: Promise<void> | null = null;
	private cliManagementListeners = new Set<() => void>();
	private larkCliRequestQueue: Promise<void> = Promise.resolve();
	private larkCliActiveRequestCount = 0;
	private lastLarkCliRequestAt = 0;
	private operationQueue = new SyncQueue();
	private folderResolutionQueue = new SyncQueue();
	private ignoreRules = new IgnoreRules();
	private settingsWriteQueue = new SyncQueue();
	private hasUnsavedSettings = false;
	private syncState: LarkSyncStateFile = createEmptySyncStateFile();
	private readonly syncStateChangedKeys = new Set<string>();
	private readonly syncStateRemovedKeys = new Set<string>();

	override async onload(): Promise<void> {
		addIcon(LARK_RIBBON_ICON_ID, LARK_RIBBON_ICON_SVG);
		await this.migrateLegacyPluginData();
		await this.loadSettings();
		this.syncState = await this.loadLarkSyncState();
		await this.cleanupDisconnectedFolderBindings();
		await this.tryEnsureLarkSyncStateFile();
		await this.tryRefreshInstalledPrePushHook();
		this.registerSaveAutoSync();
		this.register(() => {
			for (const timer of this.autoSyncTimers.values()) {
				window.clearTimeout(timer);
			}
			this.autoSyncTimers.clear();
			this.cliManagementListeners.clear();
			this.cancelPendingLarkCliAuthorization();
		});

		this.addCommand({
			id: "sync-current-note-to-lark",
			name: this.t("commandSyncCurrentNote"),
			callback: () => {
				void this.syncCurrentNote();
			}
		});

		this.addCommand({
			id: "overwrite-sync-current-note-to-lark",
			name: this.t("commandOverwriteCurrentNote"),
			callback: () => {
				void this.overwriteSyncCurrentNote();
			}
		});

		this.addCommand({ id: "manage-published-links", name: this.t("menuManagePublishedLinks"),
			callback: () => this.openPublishedLinks() });
		this.registerView(SYNC_IGNORE_VIEW_TYPE, (leaf) => new SyncIgnoreView(leaf, this.syncIgnoreHost()));
		this.addCommand({ id: "open-sync-ignore", name: this.t("commandOpenSyncIgnore"),
			callback: () => { void this.openSyncIgnore(); } });
		this.addCommand({ id: "open-current-published-link", name: this.t("menuOpenPublishedLink"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const url = file ? this.getPublishedEntry(file.path, file.extension.toLowerCase() === "pdf" ? "pdf" : "markdown")?.url : "";
				if (!url) return false;
				if (!checking) window.open(url);
				return true;
			} });
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			void (this.operationQueue ??= new SyncQueue()).run(() => this.moveLocalBindings(oldPath, file.path, file instanceof TFolder))
				.catch((error: unknown) => new Notice(String(error)));
		}));

		this.addRibbonIcon(LARK_RIBBON_ICON_ID, this.t("menuManagePublishedLinks"), () => {
			this.openPublishedLinks();
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file) => {
			let kind: PublishedLinkEntry["kind"];
			if (file instanceof TFolder) {
				kind = "folder";
				menu.addItem((item) => item.setTitle(this.t("menuSyncToLark")).setIcon("folder-up")
					.onClick(() => { void this.publishFolder(file.path); }));
				menu.addItem((item) => item.setTitle(this.t("menuOverwriteSyncToLark")).setIcon("replace")
					.onClick(() => { void this.publishFolder(file.path, true); }));
				menu.addItem((item) => item.setTitle(`Lark: ${this.t("menuSyncIgnore")}`).setIcon("eye-off")
					.onClick(() => { void this.openSyncIgnore(file.path); }));
			} else if (file instanceof TFile && file.extension.toLowerCase() === "md") {
				kind = "markdown";
				menu.addItem((item) => {
					item.setTitle(this.t("menuSyncToLark")).setIcon("refresh-cw").onClick(() => {
						void this.syncFile(file);
					});
				});
				menu.addItem((item) => item.setTitle(this.t("menuOverwriteSyncToLark")).setIcon("replace")
					.onClick(() => { void this.overwriteSyncFile(file); }));
			} else if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
				kind = "pdf";
				menu.addItem((item) => item.setTitle(this.t("menuSyncToLark")).setIcon("upload")
					.onClick(() => { void this.runWithNotice(this.t("noticeSyncingToLark"), () => this.syncPdfFile(file)); }));
				menu.addItem((item) => item.setTitle(this.t("menuOverwriteSyncToLark")).setIcon("replace")
					.onClick(() => { void this.runWithNotice(this.t("noticeOverwriteSyncingToLark"), () => this.syncPdfFile(file, true)); }));
			} else {
				return;
			}
			this.addPublishedLinkMenu(menu, file.path, kind);
		}));

		this.addSettingTab(new LarkCliSyncSettingTab(this.app, this));
	}

	private isOurPrePushHook(content: string): boolean {
		return content.includes(PRE_PUSH_HOOK_MARKER) || content.includes(LEGACY_PRE_PUSH_HOOK_MARKER);
	}

	private async migrateLegacyPluginData(): Promise<void> {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return;
		}

		let currentDirectory: string;
		try {
			currentDirectory = this.getPluginDirectoryPath();
		} catch {
			return;
		}

		const legacyDirectory = join(vaultPath, this.app.vault.configDir, "plugins", LEGACY_PLUGIN_ID);
		await this.copyLegacyPluginFileIfMissing(
			join(legacyDirectory, "data.json"),
			join(currentDirectory, "data.json")
		);
		await this.copyLegacyPluginFileIfMissing(
			join(legacyDirectory, LARK_SYNC_STATE_FILE_NAME),
			join(currentDirectory, LARK_SYNC_STATE_FILE_NAME)
		);
	}

	private async copyLegacyPluginFileIfMissing(sourcePath: string, destinationPath: string): Promise<void> {
		if (await this.pathExists(destinationPath) || !await this.pathExists(sourcePath)) {
			return;
		}

		try {
			await mkdir(dirname(destinationPath), { recursive: true });
			await copyFile(sourcePath, destinationPath);
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to copy legacy plugin data", {
				sourcePath,
				destinationPath,
				error
			});
		}
	}

	async loadSettings(): Promise<void> {
		const savedData: unknown = await this.loadData();
		const savedSettings = this.isRecord(savedData) ? savedData as Partial<LarkCliSyncSettings> : {};
		const savedSettingsWithoutTrimThreshold: Partial<LarkCliSyncSettings> & { stateCacheTrimThreshold?: unknown } = {
			...(savedSettings || {})
		};
		delete savedSettingsWithoutTrimThreshold.stateCacheTrimThreshold;
		this.settings = {
			...DEFAULT_SETTINGS,
			...savedSettingsWithoutTrimThreshold,
			proxyMode: normalizeProxyMode(savedSettings?.proxyMode),
			proxyHost: normalizeProxyHost(savedSettings?.proxyHost),
			proxyPort: normalizeProxyPort(savedSettings?.proxyPort),
			larkCliBrand: normalizeLarkCliBrand(savedSettings?.larkCliBrand),
			stateCacheRetainLimit: this.normalizePositiveInteger(
				savedSettings?.stateCacheRetainLimit,
				DEFAULT_STATE_CACHE_RETAIN_LIMIT
			),
			documentBindings: { ...(savedSettings?.documentBindings || {}) },
			pendingDocumentCreates: { ...(savedSettings?.pendingDocumentCreates || {}) },
			pendingFolderCreates: { ...(savedSettings?.pendingFolderCreates || {}) },
			disconnectedBindings: { ...(savedSettings?.disconnectedBindings || {}) },
			disconnectedFolders: { ...(savedSettings?.disconnectedFolders || {}) },
			pdfBindings: { ...(savedSettings?.pdfBindings || {}) },
			folderBindings: {
				...DEFAULT_SETTINGS.folderBindings,
				...(savedSettings?.folderBindings || {})
			},
			publishedFolders: {
				...DEFAULT_SETTINGS.publishedFolders,
				...(savedSettings?.publishedFolders || {})
			}
		};
	}

	async saveSettings(): Promise<void> {
		this.clearLarkCliCommandCache();
		await this.saveSettingsWithoutClearingCommandCache();
	}

	private async saveSettingsWithoutClearingCommandCache(): Promise<void> {
		await (this.settingsWriteQueue ??= new SyncQueue()).run(async () => {
			try {
				await this.saveData(JSON.parse(JSON.stringify(this.settings)));
				this.hasUnsavedSettings = false;
			} catch (error) {
				this.hasUnsavedSettings = true;
				throw error;
			}
		});
	}

	private registerSaveAutoSync(): void {
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (this.settings.autoSyncMode !== "save") {
				return;
			}

			if (!(file instanceof TFile)) {
				return;
			}
			if (file.extension === "md") {
				this.queueSaveAutoSync(file);
			} else if (isSupportedLocalMediaPath(file.path)) {
				void this.queueImageReferenceAutoSync([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (this.settings.autoSyncMode === "save" && file instanceof TFile && isSupportedLocalMediaPath(file.path)) {
				void this.queueImageReferenceAutoSync([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (this.settings.autoSyncMode === "save" && file instanceof TFile && isSupportedLocalMediaPath(file.path)) {
				void this.queueImageReferenceAutoSync([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (this.settings.autoSyncMode === "save" && file instanceof TFile
				&& (isSupportedLocalMediaPath(file.path) || isSupportedLocalMediaPath(oldPath))) {
				void this.queueImageReferenceAutoSync([oldPath, file.path]);
			}
		}));
	}

	private async queueImageReferenceAutoSync(changedImagePaths: string[]): Promise<void> {
		const markdownFiles = this.app.vault.getMarkdownFiles().filter((file) => this.getBinding(file));
		const filesByPath = new Map(markdownFiles.map((file) => [file.path, file]));
		const referencingPaths = await findReferencingMarkdownFiles({
			vaultRoot: this.getVaultRoot(),
			markdownPaths: [...filesByPath.keys()],
			changedImagePaths,
			readMarkdown: (path) => {
				const file = filesByPath.get(path);
				if (!file) throw new Error(`Markdown file not found: ${path}`);
				return this.app.vault.read(file);
			}
		});
		for (const markdownPath of referencingPaths) {
			const file = filesByPath.get(markdownPath);
			if (file && this.getBinding(file)) {
				this.queueSaveAutoSync(file);
			}
		}
	}

	private async syncCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.syncFile(file);
	}

	private async overwriteSyncCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.overwriteSyncFile(file);
	}

	async runLarkCliCommand(args: string[], options: LarkCommandOptions = {}): Promise<LarkCommandResult> {
		return await this.runLarkCli(args, options);
	}

	subscribeLarkCliManagementChanges(listener: () => void): () => void {
		(this.cliManagementListeners ??= new Set()).add(listener);
		return () => {
			this.cliManagementListeners?.delete(listener);
		};
	}

	getPendingLarkCliAuthorization(): PendingLarkCliAuthorization | null {
		return this.pendingLarkCliAuthorization ? { ...this.pendingLarkCliAuthorization } : null;
	}

	async getLarkCliManagementStatus(): Promise<LarkCliManagementStatus> {
		this.clearLarkCliCommandCache();
		const [versionProbe, npm] = await Promise.all([
			this.probeLarkCliVersion(),
			this.getNpmToolStatus()
		]);
		const auth: LarkCliAuthList = { configured: false, users: [] };
		let authStatus: LarkCliAuthStatus | null = null;
		let authError = "";

		if (versionProbe.installed) {
			const [authListResult, authStatusResult] = await Promise.all([
				this.runLarkCliCapture(["auth", "list", "--json"], LARK_CLI_STATUS_TIMEOUT_MS),
				this.runLarkCliCapture(["auth", "status", "--json"], LARK_CLI_STATUS_TIMEOUT_MS)
			]);
			const authList = authListResult.ok ? parseLarkCliAuthList(authListResult.stdout) : null;
			if (authListResult.ok && authList) {
				Object.assign(auth, authList);
			}
			if (authStatusResult.ok) {
				authStatus = parseLarkCliAuthStatus(authStatusResult.stdout);
				if (authStatus?.appId) auth.configured = true;
			}
			if (!authList && !authStatus) {
				authError = authListResult.error || authStatusResult.error || "lark-cli returned an invalid auth status.";
			}
		}

		let latestVersion = "";
		let updateError = "";
		if (versionProbe.installed) {
			const latest = await this.getLatestLarkCliVersion(npm, versionProbe.installed);
			latestVersion = latest.version;
			updateError = latest.error;
		}

		return {
			installed: versionProbe.installed,
			version: versionProbe.version,
			versionError: versionProbe.error,
			supported: isSupportedLarkCliVersion(versionProbe.version),
			npm,
			latestVersion,
			updateAvailable: Boolean(latestVersion && versionProbe.version
				&& isLarkCliVersionNewer(latestVersion, versionProbe.version)),
			updateError,
			auth,
			authStatus,
			authError
		};
	}

	async installOrUpgradeLarkCli(): Promise<LarkCliManagementStatus> {
		if (this.pendingLarkCliAuthorization || this.pendingLarkCliTask) {
			throw new Error(this.t("errorCliOperationPending"));
		}

		const npm = await this.getNpmToolStatus();
		const versionProbe = await this.probeLarkCliVersion();
		let result: RawCommandResult;
		let installedWithNpm = false;
		if (npm.available) {
			result = await this.runNpmCapture([
				"install", "-g", `${LARK_CLI_NPM_PACKAGE}@latest`, "--no-audit", "--no-fund"
			], LARK_CLI_INSTALL_TIMEOUT_MS);
			installedWithNpm = true;
		} else if (versionProbe.installed) {
			result = await this.runLarkCliCapture(["update", "--json"], LARK_CLI_INSTALL_TIMEOUT_MS);
			const update = result.ok ? this.parseUpdateResult(result.stdout) : null;
			if (update?.action === "manual_required") {
				throw new Error(update.message || "lark-cli requires a manual update.");
			}
		} else {
			throw new Error(this.t("errorCliInstallRequiresNode"));
		}

		if (!result.ok) {
			throw new Error(result.error);
		}
		if (installedWithNpm && (this.settings.larkCliPath || "").trim() === DEFAULT_SETTINGS.larkCliPath) {
			const npmLarkCliPath = await this.resolveNpmGlobalLarkCliPath();
			if (npmLarkCliPath) {
				this.settings.larkCliPath = npmLarkCliPath;
			}
		}

		this.clearLarkCliCommandCache();
		delete this.settings.larkCliVersionCheck;
		await this.saveSettingsWithoutClearingCommandCache();
		const status = await this.getLarkCliManagementStatus();
		if (!status.installed) {
			throw new Error(this.t("errorCliInstallNotDetected"));
		}
		if (!status.supported) {
			throw new Error(formatUnsupportedLarkCliVersion(status.version, this.settings.language));
		}
		if (status.updateAvailable && status.latestVersion) {
			throw new Error(this.t("errorCliUpgradeNotApplied"));
		}
		new Notice(this.t(versionProbe.installed ? "noticeCliUpgraded" : "noticeCliInstalled", {
			version: status.version || "lark-cli"
		}));
		this.notifyLarkCliManagementChange();
		return status;
	}

	async startLarkCliLogin(): Promise<PendingLarkCliAuthorization> {
		const existing = this.pendingLarkCliAuthorization;
		if (existing?.kind === "login") return { ...existing };
		if (existing || this.pendingLarkCliTask) {
			throw new Error(this.t("errorCliOperationPending"));
		}

		const result = await this.runLarkCliCapture([
			"auth", "login",
			"--recommend",
			"--no-wait", "--json"
		], 60_000);
		if (!result.ok) throw new Error(result.error);
		const authorization = parseLarkCliDeviceAuthorization(result.stdout);
		if (!authorization) throw new Error(this.t("loginCliFailed", { message: "lark-cli did not return a device authorization." }));

		const pending: PendingLarkCliAuthorization = {
			kind: "login",
			verificationUrl: authorization.verificationUrl,
			startedAt: new Date().toISOString(),
			deviceCode: authorization.deviceCode
		};
		this.pendingLarkCliAuthorization = pending;
		this.openAuthorizationUrl(authorization.verificationUrl);
		this.notifyLarkCliManagementChange();
		this.startLarkCliLoginPolling(pending);
		return { ...pending };
	}

	async logoutLarkCli(): Promise<void> {
		this.cancelPendingLarkCliAuthorization();
		const result = await this.runLarkCliCapture(["auth", "logout", "--json"], 60_000);
		if (!result.ok) throw new Error(result.error);
		new Notice(this.t("logoutCliSuccess"));
		this.notifyLarkCliManagementChange();
	}

	cancelLarkCliAuthorization(): void {
		this.cancelPendingLarkCliAuthorization();
		this.notifyLarkCliManagementChange();
	}

	async startLarkCliAppConfiguration(brand: LarkCliBrand): Promise<void> {
		if (this.pendingLarkCliAuthorization || this.pendingLarkCliTask) {
			throw new Error(this.t("errorCliOperationPending"));
		}

		this.settings.larkCliBrand = normalizeLarkCliBrand(brand);
		await this.saveSettingsWithoutClearingCommandCache();
		const pending: PendingLarkCliAuthorization = {
			kind: "app-configuration",
			verificationUrl: "",
			startedAt: new Date().toISOString()
		};
		this.pendingLarkCliAuthorization = pending;
		this.notifyLarkCliManagementChange();

		let output = "";
		let opened = false;
		const task = this.runLarkCliSpawn([
			"config", "init", "--new",
			"--brand", this.settings.larkCliBrand,
			"--lang", this.settings.language === "en" ? "en" : "zh"
		], LARK_CLI_CONFIGURATION_TIMEOUT_MS, (chunk) => {
			output += chunk;
			const verificationUrl = extractLarkCliVerificationUrl(output);
			if (!verificationUrl || this.pendingLarkCliAuthorization !== pending) return;
			if (pending.verificationUrl !== verificationUrl) {
				pending.verificationUrl = verificationUrl;
				this.notifyLarkCliManagementChange();
			}
			if (!opened) {
				opened = true;
				this.openAuthorizationUrl(verificationUrl);
			}
		});
		const settled = task.then(() => {
			if (this.pendingLarkCliAuthorization !== pending) return;
			new Notice(this.t("cliAppSetupSuccess"));
		}).catch((error: unknown) => {
			if (this.pendingLarkCliAuthorization !== pending) return;
			new Notice(this.t("cliAppSetupFailed", { message: this.formatNoticeErrorDetail(error) }));
		}).finally(() => {
			if (this.pendingLarkCliAuthorization === pending) {
				this.pendingLarkCliAuthorization = null;
			}
			if (this.pendingLarkCliTask === settled) this.pendingLarkCliTask = null;
			this.notifyLarkCliManagementChange();
		});
		this.pendingLarkCliTask = settled;
	}

	private startLarkCliLoginPolling(pending: PendingLarkCliAuthorization): void {
		const deviceCode = pending.deviceCode || "";
		if (!deviceCode) return;
		const task = this.runLarkCliSpawn([
			"auth", "login", "--device-code", deviceCode, "--json"
		], LARK_CLI_LOGIN_TIMEOUT_MS);
		const settled = task.then((result) => {
			if (this.pendingLarkCliAuthorization !== pending) return;
			const payload = this.tryParseJsonRecord(result.stdout);
			const warning = payload && this.isRecord(payload.warning) ? payload.warning : null;
			const warningMessage = warning && typeof warning.hint === "string" ? warning.hint : "";
			new Notice(warningMessage
				? this.t("loginCliScopeWarning", { message: warningMessage })
				: this.t("loginCliSuccess"));
		}).catch((error: unknown) => {
			if (this.pendingLarkCliAuthorization !== pending) return;
			new Notice(this.t("loginCliFailed", { message: this.formatNoticeErrorDetail(error) }));
		}).finally(() => {
			if (this.pendingLarkCliAuthorization === pending) {
				this.pendingLarkCliAuthorization = null;
			}
			if (this.pendingLarkCliTask === settled) this.pendingLarkCliTask = null;
			this.notifyLarkCliManagementChange();
		});
		this.pendingLarkCliTask = settled;
	}

	private cancelPendingLarkCliAuthorization(): void {
		this.pendingLarkCliAuthorization = null;
		if (this.pendingLarkCliChild && !this.pendingLarkCliChild.killed) {
			try {
				this.pendingLarkCliChild.kill();
			} catch {
				// The process may already have exited.
			}
		}
		this.pendingLarkCliChild = null;
		this.pendingLarkCliTask = null;
	}

	private notifyLarkCliManagementChange(): void {
		for (const listener of [...(this.cliManagementListeners ?? [])]) {
			try {
				listener();
			} catch (error) {
				console.warn("[Feishu Docs Publisher] CLI status listener failed", error);
			}
		}
	}

	private openAuthorizationUrl(url: string): void {
		if (!url) return;
		try {
			window.open(url, "_blank", "noopener,noreferrer");
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to open authorization URL", error);
		}
	}

	private async syncFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticeSyncingToLark"), async () => {
			await this.syncFileInternal(file, {
				allowCreate: true,
				openAfterSync: true,
				showSuccess: true,
				showRemoteDeletedNotice: true,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "manual"
			});
		});
	}

	private async overwriteSyncFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticeOverwriteSyncingToLark"), async () => {
			await this.syncFileInternal(file, {
				allowCreate: true,
				openAfterSync: true,
				showSuccess: true,
				showRemoteDeletedNotice: true,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "manual",
				strategy: "overwrite",
				successMessageKey: "noticeOverwriteSyncedToLark"
			});
		});
	}

	private async syncFileInternal(file: TFile, options: SyncFileOptions): Promise<BoundLarkDocument | null> {
		return await (this.operationQueue ??= new SyncQueue()).run(() => this.syncFileUnlocked(file, options));
	}

	private async syncFileUnlocked(file: TFile, options: SyncFileOptions): Promise<BoundLarkDocument | null> {
		if (this.hasUnsavedSettings) await this.saveSettingsWithoutClearingCommandCache();
		if (options.strategy === "overwrite") return await this.overwriteFileUnlocked(file, options);
		const binding = this.getBinding(file);
		if (binding) this.assertRemoteBindingExclusive(file.path, binding);
		if (!binding) {
			if (!options.allowCreate) {
				return null;
			}

			const rawPreparedContent = await this.readNoteForLark(file);
			const preparedContent = { ...rawPreparedContent,
				content: this.rewritePublishedPdfReferences(file, rawPreparedContent.content) };
			const publishedFolder = await this.resolvePublishedFolderParentForFile(file);
			if (publishedFolder) {
				const siblings = this.app.vault.getMarkdownFiles().filter((candidate) => this.parentPath(candidate.path) === this.parentPath(file.path));
				const prepared = await Promise.all(siblings.map(async (candidate): Promise<FolderPreparedFile> => ({
					file: candidate, binding: this.getBinding(candidate), remoteParentPath: publishedFolder.remoteParentPath,
					preparedContent: candidate.path === file.path ? preparedContent : {
						content: prepareNoteContentForLark(candidate, removeLarkBinding(await this.app.vault.read(candidate)), this.settings.titleSource), images: []
					}
				})));
				await this.recoverPreparedBindings(prepared, new Map([[publishedFolder.remoteParentPath, publishedFolder.parent]]), true, file.path);
				if (this.getBinding(file)) return await this.syncFileUnlocked(file, options);
			}
			const persistCreatedBinding = options.updateFrontmatter
				? async (createdBinding: BoundLarkDocument): Promise<void> => {
					await this.writeBinding(file, createdBinding);
				}
				: undefined;
			const result = publishedFolder
				? this.withRemoteParentMetadata(
					await this.createLarkDocument(file, preparedContent, publishedFolder.parent, persistCreatedBinding),
					publishedFolder.remoteRoot,
					publishedFolder.remoteParentPath,
					publishedFolder.parent
				)
				: await this.createLarkDocument(file, preparedContent, undefined, persistCreatedBinding);
			await this.saveCreatedDocumentStateFromBaseline(result, preparedContent.content);

			if (options.updateFrontmatter && publishedFolder) {
				await this.writeBinding(file, result);
			}

			if (options.showSuccess) {
				this.showSuccess(this.t("noticePublishedToLark"), result.url);
			}

			if (options.openAfterSync) {
				this.openUrlIfNeeded(result.url);
			}

			return result;
		}

		const preparedContent = await this.readNoteForLark(file);
		const rewrittenContent = this.rewritePublishedFolderInternalLinks(file, preparedContent.content);
		const nextBinding = await this.syncOrRecreateDocument(file, binding, {
			...preparedContent,
			content: rewrittenContent
		}, undefined, {
			allowRecreate: options.allowCreate,
			showRemoteDeletedNotice: options.showRemoteDeletedNotice,
			updateFrontmatter: options.updateFrontmatter,
			mode: options.mode,
			path: file.path,
			strategy: options.strategy,
			stateKeys: [binding.token, binding.url]
		});

		if (this.shouldWriteBinding(binding, nextBinding, options.updateFrontmatter)) {
			await this.writeBinding(file, nextBinding);
		}

		if (options.showSuccess) {
			this.showSuccess(this.t(options.successMessageKey || "noticeSyncedToLark"), nextBinding.url);
		}

		if (options.openAfterSync) {
			this.openUrlIfNeeded(nextBinding.url);
		}

		return nextBinding;
	}

	private async overwriteFileUnlocked(file: TFile, options: SyncFileOptions): Promise<BoundLarkDocument | null> {
		let binding = this.getBinding(file);
		if (binding) this.assertRemoteBindingExclusive(file.path, binding);
		if (!binding && !options.allowCreate) return null;
		const raw = await this.readNoteForLark(file);
		const prepared = { ...raw, content: this.rewritePublishedFolderInternalLinks(file, raw.content) };
		await this.assertUniqueOverwriteTitle(file, prepared.content);
		const published = await this.resolvePublishedFolderParentForFile(file);
		const parent = published?.parent || await this.resolveOverwriteParent(binding);
		const title = extractTitle(file, prepared.content, "first-heading");
		if (!binding) {
			const matches = (await this.listRemoteDocuments(parent)).filter((document) => document.title === title);
			binding = this.selectOverwriteMatch(file.path, matches) || null;
			if (binding) await this.rememberDocumentBinding(file, { ...binding, containerToken: parent.token, containerKind: parent.kind });
		}
		let next: BoundLarkDocument;
		if (binding) {
			next = await this.syncOrRecreateDocument(file, binding, prepared, parent, {
				allowRecreate: options.allowCreate, showRemoteDeletedNotice: options.showRemoteDeletedNotice,
				updateFrontmatter: options.updateFrontmatter, mode: options.mode, path: file.path,
				strategy: "overwrite", stateKeys: this.getBindingAliases(binding)
			});
		} else {
			next = await this.createLarkDocument(file, prepared, parent);
			await this.saveCreatedDocumentStateFromBaseline(next, prepared.content);
		}
		next = published ? this.withRemoteParentMetadata(next, published.remoteRoot, published.remoteParentPath, parent)
			: { ...next, containerToken: parent.token, containerKind: parent.kind };
		// Keep the chosen target durable before deleting anything, even with frontmatter off.
		await this.writeBinding(file, next);
		const removed = await this.cleanupRemoteDuplicates(file.path, title, parent, next);
		await this.restoreOverwriteChildPageList(next, file.path, parent);
		if (options.showSuccess) {
			this.showSuccess(this.t(options.successMessageKey || "noticeOverwriteSyncedToLark"), next.url);
			if (removed) new Notice(this.t("noticeRemovedDuplicates", { count: String(removed) }), 8000);
		}
		if (options.openAfterSync) this.openUrlIfNeeded(next.url);
		return next;
	}

	private async resolveOverwriteParent(binding: BoundLarkDocument | null): Promise<RemoteParent> {
		if (binding?.containerKind && binding.containerKind !== "unknown" && binding.containerToken !== undefined) {
			return { kind: binding.containerKind, token: binding.containerToken };
		}
		if (binding) {
			const inspected = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", binding.url || binding.token,
				...(!binding.url ? ["--type", "docx"] : []), "--json"]);
			const wiki = inspected.data?.wiki_node;
			if (wiki?.node_token) {
				const result = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", wiki.node_token, "--json"]);
				const node = result.data?.node || result.data;
				if (node?.parent_node_token !== undefined && node.space_id) {
					binding.nodeToken = wiki.node_token;
					return { kind: "wiki", token: node.parent_node_token, spaceId: node.space_id };
				}
			}
		}
		const parent = await this.resolveRemoteRootParent();
		if (parent.kind === "unknown") throw new LocalizedSyncError(this.settings.language === "en"
			? "Use a Wiki or Drive folder URL as the upload target before overwrite sync."
			: "覆盖同步前，请将上传位置设置为 Wiki 或云盘文件夹链接。");
		return parent;
	}

	private async assertUniqueOverwriteTitle(file: TFile, content: string): Promise<void> {
		const title = extractTitle(file, content, "first-heading");
		for (const sibling of this.app.vault.getMarkdownFiles()) {
			if (sibling.path === file.path || this.parentPath(sibling.path) !== this.parentPath(file.path)) continue;
			const prepared = await this.readNoteForLark(sibling);
			if (extractTitle(sibling, prepared.content, "first-heading") === title) throw new LocalizedSyncError(this.settings.language === "en"
				? `Local notes have the same document title: ${file.path} and ${sibling.path}. Give them distinct titles before overwrite sync.`
				: `本地笔记的文档标题相同：${file.path} 和 ${sibling.path}。请先使用不同标题，再覆盖同步。`);
		}
		for (const sibling of this.app.vault.getAllLoadedFiles?.() || []) {
			if (sibling instanceof TFolder && this.parentPath(sibling.path) === this.parentPath(file.path) && sibling.name === title) {
				throw new LocalizedSyncError(this.settings.language === "en"
					? `The note title conflicts with a sibling folder: ${file.path} and ${sibling.path}. Use a distinct title before overwrite sync.`
					: `笔记标题与同级目录同名：${file.path} 和 ${sibling.path}。请先使用不同标题，再覆盖同步。`);
			}
		}
	}

	private getOtherRemoteBindings(path: string): Map<string, BoundLarkDocument> {
		const bindings = new Map<string, BoundLarkDocument>();
		const add = (owner: string, binding: BoundLarkDocument): void => {
			if (!binding?.token && !binding?.url && !binding?.nodeToken) return;
			if (owner !== path) bindings.set(owner, binding);
		};
		for (const [owner, binding] of Object.entries(this.settings.documentBindings || {})) add(owner, binding);
		for (const file of this.app?.vault?.getMarkdownFiles?.() || []) {
			const binding = this.getBinding(file);
			if (binding) add(file.path, binding);
		}
		for (const [owner, binding] of Object.entries(this.settings.pdfBindings || {})) {
			if (binding.fileToken) add(owner, { token: binding.fileToken, nodeToken: binding.nodeToken, url: binding.url || "" });
		}
		for (const [owner, published] of Object.entries(this.settings.publishedFolders || {})) {
			for (const [key, binding] of Object.entries(this.settings.folderBindings || {})) {
				const root = this.getFolderBindingRootParent(key), remotePath = this.getFolderBindingPath(key);
				if (root.kind === published.rootParent.kind && root.token === published.rootParent.token && this.isPathWithin(remotePath, published.remoteRoot)) {
					const suffix = remotePath.slice(published.remoteRoot.length).replace(/^\/+/, "");
					add([owner, suffix].filter(Boolean).join("/"), binding);
				}
			}
		}
		return bindings;
	}

	private getOtherRemoteBindingOwners(path: string): Map<string, string> {
		const owners = new Map<string, string>();
		for (const [owner, binding] of this.getOtherRemoteBindings(path)) {
			for (const key of this.getBindingAliases(binding)) owners.set(key, owner);
		}
		return owners;
	}

	private assertRemoteBindingExclusive(path: string, binding: BoundLarkDocument, owners = this.getOtherRemoteBindingOwners(path)): void {
		for (const key of this.getBindingAliases(binding)) {
			const owner = owners.get(key);
			if (owner) throw new LocalizedSyncError(this.settings.language === "en"
				? `This remote document is already bound to ${owner}; ${path} cannot share it. Set a different link first.`
				: `此远端文档已绑定本地文件“${owner}”，不能再绑定“${path}”。请先设置不同的飞书链接。`);
		}
	}

	private async resolveExclusiveRemoteBinding(path: string, binding: BoundLarkDocument): Promise<BoundLarkDocument> {
		this.assertRemoteBindingExclusive(path, binding);
		const resolvedByUrl = new Map<string, BoundLarkDocument>();
		const resolve = async (value: BoundLarkDocument): Promise<BoundLarkDocument> => {
			const url = value.url || "";
			if (!url.includes("/wiki/") || (value.token && value.token !== extractDocumentToken(url))) return value;
			const cached = resolvedByUrl.get(url);
			if (cached) return cached;
			const inspected = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", url, "--json"]);
			if (!inspected.data?.token || !["docx", "file"].includes(inspected.data.type || "")) throw new Error(this.t("invalidPublishedLink"));
			const resolved = { ...value, token: inspected.data.token, nodeToken: inspected.data.wiki_node?.node_token || value.nodeToken };
			resolvedByUrl.set(url, resolved);
			return resolved;
		};
		const resolved = await resolve(binding);
		const owners = this.getOtherRemoteBindingOwners(path);
		// Resolve the other owners as well: different Wiki nodes can point to the
		// same underlying document, including legacy frontmatter-only bindings.
		for (const [owner, other] of this.getOtherRemoteBindings(path)) {
			for (const key of this.getBindingAliases(await resolve(other))) owners.set(key, owner);
		}
		this.assertRemoteBindingExclusive(path, resolved, owners);
		return resolved;
	}

	private selectOverwriteMatch(path: string, matches: Array<BoundLarkDocument & { title: string }>): BoundLarkDocument | undefined {
		for (const match of matches) this.assertRemoteBindingExclusive(path, match);
		return [...matches].sort((left, right) => (left.nodeToken || left.token).localeCompare(right.nodeToken || right.token))[0];
	}

	private sameRemoteDocument(left: BoundLarkDocument, right: BoundLarkDocument): boolean {
		const rightNode = right.nodeToken || (right.url.includes("/wiki/") ? extractDocumentToken(right.url) : "");
		if (left.nodeToken && rightNode) return left.nodeToken === rightNode;
		const aliases = new Set(this.getBindingAliases(right));
		return this.getBindingAliases(left).some((key) => aliases.has(key));
	}

	private async cleanupRemoteDuplicates(path: string, title: string, parent: RemoteParent, keep: BoundLarkDocument, objType: "docx" | "file" = "docx"): Promise<number> {
		const matches = (await this.listRemoteDocuments(parent, objType)).filter((document) => document.title === title);
		const kept = matches.find((document) => this.sameRemoteDocument(document, keep));
		if (matches.length < 2) return 0;
		if (!kept) throw new LocalizedSyncError(this.settings.language === "en"
			? `The bound document is not in the expected remote folder: ${path}. No duplicates were deleted.`
			: `无法在对应远端目录确认保留文档：${path}。尚未删除同名文档。`);
		// Multiple Wiki nodes may reference the same underlying document; deleting
		// its origin would also invalidate the retained reference.
		const duplicates = matches.filter((document) => document !== kept && document.token !== kept.token);
		if (!duplicates.length) return 0;
		for (const duplicate of duplicates) await this.resolveExclusiveRemoteBinding(path, duplicate);
		for (const duplicate of duplicates) {
			if (parent.kind === "wiki" || parent.kind === "my_library") {
				await this.removeWikiDuplicate(parent, duplicate, kept, objType);
			} else if (parent.kind === "drive") {
				const current = await this.listRemoteDocuments(parent, objType);
				if (!current.some((document) => document.title === title && this.sameRemoteDocument(document, duplicate))
					|| !current.some((document) => this.sameRemoteDocument(document, kept))) {
					throw new LocalizedSyncError(this.settings.language === "en" ? "Remote documents changed; deletion stopped." : "远端文档已变化，已停止删除。");
				}
				await this.runLarkCli(["drive", "+delete", "--as", "user", "--file-token", duplicate.token, "--type", objType, "--yes", "--json"]);
			} else throw new LocalizedSyncError(this.t("invalidPublishedLink"));
			if (duplicate.token !== kept.token) this.removeSyncStateForBinding(duplicate);
		}
		for (let attempt = 0; attempt < STRICT_REMOTE_STATE_REFRESH_ATTEMPTS; attempt++) {
			const remaining = await this.listRemoteDocuments(parent, objType);
			if (duplicates.every((duplicate) => !remaining.some((document) => this.sameRemoteDocument(document, duplicate)))) {
				await this.saveLarkSyncState();
				return duplicates.length;
			}
			if (attempt < STRICT_REMOTE_STATE_REFRESH_ATTEMPTS - 1) await this.sleep(STRICT_REMOTE_STATE_REFRESH_DELAY_MS);
		}
		throw new LocalizedSyncError(this.settings.language === "en"
			? `Duplicate deletion is not confirmed yet: ${path}. Retry overwrite sync later.`
			: `尚未确认同名文档已删除：${path}。请稍后重试覆盖同步。`);
	}

	private async removeWikiDuplicate(parent: RemoteParent, duplicate: BoundLarkDocument & { title: string }, keep: BoundLarkDocument, objType: "docx" | "file" = "docx"): Promise<void> {
		const info = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", duplicate.nodeToken || duplicate.token, "--json"]);
		const node: LarkCommandNode | undefined = info.data?.node || info.data;
		if (!node?.node_token || node.obj_token !== duplicate.token || node.obj_type !== objType
			|| node.title !== duplicate.title || node.parent_node_token !== parent.token) {
			throw new LocalizedSyncError(this.settings.language === "en" ? "The duplicate document moved or changed; deletion stopped." : "同名文档的位置或标题已变化，已停止删除。");
		}
		const target = keep.nodeToken || keep.token;
		const childParent: RemoteParent = { kind: "wiki", token: node.node_token, spaceId: node.space_id };
		const children = await this.listRemoteWikiNodes(childParent);
		for (const child of children) {
			if (!child.node_token) throw new Error("Invalid wiki child node; duplicate deletion stopped.");
			await this.runLarkCli(["wiki", "+move", "--as", "user", "--node-token", child.node_token, "--target-parent-token", target, "--json"]);
		}
		// Never cascade-delete child pages; they must remain under the retained document.
		if ((await this.listRemoteWikiNodes(childParent)).length) throw new LocalizedSyncError(this.settings.language === "en"
			? "Child pages have not finished moving; duplicate deletion stopped." : "子页面尚未全部移动到保留文档，已停止删除。");
		for (const binding of Object.values(this.settings.documentBindings)) {
			if (binding.containerToken === node.node_token) binding.containerToken = target;
		}
		for (const binding of Object.values(this.settings.folderBindings)) {
			if (binding.containerToken === node.node_token) binding.containerToken = target;
		}
		for (const binding of Object.values(this.settings.pdfBindings)) {
			if (binding.parent?.kind === "wiki" && binding.parent.token === node.node_token) {
				binding.parent.token = target;
				binding.key = createPdfBindingKey({ vaultRoot: this.getVaultRoot(), vaultPath: binding.vaultPath, parent: binding.parent, scope: binding.scope });
			}
		}
		await this.saveSettingsWithoutClearingCommandCache();
		await this.runLarkCli(["wiki", "+node-delete", "--as", "user", "--node-token", node.node_token,
			"--obj-type", "wiki", "--include-children=false", "--yes", "--json"]);
	}

	private async restoreOverwriteChildPageList(binding: BoundLarkDocument, path: string, parent: RemoteParent): Promise<void> {
		if (parent.kind !== "wiki" && parent.kind !== "my_library") return;
		const info = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", binding.nodeToken || binding.token, "--json"]);
		const node: LarkCommandNode | undefined = info.data?.node || info.data;
		if (!node?.node_token || !node.space_id) throw new Error("Cannot resolve overwritten document's wiki node.");
		if ((await this.listRemoteWikiNodes({ kind: "wiki", token: node.node_token, spaceId: node.space_id })).length) {
			await this.ensureFolderPageList(binding, path);
		}
	}

	private queueSaveAutoSync(file: TFile): void {
		const selfWrittenAt = this.selfWrittenPaths.get(file.path);
		if (selfWrittenAt && Date.now() - selfWrittenAt < AUTO_SYNC_WRITE_IGNORE_MS) {
			return;
		}

		if (this.autoSyncRunningPaths.has(file.path)) {
			this.autoSyncPendingPaths.add(file.path);
			return;
		}

		if (!this.getBinding(file)) {
			return;
		}

		const existingTimer = this.autoSyncTimers.get(file.path);
		if (existingTimer) {
			window.clearTimeout(existingTimer);
		}

		const delayMs = this.getAutoSyncDelayMs();
		const timer = window.setTimeout(() => {
			this.autoSyncTimers.delete(file.path);
			void this.runSaveAutoSync(file);
		}, delayMs);
		this.autoSyncTimers.set(file.path, timer);
	}

	private async runSaveAutoSync(file: TFile): Promise<void> {
		if (this.autoSyncRunningPaths.has(file.path)) {
			this.autoSyncPendingPaths.add(file.path);
			return;
		}

		this.autoSyncRunningPaths.add(file.path);
		this.autoSyncPendingPaths.delete(file.path);
		try {
			await this.refreshIgnoreRules([file.path]);
			if (this.isSyncIgnored(file.path)) {
				return;
			}
			await this.syncFileInternal(file, {
				allowCreate: false,
				openAfterSync: false,
				showSuccess: false,
				showRemoteDeletedNotice: false,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "save"
			});
		} catch (error) {
			if (this.isFileNotFoundError(error)
				&& !this.app.vault.getAbstractFileByPath(file.path)) {
				return;
			}
			let effectiveError = error;
			if (this.isRemoteDocumentDeletedApiError(error)) {
				const binding = this.getBinding(file);
				try {
					if (binding) {
						await this.unbindDeletedRemoteDocument(file, binding);
						new Notice(this.t("noticeRemoteDeletedUnbound", { path: file.path }), 10000);
						console.warn("[Feishu Docs Publisher] remote document deleted; binding removed", {
							path: file.path,
							doc: getDocumentStateKey(binding.token || binding.url)
						});
						return;
					}
				} catch (unbindError) {
					effectiveError = unbindError;
				}
			}
			if (effectiveError instanceof RemoteStateRefreshError && effectiveError.updateSubmitted) {
				new Notice(this.t("noticeAutoSyncConfirmationTimedOut", { path: file.path }), 10000);
				console.warn("[Feishu Docs Publisher] auto sync update submitted but confirmation timed out", effectiveError);
			} else {
				const errorMessage = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
				new Notice(this.t("noticeAutoSyncFailed", { path: file.path, message: errorMessage }), 10000);
				console.error("[Feishu Docs Publisher] auto sync failed", effectiveError);
			}
		} finally {
			this.autoSyncRunningPaths.delete(file.path);
			if (this.autoSyncPendingPaths.delete(file.path)) {
				this.queueSaveAutoSync(file);
			}
		}
	}

	private getAutoSyncDelayMs(): number {
		const delaySeconds = Number.isFinite(this.settings.autoSyncDelaySeconds)
			? this.settings.autoSyncDelaySeconds
			: DEFAULT_AUTO_SYNC_DELAY_SECONDS;
		return Math.max(1, delaySeconds) * 1000;
	}

	async installPrePushHook(): Promise<void> {
		try {
			const vaultPath = this.getVaultBasePath();
			if (!vaultPath) {
				new Notice(this.t("noticeNoDesktopVaultPath"), 10000);
				return;
			}

			const gitDirectory = join(vaultPath, ".git");
			if (!await this.pathExists(gitDirectory)) {
				new Notice(this.t("noticeNoGitRepository"), 10000);
				return;
			}

			const hooksDirectory = join(gitDirectory, "hooks");
			const hookPath = join(hooksDirectory, "pre-push");
			const targetScript = join(hooksDirectory, PRE_PUSH_SCRIPT_NAME);
			const nodePath = await this.resolveNodePath();
			await mkdir(hooksDirectory, { recursive: true });
			await this.refreshPrePushHookHelpers(hooksDirectory);
			const backupHookPath = await this.backupExistingPrePushHook(hookPath);
			await writeFile(hookPath, this.buildPrePushHookScript(targetScript, backupHookPath, nodePath), { mode: 0o755 });
			await chmod(hookPath, 0o755);
			if (backupHookPath) {
				new Notice(this.t("noticeExistingGitHookBackedUp", { path: backupHookPath }), 10000);
			}
			new Notice(this.t("noticeGitHookInstalled"), 10000);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(this.t("noticeGitHookInstallFailed", { message }), 10000);
			console.error("[Feishu Docs Publisher] install pre-push hook failed", error);
		}
	}

	private async tryRefreshInstalledPrePushHook(): Promise<void> {
		try {
			const hookInfo = await this.getPrePushHookInfo();
			if (hookInfo.status !== "installed" || !hookInfo.hooksDirectory) {
				return;
			}

			await this.refreshPrePushHookHelpers(hookInfo.hooksDirectory);
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to refresh pre-push hook helpers", error);
		}
	}

	async getPrePushHookStatus(): Promise<PrePushHookStatus> {
		try {
			const hookInfo = await this.getPrePushHookInfo();
			return hookInfo.status;
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to check pre-push hook status", error);
			return "unknown";
		}
	}

	private async getPrePushHookInfo(): Promise<{ status: PrePushHookStatus; hooksDirectory?: string }> {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return { status: "unavailable" };
		}

		const gitDirectory = join(vaultPath, ".git");
		if (!await this.pathExists(gitDirectory)) {
			return { status: "not-git-repository" };
		}

		const hooksDirectory = join(gitDirectory, "hooks");
		const hookPath = join(hooksDirectory, "pre-push");
		if (!await this.pathExists(hookPath)) {
			return { status: "not-installed", hooksDirectory };
		}

		const hookContent = await readFile(hookPath, "utf8");
		if (!this.isOurPrePushHook(hookContent)) {
			return { status: "not-installed", hooksDirectory };
		}

		return { status: "installed", hooksDirectory };
	}

	private async refreshPrePushHookHelpers(hooksDirectory: string): Promise<void> {
		const pluginDirectory = this.getPluginDirectoryPath();
		const sourceScript = join(pluginDirectory, PRE_PUSH_SCRIPT_NAME);
		const sourceCoreScript = join(pluginDirectory, PRE_PUSH_CORE_SCRIPT_NAME);
		const sourceCommandScript = join(pluginDirectory, LARK_CLI_COMMAND_SCRIPT_NAME);
		const targetScript = join(hooksDirectory, PRE_PUSH_SCRIPT_NAME);
		const targetCoreScript = join(hooksDirectory, PRE_PUSH_CORE_SCRIPT_NAME);
		const targetCommandScript = join(hooksDirectory, LARK_CLI_COMMAND_SCRIPT_NAME);
		await this.copyOrWriteEmbeddedHelper(sourceScript, targetScript, String(EMBEDDED_PRE_PUSH_SCRIPT));
		await this.copyOrWriteEmbeddedHelper(sourceCoreScript, targetCoreScript, String(EMBEDDED_PRE_PUSH_CORE_SCRIPT));
		await this.copyOrWriteEmbeddedHelper(sourceCommandScript, targetCommandScript, String(EMBEDDED_LARK_CLI_COMMAND_SCRIPT));
		await chmod(targetScript, 0o755);
	}

	private async copyOrWriteEmbeddedHelper(sourcePath: string, targetPath: string, embeddedContent: string): Promise<void> {
		if (await this.pathExists(sourcePath)) {
			await copyFile(sourcePath, targetPath);
			return;
		}

		await writeFile(targetPath, embeddedContent);
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}

		return null;
	}

	private getPluginDirectoryPath(): string {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			throw new Error(this.t("noticeNoDesktopVaultPath"));
		}

		return join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id);
	}

	private getLarkSyncStatePath(): string | null {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return null;
		}

		return join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id, LARK_SYNC_STATE_FILE_NAME);
	}

	private async loadLarkSyncState(): Promise<LarkSyncStateFile> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return createEmptySyncStateFile();
		}

		try {
			const rawState = await readFile(statePath, "utf8");
			const state: unknown = JSON.parse(rawState);
			if (this.isValidLarkSyncStateFile(state)) {
				return {
					version: 1,
					documents: state.documents
				};
			}
		} catch (error) {
			if (!this.isFileNotFoundError(error)) {
				console.warn("[Feishu Docs Publisher] failed to load sync state", error);
			}
		}

		const emptyState = createEmptySyncStateFile();
		await this.tryRepairLarkSyncStateFile(emptyState);
		return emptyState;
	}

	private async saveLarkSyncState(): Promise<void> {
		if (this.deferredSyncStateSaveDepth > 0) {
			this.hasDeferredSyncStateSave = true;
			return;
		}

		await this.writeLarkSyncStateQueued();
	}

	private async flushDeferredLarkSyncStateSave(): Promise<void> {
		if (!this.hasDeferredSyncStateSave) {
			return;
		}

		this.hasDeferredSyncStateSave = false;
		await this.writeLarkSyncStateQueued();
	}

	private async writeLarkSyncStateQueued(): Promise<void> {
		const saveTask = this.syncStateSaveQueue.then(() => {
			return this.writeLarkSyncState();
		});
		this.syncStateSaveQueue = saveTask.catch(() => {});
		await saveTask;
	}

	private async withDeferredLarkSyncStateSave(callback: () => Promise<void>): Promise<void> {
		this.deferredSyncStateSaveDepth += 1;
		let callbackError: unknown;
		try {
			await callback();
		} catch (error) {
			callbackError = error;
		}

		try {
			this.deferredSyncStateSaveDepth -= 1;
			if (this.deferredSyncStateSaveDepth === 0) {
				await this.flushDeferredLarkSyncStateSave();
			}
		} catch (error) {
			if (!callbackError) {
				throw error;
			}
			console.warn("[Feishu Docs Publisher] failed to flush deferred sync state", error);
		}

		if (callbackError) {
			throw this.toError(callbackError);
		}
	}

	private async writeLarkSyncState(): Promise<void> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return;
		}

		const tempPath = `${statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		const changedKeys = new Set(this.syncStateChangedKeys);
		const removedKeys = new Set(this.syncStateRemovedKeys);
		this.syncStateChangedKeys.clear();
		this.syncStateRemovedKeys.clear();
		await mkdir(dirname(statePath), { recursive: true });
		try {
			const persistedState = await this.readPersistedLarkSyncState(statePath);
			const mergedState = mergeSyncStateFiles(persistedState, this.syncState, {
				changedKeys,
				removedKeys
			});
			const nextState = this.trimSyncStateCacheIfNeeded(mergedState);
			await writeFile(tempPath, JSON.stringify(nextState, null, 2), "utf8");
			await rename(tempPath, statePath);
			this.syncState = mergeSyncStateFiles(nextState, this.syncState, {
				changedKeys: this.syncStateChangedKeys,
				removedKeys: this.syncStateRemovedKeys
			});
		} catch (error) {
			this.restorePendingSyncStateKeys(changedKeys, removedKeys);
			await rm(tempPath, { force: true });
			throw error;
		}
	}

	private async readPersistedLarkSyncState(statePath: string): Promise<LarkSyncStateFile | undefined> {
		try {
			const rawState = await readFile(statePath, "utf8");
			const state: unknown = JSON.parse(rawState);
			if (this.isValidLarkSyncStateFile(state)) {
				return {
					version: 1,
					documents: state.documents
				};
			}
		} catch (error) {
			if (!this.isFileNotFoundError(error)) {
				console.warn("[Feishu Docs Publisher] failed to read persisted sync state", error);
			}
		}

		return undefined;
	}

	private setDocumentSyncState(stateKey: string, state: LarkSyncStateFile["documents"][string]): void {
		this.syncState.documents[stateKey] = state;
		this.syncStateChangedKeys.add(stateKey);
		this.syncStateRemovedKeys.delete(stateKey);
	}

	private deleteDocumentSyncStateKey(stateKey: string): void {
		delete this.syncState.documents[stateKey];
		this.syncStateChangedKeys.delete(stateKey);
		this.syncStateRemovedKeys.add(stateKey);
	}

	private restorePendingSyncStateKeys(changedKeys: Iterable<string>, removedKeys: Iterable<string>): void {
		for (const key of changedKeys) {
			if (!this.syncStateRemovedKeys.has(key)) {
				this.syncStateChangedKeys.add(key);
			}
		}
		for (const key of removedKeys) {
			if (!this.syncStateChangedKeys.has(key)) {
				this.syncStateRemovedKeys.add(key);
			}
		}
	}

	private async ensureLarkSyncStateFile(): Promise<void> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath || await this.pathExists(statePath)) {
			return;
		}

		await this.saveLarkSyncState();
	}

	private async tryEnsureLarkSyncStateFile(): Promise<void> {
		try {
			await this.ensureLarkSyncStateFile();
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to initialize sync state file", error);
		}
	}

	private async tryRepairLarkSyncStateFile(state: LarkSyncStateFile): Promise<void> {
		const previousState = this.syncState;
		try {
			this.syncState = state;
			await this.saveLarkSyncState();
		} catch (error) {
			console.warn("[Feishu Docs Publisher] failed to repair sync state file", error);
		} finally {
			this.syncState = previousState;
		}
	}

	private isValidLarkSyncStateFile(state: unknown): state is LarkSyncStateFile {
		if (!this.isRecord(state)
			|| state.version !== 1
			|| !this.isRecord(state.documents)) {
			return false;
		}

		return Object.values(state.documents).every((documentState) => {
			return this.isRecord(documentState)
				&& typeof documentState.doc === "string"
				&& typeof documentState.contentHash === "string"
				&& Array.isArray(documentState.units)
				&& typeof documentState.updatedAt === "string";
		});
	}

	private isFileNotFoundError(error: unknown): boolean {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	}

	private trimSyncStateCacheIfNeeded(state: LarkSyncStateFile): LarkSyncStateFile {
		const retainLimit = normalizeStateCacheRetainLimit(
			this.settings.stateCacheRetainLimit,
			DEFAULT_STATE_CACHE_RETAIN_LIMIT
		);
		return trimSyncStateCache(state, {
			retainLimit
		});
	}

	private normalizePositiveInteger(value: unknown, fallback: number): number {
		const numericValue = typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
		if (!Number.isFinite(numericValue)) {
			return fallback;
		}

		return Math.max(1, Math.floor(numericValue));
	}

	private async backupExistingPrePushHook(hookPath: string): Promise<string> {
		if (!await this.pathExists(hookPath)) {
			return "";
		}

		const content = await readFile(hookPath, "utf8");
		if (this.isOurPrePushHook(content)) {
			return "";
		}

		const backupHookPath = `${hookPath}.before-feishu-docs-publisher`;
		await copyFile(hookPath, backupHookPath);
		await chmod(backupHookPath, 0o755);
		return backupHookPath;
	}

	private buildPrePushHookScript(scriptPath: string, backupHookPath: string, nodePath: string): string {
		const runBackupHook = backupHookPath
			? `"${backupHookPath}" "$@"\n`
			: "";
		return `#!/usr/bin/env sh
# ${PRE_PUSH_HOOK_MARKER}
set -eu
${runBackupHook}
exec "${nodePath}" "${scriptPath}" "$@"
`;
	}

	private async resolveNodePath(): Promise<string> {
		const shellPath = await this.resolveCommandFromLoginShell(NODE_COMMAND);
		if (shellPath) {
			return shellPath;
		}

		const candidates = [
			"/opt/homebrew/bin/node",
			"/usr/local/bin/node",
			join(homedir(), ".nvm/current/bin/node"),
			NODE_COMMAND
		];

		for (const candidate of candidates) {
			if (candidate === NODE_COMMAND || await this.canExecute(candidate)) {
				return candidate;
			}
		}

		return NODE_COMMAND;
	}

	private async pathExists(path: string): Promise<boolean> {
		try {
			await access(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	private async publishFolder(folderPath: string, overwrite = false): Promise<void> {
		const base = this.t(overwrite ? "noticeOverwriteSyncingToLark" : "noticePublishingFolderToLark");
		const synced = await this.runWithNotice(base, (notice) => this.publishFolderInternal(folderPath, overwrite,
			(message) => notice.setMessage(`${base}\n${message}`)));
		if (synced) await this.cleanupMissingRemoteFiles(folderPath);
	}

	/** Offer to delete remote files this plugin published whose local file is gone. */
	private async cleanupMissingRemoteFiles(folderPath: string): Promise<void> {
		if (!this.settings.deleteMissingRemote) return;
		await this.refreshIgnoreRules(this.publishedPathsWithin(folderPath));
		const missing = this.findMissingRemoteFiles(folderPath);
		if (missing.length === 0 || !await this.confirmDeleteMissingRemote(missing)) return;
		await this.runWithNotice(this.t("noticeDeletingMissingRemote"), () =>
			(this.operationQueue ??= new SyncQueue()).run(() => this.deleteMissingRemoteFiles(folderPath, missing)));
	}

	private confirmDeleteMissingRemote(missing: MissingRemoteFile[]): Promise<boolean> {
		return confirmDeletion(this.app, {
			title: this.t("confirmDeleteMissingRemoteTitle"),
			body: this.t("confirmDeleteMissingRemoteBody", { count: String(missing.length) }),
			confirm: this.t("confirmDeleteMissingRemoteButton"),
			cancel: this.t("confirmDeleteMissingRemoteCancel")
		}, missing.map((file) => file.path));
	}

	private findMissingRemoteFiles(folderPath: string): MissingRemoteFile[] {
		// Whatever an existing local file or folder page still points at must survive.
		const liveAliases = new Set<string>();
		const keep = (binding: BoundLarkDocument): void => {
			for (const alias of this.getBindingAliases(binding)) if (alias) liveAliases.add(alias);
		};
		for (const file of this.app.vault.getMarkdownFiles()) {
			const binding = this.getBinding(file);
			if (binding) keep(binding);
		}
		for (const [path, binding] of Object.entries(this.settings.pdfBindings || {})) {
			if (binding.fileToken && this.app.vault.getAbstractFileByPath(path)) {
				keep({ token: binding.fileToken, nodeToken: binding.nodeToken, url: binding.url || "" });
			}
		}
		for (const binding of Object.values(this.settings.folderBindings || {})) keep(binding);
		return findMissingRemoteFiles({
			folderPath,
			documentBindings: this.settings.documentBindings || {},
			pdfBindings: this.settings.pdfBindings || {},
			localFileExists: (path) => !!this.app.vault.getAbstractFileByPath(path),
			isDisconnected: (path) => this.isFolderDisconnected(path) || !!this.settings.disconnectedBindings?.[path]
				|| this.isSyncIgnored(path),
			liveAliases,
			aliasesOf: (binding) => this.getBindingAliases({ ...binding })
		});
	}

	private async deleteMissingRemoteFiles(folderPath: string, planned: MissingRemoteFile[]): Promise<void> {
		// Recompute inside the queue: a file may have reappeared since the user confirmed.
		const confirmed = new Set(planned.map((file) => file.token));
		await this.refreshIgnoreRules(this.publishedPathsWithin(folderPath));
		let deleted = 0, skipped = 0;
		const failures: string[] = [];
		for (const target of this.findMissingRemoteFiles(folderPath).filter((file) => confirmed.has(file.token))) {
			try {
				if (await this.deleteRemoteFile(target) === "has-children") {
					skipped += 1;
					continue;
				}
				this.forgetMissingRemoteFile(target);
				deleted += 1;
			} catch (error) {
				failures.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (deleted) {
			await this.saveSettingsWithoutClearingCommandCache();
			await this.saveLarkSyncState();
			new Notice(this.t("noticeDeletedMissingRemote", { count: String(deleted) }), 8000);
		}
		if (skipped) new Notice(this.t("noticeSkippedMissingRemote", { count: String(skipped) }), 10000);
		if (failures.length) new Notice(this.t("noticeDeleteMissingRemoteFailed", { message: failures.join("\n") }), 10000);
	}

	private async deleteRemoteFile(target: MissingRemoteFile): Promise<"deleted" | "has-children"> {
		const objType = target.kind === "pdf" ? "file" : "docx";
		try {
			if (target.location === "drive") {
				await this.runLarkCli(["drive", "+delete", "--as", "user", "--file-token", target.token,
					"--type", objType, "--yes", "--json"]);
				return "deleted";
			}
			return await this.deleteWikiLeaf(target, objType);
		} catch (error) {
			// Already deleted by hand: only the stale local record is left to clear.
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("1061007") || message.toLowerCase().includes("has been delete")) return "deleted";
			throw error;
		}
	}

	private async deleteWikiLeaf(target: MissingRemoteFile, objType: "docx" | "file"): Promise<"deleted" | "has-children"> {
		if (!target.nodeToken) throw new LocalizedSyncError(this.settings.language === "en"
			? "Cannot resolve the wiki node; deletion stopped." : "无法确定知识库节点，已停止删除。");
		const info = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", target.nodeToken, "--json"]);
		const node: LarkCommandNode | undefined = info.data?.node || info.data;
		if (!node?.node_token || node.obj_token !== target.token || node.obj_type !== objType) {
			throw new LocalizedSyncError(this.settings.language === "en"
				? "The remote file moved or changed; deletion stopped." : "远端文件的位置或类型已变化，已停止删除。");
		}
		// Never cascade into child pages that belong to other notes.
		if ((await this.listRemoteWikiNodes({ kind: "wiki", token: node.node_token, spaceId: node.space_id })).length) {
			return "has-children";
		}
		await this.runLarkCli(["wiki", "+node-delete", "--as", "user", "--node-token", node.node_token,
			"--obj-type", "wiki", "--include-children=false", "--yes", "--json"]);
		return "deleted";
	}

	private forgetMissingRemoteFile(target: MissingRemoteFile): void {
		if (target.kind === "pdf") {
			delete this.settings.pdfBindings[target.path];
			return;
		}
		const binding = this.settings.documentBindings[target.path];
		delete this.settings.documentBindings[target.path];
		if (binding) this.removeSyncStateForBinding(binding);
	}

	private async publishFolderInternal(folderPath: string, overwrite = false, onProgress?: (message: string) => void): Promise<void> {
		await (this.operationQueue ??= new SyncQueue()).run(() => this.withDeferredLarkSyncStateSave(async () => {
			onProgress?.(this.t("progressFolderScan"));
			if (this.hasUnsavedSettings) await this.saveSettingsWithoutClearingCommandCache();
			const reconnected = clearDisconnectedFolderPaths(this.settings.disconnectedFolders ??= {}, folderPath);
			await this.refreshIgnoreRules([`${folderPath}/`, ...this.collectFolderFiles(folderPath).map((file) => file.path)]);
			const createdGalleries = await this.ensureImageGalleryNotes(folderPath);
			const notes = this.collectMarkdownFiles(folderPath).filter((file) => !this.isFolderDisconnected(file.path));
			const pdfs = this.collectFolderFiles(folderPath).filter((file) => file.extension.toLowerCase() === "pdf"
				&& !this.isFolderDisconnected(file.path));
			const files = notes.filter((file) => !this.isSyncIgnored(file.path));
			const pdfFiles = pdfs.filter((file) => !this.isSyncIgnored(file.path));
			const ignoredCount = notes.length + pdfs.length - files.length - pdfFiles.length;
			if (files.length + pdfFiles.length === 0) {
				if (reconnected) await this.saveSettingsWithoutClearingCommandCache();
				new Notice(this.t(this.hasIgnoredContent(folderPath) ? "noticeAllFilesIgnoredInFolder" : "noticeNoMarkdownFilesInFolder"));
				return;
			}

			const total = String(files.length + pdfFiles.length);
			onProgress?.(ignoredCount > 0
				? this.t("progressFolderFilesIgnored", { count: total, ignored: String(ignoredCount) })
				: this.t("progressFolderFiles", { count: total }));
			const entries: FolderPublishEntry[] = [];
			const folderRoot = this.settings.publishedFolders[this.normalizeLinkPath(folderPath)]?.remoteRoot
				?? this.getSelectedFolderName(folderPath);
			const rootParent = this.settings.publishedFolders[this.normalizeLinkPath(folderPath)]?.rootParent
				|| await this.resolveRemoteRootParent();
			this.savePublishedFolderBinding(folderPath, rootParent, folderRoot);
			await this.saveSettingsWithoutClearingCommandCache();
			onProgress?.(this.t("progressFolderRead", { count: String(files.length) }));
			const preparedFiles = await Promise.all(files.map(async (file) => {
				const preparedContent = await this.readNoteForLark(file);
				const binding = this.getBinding(file);
				const documentParentPath = this.getRemoteParentPath(folderPath, file, folderRoot);
				return {
					file,
					preparedContent,
					binding,
					remoteParentPath: documentParentPath
				};
			}));
			for (const prepared of preparedFiles) {
				if (prepared.binding) this.assertRemoteBindingExclusive(prepared.file.path, prepared.binding);
			}
			const parentsByPath = await this.resolveFolderParents(rootParent, preparedFiles);
			let removed = 0;
			if (overwrite) {
				for (const prepared of preparedFiles) {
					await this.assertUniqueOverwriteTitle(prepared.file, prepared.preparedContent.content);
				}
				for (const pdf of pdfFiles) await this.ensureRemoteFolderPath(rootParent, this.getRemoteParentPath(folderPath, pdf, folderRoot));
				removed += await this.consolidateOverwriteFolderPages(folderPath, folderRoot, rootParent);
			}
			await this.recoverPreparedBindings(preparedFiles, parentsByPath, true, undefined, overwrite);
			const indexedPreparedFiles = preparedFiles.map((preparedFile, index) => {
				return {
					preparedFile,
					index
				};
			});

			const preparedFileGroups = this.groupPreparedFilesByDocument(indexedPreparedFiles);
			onProgress?.(this.t("progressFolderDocs", { count: String(files.length) }));
			await this.runWithConcurrency(preparedFileGroups, FOLDER_SYNC_PARALLEL_LIMIT, async (preparedFileGroup) => {
				for (const item of preparedFileGroup) {
					await this.prepareFolderEntry(item, entries, folderRoot, rootParent, parentsByPath);
				}
			});

			for (const [index, file] of pdfFiles.entries()) {
				onProgress?.(this.t("progressFolderPdf", { current: String(index + 1), total: String(pdfFiles.length), name: file.name }));
				const remotePath = this.getRemoteParentPath(folderPath, file, folderRoot);
				const { parent } = await this.ensureRemoteFolderPath(rootParent, remotePath);
				await this.syncPdfFileUnlocked(file, parent, overwrite);
			}
			onProgress?.(this.t("progressFolderContent", { count: String(entries.length) }));
			await this.syncFolderEntries(folderPath, folderRoot, entries, overwrite);
			if (overwrite) {
				for (const entry of entries) {
					if (entry.binding) {
						removed += await this.cleanupRemoteDuplicates(entry.file.path,
							extractTitle(entry.file, entry.preparedContent.content, "first-heading"), entry.parent, entry.binding);
						await this.restoreOverwriteChildPageList(entry.binding, entry.file.path, entry.parent);
					}
				}
			}
			onProgress?.(this.t("progressFolderPages"));
			await this.syncFolderPageLists(folderPath, folderRoot, rootParent, overwrite);
			this.savePublishedFolderBinding(folderPath, rootParent, folderRoot);
			await this.saveSettings();

			new Notice(this.t("noticePublishedFolderToLark", { count: String(entries.length + pdfFiles.length) }), 8000);
			if (createdGalleries) new Notice(this.t("noticeImageGalleryCreated", { count: String(createdGalleries) }), 8000);
			if (removed) new Notice(this.t("noticeRemovedDuplicates", { count: String(removed) }), 8000);
		}));
	}

	/**
	 * Images that no note embeds never reach the remote, so collect them into one generated
	 * note per folder. Images already embedded by a hand-written note are left alone.
	 */
	private async ensureImageGalleryNotes(folderPath: string): Promise<number> {
		const images = this.collectFolderFiles(folderPath).filter((file) => isSupportedImagePath(file.path)
			&& !this.isFolderDisconnected(file.path)
			&& !this.isSyncIgnored(file.path));
		// Ignored notes stay in the list: they still occupy their paths and still embed images that must not be re-collected.
		const notes = await Promise.all(this.collectMarkdownFiles(folderPath)
			.filter((file) => !this.isFolderDisconnected(file.path))
			.map(async (file) => ({ file, content: await this.app.vault.read(file) })));
		const plans = planImageGalleries({
			imagePaths: images.map((file) => file.path),
			notes: notes.map(({ file, content }) => ({ path: file.path, isGallery: isImageGalleryContent(content) })),
			referencedImagePaths: images.length === 0 ? new Set<string>() : collectReferencedLocalImagePaths(
				notes.filter(({ content }) => !isImageGalleryContent(content))
					.map(({ file, content }) => ({ path: file.path, content })),
				this.buildVaultImageIndex()
			),
			noteName: (folderName) => this.t("imageGalleryNoteName", { name: folderName || this.app.vault.getName() })
		});

		let created = 0;
		for (const plan of plans) {
			if (this.isSyncIgnored(plan.notePath)) continue;
			if (!plan.exists) {
				this.selfWrittenPaths.set(plan.notePath, Date.now());
				await this.app.vault.create(plan.notePath, buildImageGalleryBody(plan.imagePaths));
				created += 1;
				continue;
			}
			const existing = notes.find(({ file }) => file.path === plan.notePath);
			if (!existing) continue;
			const next = replaceImageGalleryBody(existing.content, plan.imagePaths);
			if (next === existing.content) continue;
			this.selfWrittenPaths.set(plan.notePath, Date.now());
			await this.app.vault.modify(existing.file, next);
		}
		return created;
	}

	private async consolidateOverwriteFolderPages(folderPath: string, folderRoot: string, rootParent: RemoteParent): Promise<number> {
		const root = this.normalizeLinkPath(folderRoot);
		let removed = 0;
		const bindings = Object.entries(this.settings.folderBindings).sort(([left], [right]) => {
			return this.countPathSegments(this.getFolderBindingPath(left)) - this.countPathSegments(this.getFolderBindingPath(right));
		});
		for (const [key, binding] of bindings) {
			const boundRoot = this.getFolderBindingRootParent(key), remotePath = this.getFolderBindingPath(key);
			if (boundRoot.kind !== rootParent.kind || boundRoot.token !== rootParent.token || !remotePath || !this.isPathWithin(remotePath, root)) continue;
			const kind = binding.containerKind || rootParent.kind;
			if (kind !== "wiki" && kind !== "my_library") continue;
			const suffix = remotePath.slice(root.length).replace(/^\/+/, "");
			const localPath = [folderPath, suffix].filter(Boolean).join("/");
			if (this.isFolderDisconnected(localPath) || this.isSyncIgnored(localPath, true)) continue;
			this.assertRemoteBindingExclusive(localPath, binding);
			const parentBinding = this.settings.folderBindings[this.getFolderBindingKey(rootParent, this.parentPath(remotePath))];
			const parent = { kind, token: binding.containerToken ?? parentBinding?.token ?? rootParent.token };
			removed += await this.cleanupRemoteDuplicates(localPath, remotePath.split("/").pop() || "Untitled", parent, binding);
		}
		return removed;
	}

	private async syncFolderPageLists(folderPath: string, folderRoot: string, rootParent: RemoteParent, overwrite = false): Promise<void> {
		const remoteRoot = this.normalizeLinkPath(folderRoot);
		for (const [key, binding] of Object.entries(this.settings.folderBindings)) {
			const boundRoot = this.getFolderBindingRootParent(key);
			const remotePath = this.getFolderBindingPath(key);
			if (boundRoot.kind !== rootParent.kind || boundRoot.token !== rootParent.token
				|| !this.isPathWithin(remotePath, remoteRoot)) continue;
			const suffix = remotePath.slice(remoteRoot.length).replace(/^\/+/, "");
			const localPath = [folderPath, suffix].filter(Boolean).join("/");
			if (this.isFolderDisconnected(localPath) || this.isSyncIgnored(localPath, true)) continue;
			const kind = binding.containerKind || rootParent.kind;
			if (kind !== "wiki" && kind !== "my_library" && !binding.url.includes("/wiki/")) continue;
			await this.ensureFolderPageList(binding, localPath, overwrite);
		}
	}

	private async ensureFolderPageList(binding: BoundLarkDocument, path: string, overwrite = false): Promise<void> {
		const doc = binding.url || binding.token;
		const snapshot = await this.fetchLarkDocumentWithIds(doc);
		if (!overwrite && /<sub-page-list\b/i.test(snapshot.content)) return;
		const title = (path.split("/").pop() || "Untitled").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		const args = ["docs", "+update", "--api-version", "v2", "--as", "user",
			"--doc", snapshot.doc || doc, "--command", overwrite ? "overwrite" : "block_insert_after",
			...(!overwrite ? ["--block-id", DOCUMENT_END_BLOCK_ID] : []),
			"--doc-format", "xml", "--content", overwrite ? `<title>${title}</title><sub-page-list/>` : "<sub-page-list/>"];
		if (snapshot.revisionId !== undefined) args.push("--revision-id", String(snapshot.revisionId));
		args.push("--json");
		const result = await this.runLarkCli(args);
		const expectedRevision = result.data?.document?.revision_id;
		for (let attempt = 0; attempt < STRICT_REMOTE_STATE_REFRESH_ATTEMPTS; attempt++) {
			const remote = await this.fetchLarkDocumentWithIds(snapshot.doc || doc);
			if (/<sub-page-list\b/i.test(remote.content)
				&& (expectedRevision === undefined || (remote.revisionId !== undefined && remote.revisionId >= expectedRevision))) return;
			if (attempt < STRICT_REMOTE_STATE_REFRESH_ATTEMPTS - 1) await this.sleep(STRICT_REMOTE_STATE_REFRESH_DELAY_MS);
		}
		throw new RemoteStateRefreshError(this.formatSyncFailure("folder", path, "remote-update-not-visible"), true);
	}

	private async resolveFolderParents(
		rootParent: RemoteParent,
		preparedFiles: FolderPreparedFile[]
	): Promise<Map<string, RemoteParent>> {
		const parentsByPath = new Map<string, RemoteParent>();
		let hasFolderBindingChanges = false;
		const parentPaths = uniquePathEntries(preparedFiles.map((preparedFile) => {
			return preparedFile.remoteParentPath;
		})).sort((left, right) => {
			return this.countPathSegments(left) - this.countPathSegments(right) || left.localeCompare(right);
		});

		for (const parentPath of parentPaths) {
			const resolution = await this.ensureRemoteFolderPath(rootParent, parentPath);
			parentsByPath.set(parentPath, resolution.parent);
			hasFolderBindingChanges = hasFolderBindingChanges || resolution.createdBinding;
		}

		if (hasFolderBindingChanges) {
			await this.saveSettings();
		}

		return parentsByPath;
	}

	private groupPreparedFilesByDocument(
		preparedFiles: IndexedFolderPreparedFile[]
	): IndexedFolderPreparedFile[][] {
		const groups = new Map<string, IndexedFolderPreparedFile[]>();
		for (const preparedFile of preparedFiles) {
			const binding = preparedFile.preparedFile.binding;
			const groupKey = binding ? getDocumentStateKey(binding.token || binding.url) : `new:${preparedFile.index}`;
			const group = groups.get(groupKey) || [];
			group.push(preparedFile);
			groups.set(groupKey, group);
		}

		return Array.from(groups.values());
	}

	private async prepareFolderEntry(
		item: IndexedFolderPreparedFile,
		entries: FolderPublishEntry[],
		folderRoot: string,
		rootParent: RemoteParent,
		parentsByPath: Map<string, RemoteParent>
	): Promise<void> {
		const { preparedFile, index } = item;
		const documentParent = parentsByPath.get(preparedFile.remoteParentPath) || rootParent;
		const nextBinding = preparedFile.binding
			? await this.resolveFolderBinding(
				preparedFile.file,
				preparedFile.binding,
				preparedFile.preparedContent,
				documentParent
			)
			: await this.createLarkDocument(
				preparedFile.file,
				preparedFile.preparedContent,
				documentParent,
				this.settings.updateFrontmatter
					? async (createdBinding) => {
						await this.writeBinding(preparedFile.file, createdBinding);
					}
					: undefined
			);
		const nextBindingWithParent = this.withRemoteParentMetadata(
			nextBinding,
			folderRoot,
			preparedFile.remoteParentPath,
			documentParent
		);

		entries[index] = {
			file: preparedFile.file,
			preparedContent: preparedFile.preparedContent,
			binding: nextBindingWithParent,
			parent: documentParent,
			remoteParentPath: preparedFile.remoteParentPath,
			isNewDocument: !preparedFile.binding
				|| nextBinding.token !== preparedFile.binding.token
				|| nextBinding.url !== preparedFile.binding.url
		};

		if (this.shouldWriteBinding(preparedFile.binding, nextBindingWithParent, this.settings.updateFrontmatter)) {
			await this.writeBinding(preparedFile.file, nextBindingWithParent);
		}
	}

	private async syncFolderEntries(folderPath: string, folderRoot: string, entries: FolderPublishEntry[], overwrite = false): Promise<void> {
		const maxAttempts = entries.length + 1;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const linkMap = this.buildFolderLinkMap(folderPath, entries);
			const bindingChanged = await this.syncFolderEntriesOnce(folderRoot, entries, linkMap, overwrite);
			if (!bindingChanged) {
				return;
			}
		}

		throw new LocalizedSyncError(this.formatSyncFailure("folder", folderPath, "remote-revision-changed"));
	}

	private buildFolderLinkMap(folderPath: string, entries: FolderPublishEntry[]): Map<string, LinkTarget> {
		const linkEntries: FolderLinkMapEntry[] = [];
		for (const entry of entries) {
			if (entry.binding) {
				linkEntries.push({
					file: entry.file,
					target: this.toLinkTarget(entry.file, entry.binding)
				});
			}
		}
		return createFolderLinkMap(folderPath, linkEntries);
	}

	private async syncFolderEntriesOnce(
		folderRoot: string,
		entries: FolderPublishEntry[],
		linkMap: Map<string, LinkTarget>,
		overwrite = false
	): Promise<boolean> {
		const entryGroups = this.groupFolderEntriesByDocument(entries);
		let hasBindingChanged = false;
		await this.runWithConcurrency(entryGroups, FOLDER_SYNC_PARALLEL_LIMIT, async (entryGroup) => {
			const groupBindingChanged = await this.syncFolderEntryGroupOnce(folderRoot, entryGroup, linkMap, overwrite);
			hasBindingChanged = hasBindingChanged || groupBindingChanged;
		});

		return hasBindingChanged;
	}

	private groupFolderEntriesByDocument(entries: FolderPublishEntry[]): FolderPublishEntry[][] {
		const groups = new Map<string, FolderPublishEntry[]>();
		for (const entry of entries) {
			if (!entry.binding) {
				continue;
			}

			const groupKey = getDocumentStateKey(entry.binding.token || entry.binding.url);
			const group = groups.get(groupKey) || [];
			group.push(entry);
			groups.set(groupKey, group);
		}

		return Array.from(groups.values());
	}

	private async syncFolderEntryGroupOnce(
		folderRoot: string,
		entries: FolderPublishEntry[],
		linkMap: Map<string, LinkTarget>,
		overwrite = false
	): Promise<boolean> {
		for (const entry of entries) {
			if (!entry.binding) {
				continue;
			}

			const rewrittenContent = this.rewriteInternalLinks(entry.preparedContent.content, linkMap, entry.file);
			if (entry.isNewDocument) {
				await this.saveCreatedDocumentStateFromBaseline(entry.binding, entry.preparedContent.content);
				if (rewrittenContent === entry.preparedContent.content) {
					continue;
				}
			}
			const strategy = overwrite ? "overwrite" : entry.isNewDocument ? "precise" : undefined;

			const nextBinding = await this.syncOrRecreateDocument(entry.file, entry.binding, {
				...entry.preparedContent,
				content: rewrittenContent
			}, entry.parent, {
				allowRecreate: true,
				showRemoteDeletedNotice: false,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "folder",
				path: entry.file.path,
				strategy,
				stateKeys: [entry.binding.token, entry.binding.url]
			});
			const nextBindingWithParent = this.withRemoteParentMetadata(
				nextBinding,
				folderRoot,
				entry.remoteParentPath,
				entry.parent
			);

			if (nextBindingWithParent.token !== entry.binding.token || nextBindingWithParent.url !== entry.binding.url) {
				entry.binding = nextBindingWithParent;
				entry.isNewDocument = true;
				await this.writeBinding(entry.file, nextBindingWithParent);
				return true;
			}

			if (this.shouldWriteBinding(entry.binding, nextBindingWithParent, this.settings.updateFrontmatter)) {
				await this.writeBinding(entry.file, nextBindingWithParent);
			}

		}

		return false;
	}

	private async runWithConcurrency<T>(
		items: T[],
		limit: number,
		worker: (item: T) => Promise<void>
	): Promise<void> {
		const executing = new Set<Promise<void>>();
		let firstError: unknown;
		for (const item of items) {
			let task: Promise<void>;
			task = Promise.resolve().then(() => {
				return worker(item);
			}).catch((error) => {
				firstError = firstError || error;
			}).finally(() => {
				executing.delete(task);
			});
			executing.add(task);
			if (executing.size >= limit) {
				await Promise.race(executing);
			}
		}

		await Promise.all(executing);
		if (firstError) {
			throw this.toError(firstError);
		}
	}

	private getActiveMarkdownFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (file instanceof TFile && file.extension === "md") {
			return file;
		}
		return null;
	}

	private collectFolderFiles(folderPath: string): TFile[] {
		const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
		if (!(folder instanceof TFolder)) return [];
		const files: TFile[] = [];
		const pending = [folder];
		while (pending.length) {
			const current = pending.pop();
			if (!current) continue;
			for (const child of current.children) {
				if (child instanceof TFolder) pending.push(child);
				else if (child instanceof TFile) files.push(child);
			}
		}
		return files;
	}

	private collectMarkdownFiles(folderPath: string): TFile[] {
		return this.collectFolderFiles(folderPath)
			.filter((file) => file.extension === "md")
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private buildVaultImageIndex(): LocalImageFileIndex {
		return buildLocalImageFileIndexFromPaths(this.app.vault.getFiles().map((file) => file.path));
	}

	private buildVaultMediaIndex(): LocalImageFileIndex {
		return buildLocalMediaFileIndexFromPaths(this.app.vault.getFiles().map((file) => file.path));
	}

	private async readNoteForLark(file: TFile): Promise<PreparedNoteContent> {
		const rawContent = await this.app.vault.read(file);
		const normalizedContent = removeBindingOnlyFrontmatterBeforeNextFrontmatter(rawContent);
		const contentWithoutBinding = removeLarkBinding(normalizedContent);
		const warnings: string[] = [];
		const binding = this.getBinding(file);
		const preserveCallouts =
			this.settings.nativeCalloutExport || !!this.nativeStateForDocument(binding?.token || binding?.url || "");
		const content = prepareNoteContentForLark(
			file,
			contentWithoutBinding,
			this.settings.titleSource,
			(warning) => warnings.push(warning),
			preserveCallouts
		);
		this.reportExportWarnings(file, warnings);
		const pdf = scanPdfCropReferences(content).length
			? await preparePdfCropImages({
					vaultRoot: this.getVaultRoot(),
					markdownPath: file.path,
					content,
					imageIndex: buildLocalMediaFileIndexFromPaths(
						this.app.vault.getFiles().map((file) => file.path),
						true
					),
					render: async (path, pageNumber, rect) => {
						const pdfjs = await loadPdfJs() as PdfJs;
						const task = pdfjs.getDocument({
							data: new Uint8Array(await readFile(path)),
							isEvalSupported: false
						});
						const document = await task.promise;
						try {
							const page = await document.getPage(pageNumber),
								viewport = page.getViewport({ scale: 2 });
							const region: [number, number, number, number] = rect
								? viewport.convertToViewportRectangle(rect)
								: [0, 0, viewport.width, viewport.height];
							const left = Math.min(region[0], region[2]),
								top = Math.min(region[1], region[3]);
							const width = Math.ceil(Math.abs(region[2] - region[0])),
								height = Math.ceil(Math.abs(region[3] - region[1]));
							if (
								left < 0 ||
								top < 0 ||
								left + width > viewport.width + 1 ||
								top + height > viewport.height + 1 ||
								width < 1 ||
								height < 1
							)
								throw new Error("PDF 裁剪区域超出页面边界");
							const canvas = createEl("canvas");
							canvas.width = width;
							canvas.height = height;
							const context = canvas.getContext("2d");
							if (!context) throw new Error("无法创建 PDF 渲染画布");
							await page.render({
								canvasContext: context,
								viewport,
								transform: [1, 0, 0, 1, -left, -top],
								background: "rgb(255,255,255)"
							}).promise;
							return Buffer.from(canvas.toDataURL("image/png").split(",")[1]!, "base64");
						} finally {
							await document.destroy();
						}
					}
				})
			: { content, images: [] };
		if (!scanLocalImageReferences(pdf.content).length) return pdf;
		const local = await prepareLocalImages({
			vaultRoot: this.getVaultRoot(),
			markdownPath: file.path,
			content: pdf.content,
			imageIndex: this.buildVaultMediaIndex()
		});
		return { content: local.content, images: [...pdf.images, ...local.images] };
	}

	private getVaultRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new LocalizedSyncError("本地媒体同步仅支持桌面端文件系统 vault。");
		}
		return adapter.getBasePath();
	}

	private getBinding(file: TFile): BoundLarkDocument | null {
		if (this.settings.disconnectedBindings?.[file.path]) return null;
		const savedBinding = this.settings.documentBindings?.[file.path];
		if (savedBinding?.token || savedBinding?.url) {
			return savedBinding;
		}
		const cache = this.app.metadataCache?.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) {
			return null;
		}

		const token = this.readFrontmatterString(frontmatter[FRONTMATTER_TOKEN_KEY]);
		const url = this.readFrontmatterString(frontmatter[FRONTMATTER_URL_KEY]);
		if (!token && !url) {
			return null;
		}

		return {
			token,
			url
		};
	}

	private readFrontmatterString(value: unknown): string {
		return typeof value === "string" ? value : "";
	}

	private async createLarkDocument(
		file: TFile,
		preparedContent: PreparedNoteContent,
		parent?: RemoteParent,
		onCreated?: (binding: BoundLarkDocument) => Promise<void>
	): Promise<BoundLarkDocument> {
		const title = extractTitle(file, preparedContent.content, "first-heading");
		const bodyContent = stripPreparedMarkdownTitle(preparedContent.content);
		const publishPlan = createStagedMarkdownPublishPlan(
			preparedContent.content,
			this.getStagedPublishOptions()
		);
		const native = this.settings.nativeCalloutExport && this.hasNativeCallouts(preparedContent.content);
		const initialBodyContent = native || publishPlan.staged ? "" : bodyContent;
		return await this.withTempMarkdown(file.basename, initialBodyContent, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--title", title, "--content", `@${tempFile.fileName}`, "--json"];

			const remoteParent = parent || await this.resolveRemoteRootParent();
			if (remoteParent.token) {
				args.push("--parent-token", remoteParent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			if (this.settings.pendingDocumentCreates?.[file.path]) {
				throw new LocalizedSyncError(this.settings.language === "en"
					? "A previous document creation has an uncertain result. Bind its existing URL or disconnect the pending local record before publishing again."
					: "上次上传结果尚未确认。请先设置已有飞书链接；确认未上传后，可移除链接记录再重试。");
			}
			(this.settings.pendingDocumentCreates ??= {})[file.path] = { title, startedAt: new Date().toISOString() };
			try { await this.saveSettingsWithoutClearingCommandCache(); }
			catch (error) { delete this.settings.pendingDocumentCreates[file.path]; throw error; }
			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const commandDocument = result.data?.["document"];
			const token = commandDocument?.document_id;
			const url = commandDocument?.url;

			if (!token || !url) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			const binding = {
				token,
				url,
				...(result.data?.wiki_node?.node_token ? { nodeToken: result.data.wiki_node.node_token } : {})
			};
			// Persist immediately: later content/image/state failures must reuse this document.
			await this.rememberDocumentBinding(file, this.withRemoteParentMetadata(
				binding, file.parent?.name || "", this.parentPath(file.path), remoteParent
			));
			await onCreated?.(binding);
			if (native) {
				await this.syncNativePreparedDocument(token, preparedContent, true);
				return binding;
			}
			if (publishPlan.staged) {
				await this.appendStagedDocumentBatches(token || url, publishPlan.batches);
			}
			await this.materializeLocalImages(token, preparedContent.images);
			return binding;
		});
	}

	private nativeStateForDocument(doc: string): NativeState | undefined {
		return this.settings.nativeCalloutStates?.[getDocumentStateKey(doc)];
	}

	private hasNativeCallouts(content: string): boolean {
		return /\[![\w-]+/.test(content) && prepareNativeCallouts(content).callouts.length > 0;
	}

	private async syncNativePreparedDocument(
		doc: string,
		prepared: PreparedNoteContent,
		creating = false,
		strategy = this.settings.syncStrategy
	): Promise<void> {
		const fetched = await this.fetchLarkDocumentWithIds(doc);
		const canonical =
			fetched.doc ||
			fetched.content.match(/<title\b[^>]*\bid="([A-Za-z0-9_-]+)"/)?.[1] ||
			getDocumentStateKey(doc);
		if (!canonical) throw new Error("无法解析原生折叠文档 ID");
		const previous = this.nativeStateForDocument(canonical);
		await syncNativeDocument(
			canonical,
			stripPreparedMarkdownTitle(prepared.content),
			{
				allowReplaceUntracked: creating || strategy !== "precise",
				labelColors: this.settings.researchLabelColors,
				images: prepared.images,
				uploadImage: async (blockId, image) => {
					const result = await this.runLarkCli(
						[
							"docs",
							"+media-upload",
							"--as",
							"user",
							"--doc-id",
							canonical,
							"--parent-type",
							"docx_image",
							"--parent-node",
							blockId,
							"--file",
							`./${basename(image.absolutePath)}`,
							"--json"
						],
						{ cwd: dirname(image.absolutePath) }
					);
					if (!result.data?.file_token) throw new Error("图片上传未返回 file_token");
					return result.data.file_token;
				},
				api: async (method, path, body, params) => {
					return await this.withTempMarkdown(
						"native-request",
						body === undefined ? "" : JSON.stringify(body),
						async (file) => {
							const args = ["api", method, path, "--as", "user", "--json"];
							if (body !== undefined) args.push("--data", `@${file.fileName}`);
							if (params) args.push("--params", JSON.stringify(params));
							const result = await this.runLarkCli(args, { cwd: file.directory });
							if (!result.ok || !result.data) throw new Error("原生块操作返回异常");
							return result.data;
						}
					);
				},
				save: async (state) => {
					(this.settings.nativeCalloutStates ??= {})[canonical] = state;
					const alias = getDocumentStateKey(doc);
					if (alias) this.settings.nativeCalloutStates[alias] = state;
					await this.saveSettingsWithoutClearingCommandCache();
				},
				materialize: async () => {
					await this.materializeLocalImages(
						canonical,
						prepared.images.filter((image) => image.mediaType === "video")
					);
				}
			},
			previous,
			extractTitle({ basename: "" }, prepared.content, "first-heading")
		);
	}

	private getStagedPublishOptions() {
		return {
			thresholdBytes: STAGED_PUBLISH_THRESHOLD_BYTES,
			thresholdUnits: STAGED_PUBLISH_THRESHOLD_UNITS,
			maxBatchBytes: STAGED_PUBLISH_MAX_BATCH_BYTES,
			maxBatchUnits: STAGED_PUBLISH_MAX_BATCH_UNITS
		};
	}

	private async appendStagedDocumentBatches(doc: string, batches: string[]): Promise<number | undefined> {
		if (batches.length === 0) {
			return undefined;
		}

		return await this.withTempMarkdown("staged-publish", "", async (tempFile) => {
			let revisionId: number | undefined;
			for (const [index, batch] of batches.entries()) {
				const contentFileName = await this.writeTempMarkdown(
					tempFile.directory,
					`staged-publish-${index}`,
					batch
				);
				const result = await this.runLarkCli(buildUpdateCommandArgs({
					doc,
					command: "block_insert_after",
					docFormat: "markdown",
					blockId: DOCUMENT_END_BLOCK_ID,
					contentFileName,
					revisionId
				}), { cwd: tempFile.directory });
				revisionId = result.data?.["document"]?.revision_id;
			}
			return revisionId;
		});
	}

	private async updateLarkDocument(
		doc: string,
		preparedContent: PreparedNoteContent,
		context: { mode: SyncMode; path: string; strategy?: SyncStrategy; stateKeys?: string[] }
	): Promise<Partial<BoundLarkDocument>> {
		const content = preparedContent.content;
		const strategy = context.strategy || this.settings.syncStrategy;
		if ((this.settings.nativeCalloutExport && this.hasNativeCallouts(content)) || this.nativeStateForDocument(doc)) {
			await this.syncNativePreparedDocument(doc, preparedContent, false, strategy);
			return {};
		}
		if (strategy !== "overwrite") {
			const resumedDocument = await this.tryResumeStagedDocumentPublish(doc, preparedContent, context);
			if (resumedDocument) {
				return resumedDocument;
			}
		}
		let state = this.findDocumentState([doc, ...(context.stateKeys || [])], doc);
		let syncDoc = state?.doc || doc;
		if (strategy !== "overwrite" && this.shouldRefreshPreciseSyncState(state)) {
			state = await this.tryBootstrapPreciseSyncState(syncDoc, context.stateKeys || [], content) || state;
			syncDoc = state?.doc || syncDoc;
		}
		syncDoc = state?.doc || syncDoc;
		const plan = await buildSyncPlan({
			doc: syncDoc,
			markdown: content,
			contentFileName: "sync.md",
			strategy,
			state
		});
		if (strategy !== "overwrite" && this.shouldRetryPlanWithRefreshedState(plan)) {
			const refreshedState = await this.tryBootstrapPreciseSyncState(syncDoc, context.stateKeys || [], content);
			if (refreshedState) {
				const refreshedPlan = await buildSyncPlan({
					doc: refreshedState.doc,
					markdown: content,
					contentFileName: "sync.md",
					strategy,
					state: refreshedState
				});
				if (refreshedPlan.mode !== "blocked") {
					return await this.executeSyncPlan(refreshedState.doc, preparedContent, refreshedPlan, {
						...context,
						previousRevisionId: refreshedState.revisionId
					});
				}
			}
		}

		return await this.executeSyncPlan(syncDoc, preparedContent, plan, {
			...context,
			previousRevisionId: state?.revisionId
		});
	}

	private async tryResumeStagedDocumentPublish(
		doc: string,
		preparedContent: PreparedNoteContent,
		context: { mode: SyncMode; path: string; stateKeys?: string[] }
	): Promise<LarkDocumentUpdateResult | null> {
		const state = this.findDocumentState([doc, ...(context.stateKeys || [])], doc);
		if (state && isDocumentStateBlockMappingAcceptable(state)) {
			return null;
		}

		const initialPlan = createStagedMarkdownPublishPlan(
			preparedContent.content,
			this.getStagedPublishOptions()
		);
		if (!initialPlan.staged) {
			return null;
		}

		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		const resumePlan = createStagedMarkdownPublishPlan(
			preparedContent.content,
			this.getStagedPublishOptions(),
			remoteMarkdown.content
		);
		if (!resumePlan.resumable) {
			return null;
		}

		let revisionId = remoteMarkdown.revisionId;
		if (resumePlan.batches.length > 0) {
			revisionId = await this.appendStagedDocumentBatches(doc, resumePlan.batches) ?? revisionId;
		}
		const mediaSnapshot = await this.materializeLocalImages(doc, preparedContent.images);
		revisionId = mediaSnapshot?.revisionId ?? revisionId;
		await this.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
			doc,
			context.stateKeys || [],
			preparedContent.content,
			revisionId,
			context
		);
		return { revisionId };
	}

	private shouldRetryPlanWithRefreshedState(plan: SyncPlan): boolean {
		if (plan.mode === "blocked" || plan.mode === "overwrite") {
			return true;
		}

		return plan.mode === "precise" && plan.commands.some((command) => {
			return command.command === "block_insert_after"
				&& !this.isBlockDeletedByPlan(plan.commands, command.blockId);
		});
	}

	private isBlockDeletedByPlan(commands: SyncPlan["commands"], blockId: string): boolean {
		return commands.some((command) => {
			return command.command === "block_delete"
				&& command.blockId.split(",").includes(blockId);
		});
	}

	private shouldRefreshPreciseSyncState(state: LarkSyncStateFile["documents"][string] | undefined): boolean {
		return !state || !isDocumentStateBlockMappingAcceptable(state);
	}

	private findDocumentState(docs: string[], canonicalDoc = ""): LarkSyncStateFile["documents"][string] | undefined {
		for (const key of getDocumentStateKeys(docs)) {
			const state = this.syncState.documents[key];
			if (state && (!canonicalDoc || canonicalDoc.includes("/wiki/")
				|| getDocumentStateKey(state.doc) === getDocumentStateKey(canonicalDoc))) {
				return state;
			}
		}

		return undefined;
	}

	private async executeSyncPlan(
		doc: string,
		preparedContent: PreparedNoteContent,
		plan: SyncPlan,
		context: { mode: SyncMode; path: string; stateKeys?: string[]; previousRevisionId?: number }
	): Promise<Partial<BoundLarkDocument>> {
		const content = preparedContent.content;
		if (plan.mode === "skipped") {
			if (preparedContent.images.length > 0) {
				const mediaSnapshot = await this.materializeLocalImages(doc, preparedContent.images);
				await this.saveRemoteDocumentState(doc, context.stateKeys || [], {
					expectedMarkdown: content,
					expectedRevisionId: mediaSnapshot?.revisionId,
					allowRemoteChanges: true,
					context,
					refreshPolicy: this.getRemoteStateRefreshPolicy(context.mode)
				});
				return {};
			}
			return await this.executeSkippedSyncPlan(doc, content, plan, context);
		}

		if (plan.mode === "blocked") {
			await this.ensureRemoteDocumentExists(doc);
			throw new LocalizedSyncError(this.formatSyncFailure(context.mode, context.path, plan.reason));
		}

		return await this.withTempMarkdown("sync", content, async (tempFile) => {
			let latestDocument: LarkDocumentUpdateResult = {};
			let nextRevisionId = context.previousRevisionId;
			if (plan.mode === "overwrite") {
				this.removeSyncStateKeys([doc, ...(context.stateKeys || [])], doc);
				await this.saveLarkSyncState();
			}
			for (const [index, command] of plan.commands.entries()) {
				const contentFileName = command.command === "overwrite"
					? await this.writeTempMarkdown(tempFile.directory, `sync-${index}`, prepareOverwriteMarkdownContent(content))
					: "content" in command && command.content
					? await this.writeTempMarkdown(tempFile.directory, `sync-${index}`, command.content)
					: tempFile.fileName;
				const commandRevisionId = plan.mode === "precise" ? nextRevisionId : undefined;
				const commandWithContent = "contentFileName" in command
					? { ...command, doc, contentFileName }
					: { ...command, doc };
				const commandWithRevision = commandRevisionId === undefined
					? commandWithContent
					: { ...commandWithContent, revisionId: commandRevisionId };
				const commandArgs = buildUpdateCommandArgs(commandWithRevision);
				const result = await this.runLarkCli(commandArgs, {
					cwd: tempFile.directory
				});
				const commandDocument = result.data?.["document"];
				nextRevisionId = commandDocument?.revision_id;
				latestDocument = {
					token: commandDocument?.document_id || latestDocument.token,
					url: commandDocument?.url || latestDocument.url,
					revisionId: commandDocument?.revision_id ?? latestDocument.revisionId
				};
			}

			const mediaSnapshot = await this.materializeLocalImages(doc, preparedContent.images);
			if (mediaSnapshot?.revisionId !== undefined) {
				latestDocument.revisionId = mediaSnapshot.revisionId;
				nextRevisionId = mediaSnapshot.revisionId;
			}

			if (plan.mode === "precise") {
				await this.saveRemoteDocumentState(doc, context.stateKeys || [], {
					expectedMarkdown: content,
					expectedRevisionId: latestDocument.revisionId,
					allowRemoteChanges: true,
					updateSubmitted: true,
					context,
					refreshPolicy: this.getRemoteStateRefreshPolicy(context.mode)
				});
			} else if (plan.mode === "overwrite") {
				await this.saveOverwrittenDocumentState(
					doc,
					latestDocument,
					content,
					context
				);
			} else {
				await this.saveSyncPlanStateForDocument(doc, latestDocument, plan, context.stateKeys || []);
			}
			return latestDocument;
		});
	}

	private async saveSyncPlanStateForDocument(
		doc: string,
		document: Partial<BoundLarkDocument>,
		plan: SyncPlan,
		extraKeys: string[]
	): Promise<void> {
		await this.saveSyncPlanState(doc, plan);
		if (document.token || document.url) {
			this.removeSyncStateKeys([doc, document.token || "", document.url || "", ...extraKeys], doc);
			await this.saveLarkSyncState();
		}
	}

	private async saveSyncPlanState(doc: string, plan: SyncPlan): Promise<void> {
		if (plan.mode === "blocked") {
			return;
		}

		const nextState = this.getCompletePlanNextState(plan);
		if (!nextState) {
			return;
		}

		const stateKey = getDocumentStateKey(doc);
		this.setDocumentSyncState(stateKey, {
			...touchDocumentSyncState(nextState),
			doc: stateKey
		});
		await this.saveLarkSyncState();
	}

	private async saveOverwrittenDocumentState(
		doc: string,
		document: LarkDocumentUpdateResult,
		expectedMarkdown: string,
		context: { mode: SyncMode; path: string; stateKeys?: string[] }
	): Promise<void> {
		const resolvedDoc = document.token || document.url || doc;
		const stateKeys = [doc, document.token || "", document.url || "", ...(context.stateKeys || [])];
		await this.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
			resolvedDoc,
			stateKeys,
			expectedMarkdown,
			document.revisionId,
			context
		);
	}

	private async saveCreatedDocumentState(binding: BoundLarkDocument): Promise<void> {
		const remoteDoc = binding.token || binding.url;
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(remoteDoc),
			this.fetchLarkDocumentWithIds(remoteDoc)
		]);
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [remoteDoc, binding.token, binding.url]);
	}

	private async saveCreatedDocumentStateFromBaseline(
		binding: BoundLarkDocument,
		baselineMarkdown?: string
	): Promise<void> {
		if (this.nativeStateForDocument(binding.token || binding.url)
			|| (this.settings.nativeCalloutExport && baselineMarkdown && this.hasNativeCallouts(baselineMarkdown))) return;
		if (baselineMarkdown !== undefined) {
			await this.saveSyncStateFromBaselineAndRemoteIds(binding, baselineMarkdown);
			return;
		}

		const doc = binding.token || binding.url;
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [doc, binding.token, binding.url], baselineMarkdown);
	}

	private async saveSyncStateFromBaselineAndRemoteIds(
		binding: BoundLarkDocument,
		baselineMarkdown: string
	): Promise<void> {
		const doc = binding.token || binding.url;
		const remoteXml = await this.fetchLarkDocumentWithIds(doc);
		const remoteMarkdown = {
			doc: remoteXml.doc,
			content: baselineMarkdown,
			revisionId: remoteXml.revisionId
		};
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [doc, binding.token, binding.url], baselineMarkdown);
	}

	private async saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
		doc: string,
		stateKeys: string[],
		baselineMarkdown: string,
		expectedRevisionId: number | undefined,
		context: { mode: SyncMode; path: string }
	): Promise<void> {
		const refreshPolicy = this.getRemoteStateRefreshPolicy(context.mode);
		const expectedSignature = await createSyncContentSignature(baselineMarkdown);
		let lastDiagnostic: RemoteStateRefreshDiagnostic | undefined;
		for (let attempt = 0; attempt < refreshPolicy.attempts; attempt += 1) {
			const remoteXml = await this.fetchLarkDocumentWithIds(doc);
			if (expectedRevisionId !== undefined
				&& (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId)) {
				lastDiagnostic = {
					rejectReason: "revision-lag",
					observedRevisionId: remoteXml.revisionId
				};
				if (attempt < refreshPolicy.attempts - 1) {
					await this.sleep(refreshPolicy.delayMs);
				}
				continue;
			}

			const hasLocalImages = containsLocalImagePlaceholders(baselineMarkdown);
			const isExpectedContentVisible = hasLocalImages
				? await isRemoteXmlContentEquivalent(remoteXml.content, baselineMarkdown)
				: await this.isRemoteMarkdownContentEquivalent(
					(await this.fetchLarkDocumentMarkdown(doc)).content,
					expectedSignature
				);
			if (!isExpectedContentVisible) {
				lastDiagnostic = {
					rejectReason: "content-not-equivalent",
					observedRevisionId: remoteXml.revisionId
				};
				if (attempt < refreshPolicy.attempts - 1) {
					await this.sleep(refreshPolicy.delayMs);
				}
				continue;
			}

			const stateMarkdown = {
				doc: remoteXml.doc,
				content: baselineMarkdown,
				revisionId: remoteXml.revisionId
			};
			const state = await this.createRemoteDocumentState(doc, stateMarkdown, remoteXml, baselineMarkdown);
			if (isDocumentStateBlockMappingAcceptable(state)) {
				await this.persistDocumentState(state, [doc, ...stateKeys]);
				return;
			}
			lastDiagnostic = this.createBlockMappingDiagnostic(state);

			if (attempt < refreshPolicy.attempts - 1) {
				await this.sleep(refreshPolicy.delayMs);
			}
		}

		this.logRemoteStateRefreshTimeout(doc, refreshPolicy.attempts, expectedRevisionId, lastDiagnostic);
		throw new RemoteStateRefreshError(
			this.formatSyncFailure(context.mode, context.path, "remote-update-not-visible"),
			true
		);
	}

	private async saveRemoteDocumentStateFromFetched(
		remoteMarkdown: { doc?: string; content: string; revisionId?: number },
		remoteXml: { doc?: string; content: string; revisionId?: number },
		stateKeys: Array<string | undefined>,
		baselineMarkdown?: string
	): Promise<void> {
		const remoteDoc = remoteXml.doc || remoteMarkdown.doc || stateKeys.find((key) => key) || "";
		const effectiveMarkdown = baselineMarkdown || remoteMarkdown.content;
		const state = await createDocumentSyncStateFromRemote(
			remoteDoc,
			effectiveMarkdown,
			remoteXml.content,
			remoteXml.revisionId ?? remoteMarkdown.revisionId
		);
		await this.persistDocumentState(state, stateKeys.filter((key): key is string => Boolean(key)));
	}

	private removeSyncStateKeys(docs: string[], keepDoc: string): void {
		const keepKey = getDocumentStateKey(keepDoc);
		for (const key of getDocumentStateKeys(docs)) {
			if (key !== keepKey) {
				this.deleteDocumentSyncStateKey(key);
			}
		}
	}

	private async saveRemoteDocumentState(
		doc: string,
		stateKeys: string[],
		options: {
			expectedMarkdown?: string;
			expectedRevisionId?: number;
			previousRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
			allowIncompleteFallback?: boolean;
			allowRemoteChanges?: boolean;
			updateSubmitted?: boolean;
			refreshPolicy?: RemoteStateRefreshPolicy;
			context?: { mode: SyncMode; path: string };
		} = {}
	): Promise<void> {
		const refreshPolicy = options.refreshPolicy || STRICT_REMOTE_STATE_REFRESH_POLICY;
		const expectedSignature = options.expectedMarkdown
			? await createSyncContentSignature(options.expectedMarkdown)
			: undefined;
		let state: LarkSyncStateFile["documents"][string] | undefined;
		let latestState: LarkSyncStateFile["documents"][string] | undefined;
		let lastDiagnostic: RemoteStateRefreshDiagnostic | undefined;
		const captureDiagnostic = (diagnostic: RemoteStateRefreshDiagnostic): void => {
			lastDiagnostic = diagnostic;
		};
		for (let attempt = 0; attempt < refreshPolicy.attempts; attempt += 1) {
			const remoteState = options.expectedRevisionId !== undefined
				? await this.fetchRemoteDocumentStateAfterExpectedRevision(
					doc,
					options.expectedRevisionId,
					expectedSignature,
					options.expectedMarkdown,
					options.allowRemoteChanges,
					captureDiagnostic
				)
				: await this.fetchRemoteDocumentState(
					doc,
					options.expectedMarkdown,
					options.allowRemoteChanges
				);
			latestState = remoteState;
			if (remoteState
				&& this.isRemoteDocumentStateRefreshAccepted(remoteState, expectedSignature, options.previousRevisionId)) {
				state = remoteState;
				break;
			}
			if (remoteState) {
				lastDiagnostic = {
					rejectReason: "content-not-equivalent",
					observedRevisionId: remoteState.revisionId
				};
			} else if (options.expectedRevisionId === undefined) {
				lastDiagnostic = { rejectReason: "state-not-accepted" };
			}

			if (attempt < refreshPolicy.attempts - 1) {
				await this.sleep(refreshPolicy.delayMs);
			}
		}

		if (!state && refreshPolicy.allowTimeoutFallback && !options.expectedMarkdown) {
			state = this.firstCompleteSyncState([latestState]);
			if (!state) {
				const refreshedState = await this.fetchRemoteDocumentState(doc);
				state = this.firstCompleteSyncState([refreshedState]);
			}
		}
		if (!state && options.allowIncompleteFallback) {
			state = await this.selectIncompleteFallbackState(doc, latestState, options);
		}
		if (state && options.allowIncompleteFallback && state.units.length === 0 && options.fallbackMarkdown) {
			state = await this.createIncompleteFallbackState(doc, {
				...options,
				fallbackState: state
			});
		}

		if (!state) {
			if (options.context) {
				this.logRemoteStateRefreshTimeout(
					doc,
					refreshPolicy.attempts,
					options.expectedRevisionId,
					lastDiagnostic
				);
				throw new RemoteStateRefreshError(
					this.formatSyncFailure(options.context.mode, options.context.path, "remote-update-not-visible"),
					options.updateSubmitted === true
				);
			}
			return;
		}

		await this.persistDocumentState(state, [doc, ...stateKeys]);
	}

	private async selectIncompleteFallbackState(
		doc: string,
		latestState: LarkSyncStateFile["documents"][string] | undefined,
		options: {
			expectedRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
		}
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (latestState && latestState.units.length > 0) {
			return latestState;
		}

		return await this.createIncompleteFallbackState(doc, {
			...options,
			fallbackState: latestState || options.fallbackState
		});
	}

	private async createIncompleteFallbackState(
		doc: string,
		options: {
			expectedRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
		}
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (this.isCompleteSyncState(options.fallbackState) || !options.fallbackMarkdown) {
			return options.fallbackState;
		}

		return await createIncompleteDocumentSyncStateFromMarkdown(
			doc,
			options.fallbackMarkdown,
			options.expectedRevisionId ?? options.fallbackState?.revisionId
		);
	}

	private async fetchRemoteDocumentStateAfterExpectedRevision(
		doc: string,
		expectedRevisionId: number,
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>> | undefined,
		expectedMarkdown?: string,
		allowRemoteChanges = false,
		captureDiagnostic?: (diagnostic: RemoteStateRefreshDiagnostic) => void
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		const remoteXml = await this.fetchLarkDocumentWithIds(doc);
		if (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId) {
			captureDiagnostic?.({
				rejectReason: "revision-lag",
				observedRevisionId: remoteXml.revisionId
			});
			return undefined;
		}
		if (allowRemoteChanges && expectedMarkdown) {
			const state = await this.createRemoteDocumentState(
				doc,
				{ doc: remoteXml.doc, content: expectedMarkdown, revisionId: remoteXml.revisionId },
				remoteXml,
				expectedMarkdown
			);
			if (!isDocumentStateBlockMappingAcceptable(state)) {
				captureDiagnostic?.(this.createBlockMappingDiagnostic(state));
				return undefined;
			}
			return state;
		}

		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		if (remoteMarkdown.revisionId !== undefined && remoteMarkdown.revisionId < expectedRevisionId) {
			captureDiagnostic?.({
				rejectReason: "revision-lag",
				observedRevisionId: remoteMarkdown.revisionId
			});
			return undefined;
		}

		if (expectedMarkdown && expectedSignature) {
			const isExpectedContentVisible = await this.isRemoteMarkdownContentEquivalent(
				remoteMarkdown.content,
				expectedSignature
			);
			if (!isExpectedContentVisible) {
				captureDiagnostic?.({
					rejectReason: "content-not-equivalent",
					observedRevisionId: remoteXml.revisionId
				});
				return undefined;
			}
		}

		const state = await this.createRemoteDocumentState(doc, remoteMarkdown, remoteXml, expectedMarkdown);
		if (expectedMarkdown && !isDocumentStateBlockMappingAcceptable(state)) {
			captureDiagnostic?.(this.createBlockMappingDiagnostic(state));
			return undefined;
		}

		return state;
	}

	private async fetchRemoteDocumentState(
		doc: string,
		baselineMarkdown?: string,
		allowRemoteChanges = false
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (allowRemoteChanges && baselineMarkdown) {
			const remoteXml = await this.fetchLarkDocumentWithIds(doc);
			const state = await this.createRemoteDocumentState(
				doc,
				{ doc: remoteXml.doc, content: baselineMarkdown, revisionId: remoteXml.revisionId },
				remoteXml,
				baselineMarkdown
			);
			return isDocumentStateBlockMappingAcceptable(state) ? state : undefined;
		}

		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		if (baselineMarkdown) {
			const expectedSignature = await createSyncContentSignature(baselineMarkdown);
			if (!await this.isRemoteMarkdownContentEquivalent(remoteMarkdown.content, expectedSignature)) {
				return undefined;
			}
		}

		const state = await this.createRemoteDocumentState(doc, remoteMarkdown, remoteXml, baselineMarkdown);
		if (baselineMarkdown && !isDocumentStateBlockMappingAcceptable(state)) {
			return undefined;
		}

		return state;
	}

	private async createRemoteDocumentState(
		doc: string,
		remoteMarkdown: { doc?: string; content: string; revisionId?: number },
		remoteXml: { doc?: string; content: string; revisionId?: number },
		baselineMarkdown?: string
	): Promise<LarkSyncStateFile["documents"][string]> {
		const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
		return await createDocumentSyncStateFromRemote(
			remoteDoc,
			baselineMarkdown || remoteMarkdown.content,
			remoteXml.content,
			remoteXml.revisionId ?? remoteMarkdown.revisionId
		);
	}

	private async isRemoteMarkdownContentEquivalent(
		remoteMarkdown: string,
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>>
	): Promise<boolean> {
		return isExportedMarkdownContentEquivalent(remoteMarkdown, expectedSignature);
	}

	private isRemoteDocumentStateRefreshAccepted(
		remoteState: LarkSyncStateFile["documents"][string],
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>> | undefined,
		previousRevisionId: number | undefined
	): boolean {
		if (expectedSignature) {
			return isDocumentStateContentEquivalent(remoteState, expectedSignature);
		}

		if (previousRevisionId !== undefined) {
			return remoteState.revisionId !== undefined && remoteState.revisionId !== previousRevisionId;
		}

		return true;
	}

	private createBlockMappingDiagnostic(
		state: LarkSyncStateFile["documents"][string]
	): RemoteStateRefreshDiagnostic {
		return {
			rejectReason: "block-mapping-incomplete",
			observedRevisionId: state.revisionId,
			unitCount: state.units.length,
			missingBlockIdCount: state.units.filter((unit) => !unit.blockId).length
		};
	}

	private logRemoteStateRefreshTimeout(
		doc: string,
		attempts: number,
		expectedRevisionId: number | undefined,
		diagnostic: RemoteStateRefreshDiagnostic | undefined
	): void {
		console.warn("[Feishu Docs Publisher] remote state confirmation timed out", {
			doc: extractDocumentToken(doc) || doc,
			attempts,
			expectedRevisionId,
			observedRevisionId: diagnostic?.observedRevisionId,
			unitCount: diagnostic?.unitCount,
			missingBlockIdCount: diagnostic?.missingBlockIdCount,
			rejectReason: diagnostic?.rejectReason || "unknown"
		});
	}

	private getPlanNextState(plan: SyncPlan): LarkSyncStateFile["documents"][string] | undefined {
		if (!("nextState" in plan)) {
			return undefined;
		}

		return plan.nextState;
	}

	private getCompletePlanNextState(plan: SyncPlan): LarkSyncStateFile["documents"][string] | undefined {
		const nextState = this.getPlanNextState(plan);
		if (!this.isCompleteSyncState(nextState)) {
			return undefined;
		}

		return nextState;
	}

	private firstCompleteSyncState(
		states: Array<LarkSyncStateFile["documents"][string] | undefined>
	): LarkSyncStateFile["documents"][string] | undefined {
		return states.find((state) => this.isCompleteSyncState(state));
	}

	private isCompleteSyncState(state: LarkSyncStateFile["documents"][string] | undefined): boolean {
		if (!state) {
			return false;
		}

		return state.units.length > 0
			&& state.units.every((unit) => Boolean(unit.blockId));
	}

	private getRemoteStateRefreshPolicy(mode: SyncMode): RemoteStateRefreshPolicy {
		if (mode === "save") {
			return SAVE_REMOTE_STATE_REFRESH_POLICY;
		}

		return STRICT_REMOTE_STATE_REFRESH_POLICY;
	}

	private async persistDocumentState(
		state: LarkSyncStateFile["documents"][string],
		aliases: string[]
	): Promise<void> {
		const stateKey = getDocumentStateKey(state.doc);
		this.setDocumentSyncState(stateKey, {
			...touchDocumentSyncState(state),
			doc: stateKey
		});
		this.removeSyncStateKeys(aliases, stateKey);
		await this.saveLarkSyncState();
	}

	private async tryBootstrapPreciseSyncState(
		doc: string,
		stateKeys: string[],
		expectedMarkdown?: string
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
		const existingState = this.findDocumentState([remoteDoc, doc, ...stateKeys], remoteDoc);
		if (existingState
			&& existingState.revisionId !== undefined
			&& existingState.revisionId === remoteXml.revisionId
			&& isDocumentStateBlockMappingAcceptable(existingState)) {
			await this.persistDocumentState(existingState, [doc, remoteDoc, ...stateKeys]);
			return existingState;
		}
		const baselineMarkdown = expectedMarkdown && containsLocalImagePlaceholders(expectedMarkdown)
			? expectedMarkdown
			: remoteMarkdown?.content || expectedMarkdown || "";
		let state = await createDocumentSyncStateFromRemote(
			remoteDoc,
			baselineMarkdown,
			remoteXml.content,
			remoteXml.revisionId
		);
		if (expectedMarkdown && containsLocalImagePlaceholders(expectedMarkdown)) {
			state = invalidateLocalImageSyncState(state);
		}
		if (isDocumentStateBlockMappingAcceptable(state)) {
			await this.persistDocumentState(state, [doc, remoteDoc, ...stateKeys]);
			return state;
		}
		return undefined;
	}

	private async fetchLarkDocumentMarkdown(doc: string): Promise<{ doc?: string; content: string; revisionId?: number }> {
		const result = await this.runLarkCli([
			"docs",
			"+fetch",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc",
			doc,
			"--doc-format",
			"markdown",
			"--json"
		]);
		return {
			doc: result.data?.["document"]?.document_id,
			content: result.data?.["document"]?.content || "",
			revisionId: result.data?.["document"]?.revision_id
		};
	}

	private async fetchLarkDocumentWithIds(doc: string): Promise<{ doc?: string; content: string; revisionId?: number }> {
		const result = await this.runLarkCli([
			"docs",
			"+fetch",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc",
			doc,
			"--detail",
			"with-ids",
			"--json"
		]);
		return {
			doc: result.data?.["document"]?.document_id,
			content: result.data?.["document"]?.content || "",
			revisionId: result.data?.["document"]?.revision_id
		};
	}

	private async materializeLocalImages(
		doc: string,
		images: LocalImageResource[]
	): Promise<{ content: string; revisionId?: number } | undefined> {
		return await materializePreparedLocalImages(images, {
			uploadJournal: images.length > 0
				? createMediaUploadJournal(join(this.getPluginDirectoryPath(), "media-uploads"), getDocumentStateKey(doc))
				: undefined,
			fetchRemoteWithIds: async () => {
				const remote = await this.fetchLarkDocumentWithIds(doc);
				return { content: remote.content, revisionId: remote.revisionId };
			},
			insertImage: async (image) => {
				const result = await this.runLarkCli(buildMediaInsertArgs(doc, image), {
					cwd: dirname(image.absolutePath)
				});
				const blockId = result.data?.block_id || result.data?.document?.new_blocks?.[0]?.block_id;
				if (!blockId) {
					throw new Error(`${image.mediaType === "video" ? "视频" : "图片"}上传后未返回 block id：${image.vaultPath}`);
				}
				return { blockId };
			},
			moveBlockAfter: async (blockId, targetBlockId) => {
				await this.runLarkCli(buildMediaMoveArgs(doc, blockId, targetBlockId));
			},
			deleteBlock: async (blockId, revisionId) => {
				const args = buildUpdateCommandArgs({
					doc,
					command: "block_delete",
					blockId,
					revisionId
				});
				await this.runLarkCli(args);
			},
			removePlaceholder: async (placeholder, revisionId) => {
				await this.runLarkCli(buildPlaceholderRemoveArgs(doc, placeholder, revisionId));
			}
		});
	}

	private async fetchLarkDocumentRevisionId(doc: string): Promise<number | undefined> {
		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		return remoteMarkdown.revisionId;
	}

	private async sleep(ms: number): Promise<void> {
		await new Promise((resolvePromise) => window.setTimeout(resolvePromise, ms));
	}

	private formatSyncFailure(mode: SyncMode, path: string, reason: SyncFailureReason): string {
		return formatSyncFailureMessage({
			language: this.settings.language,
			mode,
			path,
			reason
		});
	}

	private async ensureRemoteDocumentExists(doc: string): Promise<void> {
		const args = ["drive", "+inspect", "--as", "user", "--url", doc, "--json"];
		if (!/^https?:\/\//.test(doc)) {
			args.push("--type", "docx");
		}

		await this.runLarkCli(args);
	}

	private async executeSkippedSyncPlan(
		doc: string,
		content: string,
		plan: SyncPlan,
		context: { mode: SyncMode; path: string; stateKeys?: string[]; previousRevisionId?: number }
	): Promise<Partial<BoundLarkDocument>> {
		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		const [remoteSignature, expectedSignature] = await Promise.all([
			createSyncContentSignature(remoteMarkdown.content),
			createSyncContentSignature(content)
		]);
		if (isSyncContentSignatureEquivalent(remoteSignature, expectedSignature)) {
			const nextState = this.getPlanNextState(plan);
			const refreshedPlan = nextState && remoteMarkdown.revisionId !== undefined
				? { ...plan, nextState: { ...nextState, revisionId: remoteMarkdown.revisionId } }
				: plan;
			await this.saveSyncPlanStateForDocument(doc, {}, refreshedPlan, context.stateKeys || []);
			return {};
		}

		await this.saveRemoteDocumentState(doc, context.stateKeys || [], {
			expectedMarkdown: content,
			expectedRevisionId: remoteMarkdown.revisionId,
			allowRemoteChanges: true,
			context,
			refreshPolicy: this.getRemoteStateRefreshPolicy(context.mode)
		});
		return {};
	}

	private async syncOrRecreateDocument(
		file: TFile,
		binding: BoundLarkDocument,
		preparedContent: PreparedNoteContent,
		parent: RemoteParent | undefined,
		options: SyncOrRecreateOptions
	): Promise<BoundLarkDocument> {
		binding = await this.resolveExclusiveRemoteBinding(file.path, binding);
		try {
			const result = await this.updateLarkDocument(binding.token || binding.url, preparedContent, {
				mode: options.mode,
				path: options.path,
				strategy: options.strategy,
				stateKeys: options.stateKeys
			});

			return {
				...binding,
				token: result.token || binding.token,
				url: result.url || binding.url
			};
		} catch (error) {
			if (!this.isRemoteDocumentDeletedError(error)) {
				throw error;
			}

			if (!options.allowRecreate) {
				throw error;
			}

			if (options.showRemoteDeletedNotice) {
				new Notice(this.t("noticeRemoteDeletedRecreate"), 5000);
			}
			const persistRecreatedBinding = options.updateFrontmatter
				? async (createdBinding: BoundLarkDocument): Promise<void> => {
					await this.writeBinding(file, createdBinding);
				}
				: undefined;
			const recreatedBinding = await this.createLarkDocument(
				file,
				preparedContent,
				parent,
				persistRecreatedBinding
			);
			this.removeSyncStateForBinding(binding);
			await this.saveCreatedDocumentStateFromBaseline(recreatedBinding, preparedContent.content);
			return recreatedBinding;
		}
	}

	private async resolveFolderBinding(
		file: TFile,
		binding: BoundLarkDocument,
		preparedContent: PreparedNoteContent,
		parent: RemoteParent
	): Promise<BoundLarkDocument> {
		try {
			await this.ensureRemoteDocumentExists(binding.token || binding.url);
			return binding;
		} catch (error) {
			if (!this.isRemoteDocumentDeletedError(error)) {
				throw error;
			}

			const persistRecreatedBinding = this.settings.updateFrontmatter
				? async (createdBinding: BoundLarkDocument): Promise<void> => {
					await this.writeBinding(file, createdBinding);
				}
				: undefined;
			const recreatedBinding = await this.createLarkDocument(
				file,
				preparedContent,
				parent,
				persistRecreatedBinding
			);
			this.removeSyncStateForBinding(binding);
			await this.saveCreatedDocumentStateFromBaseline(recreatedBinding, preparedContent.content);
			return recreatedBinding;
		}
	}

	private hasBindingChanged(previous: BoundLarkDocument | null | undefined, next: BoundLarkDocument): boolean {
		return Boolean(previous)
			&& (previous?.token !== next.token || previous.url !== next.url);
	}

	private shouldWriteBinding(
		previous: BoundLarkDocument | null | undefined,
		next: BoundLarkDocument,
		updateFrontmatter: boolean
	): boolean {
		if (this.hasBindingChanged(previous, next)) {
			return true;
		}

		if (!updateFrontmatter) {
			return !previous || previous.containerToken !== next.containerToken
				|| previous.containerKind !== next.containerKind
				|| previous.remoteRoot !== next.remoteRoot
				|| previous.remoteParentPath !== next.remoteParentPath;
		}

		return !previous
			|| previous.url !== next.url
			|| Boolean(previous.token)
			|| previous.remoteRoot !== next.remoteRoot
			|| previous.remoteParentPath !== next.remoteParentPath;
	}

	private removeSyncStateForBinding(binding: BoundLarkDocument): void {
		this.removeSyncStateForDocuments(this.getBindingAliases(binding));
	}

	private removeSyncStateForDocuments(docs: string[]): void {
		const keys = uniquePathEntries([...docs, ...getDocumentStateKeys(docs)]);
		for (const key of keys) {
			this.deleteDocumentSyncStateKey(key);
		}
	}

	private getBindingAliases(binding: BoundLarkDocument): string[] {
		return uniquePathEntries([
			binding.token,
			binding.nodeToken || "",
			binding.url,
			binding.url ? extractDocumentToken(binding.url) : ""
		]);
	}

	private toLinkTarget(file: TFile, binding: BoundLarkDocument): LinkTarget {
		return {
			token: binding.token,
			url: binding.url,
			label: file.basename
		};
	}

	private rewriteInternalLinks(content: string, linkMap: Map<string, LinkTarget>, currentFile: TFile): string {
		return this.rewritePublishedPdfReferences(currentFile, rewriteInternalLinks(content, linkMap, currentFile));
	}

	private rewritePublishedPdfReferences(file: TFile, content: string): string {
		const targets = buildPublishedPdfTargets(this.settings.pdfBindings, this.settings.disconnectedFolders);
		const metadata = this.app.metadataCache;
		const warnings: string[] = [];
		const result = rewritePublishedPdfLinks(content, targets, file, metadata?.getFirstLinkpathDest
			? (target, source) => metadata.getFirstLinkpathDest(target, source)?.path ?? null
			: undefined, (warning) => warnings.push(warning));
		this.reportExportWarnings(file, warnings);
		return result;
	}

	private reportExportWarnings(file: TFile, warnings: string[]): void {
		if (!warnings.length) return;
		console.warn(`[Feishu export] ${file.path}`, [...new Set(warnings)]);
		if (warnings.some((warning) => warning.startsWith("PDF 未解析"))) {
			new Notice(`${file.path}：有 PDF 尚未发布或绑定，已保留可读引用。详情见开发者控制台。`, 10000);
		}
	}

	private rewritePublishedFolderInternalLinks(file: TFile, content: string): string {
		content = this.rewritePublishedPdfReferences(file, content);
		if (!mayContainInternalLinks(content)) {
			return content;
		}

		const publishedFolder = this.findExplicitPublishedFolderForFile(file);
		if (!publishedFolder) {
			return content;
		}

		const linkEntries: FolderLinkMapEntry[] = [];
		for (const linkedFile of this.collectMarkdownFiles(publishedFolder.folderPath)) {
			const binding = this.getBinding(linkedFile);
			if (binding) {
				linkEntries.push({
					file: linkedFile,
					target: this.toLinkTarget(linkedFile, binding)
				});
			}
		}

		const linkMap = createFolderLinkMap(publishedFolder.folderPath, linkEntries);
		return this.rewriteInternalLinks(content, linkMap, file);
	}

	private findExplicitPublishedFolderForFile(file: TFile): PublishedFolderResolution | null {
		if (this.isFolderDisconnected(file.path)) return null;
		let folderPath = this.parentPath(file.path);
		while (folderPath) {
			const normalizedFolderPath = this.normalizeLinkPath(folderPath);
			const binding = this.settings.publishedFolders[normalizedFolderPath];
			if (binding) {
				return {
					folderPath,
					binding,
					inferred: false
				};
			}

			folderPath = this.parentPath(folderPath);
		}

		return null;
	}

	private resolveInternalLink(target: string, linkMap: Map<string, LinkTarget>, currentFile: TFile): LinkTarget | null {
		return resolveInternalLink(target, linkMap, currentFile);
	}

	private normalizeLinkPath(path: string): string {
		return normalizeLinkPath(path);
	}

	private countPathSegments(path: string): number {
		return this.normalizeLinkPath(path).split("/").filter(Boolean).length;
	}

	private parentPath(path: string): string {
		return parentPath(path);
	}

	private async resolvePublishedFolderParentForFile(file: TFile): Promise<FolderDocumentParent | null> {
		const publishedFolder = this.findPublishedFolderForFile(file);
		if (!publishedFolder) {
			return null;
		}

		const remoteParentPath = this.getRemoteParentPath(publishedFolder.folderPath, file, publishedFolder.binding.remoteRoot);
		const resolution = await this.ensureRemoteFolderPath(publishedFolder.binding.rootParent, remoteParentPath);
		if (publishedFolder.inferred || resolution.createdBinding) {
			await this.saveSettings();
		}

		return {
			parent: resolution.parent,
			remoteRoot: publishedFolder.binding.remoteRoot,
			remoteParentPath
		};
	}

	private findPublishedFolderForFile(file: TFile): PublishedFolderResolution | null {
		if (this.isFolderDisconnected(file.path)) return null;
		let folderPath = this.parentPath(file.path);
		while (folderPath) {
			const normalizedFolderPath = this.normalizeLinkPath(folderPath);
			const existingBinding = this.settings.publishedFolders[normalizedFolderPath];
			const binding = existingBinding || this.inferPublishedFolderBinding(normalizedFolderPath);
			if (binding) {
				this.settings.publishedFolders[normalizedFolderPath] = binding;
				return {
					folderPath,
					binding,
					inferred: !existingBinding
				};
			}

			folderPath = this.parentPath(folderPath);
		}

		return null;
	}

	private inferPublishedFolderBinding(folderPath: string): PublishedFolderBinding | null {
		const remoteRoot = this.getSelectedFolderName(folderPath);
		for (const bindingKey of Object.keys(this.settings.folderBindings)) {
			const bindingPath = this.getFolderBindingPath(bindingKey);
			if (bindingPath !== remoteRoot) {
				continue;
			}

			return {
				rootParent: this.getFolderBindingRootParent(bindingKey),
				remoteRoot
			};
		}

		return null;
	}

	private getFolderBindingPath(bindingKey: string): string {
		const segments = bindingKey.split("|");
		return this.normalizeLinkPath(segments[3] || "");
	}

	private getFolderBindingRootParent(bindingKey: string): RemoteParent {
		const segments = bindingKey.split("|");
		return {
			kind: this.normalizeRemoteParentKind(segments[1]),
			token: segments[2] || ""
		};
	}

	private normalizeRemoteParentKind(kind: string | undefined): RemoteParentKind {
		if (kind === "wiki" || kind === "drive" || kind === "my_library" || kind === "unknown") {
			return kind;
		}

		return "unknown";
	}

	private savePublishedFolderBinding(folderPath: string, rootParent: RemoteParent, remoteRoot: string): void {
		this.settings.publishedFolders[this.normalizeLinkPath(folderPath)] = {
			rootParent,
			remoteRoot
		};
	}

	private async ensureRemoteFolderPath(
		rootParent: RemoteParent,
		folderPath: string
	): Promise<RemoteFolderPathResolution> {
		return await (this.folderResolutionQueue ??= new SyncQueue()).run(() => this.ensureRemoteFolderPathUnlocked(rootParent, folderPath));
	}

	private async ensureRemoteFolderPathUnlocked(rootParent: RemoteParent, folderPath: string): Promise<RemoteFolderPathResolution> {
		if (this.hasUnsavedSettings) await this.saveSettingsWithoutClearingCommandCache();
		const normalizedFolderPath = this.normalizeLinkPath(folderPath);
		if (!normalizedFolderPath) {
			return {
				parent: rootParent,
				createdBinding: false
			};
		}

		let parent = rootParent;
		let createdBinding = false;
		const segments = normalizedFolderPath.split("/").filter(Boolean);
		for (let index = 0; index < segments.length; index += 1) {
			const partialPath = segments.slice(0, index + 1).join("/");
			const bindingKey = this.getFolderBindingKey(rootParent, partialPath);
			const existingBinding = this.settings.folderBindings[bindingKey];

			if (existingBinding?.token) {
				parent = {
					token: existingBinding.token,
					kind: existingBinding.containerKind || parent.kind
				};
				continue;
			}

			const recoveredBinding = await this.findRemoteFolderBinding(parent, segments[index] || "Untitled", partialPath);
			if (recoveredBinding) {
				this.settings.folderBindings[bindingKey] = recoveredBinding;
				delete this.settings.pendingFolderCreates?.[bindingKey];
				await this.saveSettingsWithoutClearingCommandCache();
				createdBinding = true;
				parent = { token: recoveredBinding.token, kind: recoveredBinding.containerKind || parent.kind };
				continue;
			}

			if (this.settings.pendingFolderCreates?.[bindingKey]) {
				throw new LocalizedSyncError(this.settings.language === "en"
					? `Folder creation is unconfirmed: ${partialPath}. Manage its existing remote binding before retrying.`
					: `尚未确认目录是否已创建：${partialPath}。请先设置此目录的飞书链接。`);
			}
			(this.settings.pendingFolderCreates ??= {})[bindingKey] = segments[index] || "Untitled";
			try { await this.saveSettingsWithoutClearingCommandCache(); }
			catch (error) { delete this.settings.pendingFolderCreates[bindingKey]; throw error; }
			const folderBinding = await this.createRemoteFolderPage(segments[index] || "Untitled", parent);
			delete this.settings.pendingFolderCreates[bindingKey];
			this.settings.folderBindings[bindingKey] = folderBinding;
			await this.saveSettingsWithoutClearingCommandCache();
			createdBinding = true;
			parent = {
				token: folderBinding.token,
				kind: folderBinding.containerKind || parent.kind
			};
		}

		return {
			parent,
			createdBinding
		};
	}

	private async findRemoteFolderBinding(parent: RemoteParent, name: string, path: string): Promise<BoundLarkDocument | null> {
		if (parent.kind === "unknown") throw new LocalizedSyncError(this.settings.language === "en"
			? "Use a Wiki or Drive folder URL as the upload target before syncing folders."
			: "同步目录前，请将上传位置设置为 Wiki 或云盘文件夹链接。");
		if (parent.kind === "wiki" || parent.kind === "my_library") {
			// Wiki folder pages and ordinary notes both have type docx; a title cannot identify a folder.
			const matches = (await this.listRemoteWikiNodes(parent)).filter((node) => node.title === name);
			if (matches.length) throw new LocalizedSyncError(this.settings.language === "en"
				? `A Wiki page already has the folder title ${path}. Set this folder's Feishu/Lark link before retrying.`
				: `Wiki 中已有与目录“${path}”同名的页面。请先设置此目录的飞书链接，再重试。`);
			return null;
		}

		const matches = (await this.listRemoteDocuments(parent, "folder")).filter((folder) => folder.title === name);
		if (!matches.length) return null;
		if (matches.length !== 1) throw new LocalizedSyncError(this.settings.language === "en"
			? `Several remote folders match ${path} under the same parent. Set this folder's Feishu/Lark link before retrying.`
			: `同一飞书父目录下有多个与“${path}”同名的文件夹。请先设置此目录的飞书链接，再重试。`);
		const match = matches[0]!;
		const aliases = this.getBindingAliases(match);
		const bindings = [...Object.values(this.settings.folderBindings), ...this.getOtherRemoteBindings("").values()];
		if (bindings.some((binding) => this.getBindingAliases(binding).some((alias) => aliases.includes(alias)))) {
			throw new LocalizedSyncError(this.settings.language === "en"
				? `The remote folder matching ${path} is already bound elsewhere. Set a different folder link before retrying.`
				: `与“${path}”同名的飞书文件夹已绑定其他本地路径。请先设置不同的目录链接，再重试。`);
		}
		return { token: match.token, url: match.url, containerToken: parent.token, containerKind: "drive" };
	}

	private async createRemoteFolderPage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		if (parent.kind === "drive") {
			const result = await this.runLarkCli(["drive", "+create-folder", "--as", "user",
				"--folder-token", parent.token, "--name", name, "--json"]);
			const token = result.data?.folder_token;
			const url = result.data?.url || "";

			if (!token) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			return {
				token,
				url,
				containerToken: parent.token,
				containerKind: "drive"
			};
		}

		if (parent.kind === "wiki" || parent.kind === "my_library") {
			return await this.createWikiNodePage(name, parent);
		}

		return await this.createLarkDocumentLikePage(name, parent);
	}

	private async createWikiNodePage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		const args = ["wiki", "+node-create", "--as", "user", "--title", name, "--obj-type", "docx", "--json"];
		if (parent.kind === "my_library" && !parent.token) {
			args.push("--space-id", "my_library");
		} else {
			args.push("--parent-node-token", parent.token);
		}

		const result = await this.runLarkCli(args);
		const token = result.data?.node_token;
		const url = result.data?.url || "";

		if (!token) {
			throw new Error(this.t("errorNoDocumentToken"));
		}

			return {
				token,
				url,
				containerToken: parent.token,
				containerKind: parent.kind
			};
		}

	private async createLarkDocumentLikePage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		const content = `# ${name}\n`;
		const bodyContent = stripPreparedMarkdownTitle(content);
		return await this.withTempMarkdown(name, bodyContent, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--title", name, "--content", `@${tempFile.fileName}`, "--json"];

			if (parent.token) {
				args.push("--parent-token", parent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const commandDocument = result.data?.["document"];
			const token = result.data?.wiki_node?.node_token || commandDocument?.document_id;
			const url = commandDocument?.url || result.data?.url || "";

			if (!token || !url) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			return {
				token,
				url,
				containerToken: parent.token,
				containerKind: parent.kind
			};
		});
	}

	private getRemoteParentPath(folderPath: string, file: TFile, remoteRoot: string): string {
		return getSelectedRemoteParentPath(folderPath, file.path, remoteRoot);
	}

	private getSelectedFolderName(folderPath: string): string {
		return getSelectedRemoteRootName(folderPath);
	}

	private withRemoteParentMetadata(
		binding: BoundLarkDocument,
		remoteRoot: string,
		remoteParentPath: string,
		parent: RemoteParent
	): BoundLarkDocument {
		return {
			...binding,
			containerToken: parent.token,
			containerKind: parent.kind,
			remoteRoot,
			remoteParentPath
		};
	}

	private getFolderBindingKey(rootParent: RemoteParent, folderPath: string): string {
		// Existing associations remain valid when the default target setting changes.
		const existingKey = Object.keys(this.settings.folderBindings).find((key) => {
			const root = this.getFolderBindingRootParent(key);
			return root.kind === rootParent.kind && root.token === rootParent.token
				&& this.getFolderBindingPath(key) === this.normalizeLinkPath(folderPath);
		});
		if (existingKey) return existingKey;
		// An uncertain create must also survive a change to the default target setting.
		const pendingKey = Object.keys(this.settings.pendingFolderCreates || {}).find((key) => {
			const root = this.getFolderBindingRootParent(key);
			return root.kind === rootParent.kind && root.token === rootParent.token
				&& this.getFolderBindingPath(key) === this.normalizeLinkPath(folderPath);
		});
		if (pendingKey) return pendingKey;
		const target = this.settings.targetTokenOrUrl.trim() || "my_library";
		return `${target}|${rootParent.kind}|${rootParent.token}|${this.normalizeLinkPath(folderPath)}`;
	}

	private async resolveRemoteRootParent(): Promise<RemoteParent> {
		const target = this.settings.targetTokenOrUrl.trim();
		if (!target) {
			return {
				token: "",
				kind: "my_library"
			};
		}

		if (!/^https?:\/\//.test(target)) {
			return {
				token: target,
				kind: "unknown"
			};
		}

		const result = await this.inspectDefaultTarget(target);
		const kind = target.includes("/drive/folder/") ? "drive" : "wiki";
		const token = kind === "drive"
			? result.data?.token || extractDocumentToken(target)
			: result.data?.wiki_node?.node_token || result.data?.node?.node_token || result.data?.token || extractDocumentToken(target);

		return {
			token,
			kind
		};
	}

	private async inspectDefaultTarget(target: string): Promise<LarkCommandResult> {
		try {
			return await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", target, "--json"]);
		} catch (error) {
			const detail = this.formatNoticeErrorDetail(error);
			throw new LocalizedSyncError(this.t("errorInvalidDefaultTarget", {
				target,
				detail
			}));
		}
	}

	private async resolveParentToken(): Promise<string> {
		const target = this.settings.targetTokenOrUrl.trim();
		if (!target) {
			return "";
		}

		if (!/^https?:\/\//.test(target)) {
			return target;
		}

		const result = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", target, "--json"]);
		const wikiNodeToken = result.data?.wiki_node?.node_token;

		return wikiNodeToken || result.data?.token || target;
	}

	private async runLarkCli(args: string[], options: LarkCommandOptions = {}): Promise<LarkCommandResult> {
		return await this.runLarkCliQueued(args, options);
	}

	private async runLarkCliQueued(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		const previousRequest = this.larkCliRequestQueue;
		let releaseRequestSlot: () => void = () => {};
		this.larkCliRequestQueue = new Promise((resolveRequestSlot) => {
			releaseRequestSlot = resolveRequestSlot;
		});

		await previousRequest;
		try {
			while (this.larkCliActiveRequestCount >= LARK_CLI_MAX_CONCURRENT_REQUESTS) {
				await this.sleep(LARK_CLI_REQUEST_INTERVAL_MS);
			}
			await this.waitForLarkCliStartInterval();
			this.larkCliActiveRequestCount += 1;
		} finally {
			releaseRequestSlot();
		}

		try {
			return await this.runLarkCliWithRetry(args, options);
		} catch (error) {
			throw new Error(this.formatCommandError(error));
		} finally {
			this.larkCliActiveRequestCount = Math.max(0, this.larkCliActiveRequestCount - 1);
		}
	}

	private async waitForLarkCliStartInterval(): Promise<void> {
		const elapsedMs = Date.now() - this.lastLarkCliRequestAt;
		if (elapsedMs < LARK_CLI_REQUEST_INTERVAL_MS) {
			await this.sleep(LARK_CLI_REQUEST_INTERVAL_MS - elapsedMs);
		}
		this.lastLarkCliRequestAt = Date.now();
	}

	private async runLarkCliWithRetry(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		for (let attempt = 0; attempt <= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
			try {
				return await this.runLarkCliOnce(args, options);
			} catch (error) {
				// An upload may already have committed; retry only after reconciling its token.
				if (["+upload", "+create", "+node-create", "+create-folder", "+delete", "+node-delete"].includes(args[1] || "")
					|| !this.isLarkRateLimitError(error) || attempt >= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length) {
					throw error;
				}

				const retryDelayMs = LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS[attempt];
				if (retryDelayMs === undefined) {
					throw error;
				}
				await this.sleep(retryDelayMs);
			}
		}

		throw new Error("lark-cli request failed.");
	}

	private async runLarkCliOnce(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		const executable = await this.resolveLarkCliPath();
		const env = await this.buildCommandEnvironment(executable);
		await this.ensureSupportedLarkCliVersion(executable, env);
		const invocation = await this.resolveLarkCliInvocation(executable);
		const { stdout } = await execFileAsync(invocation.executable, [
			...invocation.argsPrefix,
			...withDocsApiVersion(args)
		], {
			cwd: options.cwd,
			env,
			maxBuffer: 20 * 1024 * 1024
		});
		const result = this.parseLarkCommandResult(stdout);

		if (!result.ok) {
			throw new Error(this.formatLarkError(result));
		}

		return result;
	}

	private async ensureSupportedLarkCliVersion(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
		if (this.checkedLarkCliVersionExecutable === executable) {
			return;
		}

		const cachedCheck = this.settings.larkCliVersionCheck;
		if (cachedCheck?.executable === executable && isSupportedLarkCliVersion(cachedCheck.version)) {
			this.checkedLarkCliVersionExecutable = executable;
			return;
		}

		if (this.pendingLarkCliVersionCheck && this.pendingLarkCliVersionExecutable === executable) {
			return await this.pendingLarkCliVersionCheck;
		}

		this.pendingLarkCliVersionExecutable = executable;
		this.pendingLarkCliVersionCheck = this.checkLarkCliVersion(executable, env);
		try {
			await this.pendingLarkCliVersionCheck;
		} finally {
			this.pendingLarkCliVersionExecutable = "";
			this.pendingLarkCliVersionCheck = null;
		}
	}

	private async checkLarkCliVersion(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
		let versionOutput: string;
		try {
			versionOutput = await this.readLarkCliVersionOutput(executable, env);
		} catch (error) {
			if (this.isExecutableLaunchError(error)) {
				throw new Error(formatMissingLarkCli(this.settings.language));
			}
			throw error;
		}

		const version = parseLarkCliVersion(versionOutput);
		if (!isSupportedLarkCliVersion(version)) {
			throw new Error(formatUnsupportedLarkCliVersion(version, this.settings.language));
		}

		this.settings.larkCliVersionCheck = {
			executable,
			version
		};
		await this.saveSettingsWithoutClearingCommandCache();
		this.checkedLarkCliVersionExecutable = executable;
	}

	private async readLarkCliVersionOutput(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
		let lastError: unknown = null;
		let onlyUnsupportedVersionCommands = true;
		const invocation = await this.resolveLarkCliInvocation(executable);
		for (const args of LARK_CLI_VERSION_ARGS) {
			try {
				const { stdout, stderr } = await execFileAsync(invocation.executable, [
					...invocation.argsPrefix,
					...args
				], {
					env,
					maxBuffer: 1024 * 1024
				});
				return `${this.commandOutputToString(stdout)}\n${this.commandOutputToString(stderr)}`;
			} catch (error) {
				lastError = error;
				if (!this.isUnsupportedVersionCommandError(error)) {
					onlyUnsupportedVersionCommands = false;
				}
			}
		}

		if (onlyUnsupportedVersionCommands) {
			return "";
		}
		throw this.toError(lastError);
	}

	private isExecutableLaunchError(error: unknown): boolean {
		if (!(error instanceof Error) || !("code" in error)) {
			return false;
		}
		return error.code === "ENOENT" || error.code === "EACCES";
	}

	private isUnsupportedVersionCommandError(error: unknown): boolean {
		const message = [
			error instanceof Error ? error.message : String(error),
			this.hasCommandStderr(error) ? this.commandOutputToString(error.stderr) : "",
			this.hasCommandStdout(error) ? this.commandOutputToString(error.stdout) : ""
		].join("\n").toLowerCase();
		return message.includes("unknown command")
			|| message.includes("unknown flag")
			|| message.includes("unknown shorthand flag")
			|| message.includes("unknown option")
			|| message.includes("unrecognized option");
	}

	private isLarkRateLimitError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		const normalizedMessage = message.toLowerCase();
		return normalizedMessage.includes("request trigger frequency limit")
			|| normalizedMessage.includes("frequency limit")
			|| normalizedMessage.includes("rate limit")
			|| normalizedMessage.includes("too many requests");
	}

	private formatLarkError(result: LarkCommandResult): string {
		const message = result.error?.message || "lark-cli request failed.";
		const hint = result.error?.hint;
		return hint ? `${message}\n${hint}` : message;
	}

	private formatCommandError(error: unknown): string {
		if (this.hasCommandStderr(error)) {
			const stderr = this.commandOutputToString(error.stderr).trim();
			if (stderr) {
				return this.formatStderr(stderr);
			}
		}

		if (this.hasCommandStdout(error)) {
			const stdout = this.commandOutputToString(error.stdout).trim();
			if (stdout) {
				return this.formatStderr(stdout);
			}
		}

		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}

	private hasCommandStderr(error: unknown): error is Error & { stderr: unknown } {
		return error instanceof Error && "stderr" in error;
	}

	private hasCommandStdout(error: unknown): error is Error & { stdout: unknown } {
		return error instanceof Error && "stdout" in error;
	}

	private commandOutputToString(output: unknown): string {
		if (typeof output === "string") {
			return output;
		}
		if (Buffer.isBuffer(output)) {
			return output.toString("utf8");
		}
		return "";
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private formatStderr(stderr: string): string {
		const parsed = this.tryParseLarkCommandResult(stderr);
		if (parsed?.error?.message) {
			return this.formatLarkError(parsed);
		}

		const embeddedJson = this.extractEmbeddedJson(stderr);
		if (embeddedJson) {
			const embeddedResult = this.tryParseLarkCommandResult(embeddedJson);
			if (embeddedResult?.error?.message) {
				return this.formatLarkError(embeddedResult);
			}
		}

		return stderr.slice(0, MAX_STDERR_LENGTH);
	}

	private parseLarkCommandResult(rawJson: string): LarkCommandResult {
		const parsed: unknown = JSON.parse(rawJson);
		if (!this.isLarkCommandResult(parsed)) {
			throw new Error("lark-cli returned an invalid JSON response.");
		}

		return parsed;
	}

	private tryParseLarkCommandResult(rawJson: string): LarkCommandResult | null {
		try {
			const parsed: unknown = JSON.parse(rawJson);
			return this.isLarkCommandResult(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private isLarkCommandResult(value: unknown): value is LarkCommandResult {
		if (!this.isRecord(value) || typeof value.ok !== "boolean") {
			return false;
		}

		const data = value.data;
		const error = value.error;
		return (data === undefined || this.isLarkCommandData(data))
			&& (error === undefined || this.isLarkCommandError(error));
	}

	private isLarkCommandData(value: unknown): value is LarkCommandResult["data"] {
		if (!this.isRecord(value)) {
			return false;
		}

		return this.isOptionalString(value.token)
			&& this.isOptionalString(value.folder_token)
			&& this.isOptionalString(value.comment_id)
			&& this.isOptionalString(value.reply_id)
			&& this.isOptionalString(value.node_token)
			&& this.isOptionalString(value.obj_token)
			&& this.isOptionalString(value.url)
			&& this.isOptionalLarkCommandDocument(value["document"])
			&& this.isOptionalLarkCommandNode(value.node)
			&& this.isOptionalLarkCommandNode(value.wiki_node);
	}

	private isLarkCommandError(value: unknown): value is LarkCommandResult["error"] {
		return this.isRecord(value)
			&& this.isOptionalString(value.message)
			&& this.isOptionalString(value.hint);
	}

	private isOptionalLarkCommandDocument(value: unknown): value is LarkCommandDocument | undefined {
		if (value === undefined) {
			return true;
		}

		return this.isRecord(value)
			&& this.isOptionalString(value.document_id)
			&& this.isOptionalString(value.url)
			&& this.isOptionalNumber(value.revision_id)
			&& this.isOptionalString(value.content);
	}

	private isOptionalLarkCommandNode(value: unknown): value is LarkCommandNode | undefined {
		if (value === undefined) {
			return true;
		}

		return this.isRecord(value)
			&& this.isOptionalString(value.node_token)
			&& this.isOptionalString(value.obj_token)
			&& this.isOptionalString(value.url);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	}

	private isOptionalString(value: unknown): value is string | undefined {
		return value === undefined || typeof value === "string";
	}

	private isOptionalNumber(value: unknown): value is number | undefined {
		return value === undefined || typeof value === "number";
	}

	private extractEmbeddedJson(text: string): string {
		const firstBrace = text.indexOf("{");
		const lastBrace = text.lastIndexOf("}");
		if (firstBrace < 0 || lastBrace <= firstBrace) {
			return "";
		}

		return text.slice(firstBrace, lastBrace + 1);
	}

	private formatNoticeErrorDetail(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
		const detail = lines[0] || message;
		return detail.slice(0, MAX_NOTICE_ERROR_DETAIL_LENGTH);
	}

	private async probeLarkCliVersion(): Promise<{ installed: boolean; version: string; error: string }> {
		try {
			const executable = await this.resolveLarkCliPath();
			await this.resolveLarkCliInvocation(executable);
		} catch (error) {
			return { installed: false, version: "", error: this.formatCommandError(error) };
		}

		let lastError = "";
		for (const args of LARK_CLI_VERSION_ARGS) {
			const result = await this.runLarkCliCapture(args, 10_000);
			if (result.launchError) {
				return { installed: false, version: "", error: result.error };
			}
			if (result.ok) {
				const output = `${result.stdout}\n${result.stderr}`;
				const version = parseLarkCliVersion(output);
				return {
					installed: true,
					version,
					error: version ? "" : this.t("cliStatusVersionUnknown")
				};
			}
			lastError = result.error;
			if (!this.isUnsupportedVersionCommandError(new Error(result.error))) {
				return { installed: true, version: "", error: result.error };
			}
		}

		return { installed: true, version: "", error: lastError || this.t("cliStatusVersionUnknown") };
	}

	private async getNpmToolStatus(): Promise<LarkCliToolStatus> {
		const loginShellPath = await this.resolveCommandFromLoginShell("npm").catch(() => "");
		const candidates = uniquePathEntries([
			loginShellPath,
			process.platform === "win32" ? "npm.cmd" : "npm",
			"npm"
		]);
		let lastError = "";
		for (const candidate of candidates) {
			const result = await this.runExecutableCapture(candidate, ["--version"], 10_000);
			if (result.ok) {
				const version = parseNpmVersionOutput(`${result.stdout}\n${result.stderr}`);
				return { available: true, version, path: candidate, error: "" };
			}
			lastError = result.error;
		}
		return { available: false, version: "", path: "", error: lastError };
	}

	private async getLatestLarkCliVersion(
		npm: LarkCliToolStatus,
		installed: boolean
	): Promise<{ version: string; error: string }> {
		if (npm.available) {
			const result = await this.runNpmCapture([
				"view", LARK_CLI_NPM_PACKAGE, "version", "--json"
			], 15_000);
			if (result.ok) {
				const version = parseNpmVersionOutput(`${result.stdout}\n${result.stderr}`);
				if (version) return { version, error: "" };
			}
			return { version: "", error: result.error };
		}

		if (installed) {
			const result = await this.runLarkCliCapture(["update", "--check", "--json"], LARK_CLI_STATUS_TIMEOUT_MS);
			if (result.ok) {
				const update = parseLarkCliUpdateCheck(result.stdout);
				if (update?.latestVersion) return { version: update.latestVersion, error: "" };
			}
			return { version: "", error: result.error };
		}

		return { version: "", error: "" };
	}

	private async runLarkCliCapture(args: string[], timeoutMs: number): Promise<RawCommandResult> {
		try {
			const executable = await this.resolveLarkCliPath();
			const env = await this.buildCommandEnvironment(executable);
			const invocation = await this.resolveLarkCliInvocation(executable);
			const { stdout, stderr } = await execFileAsync(invocation.executable, [
				...invocation.argsPrefix,
				...args
			], {
				env,
				maxBuffer: 5 * 1024 * 1024,
				timeout: timeoutMs,
				windowsHide: true
			});
			return {
				ok: true,
				stdout: this.commandOutputToString(stdout),
				stderr: this.commandOutputToString(stderr),
				error: "",
				launchError: false
			};
		} catch (error) {
			return {
				ok: false,
				stdout: this.hasCommandStdout(error) ? this.commandOutputToString(error.stdout) : "",
				stderr: this.hasCommandStderr(error) ? this.commandOutputToString(error.stderr) : "",
				error: this.formatCommandError(error),
				launchError: this.isExecutableLaunchError(error)
			};
		}
	}

	private async runNpmCapture(args: string[], timeoutMs: number): Promise<RawCommandResult> {
		const npm = await this.getNpmToolStatus();
		if (!npm.available) {
			return {
				ok: false,
				stdout: "",
				stderr: "",
				error: this.t("errorCliInstallRequiresNode"),
				launchError: true
			};
		}
		return await this.runExecutableCapture(npm.path, args, timeoutMs);
	}

	private async resolveNpmGlobalLarkCliPath(): Promise<string> {
		const result = await this.runNpmCapture(["prefix", "-g"], 10_000);
		if (!result.ok) return "";
		const prefix = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() || "";
		if (!prefix) return "";
		const candidates = process.platform === "win32"
			? [join(prefix, "lark-cli.cmd"), join(prefix, "lark-cli.exe")]
			: [join(prefix, "bin", "lark-cli")];
		for (const candidate of candidates) {
			if (await this.canExecute(candidate)) return candidate;
		}
		return "";
	}

	private async runExecutableCapture(
		executable: string,
		args: string[],
		timeoutMs: number
	): Promise<RawCommandResult> {
		try {
			const env = await this.buildCommandEnvironment(executable);
			const { stdout, stderr } = await execFileAsync(executable, args, {
				env,
				maxBuffer: 20 * 1024 * 1024,
				timeout: timeoutMs,
				windowsHide: true,
				shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
			});
			return {
				ok: true,
				stdout: this.commandOutputToString(stdout),
				stderr: this.commandOutputToString(stderr),
				error: "",
				launchError: false
			};
		} catch (error) {
			return {
				ok: false,
				stdout: this.hasCommandStdout(error) ? this.commandOutputToString(error.stdout) : "",
				stderr: this.hasCommandStderr(error) ? this.commandOutputToString(error.stderr) : "",
				error: this.formatCommandError(error),
				launchError: this.isExecutableLaunchError(error)
			};
		}
	}

	private async runLarkCliSpawn(
		args: string[],
		timeoutMs: number,
		onOutput?: (chunk: string) => void
	): Promise<RawCommandCapture> {
		const executable = await this.resolveLarkCliPath();
		const env = await this.buildCommandEnvironment(executable);
		const invocation = await this.resolveLarkCliInvocation(executable);
		return await new Promise<RawCommandCapture>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(invocation.executable, [...invocation.argsPrefix, ...args], {
					env,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true
				});
			} catch (error) {
				reject(this.toError(error));
				return;
			}

			this.pendingLarkCliChild = child;
			let stdout = "";
			let stderr = "";
			let finished = false;
			const finish = (error?: Error, result?: RawCommandCapture): void => {
				if (finished) return;
				finished = true;
				window.clearTimeout(timeout);
				if (this.pendingLarkCliChild === child) this.pendingLarkCliChild = null;
				if (error) reject(error);
				else resolve(result || { stdout, stderr });
			};
			const timeout = window.setTimeout(() => {
				if (finished) return;
				try {
					child.kill();
				} catch {
					// The process may already have exited.
				}
				finish(new Error(this.settings.language === "en"
					? "The CLI operation timed out."
					: "CLI 操作超时。"));
			}, timeoutMs);
			child.stdout?.on("data", (chunk: Buffer | string) => {
				const text = this.commandOutputToString(chunk);
				stdout += text;
				onOutput?.(text);
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				const text = this.commandOutputToString(chunk);
				stderr += text;
				onOutput?.(text);
			});
			child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
			child.on("close", (code) => {
				if (finished) return;
				if (code === 0) finish(undefined, { stdout, stderr });
				else finish(new Error(this.formatSpawnFailure(code, stdout, stderr)));
			});
		});
	}

	private formatSpawnFailure(code: number | null, stdout: string, stderr: string): string {
		const details = parseLarkCliError(stderr) || parseLarkCliError(stdout);
		if (details?.message) {
			return details.hint ? `${details.message}\n${details.hint}` : details.message;
		}
		const output = (stderr.trim() || stdout.trim());
		if (output) return output.slice(0, MAX_STDERR_LENGTH);
		return this.settings.language === "en"
			? `lark-cli exited with code ${code ?? "unknown"}.`
			: `lark-cli 退出，代码 ${code ?? "未知"}。`;
	}

	private parseUpdateResult(rawJson: string): LarkCliUpdateCheck | null {
		return parseLarkCliUpdateCheck(rawJson);
	}

	private tryParseJsonRecord(rawJson: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = JSON.parse(rawJson);
			return this.isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private isRemoteDocumentDeletedError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("3380003")
			|| message.toLowerCase().includes("document page has been deleted");
	}

	private isRemoteDocumentDeletedApiError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("3380003")
			|| message.toLowerCase().includes("document page has been deleted");
	}

	private async buildCommandEnvironment(executable: string): Promise<NodeJS.ProcessEnv> {
		const shellPath = await this.getLoginShellPath();
		if (this.cachedCommandEnvironment
			&& this.cachedCommandEnvironmentExecutable === executable
			&& this.cachedCommandEnvironmentShellPath === shellPath) {
			return this.cachedCommandEnvironment;
		}

		const env = applyProxyEnvironment(buildLarkCommandEnvironment(executable, {
			loginShellPath: shellPath
		}), this.settings);
		this.cachedCommandEnvironment = env;
		this.cachedCommandEnvironmentExecutable = executable;
		this.cachedCommandEnvironmentShellPath = shellPath;
		return env;
	}

	private async resolveLarkCliPath(): Promise<string> {
		const configuredPath = this.settings.larkCliPath.trim();
		if (this.cachedLarkCliPathSetting === configuredPath && this.cachedLarkCliPath) {
			return this.cachedLarkCliPath;
		}

		if (this.pendingLarkCliPath) {
			return await this.pendingLarkCliPath;
		}

		this.pendingLarkCliPath = this.resolveLarkCliPathUncached(configuredPath);
		try {
			return await this.pendingLarkCliPath;
		} finally {
			this.pendingLarkCliPath = null;
		}
	}

	private async resolveLarkCliInvocation(executable: string): Promise<{ executable: string; argsPrefix: string[] }> {
		return await resolveLarkCliInvocation(executable, {
			pathExists: (path) => this.pathExists(path),
			readTextFile: (path) => readFile(path, "utf8")
		});
	}

	private async resolveLarkCliPathUncached(configuredPath: string): Promise<string> {
		const resolvedPath = await resolveLarkCliPathFromSetting(configuredPath, {
			env: process.env,
			canExecute: (path) => this.canExecute(path),
			pathExists: (path) => this.pathExists(path),
			isDirectory: (path) => this.isDirectory(path),
			resolveCommandFromLoginShell: (command) => this.resolveCommandFromLoginShell(command)
		});
		return this.cacheResolvedLarkCliPath(configuredPath, resolvedPath);
	}

	private cacheResolvedLarkCliPath(setting: string, resolvedPath: string): string {
		this.cachedLarkCliPathSetting = setting;
		this.cachedLarkCliPath = resolvedPath;
		this.cachedCommandEnvironment = null;
		this.cachedCommandEnvironmentExecutable = "";
		this.cachedCommandEnvironmentShellPath = "";
		return resolvedPath;
	}

	private async resolveCommandFromLoginShell(command: string): Promise<string> {
		for (const shell of this.getShellCandidates()) {
			try {
				const { stdout } = await execFileAsync(shell, ["-lc", `command -v ${command}`], {
					maxBuffer: 1024 * 1024
				});
				const resolvedPath = stdout.trim().split(/\r?\n/)[0] || "";
				if (resolvedPath) {
					return resolvedPath;
				}
			} catch {
				// Try the next shell candidate.
			}
		}

		return "";
	}

	private async getLoginShellPath(): Promise<string> {
		if (this.cachedLoginShellPath !== null) {
			return this.cachedLoginShellPath;
		}

		if (this.pendingLoginShellPath) {
			return await this.pendingLoginShellPath;
		}

		this.pendingLoginShellPath = this.resolveLoginShellPathUncached();
		try {
			this.cachedLoginShellPath = await this.pendingLoginShellPath;
			return this.cachedLoginShellPath;
		} finally {
			this.pendingLoginShellPath = null;
		}
	}

	private async resolveLoginShellPathUncached(): Promise<string> {
		for (const shell of this.getShellCandidates()) {
			try {
				const { stdout } = await execFileAsync(shell, ["-lc", "printf %s \"$PATH\""], {
					maxBuffer: 1024 * 1024
				});
				const path = stdout.trim();
				if (path) {
					return path;
				}
			} catch {
				// Try the next shell candidate.
			}
		}

		return "";
	}

	private clearLarkCliCommandCache(): void {
		this.cachedLarkCliPath = null;
		this.cachedLarkCliPathSetting = "";
		this.cachedCommandEnvironment = null;
		this.cachedCommandEnvironmentExecutable = "";
		this.cachedCommandEnvironmentShellPath = "";
		this.cachedLoginShellPath = null;
		this.pendingLarkCliPath = null;
		this.pendingLoginShellPath = null;
		this.checkedLarkCliVersionExecutable = "";
		this.pendingLarkCliVersionExecutable = "";
		this.pendingLarkCliVersionCheck = null;
	}

	private getShellCandidates(): string[] {
		const candidates = [process.env.SHELL || "", ...FALLBACK_LOGIN_SHELLS];
		return uniquePathEntries(candidates);
	}

	private async canExecute(path: string): Promise<boolean> {
		try {
			await access(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	private async isDirectory(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	}

	private async withTempMarkdown<T>(
		baseName: string,
		content: string,
		callback: (file: { directory: string; fileName: string }) => Promise<T>
	): Promise<T> {
		const tempDir = await mkdtemp(join(tmpdir(), "feishu-docs-publisher-"));
		const fileName = `${this.sanitizeFileName(baseName)}.md`;
		const tempPath = join(tempDir, fileName);

		try {
			await writeFile(tempPath, content, "utf8");
			return await callback({ directory: tempDir, fileName });
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}

	private async writeTempMarkdown(directory: string, baseName: string, content: string): Promise<string> {
		const fileName = `${this.sanitizeFileName(baseName)}.md`;
		await writeFile(join(directory, fileName), content, "utf8");
		return fileName;
	}

	private sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "note";
	}

	private async rememberDocumentBinding(file: TFile, binding: BoundLarkDocument): Promise<void> {
		this.assertRemoteBindingExclusive(file.path, binding);
		delete this.settings.disconnectedBindings?.[file.path];
		delete this.settings.pendingDocumentCreates?.[file.path];
		(this.settings.documentBindings ??= {})[file.path] = { ...binding };
		await this.saveSettingsWithoutClearingCommandCache();
	}

	private async writeBinding(file: TFile, binding: BoundLarkDocument): Promise<void> {
		this.assertRemoteBindingExclusive(file.path, binding);
		const previousBinding = this.getBinding(file);
		if (previousBinding && this.hasBindingChanged(previousBinding, binding)) {
			this.removeSyncStateForBinding(previousBinding);
			await this.saveLarkSyncState();
		}

		await this.rememberDocumentBinding(file, binding);
		if (!this.settings.updateFrontmatter) {
			return;
		}
		this.selfWrittenPaths.set(file.path, Date.now());
		const rawContent = await this.app.vault.read(file);
		const normalizedContent = removeBindingOnlyFrontmatterBeforeNextFrontmatter(rawContent);
		if (normalizedContent !== rawContent) {
			await this.app.vault.modify(file, normalizedContent);
			this.selfWrittenPaths.set(file.path, Date.now());
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			delete frontmatter.lark_doc;
			delete frontmatter[FRONTMATTER_TOKEN_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_ROOT_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_PARENT_PATH_KEY];
			delete frontmatter[LEGACY_FRONTMATTER_SYNCED_AT_KEY];
			frontmatter[FRONTMATTER_URL_KEY] = binding.url;
		});
		this.selfWrittenPaths.set(file.path, Date.now());
	}

	private async unbindDeletedRemoteDocument(file: TFile, binding: BoundLarkDocument): Promise<void> {
		delete this.settings.documentBindings?.[file.path];
		(this.settings.disconnectedBindings ??= {})[file.path] = true;
		await this.saveSettingsWithoutClearingCommandCache();
		this.selfWrittenPaths.set(file.path, Date.now());
		const legacy = this.app.metadataCache?.getFileCache(file)?.frontmatter;
		if (this.settings.updateFrontmatter && (legacy?.[FRONTMATTER_URL_KEY] || legacy?.[FRONTMATTER_TOKEN_KEY])) {
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			delete frontmatter.lark_doc;
			delete frontmatter[FRONTMATTER_URL_KEY];
			delete frontmatter[FRONTMATTER_TOKEN_KEY];
			delete frontmatter[LEGACY_FRONTMATTER_SYNCED_AT_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_ROOT_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_PARENT_PATH_KEY];
		});
		}
		this.selfWrittenPaths.set(file.path, Date.now());
		this.removeSyncStateForBinding(binding);
		await this.saveLarkSyncState();
	}

	private async runWithNotice(message: string, callback: (notice: Notice) => Promise<void>): Promise<boolean> {
		try {
			await this.runWithProgressNotice(message, callback);
			return true;
		} catch {
			return false;
		}
	}

	/** Keep a notice at the top right while the work runs, and report a failure there too before rethrowing it. */
	private async runWithProgressNotice<T>(message: string, callback: (notice: Notice) => Promise<T>): Promise<T> {
		const notice = new Notice(message, 0);

		try {
			return await callback(notice);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const noticeMessage = error instanceof LocalizedSyncError
				? errorMessage
				: this.t("noticeSyncFailed", { message: errorMessage });
			new Notice(noticeMessage, 10000);
			console.error("[Feishu Docs Publisher] operation failed", error);
			throw error;
		} finally {
			notice.hide();
		}
	}

	private showSuccess(message: string, url: string): void {
		new Notice(`${message}\n${url}`, 8000);
	}

	private openUrlIfNeeded(url: string): void {
		if (this.settings.openAfterSync && url) {
			window.open(url);
		}
	}

	private isPathWithin(path: string, folderPath: string): boolean {
		return !folderPath || path === folderPath || path.startsWith(`${folderPath}/`);
	}

	private isFolderDisconnected(path: string): boolean {
		return Object.keys(this.settings.disconnectedFolders || {}).some((folder) => this.isPathWithin(path, folder));
	}

	/** Listed in a .feishuignore: skipped by folder sync, auto-sync, and the pre-push hook. Call refreshIgnoreRules first. */
	private isSyncIgnored(path: string, isDirectory = false): boolean {
		return (this.ignoreRules ??= new IgnoreRules()).isIgnored(path, isDirectory);
	}

	/** Re-read every rule file that can apply to these paths. A rule file that cannot be read stops the sync rather than being skipped. */
	private async refreshIgnoreRules(paths: string[]): Promise<void> {
		const rules = this.ignoreRules ??= new IgnoreRules();
		for (const dir of collectIgnoreDirectories(paths)) rules.setFile(dir, await this.readIgnoreFile(dir));
	}

	private async readIgnoreFile(dir: string): Promise<string | null> {
		const path = ignoreFilePath(dir);
		const adapter = this.app?.vault?.adapter;
		if (!adapter || !await adapter.exists(path)) return null;
		return await adapter.read(path);
	}

	/** Paths this plugin published from a folder, including files that no longer exist locally. */
	private publishedPathsWithin(folderPath: string): string[] {
		return [`${folderPath}/`, ...Object.keys(this.settings.documentBindings || {}), ...Object.keys(this.settings.pdfBindings || {})]
			.filter((path) => this.isPathWithin(path, folderPath));
	}

	private hasIgnoredContent(folderPath: string): boolean {
		return this.collectFolderFiles(folderPath).some((file) => this.isSyncIgnored(file.path) && !this.isFolderDisconnected(file.path)
			&& (file.extension.toLowerCase() === "md" || file.extension.toLowerCase() === "pdf"));
	}

	async openSyncIgnore(folderPath = ""): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(SYNC_IGNORE_VIEW_TYPE)[0] ?? workspace.getLeaf("tab");
		await leaf.setViewState({ type: SYNC_IGNORE_VIEW_TYPE, active: true, state: { folder: folderPath } });
		await workspace.revealLeaf(leaf);
	}

	private syncIgnoreHost(): SyncIgnoreHost {
		return {
			getLanguage: () => this.settings.language,
			getVaultRoot: (): VaultNodeLike => this.app.vault.getRoot(),
			getPublishedFolders: () => Object.keys(this.settings.publishedFolders || {}),
			readIgnoreFiles: async (dirs) => {
				const found = new Map<string, string>();
				for (const dir of dirs) {
					const content = await this.readIgnoreFile(dir);
					if (content !== null) found.set(dir, content);
				}
				return found;
			},
			writeIgnoreFile: (dir, content) => this.app.vault.adapter.write(ignoreFilePath(dir), content)
		};
	}

	private getRemoteFolderBinding(binding: PublishedFolderBinding, path: string): BoundLarkDocument | undefined {
		return this.settings.folderBindings[this.getFolderBindingKey(binding.rootParent, path)];
	}

	private listPublishedEntries(): PublishedLinkEntry[] {
		const entries = new Map<string, PublishedLinkEntry>();
		const add = (path: string, kind: PublishedLinkEntry["kind"], binding: { url?: string; token?: string }): void => {
			const id = `${kind}:${path}`;
			entries.set(id, { id, path, kind, url: binding.url || "", token: binding.token });
		};
		for (const path of Object.keys(this.settings.pendingDocumentCreates || {})) {
			add(path, "markdown", {});
			entries.get(`markdown:${path}`)!.name = `${path} (${this.settings.language === "en" ? "creation unconfirmed" : "创建结果待确认"})`;
		}
		for (const [path, binding] of Object.entries(this.settings.documentBindings || {})) add(path, "markdown", binding);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const binding = this.getBinding(file);
			if (binding) add(file.path, "markdown", binding);
		}
		for (const [path, binding] of Object.entries(this.settings.pdfBindings || {})) {
			add(path, "pdf", { url: binding.url, token: binding.fileToken });
		}
		for (const [folderPath, published] of Object.entries(this.settings.publishedFolders || {})) {
			const rootBinding = this.getRemoteFolderBinding(published, published.remoteRoot);
			add(folderPath, "folder", rootBinding || { token: published.rootParent.token });
			for (const key of Object.keys(this.settings.pendingFolderCreates || {})) {
				const root = this.getFolderBindingRootParent(key), remotePath = this.getFolderBindingPath(key);
				if (root.kind !== published.rootParent.kind || root.token !== published.rootParent.token || !this.isPathWithin(remotePath, published.remoteRoot)) continue;
				const suffix = remotePath.slice(published.remoteRoot.length).replace(/^\/+/, "");
				add([folderPath, suffix].filter(Boolean).join("/"), "folder", {});
			}
			for (const [key, binding] of Object.entries(this.settings.folderBindings)) {
				const root = this.getFolderBindingRootParent(key);
				const remotePath = this.getFolderBindingPath(key);
				if (root.kind !== published.rootParent.kind || root.token !== published.rootParent.token
					|| !this.isPathWithin(remotePath, published.remoteRoot)) continue;
				const suffix = remotePath.slice(published.remoteRoot.length).replace(/^\/+/, "");
				add([folderPath, suffix].filter(Boolean).join("/"), "folder", binding);
			}
		}
		return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
	}

	private getPublishedEntry(path: string, kind: PublishedLinkEntry["kind"]): PublishedLinkEntry | undefined {
		return this.listPublishedEntries().find((entry) => entry.path === path && entry.kind === kind);
	}

	private addPublishedLinkMenu(menu: Menu, path: string, kind: PublishedLinkEntry["kind"]): void {
		const entry = this.getPublishedEntry(path, kind) || { id: `${kind}:${path}`, path, kind, url: "" };
		menu.addItem((item) => item.setTitle(`Lark: ${this.t("menuEditPublishedLink")}`).setIcon("link")
			.onClick(() => {
				new PublishedLinkBindingModal(this.app, this.publishedLinksHost(), entry, () => {}).open();
			}));
		menu.addItem((item) => item.setTitle(`Lark: ${this.t("menuOpenPublishedLink")}`).setIcon("external-link")
			.setDisabled(!entry.url).onClick(() => { if (entry.url) window.open(entry.url); }));
	}

	openPublishedLinks(folderPath = ""): void {
		new PublishedLinksModal(this.app, this.publishedLinksHost(), folderPath).open();
	}

	private publishedLinksHost(): PublishedLinksHost {
		return {
			getLanguage: () => this.settings.language,
			listEntries: () => this.listPublishedEntries(),
			recoverBindings: (scope) => (this.operationQueue ??= new SyncQueue()).run(() => this.recoverPublishedBindings(scope)),
			saveBindingUrl: (entry, url) => (this.operationQueue ??= new SyncQueue()).run(() => this.savePublishedBinding(entry, url)),
			removeBinding: (entry) => (this.operationQueue ??= new SyncQueue()).run(() => this.disconnectPublishedBinding(entry)),
			openSyncIgnore: (folderPath) => { void this.openSyncIgnore(folderPath); },
			openLocalFile: async (entry) => {
				const file = this.app.vault.getAbstractFileByPath(entry.path);
				if (!(file instanceof TFile)) throw new Error(`Local file not found: ${entry.path}`);
				await this.app.workspace.getLeaf(false).openFile(file);
			},
			sync: async (entry, report) => {
				// The top-right notice keeps showing progress after the window is closed; the window shows the same lines.
				if (entry.kind === "folder") {
					const base = this.t("noticePublishingFolderToLark");
					await this.runWithProgressNotice(base, (notice) => this.publishFolderInternal(entry.path, false, (message) => {
						notice.setMessage(`${base}\n${message}`);
						report?.(message);
					}));
					await this.cleanupMissingRemoteFiles(entry.path);
					return;
				}
				const file = this.app.vault.getAbstractFileByPath(entry.path);
				if (!(file instanceof TFile)) throw new Error(`Local file not found: ${entry.path}`);
				await this.runWithProgressNotice(this.t("noticeSyncingToLark"), async () => {
					if (entry.kind === "pdf") { await this.syncPdfFile(file); return; }
					await this.syncFileInternal(file, { allowCreate: false, openAfterSync: false,
						showSuccess: false, showRemoteDeletedNotice: false, updateFrontmatter: this.settings.updateFrontmatter, mode: "manual" });
				});
			}
		};
	}

	private async savePublishedBinding(entry: PublishedLinkEntry, url: string): Promise<void> {
		let parsed: URL;
		try { parsed = new URL(url); } catch { throw new Error(this.t("invalidPublishedLink")); }
		if (parsed.protocol !== "https:" || parsed.username || parsed.password
			|| !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(parsed.hostname)
			|| !/^\/(docx|wiki|file|drive\/folder)\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
			throw new Error(this.t("invalidPublishedLink"));
		}
		const result = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", url, "--json"]);
		const data = result.data;
		if (!data?.token) throw new Error(this.t("errorNoDocumentToken"));
		await this.resolveExclusiveRemoteBinding(entry.path, { token: data.token, nodeToken: data.wiki_node?.node_token, url });
		if (entry.kind === "folder") {
			const wiki = data.wiki_node;
			if (data.type !== "folder" && !wiki?.node_token) throw new Error(this.t("invalidPublishedLink"));
			await this.disconnectFolderBinding(entry.path);
			clearDisconnectedFolderPaths(this.settings.disconnectedFolders ??= {}, entry.path);
			const parent: RemoteParent = { kind: data.type === "folder" ? "drive" : "wiki", token: wiki?.node_token || data.token };
			this.savePublishedFolderBinding(entry.path, parent, "");
			this.settings.folderBindings[this.getFolderBindingKey(parent, "")] = { token: parent.token, url, containerKind: parent.kind };
			await this.saveSettingsWithoutClearingCommandCache();
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile)) throw new Error(`Local file not found: ${entry.path}`);
		if (entry.kind === "markdown") {
			if (data.type !== "docx") throw new Error(this.t("invalidPublishedLink"));
			const previous = this.getBinding(file);
			if (previous) { this.removeSyncStateForBinding(previous); await this.saveLarkSyncState(); }
			await this.rememberDocumentBinding(file, { token: data.token, nodeToken: data.wiki_node?.node_token, url });
		} else {
			if (data.type !== "file") throw new Error(this.t("invalidPublishedLink"));
			const wiki = data.wiki_node;
			let resolvedParent: PdfPublishParent = { kind: "drive", token: "" };
			let nodeToken: string | undefined;
			if (wiki?.node_token) {
				const node = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", wiki.node_token, "--json"]);
				const details = node.data?.node || node.data;
				if (details?.obj_type !== "file" || !details.parent_node_token) throw new Error(this.t("invalidPublishedLink"));
				resolvedParent = { kind: "wiki", token: details.parent_node_token };
				nodeToken = wiki.node_token;
			}
			const options = { vaultRoot: this.getVaultRoot(), vaultPath: file.path, parent: resolvedParent, scope: "user" };
			this.settings.pdfBindings[entry.path] = { version: 1, key: createPdfBindingKey(options), vaultPath: file.path,
				parent: resolvedParent, scope: "user", fileName: file.name, contentHash: "0".repeat(64), size: 5,
				status: "published", fileToken: data.token, nodeToken, url, updatedAt: new Date().toISOString() };
			await this.saveSettingsWithoutClearingCommandCache();
		}
	}

	private async disconnectFolderBinding(path: string): Promise<void> {
		// Drop only associations for this local subtree; individual documents keep their bindings.
		for (const [folder, published] of Object.entries(this.settings.publishedFolders)) {
			if (!this.isPathWithin(path, folder) && !this.isPathWithin(folder, path)) continue;
			const prefix = this.isPathWithin(folder, path) ? published.remoteRoot
				: getSelectedRemoteParentPath(folder, `${path}/__file.md`, published.remoteRoot);
			for (const key of new Set([
				...Object.keys(this.settings.folderBindings), ...Object.keys(this.settings.pendingFolderCreates || {})
			])) {
				const root = this.getFolderBindingRootParent(key);
				if (root.kind === published.rootParent.kind && root.token === published.rootParent.token && this.isPathWithin(this.getFolderBindingPath(key), prefix)) {
					delete this.settings.folderBindings[key];
					delete this.settings.pendingFolderCreates[key];
				}
			}
		}
		for (const folder of Object.keys(this.settings.publishedFolders)) {
			if (this.isPathWithin(folder, path)) delete this.settings.publishedFolders[folder];
		}
	}

	private async disconnectPublishedBinding(entry: PublishedLinkEntry): Promise<void> {
		if (entry.kind === "folder") {
			const notes = new Map(this.app.vault.getMarkdownFiles().map((file) => [file.path, file]));
			const paths = new Set([
				...Object.keys(this.settings.documentBindings),
				...Object.keys(this.settings.pendingDocumentCreates || {}),
				...notes.keys()
			]);
			for (const path of paths) {
				if (!this.isPathWithin(path, entry.path)) continue;
				const file = notes.get(path);
				const binding = this.settings.documentBindings[path] || (file ? this.getBinding(file) : null);
				(this.settings.disconnectedBindings ??= {})[path] = true;
				delete this.settings.documentBindings[path];
				delete this.settings.pendingDocumentCreates?.[path];
				if (binding) this.removeSyncStateForBinding(binding);
			}
			for (const path of Object.keys(this.settings.pdfBindings)) {
				if (this.isPathWithin(path, entry.path)) delete this.settings.pdfBindings[path];
			}
			await this.disconnectFolderBinding(entry.path);
			(this.settings.disconnectedFolders ??= {})[entry.path] = true;
			await this.saveLarkSyncState();
		}
		else if (entry.kind === "pdf") delete this.settings.pdfBindings[entry.path];
		else {
			const file = this.app.vault.getAbstractFileByPath(entry.path);
			const binding = file instanceof TFile ? this.getBinding(file) : this.settings.documentBindings[entry.path];
			(this.settings.disconnectedBindings ??= {})[entry.path] = true;
			delete this.settings.documentBindings[entry.path];
			delete this.settings.pendingDocumentCreates?.[entry.path];
			if (binding) { this.removeSyncStateForBinding(binding); await this.saveLarkSyncState(); }
		}
		await this.saveSettingsWithoutClearingCommandCache();
	}

	/** Finish local-only removals made by versions that left descendant links behind. */
	private async cleanupDisconnectedFolderBindings(): Promise<void> {
		if (this.settings.recursiveFolderUnlinkMigrated) return;
		for (const path of Object.keys(this.settings.disconnectedFolders || {})) {
			if (!this.settings.disconnectedFolders[path]) continue;
			await this.disconnectPublishedBinding({ id: `folder:${path}`, path, kind: "folder", url: "" });
		}
		this.settings.recursiveFolderUnlinkMigrated = true;
		await this.saveSettingsWithoutClearingCommandCache();
	}

	private async moveLocalBindings(oldPath: string, newPath: string, isFolder = true): Promise<void> {
		// Folder-cache paths follow the local hierarchy while their tokens stay fixed.
		const containing = Object.entries(this.settings.publishedFolders).filter(([folder]) =>
			folder !== oldPath && this.isPathWithin(oldPath, folder)).sort((a, b) => b[0].length - a[0].length)[0];
		if (containing && isFolder) {
			const [folderPath, published] = containing;
			const oldPrefix = getSelectedRemoteParentPath(folderPath, `${oldPath}/__file.md`, published.remoteRoot);
			const newPrefix = getSelectedRemoteParentPath(folderPath, `${newPath}/__file.md`, published.remoteRoot);
			const movedFolder = this.getRemoteFolderBinding(published, oldPrefix);
			for (const [key, binding] of Object.entries(this.settings.folderBindings)) {
				const root = this.getFolderBindingRootParent(key), remotePath = this.getFolderBindingPath(key);
				if (root.kind !== published.rootParent.kind || root.token !== published.rootParent.token || !this.isPathWithin(remotePath, oldPrefix)) continue;
				delete this.settings.folderBindings[key];
				if (this.isPathWithin(newPath, folderPath)) {
					this.settings.folderBindings[this.getFolderBindingKey(published.rootParent, newPrefix + remotePath.slice(oldPrefix.length))] = binding;
				} else if (movedFolder) {
					const parent = { token: movedFolder.token, kind: movedFolder.containerKind || published.rootParent.kind };
					this.settings.folderBindings[this.getFolderBindingKey(parent, remotePath.slice(oldPrefix.length).replace(/^\/+/, ""))] = binding;
				}
			}
			for (const [key, title] of Object.entries(this.settings.pendingFolderCreates || {})) {
				const root = this.getFolderBindingRootParent(key), remotePath = this.getFolderBindingPath(key);
				if (root.kind === published.rootParent.kind && root.token === published.rootParent.token && this.isPathWithin(remotePath, oldPrefix)) {
					delete this.settings.pendingFolderCreates[key];
					this.settings.pendingFolderCreates[this.getFolderBindingKey(published.rootParent, newPrefix + remotePath.slice(oldPrefix.length))] = title;
				}
			}
			if (!this.isPathWithin(newPath, folderPath) && movedFolder) {
				this.savePublishedFolderBinding(newPath, { token: movedFolder.token, kind: movedFolder.containerKind || published.rootParent.kind }, "");
			}
		}
		const movePaths = <T>(records: Record<string, T>): void => {
			for (const path of Object.keys(records || {})) {
				if (!this.isPathWithin(path, oldPath)) continue;
				const nextPath = newPath + path.slice(oldPath.length);
				const record = records[path];
				if (!record) continue;
				records[nextPath] = record;
				delete records[path];
			}
		};
		movePaths(this.settings.documentBindings);
		movePaths(this.settings.pendingDocumentCreates);
		movePaths(this.settings.disconnectedBindings);
		movePaths(this.settings.disconnectedFolders);
		movePaths(this.settings.pdfBindings);
		movePaths(this.settings.publishedFolders);
		for (const [path, binding] of Object.entries(this.settings.pdfBindings || {})) {
			if (!this.isPathWithin(path, newPath)) continue;
			binding.vaultPath = path;
			binding.key = createPdfBindingKey({ vaultRoot: this.getVaultRoot(), vaultPath: path, parent: binding.parent, scope: binding.scope });
		}
		await this.saveSettingsWithoutClearingCommandCache();
	}

	private toPdfParent(parent: RemoteParent): PdfPublishParent {
		if (parent.kind === "drive" || (!parent.token && parent.kind === "my_library")) return { kind: "drive", token: parent.token };
		if (parent.kind === "wiki" || parent.kind === "my_library") return { kind: "wiki", token: parent.token };
		throw new Error(this.t("invalidPublishedLink"));
	}

	private async syncPdfFile(file: TFile, overwrite = false): Promise<void> {
		await (this.operationQueue ??= new SyncQueue()).run(() => this.syncPdfFileUnlocked(file, undefined, overwrite));
	}

	private async syncPdfFileUnlocked(file: TFile, parent?: RemoteParent, overwrite = false): Promise<void> {
		if (this.hasUnsavedSettings) await this.saveSettingsWithoutClearingCommandCache();
		let existing = this.settings.pdfBindings[file.path];
		if (existing?.fileToken) await this.resolveExclusiveRemoteBinding(file.path,
			{ token: existing.fileToken, nodeToken: existing.nodeToken, url: existing.url || "" });
		const folderParent = parent || (await this.resolvePublishedFolderParentForFile(file))?.parent;
		const destination = this.toPdfParent(folderParent || existing?.parent || await this.resolveRemoteRootParent());
		const parentChanged = Boolean(existing && (existing.parent.kind !== destination.kind
			|| existing.parent.token !== destination.token));
		if (existing?.fileToken && (parentChanged || !(await this.remoteFileExists(destination, existing.fileToken)))) {
			// The saved binding can outlive a deleted or moved remote file. Drop it so
			// the upload runs again instead of reporting an unchanged PDF.
			delete this.settings.pdfBindings[file.path];
			await this.saveSettingsWithoutClearingCommandCache();
			existing = undefined;
		}
		const options = { vaultRoot: this.getVaultRoot(), vaultPath: file.path, parent: destination, scope: existing?.scope || "user", force: overwrite };
		if (overwrite && !existing) {
			const match = this.selectOverwriteMatch(file.path, (await this.listRemoteDocuments(destination, "file")).filter((document) => document.title === file.name));
			if (match) {
				this.settings.pdfBindings[file.path] = { version: 1, key: createPdfBindingKey(options), vaultPath: file.path, parent: destination,
					scope: options.scope, fileName: file.name, contentHash: "0".repeat(64), size: 5, status: "published",
					fileToken: match.token, nodeToken: match.nodeToken, url: match.url, updatedAt: new Date().toISOString() };
				await this.saveSettingsWithoutClearingCommandCache();
			}
		}
		await publishPdf(options, {
			loadBinding: async () => this.settings.pdfBindings[file.path],
			saveBinding: async (_key, binding) => {
				if (binding.fileToken) this.assertRemoteBindingExclusive(file.path,
					{ token: binding.fileToken, nodeToken: binding.nodeToken, url: binding.url || "" });
				this.settings.pdfBindings[file.path] = binding;
				await this.saveSettingsWithoutClearingCommandCache();
			},
			runLarkCli: (args, commandOptions) => this.runLarkCli(args, commandOptions)
		});
		if (overwrite) {
			const binding = this.settings.pdfBindings[file.path]!;
			const removed = await this.cleanupRemoteDuplicates(file.path, binding.fileName, destination,
				{ token: binding.fileToken!, nodeToken: binding.nodeToken, url: binding.url || "" }, "file");
			if (removed) new Notice(this.t("noticeRemovedDuplicates", { count: String(removed) }), 8000);
		}
	}

	private async remoteFileExists(parent: RemoteParent, fileToken: string): Promise<boolean> {
		const files = await this.listRemoteDocuments(parent, "file");
		return files.some((file) => file.token === fileToken);
	}

	private async listRemoteWikiNodes(parent: RemoteParent): Promise<LarkCommandNode[]> {
		const nodes: LarkCommandNode[] = [];
		let spaceId = parent.spaceId || (parent.kind === "my_library" && !parent.token ? "my_library" : "");
		if (!spaceId) {
			const info = await this.runLarkCli(["wiki", "+node-get", "--as", "user", "--node-token", parent.token, "--json"]);
			spaceId = info.data?.node?.space_id || info.data?.space_id || "";
			if (!spaceId) throw new Error("Cannot resolve the published folder's wiki space.");
		}
		let cursor = "";
		const seen = new Set<string>();
		do {
			const args = ["wiki", "+node-list", "--as", "user", "--space-id", spaceId, "--page-size", "50", "--json"];
			if (parent.token) args.push("--parent-node-token", parent.token);
			if (cursor) args.push("--page-token", cursor);
			const result = await this.runLarkCli(args);
			const data = result.data;
			if (!Array.isArray(data?.nodes)) throw new Error("Invalid wiki folder listing.");
			nodes.push(...data.nodes);
			cursor = data.has_more ? data.page_token || data.next_page_token || "" : "";
			if (data.has_more && (!cursor || seen.has(cursor))) throw new Error("Incomplete remote folder listing; operation stopped.");
			seen.add(cursor);
		} while (cursor);
		return nodes;
	}

	private async listRemoteDocuments(parent: RemoteParent, objType: "docx" | "file" | "folder" = "docx"): Promise<Array<BoundLarkDocument & { title: string }>> {
		const documents: Array<BoundLarkDocument & { title: string }> = [];
		const wiki = parent.kind === "wiki" || parent.kind === "my_library";
		if (wiki) {
			for (const node of await this.listRemoteWikiNodes(parent)) {
				if (node.obj_type === objType && node.obj_token && node.title) {
					documents.push({ title: node.title, token: node.obj_token, nodeToken: node.node_token, url: node.url || "" });
				}
			}
			return documents;
		}
		let cursor = "";
		const seen = new Set<string>();
		do {
			const args = ["drive", "files", "list", "--as", "user", "--folder-token", parent.token, "--page-size", "200", "--json"];
			if (cursor) args.push("--page-token", cursor);
			const result = await this.runLarkCli(args);
			const data = result.data;
			if (!Array.isArray(data?.files)) throw new Error("Invalid Drive folder listing.");
			for (const file of data.files) {
				if (file.type === objType) {
					if (!file.token || typeof file.name !== "string") throw new Error("Invalid Drive file in folder listing.");
					documents.push({ title: file.name, token: file.token, url: file.url || "" });
				}
			}
			cursor = data?.has_more ? data.page_token || data.next_page_token || "" : "";
			if (data?.has_more && (!cursor || seen.has(cursor))) throw new Error("Incomplete remote folder listing; binding recovery stopped.");
			seen.add(cursor);
		} while (cursor);
		return documents;
	}

	private async recoverPreparedBindings(files: FolderPreparedFile[], parents: Map<string, RemoteParent>, strict: boolean, onlyPath?: string, overwrite = false): Promise<{ recovered: number; conflicts: number }> {
		let recovered = 0, conflicts = 0;
		const listings = new Map<string, Array<BoundLarkDocument & { title: string }>>();
		const localCounts = new Map<string, number>();
		const boundTokens = new Set(Object.values(this.settings.documentBindings).map((binding) => getDocumentStateKey(binding.token || binding.url)));
		if (!files.some((prepared) => !prepared.binding && !this.settings.disconnectedBindings?.[prepared.file.path])) return { recovered, conflicts };
		for (const file of this.app.vault.getMarkdownFiles()) {
			const binding = this.getBinding(file);
			if (!binding) continue;
			boundTokens.add(getDocumentStateKey(binding.token || binding.url));
			if (binding.url) boundTokens.add(extractDocumentToken(binding.url));
		}
		for (const prepared of files) {
			if (prepared.binding || this.settings.disconnectedBindings?.[prepared.file.path]) continue;
			const parent = parents.get(prepared.remoteParentPath);
			const title = extractTitle(prepared.file, prepared.preparedContent.content, "first-heading");
			const key = `${parent?.kind}:${parent?.token}:${title}`;
			localCounts.set(key, (localCounts.get(key) || 0) + 1);
		}
		for (const prepared of files) {
			if (prepared.binding || this.settings.disconnectedBindings?.[prepared.file.path]) continue;
			if (onlyPath && prepared.file.path !== onlyPath) continue;
			const parent = parents.get(prepared.remoteParentPath);
			if (!parent?.token || parent.kind === "unknown") continue;
			const key = `${parent.kind}:${parent.token}`;
			let remote = listings.get(key);
			if (!remote) { remote = await this.listRemoteDocuments(parent); listings.set(key, remote); }
			const title = extractTitle(prepared.file, prepared.preparedContent.content, "first-heading");
			const matches = remote.filter((document) => document.title === title);
			if (!matches.length) continue;
			const localAmbiguous = (localCounts.get(`${parent.kind}:${parent.token}:${title}`) || 0) > 1;
			if (overwrite && localAmbiguous) throw new LocalizedSyncError(this.settings.language === "en"
				? `Local notes have the same document title: ${title}. Use distinct titles before overwrite sync.`
				: `本地有多篇笔记使用文档标题“${title}”，请先使用不同标题，再覆盖同步。`);
			const match = overwrite ? this.selectOverwriteMatch(prepared.file.path, matches)! : matches[0]!;
			const alreadyBound = boundTokens.has(getDocumentStateKey(match.token)) || Boolean(match.nodeToken && boundTokens.has(match.nodeToken));
			if (!overwrite && (matches.length !== 1 || alreadyBound || localAmbiguous)) {
				conflicts += 1;
				if (strict) {
					if (localAmbiguous) throw new LocalizedSyncError(this.settings.language === "en"
						? `Local notes share the document title ${title}. Use distinct titles before syncing.`
						: `本地同级笔记的文档标题重复：“${title}”。请先使用不同标题，再同步。`);
					if (alreadyBound) this.assertRemoteBindingExclusive(prepared.file.path, match);
					throw new LocalizedSyncError(this.settings.language === "en"
						? `Several files match ${prepared.file.path} in Feishu. Use Set Feishu/Lark link or Overwrite sync.`
						: `飞书中有多个同名文件：${prepared.file.path}。请右键选择“设置飞书链接”或“覆盖同步到飞书”。`);
				}
				continue;
			}
			if (!match.url) {
				const info = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", match.token, "--type", "docx", "--json"]);
				match.url = info.data?.url || "";
				if (!match.url) throw new Error(this.t("errorNoDocumentToken"));
			}
			prepared.binding = { ...match, containerToken: parent.token, containerKind: parent.kind };
			await this.rememberDocumentBinding(prepared.file, prepared.binding);
			boundTokens.add(getDocumentStateKey(prepared.binding.token));
			recovered += 1;
		}
		return { recovered, conflicts };
	}

	private async recoverPublishedBindings(scope: string): Promise<string> {
		const files: FolderPreparedFile[] = [];
		const parents = new Map<string, RemoteParent>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isPathWithin(file.path, scope) || this.getBinding(file)) continue;
			const published = this.findPublishedFolderForFile(file);
			if (!published) continue;
			const remotePath = this.getRemoteParentPath(published.folderPath, file, published.binding.remoteRoot);
			const folder = this.getRemoteFolderBinding(published.binding, remotePath);
			if (!folder?.token) continue;
			const parent = { token: folder.token, kind: folder.containerKind || published.binding.rootParent.kind };
			const key = `${parent.kind}:${parent.token}`;
			parents.set(key, parent);
			const raw = await this.app.vault.read(file);
			files.push({ file, binding: null, remoteParentPath: key, preparedContent: {
				content: prepareNoteContentForLark(file, removeLarkBinding(removeBindingOnlyFrontmatterBeforeNextFrontmatter(raw)), this.settings.titleSource), images: []
			} });
		}
		const { recovered, conflicts } = await this.recoverPreparedBindings(files, parents, false);
		return this.settings.language === "en"
			? `Found ${recovered} note links. ${conflicts} files need a link set manually.`
			: `已找到 ${recovered} 篇笔记的链接。${conflicts} 个同名文件需手动设置链接。`;
	}

	t(key: MessageKey, params: Record<string, string> = {}): string {
		const messages = MESSAGES[this.settings.language] || MESSAGES["zh-CN"];
		let text: string = messages[key] || MESSAGES.en[key];

		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, value);
		}

		return text;
	}
}

class LarkCliSyncSettingTab extends PluginSettingTab {
	private readonly plugin: LarkCliSyncPlugin;
	private unsubscribeCliManagement: (() => void) | null = null;

	constructor(app: App, plugin: LarkCliSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		this.unsubscribeCliManagement?.();
		this.unsubscribeCliManagement = null;
		super.hide();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const t = (key: MessageKey): string => this.plugin.t(key);
		return [
			{
				type: "group",
				heading: t("settingsSectionGeneral"),
				cls: "feishu-lark-settings-section",
				items: [
					{
						name: t("settingLanguageName"),
						desc: t("settingLanguageDesc"),
						control: {
							type: "dropdown",
							key: "language",
							options: {
								"zh-CN": t("languageChinese"),
								en: t("languageEnglish")
							},
							defaultValue: "zh-CN"
						}
					},
					{
						name: t("settingDefaultTargetName"),
						desc: t("settingDefaultTargetDesc"),
						control: {
							type: "text",
							key: "targetTokenOrUrl",
							placeholder: "https://xxx.feishu.cn/wiki/...",
							defaultValue: ""
						}
					}
				]
			},
			{
				type: "group",
				heading: t("settingsSectionCli"),
				cls: "feishu-lark-settings-section",
				items: this.getCliSettingDefinitions()
			},
			{
				type: "group",
				heading: t("settingsSectionNetwork"),
				cls: "feishu-lark-settings-section",
				items: this.getProxySettingDefinitions()
			},
			{
				type: "group",
				heading: t("settingsSectionContent"),
				cls: "feishu-lark-settings-section",
				items: [
					{
						name: t("settingTitleSourceName"),
						desc: t("settingTitleSourceDesc"),
						control: {
							type: "dropdown",
							key: "titleSource",
							options: {
								"first-heading": t("titleSourceFirstHeading"),
								"file-name": t("titleSourceFileName")
							},
							defaultValue: DEFAULT_SETTINGS.titleSource
						}
					},
					{
						name: t("settingNativeCalloutName"),
						desc: t("settingNativeCalloutDesc"),
						control: { type: "toggle", key: "nativeCalloutExport", defaultValue: DEFAULT_SETTINGS.nativeCalloutExport }
					},
					{
						name: t("settingResearchColorsName"),
						desc: t("settingResearchColorsDesc"),
						control: { type: "toggle", key: "researchLabelColors", defaultValue: DEFAULT_SETTINGS.researchLabelColors }
					},
					{
						name: t("settingWriteBindingName"),
						desc: t("settingWriteBindingDesc"),
						control: {
							type: "toggle",
							key: "updateFrontmatter",
							defaultValue: DEFAULT_SETTINGS.updateFrontmatter
						}
					},
					{
						name: t("settingOpenAfterSyncName"),
						desc: t("settingOpenAfterSyncDesc"),
						control: {
							type: "toggle",
							key: "openAfterSync",
							defaultValue: DEFAULT_SETTINGS.openAfterSync
						}
					}
				]
			},
			{
				type: "group",
				heading: t("settingsSectionSync"),
				cls: "feishu-lark-settings-section",
				items: [
					{
						name: t("settingSyncStrategyName"),
						desc: t("settingSyncStrategyDesc"),
						control: {
							type: "dropdown",
							key: "syncStrategy",
							options: {
								auto: t("syncStrategyAuto"),
								precise: t("syncStrategyPrecise"),
								overwrite: t("syncStrategyOverwrite")
							},
							defaultValue: DEFAULT_SETTINGS.syncStrategy
						}
					},
					{
						name: t("settingAutoSyncModeName"),
						desc: t("settingAutoSyncModeDesc"),
						control: {
							type: "dropdown",
							key: "autoSyncMode",
							options: {
								manual: t("autoSyncModeManual"),
								save: t("autoSyncModeSave"),
								"pre-push": t("autoSyncModePrePush")
							},
							defaultValue: DEFAULT_SETTINGS.autoSyncMode
						}
					},
					{
						name: t("settingAutoSyncDelayName"),
						desc: t("settingAutoSyncDelayDesc"),
						control: {
							type: "number",
							key: "autoSyncDelaySeconds",
							placeholder: String(DEFAULT_AUTO_SYNC_DELAY_SECONDS),
							min: 1,
							step: 1,
							defaultValue: DEFAULT_AUTO_SYNC_DELAY_SECONDS
						}
					},
					{
						name: t("settingSyncIgnoreName"),
						desc: t("settingSyncIgnoreDesc"),
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText(t("openSyncIgnoreButton")).onClick(() => {
									void this.plugin.openSyncIgnore();
								});
							});
						}
					},
					{
						name: t("settingDeleteMissingRemoteName"),
						desc: t("settingDeleteMissingRemoteDesc"),
						control: {
							type: "toggle",
							key: "deleteMissingRemote",
							defaultValue: DEFAULT_SETTINGS.deleteMissingRemote
						}
					},
					{
						name: t("settingStateCacheName"),
						desc: t("settingStateCacheDesc"),
						control: {
							type: "number",
							key: "stateCacheRetainLimit",
							placeholder: String(DEFAULT_STATE_CACHE_RETAIN_LIMIT),
							min: 1,
							step: 1,
							defaultValue: DEFAULT_STATE_CACHE_RETAIN_LIMIT
						}
					}
				]
			},
			{
				type: "group",
				heading: t("settingsSectionGitHook"),
				cls: "feishu-lark-settings-section",
				items: [
					{
						name: t("settingInstallPrePushHookName"),
						desc: t("settingInstallPrePushHookDesc"),
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText(t("installPrePushHookButton")).onClick(async () => {
									await this.plugin.installPrePushHook();
									this.update();
								});
							});
							this.renderPrePushHookStatus(setting);
						}
					}
				]
			}
		];
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof LarkCliSyncSettings];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		let refreshSettings = false;
		switch (key) {
			case "language":
				settings.language = value === "en" ? "en" : "zh-CN";
				refreshSettings = true;
				break;
			case "targetTokenOrUrl":
				settings.targetTokenOrUrl = typeof value === "string" ? value.trim() : "";
				break;
			case "titleSource":
				settings.titleSource = value === "first-heading" ? "first-heading" : "file-name";
				break;
			case "nativeCalloutExport":
				settings.nativeCalloutExport = value === true;
				break;
			case "researchLabelColors":
				settings.researchLabelColors = value === true;
				break;
			case "updateFrontmatter":
				settings.updateFrontmatter = value === true;
				break;
			case "openAfterSync":
				settings.openAfterSync = value === true;
				break;
			case "syncStrategy":
				settings.syncStrategy = value === "precise" || value === "overwrite" ? value : "auto";
				break;
			case "autoSyncMode":
				settings.autoSyncMode = value === "manual" || value === "pre-push" ? value : "save";
				refreshSettings = true;
				break;
			case "deleteMissingRemote":
				settings.deleteMissingRemote = value === true;
				break;
			case "autoSyncDelaySeconds":
				settings.autoSyncDelaySeconds = this.normalizePositiveInteger(value, DEFAULT_SETTINGS.autoSyncDelaySeconds);
				break;
			case "stateCacheRetainLimit":
				settings.stateCacheRetainLimit = this.normalizePositiveInteger(value, DEFAULT_STATE_CACHE_RETAIN_LIMIT);
				break;
			case "larkCliPath":
				settings.larkCliPath = (typeof value === "string" ? value.trim() : "") || DEFAULT_SETTINGS.larkCliPath;
				break;
			case "larkCliBrand":
				settings.larkCliBrand = normalizeLarkCliBrand(value);
				break;
			case "proxyMode":
				settings.proxyMode = normalizeProxyMode(value);
				refreshSettings = true;
				break;
			case "proxyHost":
				settings.proxyHost = normalizeProxyHost(value);
				break;
			case "proxyPort":
				settings.proxyPort = normalizeProxyPort(value);
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (refreshSettings) this.update();
	}

	private normalizePositiveInteger(value: unknown, fallback: number): number {
		const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
		return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
	}

	private getCliSettingDefinitions(): SettingGroupItem[] {
		let latestStatus: LarkCliManagementStatus | null = null;
		let installBusy = false;
		let authBusy = false;
		let loginBusy = false;
		let configBusy = false;
		let disposed = false;
		let statusEl: HTMLElement | null = null;
		let accountStatusEl: HTMLElement | null = null;
		let configStatusEl: HTMLElement | null = null;
		let configSettingEl: HTMLElement | null = null;
		let refreshButton: ButtonComponent | null = null;
		let actionButton: ButtonComponent | null = null;
		let loginButton: ButtonComponent | null = null;
		let logoutButton: ButtonComponent | null = null;
		let openAuthorizationButton: ButtonComponent | null = null;
		let cancelAuthorizationButton: ButtonComponent | null = null;
		let configButton: ButtonComponent | null = null;
		let configDropdown: import("obsidian").DropdownComponent | null = null;

		const renderStatus = (): void => {
			if (disposed || !latestStatus || !statusEl) return;
			const status = latestStatus;
			const lines: string[] = [];
			if (!status.installed) {
				lines.push(this.plugin.t("cliStatusMissing"));
			} else if (status.version) {
				lines.push(this.plugin.t("cliStatusInstalled", { version: status.version }));
				if (!status.supported) {
					lines.push(this.plugin.t("cliStatusUnsupported", {
						version: status.version,
						minimum: MIN_EXCLUSIVE_LARK_CLI_VERSION
					}));
				}
			} else {
				lines.push(this.plugin.t("cliStatusVersionUnknown"));
			}
			lines.push(status.npm.available
				? this.plugin.t("cliStatusNpmReady", { version: status.npm.version || "npm" })
				: this.plugin.t("cliStatusNpmMissing"));
			if (status.installed) {
				if (status.latestVersion && status.updateAvailable) {
					lines.push(this.plugin.t("cliStatusUpdateAvailable", { version: status.latestVersion }));
				} else if (status.latestVersion) {
					lines.push(this.plugin.t("cliStatusUpToDate"));
				} else if (status.updateError) {
					lines.push(this.plugin.t("cliStatusUpdateUnknown"));
				}
			}
			statusEl.setText(lines.join("\n"));
			statusEl.removeClass("is-success", "is-warning", "is-error", "is-muted");
			if (!status.installed) statusEl.addClass("is-warning");
			else if (!status.supported) statusEl.addClass("is-error");
			else if (!status.npm.available || status.updateAvailable) statusEl.addClass("is-warning");
			else statusEl.addClass("is-success");
		};

		const updateCliButtons = (): void => {
			if (disposed) return;
			const pending = this.plugin.getPendingLarkCliAuthorization();
			const configured = latestStatus?.auth.configured === true;
			const authError = Boolean(latestStatus?.authError);
			const hasAccount = Boolean(latestStatus?.authStatus?.loggedIn
				|| latestStatus?.auth.users.some((user) => user.tokenStatus && user.tokenStatus !== "no_token"));

			if (latestStatus) {
				const status = latestStatus;
				accountStatusEl?.setText(pending?.kind === "app-configuration"
					? this.plugin.t("cliAppSetupWaiting")
					: pending?.kind === "login"
						? this.plugin.t("loginCliWaiting")
						: status.authError
							? this.plugin.t("cliAccountError", { message: this.formatOperationError(status.authError) })
							: !status.installed
								? this.plugin.t("cliStatusMissing")
								: !status.auth.configured
									? this.plugin.t("cliAccountNotConfigured")
									: hasAccount
										? this.plugin.t("cliAccountLoggedIn", {
											user: status.authStatus?.userName || status.auth.users[0]?.userName || "Lark",
											brand: status.authStatus?.brand?.toLowerCase() === "lark"
												? this.plugin.t("brandLark")
												: this.plugin.t("brandFeishu")
										})
										: this.plugin.t("cliAccountLoggedOut"));
				accountStatusEl?.removeClass("is-success", "is-warning", "is-error", "is-muted");
				if (!status.installed) accountStatusEl?.addClass("is-error");
				else if (pending) accountStatusEl?.addClass("is-warning");
				else if (status.authError) accountStatusEl?.addClass("is-error");
				else if (!configured || !hasAccount) accountStatusEl?.addClass("is-warning");
				else accountStatusEl?.addClass("is-success");

				if (actionButton) {
					actionButton.setDisabled(installBusy || Boolean(pending) || authBusy || configBusy);
					actionButton.setButtonText(installBusy
						? this.plugin.t(status.installed ? "upgradingCli" : "installingCli")
						: !status.installed
							? this.plugin.t(status.npm.available ? "installCliButton" : "installNodeButton")
							: status.updateAvailable && status.latestVersion
								? this.plugin.t("upgradeCliVersionButton", { version: status.latestVersion })
								: status.latestVersion
									? this.plugin.t("reinstallCliButton")
									: this.plugin.t("upgradeCliButton"));
				}
			}

			if (loginButton) {
				loginButton.setDisabled(installBusy || authBusy || (!configured && !authError) || !latestStatus?.installed
					|| pending?.kind === "app-configuration" || pending?.kind === "login");
				loginButton.setButtonText(pending?.kind === "login"
					? this.plugin.t("loginCliWaitingButton")
					: loginBusy
						? this.plugin.t("loginCliOpening")
						: this.plugin.t("loginCliButton"));
			}
			if (openAuthorizationButton) {
				openAuthorizationButton.setDisabled(!pending?.verificationUrl);
				openAuthorizationButton.buttonEl.toggleClass("feishu-lark-settings-hidden", !pending?.verificationUrl);
			}
			if (cancelAuthorizationButton) {
				cancelAuthorizationButton.setDisabled(!pending);
				cancelAuthorizationButton.buttonEl.toggleClass("feishu-lark-settings-hidden", !pending);
			}
			if (logoutButton) {
				logoutButton.setDisabled(installBusy || authBusy || !configured || !hasAccount);
			}

			const showConfig = Boolean(latestStatus?.installed && !authError && !configured);
			configSettingEl?.toggleClass("feishu-lark-settings-hidden", !showConfig);
			if (showConfig) {
				const setupRunning = pending?.kind === "app-configuration" || configBusy || installBusy;
				configDropdown?.setDisabled(setupRunning);
				if (configButton) {
					configButton.setDisabled(setupRunning);
					configButton.setButtonText(setupRunning
						? this.plugin.t("cliAppSetupStarting")
						: this.plugin.t("createCliAppButton"));
				}
				configStatusEl?.setText(setupRunning ? this.plugin.t("cliAppSetupWaiting") : "");
			}
		};

		const refreshStatus = async (): Promise<void> => {
			if (disposed) return;
			statusEl?.setText(this.plugin.t("cliStatusChecking"));
			accountStatusEl?.setText(this.plugin.t("cliAccountChecking"));
			refreshButton?.setDisabled(true);
			actionButton?.setDisabled(true);
			try {
				const status = await this.plugin.getLarkCliManagementStatus();
				if (disposed || !statusEl?.isConnected) return;
				latestStatus = status;
				renderStatus();
				updateCliButtons();
			} catch (error) {
				if (disposed || !statusEl?.isConnected) return;
				statusEl.setText(this.plugin.t("cliStatusUpdateUnknown"));
				statusEl.removeClass("is-success", "is-warning", "is-error", "is-muted");
				statusEl.addClass("is-error");
				accountStatusEl?.setText(this.plugin.t("cliAccountError", {
					message: this.formatOperationError(error)
				}));
			} finally {
				refreshButton?.setDisabled(false);
			}
		};

		return [
			{
				name: this.plugin.t("settingLarkCliStatusName"),
				desc: this.plugin.t("settingLarkCliStatusDesc"),
				render: (setting) => {
					statusEl = setting.descEl.createDiv({
						cls: "feishu-lark-cli-status is-muted",
						text: this.plugin.t("cliStatusChecking")
					});
					setting.addButton((button) => {
						refreshButton = button;
						button.setButtonText(this.plugin.t("recheckCliButton")).onClick(() => {
							void refreshStatus();
						});
					});
					setting.addButton((button) => {
						actionButton = button;
						button.setButtonText(this.plugin.t("installCliButton")).setDisabled(true).onClick(async () => {
							if (installBusy || !latestStatus) return;
							if (!latestStatus.npm.available && !latestStatus.installed) {
								window.open(NODE_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
								return;
							}
							installBusy = true;
							updateCliButtons();
							try {
								await this.plugin.installOrUpgradeLarkCli();
							} catch (error) {
								new Notice(this.plugin.t("noticeCliInstallFailed", {
									message: this.formatOperationError(error)
								}));
							} finally {
								installBusy = false;
								await refreshStatus();
							}
						});
					});
					this.unsubscribeCliManagement?.();
					const unsubscribe = this.plugin.subscribeLarkCliManagementChanges(() => {
						if (statusEl?.isConnected) void refreshStatus();
					});
					this.unsubscribeCliManagement = unsubscribe;
					void refreshStatus();
					return () => {
						disposed = true;
						if (this.unsubscribeCliManagement === unsubscribe) {
							this.unsubscribeCliManagement = null;
						}
						unsubscribe();
					};
				}
			},
			{
				name: this.plugin.t("settingLarkCliPathName"),
				desc: this.plugin.t("settingLarkCliPathDesc"),
				control: {
					type: "text",
					key: "larkCliPath",
					placeholder: "lark-cli",
					defaultValue: DEFAULT_SETTINGS.larkCliPath
				}
			},
			{
				name: this.plugin.t("settingLarkCliAccountName"),
				desc: this.plugin.t("settingLarkCliAccountDesc"),
				render: (setting) => {
					accountStatusEl = setting.descEl.createDiv({
						cls: "feishu-lark-cli-status is-muted",
						text: this.plugin.t("cliAccountChecking")
					});
					setting.addButton((button) => {
						loginButton = button;
						button.setButtonText(this.plugin.t("loginCliButton")).setDisabled(true).onClick(async () => {
							if (authBusy) return;
							const pending = this.plugin.getPendingLarkCliAuthorization();
							if (pending?.kind === "login" && pending.verificationUrl) {
								window.open(pending.verificationUrl, "_blank", "noopener,noreferrer");
								return;
							}
							authBusy = true;
							loginBusy = true;
							updateCliButtons();
							try {
								await this.plugin.startLarkCliLogin();
							} catch (error) {
								new Notice(this.plugin.t("loginCliFailed", { message: this.formatOperationError(error) }));
							} finally {
								authBusy = false;
								loginBusy = false;
								await refreshStatus();
							}
						});
					});
					setting.addButton((button) => {
						openAuthorizationButton = button;
						button.setButtonText(this.plugin.t("loginCliOpenButton")).setDisabled(true).onClick(() => {
							const pending = this.plugin.getPendingLarkCliAuthorization();
							if (pending?.verificationUrl) {
								window.open(pending.verificationUrl, "_blank", "noopener,noreferrer");
							}
						});
					});
					setting.addButton((button) => {
						cancelAuthorizationButton = button;
						button.setButtonText(this.plugin.t("cancelCliOperationButton")).setDisabled(true).onClick(() => {
							this.plugin.cancelLarkCliAuthorization();
							void refreshStatus();
						});
					});
					setting.addButton((button) => {
						logoutButton = button;
						button.setButtonText(this.plugin.t("logoutCliButton")).setDisabled(true).onClick(async () => {
							if (authBusy) return;
							authBusy = true;
							updateCliButtons();
							try {
								await this.plugin.logoutLarkCli();
							} catch (error) {
								new Notice(this.plugin.t("logoutCliFailed", { message: this.formatOperationError(error) }));
							} finally {
								authBusy = false;
								await refreshStatus();
							}
						});
					});
					updateCliButtons();
				}
			},
			{
				name: this.plugin.t("cliAppSetupName"),
				desc: this.plugin.t("cliAppSetupDesc"),
				render: (setting) => {
					configSettingEl = setting.settingEl;
					setting.addDropdown((dropdown) => {
						configDropdown = dropdown;
						dropdown.addOption("feishu", this.plugin.t("brandFeishu"))
							.addOption("lark", this.plugin.t("brandLark"))
							.setValue(this.plugin.settings.larkCliBrand)
							.onChange(async (value) => {
								this.plugin.settings.larkCliBrand = normalizeLarkCliBrand(value);
								await this.plugin.saveSettings();
							});
					});
					setting.addButton((button) => {
						configButton = button;
						button.setButtonText(this.plugin.t("createCliAppButton")).setDisabled(true).onClick(async () => {
							if (configBusy) return;
							configBusy = true;
							updateCliButtons();
							try {
								await this.plugin.startLarkCliAppConfiguration(this.plugin.settings.larkCliBrand);
							} catch (error) {
								new Notice(this.plugin.t("cliAppSetupFailed", { message: this.formatOperationError(error) }));
							} finally {
								configBusy = false;
								await refreshStatus();
							}
						});
					});
					configStatusEl = setting.descEl.createDiv({ cls: "feishu-lark-cli-status is-muted" });
					updateCliButtons();
				}
			}
		];
	}

	private getProxySettingDefinitions(): SettingGroupItem[] {
		let hostSetting: Setting | null = null;
		let portSetting: Setting | null = null;
		let systemProxyEl: HTMLElement | null = null;
		let proxyDetailEl: HTMLElement | null = null;

		const updateProxySettings = (): void => {
			const mode = normalizeProxyMode(this.plugin.settings.proxyMode);
			const custom = mode === "custom";
			hostSetting?.settingEl.toggleClass("feishu-lark-settings-hidden", !custom);
			portSetting?.settingEl.toggleClass("feishu-lark-settings-hidden", !custom);
			if (mode === "system") {
				const detected = detectProxyEnvironment(process.env);
				systemProxyEl?.setText(detected
					? this.plugin.t("proxySystemDetected", { key: detected.key, value: detected.value })
					: this.plugin.t("proxySystemNotDetected"));
			} else {
				systemProxyEl?.setText("");
			}
			proxyDetailEl?.setText(custom
				? this.plugin.t("proxyCustomStatus", {
					url: buildProxyUrl(this.plugin.settings.proxyHost, this.plugin.settings.proxyPort)
				})
				: "");
		};

		return [
			{
				name: this.plugin.t("settingProxyModeName"),
				desc: this.plugin.t("settingProxyModeDesc"),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown.addOption("system", this.plugin.t("proxyModeSystem"))
							.addOption("custom", this.plugin.t("proxyModeCustom"))
							.addOption("off", this.plugin.t("proxyModeOff"))
							.setValue(this.plugin.settings.proxyMode)
							.onChange(async (value) => {
								this.plugin.settings.proxyMode = normalizeProxyMode(value);
								await this.plugin.saveSettings();
								updateProxySettings();
							});
					});
					systemProxyEl = setting.descEl.createDiv({ cls: "feishu-lark-proxy-detail" });
					updateProxySettings();
				}
			},
			{
				name: this.plugin.t("proxyHostName"),
				desc: this.plugin.t("proxyHostDesc"),
				render: (setting) => {
					hostSetting = setting;
					setting.addText((text) => {
						text.setPlaceholder(DEFAULT_PROXY_HOST)
							.setValue(this.plugin.settings.proxyHost)
							.onChange(async (value) => {
								this.plugin.settings.proxyHost = normalizeProxyHost(value);
								await this.plugin.saveSettings();
								updateProxySettings();
							});
					});
					updateProxySettings();
				}
			},
			{
				name: this.plugin.t("proxyPortName"),
				desc: this.plugin.t("proxyPortDesc"),
				render: (setting) => {
					portSetting = setting;
					setting.addText((text) => {
						text.setPlaceholder(String(DEFAULT_PROXY_PORT))
							.setValue(String(this.plugin.settings.proxyPort))
							.onChange(async (value) => {
								this.plugin.settings.proxyPort = normalizeProxyPort(value);
								await this.plugin.saveSettings();
								updateProxySettings();
							});
					});
					proxyDetailEl = setting.descEl.createDiv({ cls: "feishu-lark-proxy-detail" });
					updateProxySettings();
				}
			}
		];
	}

	private formatOperationError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return (message.split("\n").find((line) => line.trim()) || message).trim().slice(0, MAX_NOTICE_ERROR_DETAIL_LENGTH);
	}

	private renderPrePushHookStatus(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({
			cls: "feishu-lark-pre-push-hook-status is-muted",
			text: this.plugin.t("prePushHookStatusChecking")
		});
		void this.plugin.getPrePushHookStatus().then((status) => {
			if (!statusEl.isConnected) return;
			statusEl.setText(this.getPrePushHookStatusText(status));
			statusEl.removeClass("is-installed", "is-error", "is-warning", "is-muted");
			statusEl.addClass(this.getPrePushHookStatusClass(status));
		}).catch((error: unknown) => {
			if (!statusEl.isConnected) return;
			statusEl.setText(this.plugin.t("prePushHookStatusUnavailable"));
			statusEl.removeClass("is-installed", "is-error", "is-warning", "is-muted");
			statusEl.addClass("is-muted");
			console.warn("[Feishu Docs Publisher] failed to check pre-push hook status", error);
		});
	}

	private getPrePushHookStatusText(status: PrePushHookStatus): string {
		if (status === "installed") {
			return this.plugin.t("prePushHookStatusInstalled");
		}

		if (status === "not-git-repository") {
			return this.plugin.t("prePushHookStatusNotGitRepository");
		}

		if (status === "unavailable" || status === "unknown") {
			return this.plugin.t("prePushHookStatusUnavailable");
		}

		if (this.plugin.settings.autoSyncMode !== "pre-push") {
			return this.plugin.t("prePushHookStatusMissingInactive");
		}

		return this.plugin.t("prePushHookStatusMissing");
	}

	private getPrePushHookStatusClass(status: PrePushHookStatus): string {
		if (status === "installed") {
			return "is-installed";
		}

		if (status === "not-installed" && this.plugin.settings.autoSyncMode === "pre-push") {
			return "is-error";
		}

		if (status === "not-git-repository") {
			return "is-warning";
		}

		return "is-muted";
	}
}
