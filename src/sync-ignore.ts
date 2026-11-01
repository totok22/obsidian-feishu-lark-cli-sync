import { IgnoreRules } from "./ignore-rules";

/** The slice of TAbstractFile the ignore tree needs, so the tree can be built without Obsidian. */
export interface VaultNodeLike {
	path: string;
	name: string;
	extension?: string;
	children?: VaultNodeLike[];
}

export interface IgnoreTreeNode {
	path: string;
	name: string;
	isFolder: boolean;
	children: IgnoreTreeNode[];
}

/** "ignored": a rule covers it; "partial": something inside is ignored; "included": synced as usual. */
export type IgnoreState = "ignored" | "partial" | "included";

export const IGNORE_FILE_HEADER = "# Feishu Docs Publisher: files and folders listed here are not synced. Same syntax as .gitignore.";

const SYNCED_EXTENSIONS = new Set(["md", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** Only notes, PDFs, and images reach Feishu, so only they (and folders holding them) are worth listing. */
export function buildIgnoreTree(root: VaultNodeLike): IgnoreTreeNode {
	const build = (node: VaultNodeLike): IgnoreTreeNode | null => {
		if (!node.children) {
			return node.extension && SYNCED_EXTENSIONS.has(node.extension.toLowerCase())
				? { path: node.path, name: node.name, isFolder: false, children: [] }
				: null;
		}
		const children = node.children.map(build).filter((child): child is IgnoreTreeNode => child !== null)
			.sort((left, right) => Number(right.isFolder) - Number(left.isFolder) || left.name.localeCompare(right.name));
		return { path: node.path, name: node.name, isFolder: true, children };
	};
	const hasFiles = (node: IgnoreTreeNode): boolean => node.children.some((child) => !child.isFolder || hasFiles(child));
	const prune = (node: IgnoreTreeNode): IgnoreTreeNode => ({
		...node,
		children: node.children.filter((child) => !child.isFolder || hasFiles(child)).map(prune)
	});
	const tree = build(root);
	return tree ? prune(tree) : { path: root.path, name: root.name, isFolder: true, children: [] };
}

export function indexIgnoreTree(root: IgnoreTreeNode): Map<string, IgnoreTreeNode> {
	const index = new Map<string, IgnoreTreeNode>();
	const visit = (node: IgnoreTreeNode): void => {
		index.set(node.path, node);
		node.children.forEach(visit);
	};
	visit(root);
	return index;
}

/** The state of every node below the root, judged by the rules that apply to its vault path. */
export function computeIgnoreStates(rules: IgnoreRules, root: IgnoreTreeNode): Map<string, IgnoreState> {
	const states = new Map<string, IgnoreState>();
	const visit = (node: IgnoreTreeNode): IgnoreState => {
		const childStates = node.children.map(visit);
		const state: IgnoreState = rules.isIgnored(node.path, node.isFolder) ? "ignored"
			: childStates.some((childState) => childState !== "included") ? "partial" : "included";
		states.set(node.path, state);
		return state;
	};
	root.children.forEach(visit);
	return states;
}

/** Lines that are neither blank nor comments. */
export function listRuleLines(text: string): string[] {
	return splitLines(text).filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

/** Drop every rule but keep comments and blank lines. */
export function clearRuleLines(text: string): string {
	return joinLines(splitLines(text).filter((line) => line.trim() === "" || line.startsWith("#")));
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function joinLines(lines: string[]): string {
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function escapePattern(path: string): string {
	return path.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ");
}

/** The anchored line this page writes for a path: "/Drafts/" for a folder, "/notes.md" for a file. */
export function formatRule(path: string, isFolder: boolean, negative = false): string {
	return `${negative ? "!" : ""}/${escapePattern(path)}${isFolder ? "/" : ""}`;
}

/** Recognise a plain path rule such as "/Drafts/" or "!/a.md"; wildcard rules are not plain. */
function parsePlainRule(line: string): { path: string; negative: boolean } | null {
	let rest = line.normalize("NFC");
	const negative = rest.startsWith("!");
	if (negative) rest = rest.slice(1);
	if (!rest.startsWith("/")) return null;
	rest = rest.slice(1);
	if (rest.endsWith("/") && !rest.endsWith("\\/")) rest = rest.slice(0, -1);
	let path = "";
	for (let index = 0; index < rest.length; index += 1) {
		const char = rest[index]!;
		if (char === "\\") {
			index += 1;
			if (index >= rest.length) return null;
			path += rest[index];
		} else if (char === "*" || char === "?" || char === "[") {
			return null;
		} else {
			path += char;
		}
	}
	return path && !path.endsWith(" ") ? { path, negative } : null;
}

/** What the page needs to know about everything but the rule file it edits. Paths are relative to the sync folder. */
export interface IgnoreEditContext {
	isIgnored(text: string, path: string, isFolder: boolean): boolean;
	/** The rule that ignores the path, for messages. */
	explain(text: string, path: string, isFolder: boolean): string;
	listChildren(path: string): { path: string; isFolder: boolean }[];
}

export type IgnoreEditResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Ignore or include one path by editing the rule file's lines.
 * Including something under an ignored folder splits that folder's rule so its other children stay ignored;
 * anything a wildcard rule ignores is brought back with a "!" line.
 */
export function setPathIgnored(
	text: string,
	path: string,
	isFolder: boolean,
	ignore: boolean,
	ctx: IgnoreEditContext
): IgnoreEditResult {
	const target = path.normalize("NFC");
	let lines = splitLines(text);
	const check = (): boolean => ctx.isIgnored(joinLines(lines), target, isFolder);
	const withHeader = (): string[] => lines.length === 0 ? [IGNORE_FILE_HEADER] : lines;
	const insideTarget = (candidate: string): boolean => candidate === target || candidate.startsWith(`${target}/`);

	if (ignore) {
		if (check()) return { ok: true, text: joinLines(lines) };
		// A "!" line that spared this path would keep it included, and so would one for anything inside it.
		lines = lines.filter((line) => {
			const rule = parsePlainRule(line);
			return !(rule && insideTarget(rule.path));
		});
		if (!check()) {
			lines = withHeader();
			lines.push(formatRule(target, isFolder));
		}
		lines = collapseFullyIgnoredFolders(lines, target, ctx);
		return check() ? { ok: true, text: joinLines(lines) } : { ok: false, reason: ctx.explain(joinLines(lines), target, isFolder) };
	}

	lines = lines.filter((line) => {
		const rule = parsePlainRule(line);
		return !(rule && !rule.negative && insideTarget(rule.path));
	});
	for (let attempt = 0; attempt < 64 && check(); attempt += 1) {
		const coveringIndex = lines.findIndex((line) => {
			const rule = parsePlainRule(line);
			return rule !== null && !rule.negative && target.startsWith(`${rule.path}/`);
		});
		if (coveringIndex < 0) break;
		// Walk from the covering folder down to the target; at every level the other children stay ignored.
		const others: string[] = [];
		let current = parsePlainRule(lines[coveringIndex]!)!.path;
		while (current !== target) {
			const route = `${current}/${target.slice(current.length + 1).split("/")[0]}`;
			for (const child of ctx.listChildren(current)) {
				if (child.path !== route) others.push(formatRule(child.path, child.isFolder));
			}
			current = route;
		}
		lines.splice(coveringIndex, 1, ...others);
	}
	if (check()) {
		const spare = formatRule(target, isFolder, true);
		if (!lines.includes(spare)) lines.push(spare);
	}
	// A folder may be included while its descendants are still covered by wildcard
	// rules. Re-include the subtree, then verify deeper rule files did not block it.
	const findIgnored = (path: string, folder: boolean): { path: string; isFolder: boolean } | undefined => {
		if (ctx.isIgnored(joinLines(lines), path, folder)) return { path, isFolder: folder };
		if (folder) {
			for (const child of ctx.listChildren(path)) {
				const ignored = findIgnored(child.path, child.isFolder);
				if (ignored) return ignored;
			}
		}
		return undefined;
	};
	if (isFolder && !check() && findIgnored(target, true)) {
		const spareSubtree = `!/${escapePattern(target)}/**`;
		lines = lines.filter((line) => line !== spareSubtree);
		lines.push(spareSubtree);
	}
	const blocked = findIgnored(target, isFolder);
	return blocked ? { ok: false, reason: ctx.explain(joinLines(lines), blocked.path, blocked.isFolder) }
		: { ok: true, text: joinLines(lines) };
}

/** Once every child of a folder has its own plain rule, one rule for the folder says the same and also covers new files. */
function collapseFullyIgnoredFolders(lines: string[], path: string, ctx: IgnoreEditContext): string[] {
	let current = path;
	for (let slash = current.lastIndexOf("/"); slash > 0; slash = current.lastIndexOf("/")) {
		const parent = current.slice(0, slash);
		const children = ctx.listChildren(parent);
		const ruleLines = children.map((child) => lines.findIndex((line) => {
			const rule = parsePlainRule(line);
			return rule !== null && !rule.negative && rule.path === child.path;
		}));
		if (children.length === 0 || ruleLines.some((index) => index < 0)) return lines;
		const remove = new Set(ruleLines);
		lines = lines.filter((_, index) => !remove.has(index));
		lines.push(formatRule(parent, true));
		current = parent;
	}
	return lines;
}
