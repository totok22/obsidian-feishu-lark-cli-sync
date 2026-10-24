import MarkdownIt from "markdown-it";
import { createHash } from "crypto";
import { getNativeText, NativeText } from "./native-text";

const parser = new MarkdownIt({ html: true });
const icons: Record<string, string> = {
	note: "📝",
	tip: "💡",
	important: "❗",
	warning: "⚠️",
	caution: "⚠️",
	pdf: "📖"
};
export interface NativeCallout {
	open: string;
	close: string;
	kind: string;
	color?: string;
	foldable: boolean;
	collapsed: boolean;
}
export interface NativeCalloutDraft {
	markdown: string;
	callouts: NativeCallout[];
}
export interface NativeBlock {
	block_id: string;
	block_type: number;
	parent_id?: string;
	children?: string[];
	[key: string]: unknown;
}
export interface ConvertedBlocks {
	first_level_block_ids: string[];
	blocks: NativeBlock[];
}

/** Standalone boundary paragraphs survive native Markdown conversion. They are never published. */
export function prepareNativeCallouts(source: string): NativeCalloutDraft {
	const callouts: NativeCallout[] = [];
	const namespace = createHash("sha256").update(source).digest("hex").slice(0, 20);
	function visit(markdown: string): string {
		const lines = markdown.split("\n");
		const tokens = parser.parse(markdown, {});
		const edits: Array<{ start: number; end: number; content: string }> = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (token.type !== "blockquote_open" || !token.map) continue;
			const [start, end] = token.map;
			const indent = lines[start]!.match(/^( *)>/)?.[1];
			if (indent === undefined)
				throw new Error("Callout/quote inline in a list marker is not yet supported; no document was written.");
			let depth = 1,
				closeIndex = i + 1;
			for (; closeIndex < tokens.length; closeIndex++) {
				if (tokens[closeIndex]!.type === "blockquote_open") depth++;
				if (tokens[closeIndex]!.type === "blockquote_close" && --depth === 0) break;
			}
			const body = lines
				.slice(start, end)
				.map((line) => {
					const relative = line.startsWith(indent) ? line.slice(indent.length) : line;
					return relative.replace(/^ {0,3}>[ \t]?/, "");
				})
				.join("\n");
			const split = body.indexOf("\n");
			const header = split < 0 ? body : body.slice(0, split);
			const match = header.match(/^\[!([\w-]+)(?:\|([^\]]+))?\]([+-])?(?:[ \t]+(.*))?$/);
			let replacement: string;
			if (match) {
				const id = `${namespace}X${callouts.length}`;
				const kind = match[1]!.toLowerCase();
				const spec: NativeCallout = {
					open: `FDPCALLOUTOPEN${id}`,
					close: `FDPCALLOUTCLOSE${id}`,
					kind,
					color: match[2],
					foldable: !!match[3],
					collapsed: match[3] === "-"
				};
				callouts.push(spec);
				const title = match[4]?.trim() || kind.toUpperCase();
				const children = visit(split < 0 ? "" : body.slice(split + 1));
				replacement = `${spec.open} **${icons[kind] || "📝"} ${title}**\n\n${children}\n\n${spec.close}`;
			} else {
				const nested = visit(body);
				if (nested === body) {
					i = closeIndex;
					continue;
				}
				replacement = nested
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n");
			}
			edits.push({
				start,
				end,
				content:
					"\n" +
					replacement
						.split("\n")
						.map((line) => indent + line)
						.join("\n") +
					"\n"
			});
			i = closeIndex;
		}
		for (const edit of edits.reverse()) lines.splice(edit.start, edit.end - edit.start, edit.content);
		return lines.join("\n");
	}
	return { markdown: visit(source.replace(/\r\n/g, "\n")), callouts };
}

function textOf(block: NativeBlock): NativeText | undefined {
	return getNativeText(block.text || block.bullet || block.ordered);
}
function plainText(block: NativeBlock): string {
	return (
		textOf(block)
			?.elements.map((element) => element.text_run?.content || "")
			.join("") || ""
	);
}

/** Reparent already converted native blocks; do not flatten/rewrite code, formulas or tables. */
export function assembleNativeCallouts(converted: ConvertedBlocks, specs: NativeCallout[]): ConvertedBlocks {
	const blocks = JSON.parse(JSON.stringify(converted.blocks)) as NativeBlock[];
	const byId = new Map(blocks.map((block) => [block.block_id, block]));
	if (byId.size !== blocks.length) throw new Error("Duplicate converted block IDs");
	const opens = new Map(specs.map((spec) => [spec.open, spec]));
	const closes = new Map(specs.map((spec) => [spec.close, spec]));
	const removed = new Set<string>();
	const seen = new Set<string>();
	const active = new Set<string>();
	function group(ids: string[], parent?: string): string[] {
		const roots: string[] = [];
		const stack: Array<{ spec: NativeCallout; block: NativeBlock }> = [];
		for (const id of ids) {
			const block = byId.get(id);
			if (!block) throw new Error(`Missing converted block ${id}`);
			if (active.has(id)) throw new Error("Cyclic converted block tree");
			active.add(id);
			const text = plainText(block);
			const firstWord = text.split(/\s/, 1)[0]!;
			const opening = opens.get(firstWord);
			const closing = closes.get(text.trim());
			if (closing) {
				if (stack[stack.length - 1]?.spec !== closing || block.children?.length)
					throw new Error("Callout closing boundary mismatch");
				stack.pop();
				removed.add(id);
				active.delete(id);
				continue;
			}
			const owner = stack[stack.length - 1]?.block;
			(owner ? owner.children! : roots).push(id);
			if (owner || parent) block.parent_id = owner?.block_id || parent;
			else delete block.parent_id;
			const existingChildren = block.children?.slice() || [];
			if (opening) {
				if (seen.has(opening.open) || block.block_type !== 2 || existingChildren.length) {
					throw new Error("Callout opening must convert to an independent text block");
				}
				seen.add(opening.open);
				const richText = textOf(block)!;
				let remaining = opening.open.length + (text[opening.open.length] === " " ? 1 : 0);
				for (const element of richText.elements) {
					const run = element.text_run;
					if (!remaining || !run) continue;
					const count = Math.min(remaining, run.content.length);
					run.content = run.content.slice(count);
					remaining -= count;
				}
				if (remaining) throw new Error("Callout marker spans unsupported inline elements");
				richText.elements = richText.elements.filter(
					(element) => !element.text_run || element.text_run.content !== ""
				);
				const palette: Record<string, string> = {
					note: "Blue",
					tip: "Green",
					important: "Purple",
					warning: "Orange",
					caution: "Red",
					pdf: "Yellow"
				};
				const color =
					(
						{
							blue: "Blue",
							green: "Green",
							yellow: "Yellow",
							red: "Red",
							orange: "Orange",
							purple: "Purple",
							gray: "Gray"
						} as Record<string, string>
					)[opening.color || ""] ||
					palette[opening.kind] ||
					"Blue";
				richText.style = {
					...richText.style,
					folded: opening.collapsed,
					background_color: `Light${color}Background`
				};
				block.children = [];
				stack.push({ spec: opening, block });
			} else if (existingChildren.length) {
				block.children = group(existingChildren, id);
			}
			active.delete(id);
		}
		if (stack.length) throw new Error("Unclosed Callout boundary; refusing partial document");
		return roots;
	}
	const roots = group(converted.first_level_block_ids);
	if (seen.size !== specs.length)
		throw new Error("Native converter lost Callout boundaries; no document was written");
	return { first_level_block_ids: roots, blocks: blocks.filter((block) => !removed.has(block.block_id)) };
}
