import { colorBoldColonLabels } from "./label-colors";
import { LocalImageResource } from "./local-image";
import { readFile } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { assembleNativeCallouts, prepareNativeCallouts, ConvertedBlocks, NativeBlock } from "./native-callout";
import { transformProse } from "./obsidian-export";
import { getNativeText, isRecord, NativeTextElement } from "./native-text";

export type NativeApi = (
	method: string,
	path: string,
	body?: unknown,
	params?: Record<string, unknown>
) => Promise<Record<string, unknown>>;
export interface NativeUnit {
	id: string;
	hash: string;
	remoteHash: string;
}
export interface NativeState {
	version: 1;
	labelStyleVersion?: number;
	sourceHash: string;
	units: NativeUnit[];
	pending?: {
		sourceHash: string;
		labelStyleVersion?: number;
		request: { children_id: string[]; descendants: NativeBlock[]; index: number };
		clientToken: string;
		remove: string[];
		removeHashes: Record<string, string>;
		units: NativeUnit[];
		inserted?: boolean;
		imageRoots?: Array<{ id: string; index: number }>;
		imageUploads?: Array<{ id: string; placeholder: string; token?: string; done?: boolean }>;
	};
}
export interface NativeSyncHost {
	api: NativeApi;
	labelColors?: boolean;
	allowReplaceUntracked?: boolean;
	images?: LocalImageResource[];
	uploadImage?(blockId: string, image: LocalImageResource): Promise<string>;
	save(state: NativeState): Promise<void>;
	materialize?(): Promise<void>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = (doc: string) => `/open-apis/docx/v1/documents/${doc}`;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isNativeBlock(value: unknown): value is NativeBlock {
	return (
		isRecord(value) && typeof value.block_id === "string" && typeof value.block_type === "number" &&
		(value.children === undefined || isStringArray(value.children))
	);
}

export function nativeTreeHash(id: string, blocks: Map<string, NativeBlock>): string {
	function visit(key: string, path = new Set<string>()): unknown {
		if (path.has(key)) throw new Error("Cyclic native tree");
		const block = blocks.get(key);
		if (!block) throw new Error(`Missing native block ${key}`);
		const next = new Set(path).add(key);
		const clean: Record<string, unknown> = {};
		for (const name of Object.keys(block).sort()) {
			if (["block_id", "parent_id", "children", "comment_ids"].includes(name)) continue;
			// Fold/unfold is a reader interaction, never a content conflict.
			clean[name] = JSON.parse(JSON.stringify(block[name]), (k: string, v: unknown) =>
				k === "folded" ? undefined : v);
		}
		// Table cell IDs are structural references and vary on each conversion.
		if (isRecord(clean.table)) delete clean.table.cells;
		return { ...clean, children: (block.children || []).map((child) => visit(child, next)) };
	}
	return hash(visit(id));
}

export async function readNativeSnapshot(
	doc: string,
	api: NativeApi
): Promise<{ roots: string[]; blocks: Map<string, NativeBlock>; revision: number }> {
	const before = await api("GET", base(doc));
	const revision = isRecord(before.document) ? before.document.revision_id : undefined;
	if (typeof revision !== "number") throw new Error("Document revision unavailable");
	const blocks = new Map<string, NativeBlock>();
	let page: string | undefined;
	do {
		const data = await api("GET", `${base(doc)}/blocks`, undefined, {
			page_size: 500,
			...(page ? { page_token: page } : {})
		});
		if (!Array.isArray(data.items) || !data.items.every(isNativeBlock))
			throw new Error("Invalid native block response");
		for (const block of data.items) blocks.set(block.block_id, block);
		page = data.has_more && typeof data.page_token === "string" ? data.page_token : undefined;
		if (data.has_more && !page) throw new Error("Missing native block page token");
	} while (page);
	const after = await api("GET", base(doc));
	if (!isRecord(after.document) || after.document.revision_id !== revision)
		throw new Error("文档正在变化，请稍后重新同步。");
	const root = blocks.get(doc);
	if (!root) throw new Error("Document root not found");
	return { roots: root.children || [], blocks, revision };
}

/** Convert the standard Markdown once; restore file mentions before publishing. */
export async function convertNativeDocument(
	markdown: string,
	api: NativeApi,
	images: LocalImageResource[] = [],
	labelColors = false
): Promise<ConvertedBlocks> {
	const draft = prepareNativeCallouts(markdown);
	const mentions = new Map<string, { token: string; obj_type: number }>();
	const prefix = `FDPCITE${hash(markdown).slice(0, 16)}X`;
	const input = transformProse(
		draft.markdown,
		(text) =>
			text.replace(/<cite\b([^>]*)>\s*<\/cite>/g, (original, attrs: string) => {
				const token = attrs.match(/\bdoc-id="([A-Za-z0-9_-]+)"/)?.[1];
				if (!token) throw new Error("Unsupported document citation");
				const marker = `${prefix}${mentions.size}END`;
				mentions.set(marker, { token, obj_type: /file-type="file"/.test(attrs) ? 12 : 22 });
				return marker;
			}),
		false
	);
	const imageByMarker = new Map(
		images.filter((image) => image.mediaType !== "video").map((image) => [image.placeholder, image])
	);
	const imageInput = transformProse(input, (text) =>
		text.replace(/FEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64}/g, (marker) =>
			imageByMarker.has(marker) ? `![](https://fdp-image.invalid/${marker})` : marker
		)
	);
	const data = await api("POST", "/open-apis/docx/v1/documents/blocks/convert", {
		content_type: "markdown",
		content: imageInput
	});
	if (!Array.isArray(data.blocks) || !data.blocks.every(isNativeBlock) || !isStringArray(data.first_level_block_ids))
		throw new Error("Native conversion response incomplete");
	const imageBlocks = new Map<string, LocalImageResource>();
	const imageUrls: unknown = data.block_id_to_image_urls ?? [];
	if (!Array.isArray(imageUrls)) throw new Error("Invalid native image mapping");
	for (const entry of imageUrls as unknown[]) {
		if (!isRecord(entry) || typeof entry.image_url !== "string" || typeof entry.block_id !== "string")
			throw new Error("Invalid native image mapping");
		const marker = /^https:\/\/fdp-image\.invalid\/(FEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64})$/.exec(
			entry.image_url
		)?.[1];
		const image = marker ? imageByMarker.get(marker) : undefined;
		if (!image) throw new Error("原生折叠导出暂不支持网络图片：请先保存为本地图片；未写入文档。");
		imageBlocks.set(entry.block_id, image);
	}
	for (const marker of imageByMarker.keys()) {
		if (
			imageInput.includes(`https://fdp-image.invalid/${marker}`) &&
			![...imageBlocks.values()].some((image) => image.placeholder === marker)
		)
			throw new Error("转换器丢失图片位置，未写入文档。");
	}
	const tree = assembleNativeCallouts(
		{ blocks: data.blocks, first_level_block_ids: data.first_level_block_ids }, draft.callouts
	);
	const markerPattern = new RegExp(`${prefix}\\d+END`, "g");
	const found = new Set<string>();
	for (const block of tree.blocks) {
		delete block.parent_id;
		delete block.comment_ids;
		const image = imageBlocks.get(block.block_id);
		if (image) {
			if (block.block_type !== 27) throw new Error("图片未转换为独立原生图片块");
			block.image = {
				token: image.placeholder,
				width: image.displayWidth || image.sourceWidth,
				height: image.displayHeight || image.sourceHeight,
				...(image.alt ? { caption: { content: image.alt } } : {})
			};
		}
		for (const value of Object.values(block)) {
			const text = getNativeText(value);
			if (!text) continue;
			text.elements = text.elements.flatMap((element) => {
				const run = element.text_run;
				if (!run) return [element];
				const out: NativeTextElement[] = [];
				let cursor = 0;
				for (const match of run.content.matchAll(markerPattern)) {
					if (match.index > cursor)
						out.push({ text_run: { ...run, content: run.content.slice(cursor, match.index) } });
					const mention = mentions.get(match[0]);
					if (!mention) throw new Error("Unknown citation marker");
					found.add(match[0]);
					out.push({ mention_doc: { ...mention, text_element_style: run.text_element_style || {} } });
					cursor = match.index + match[0].length;
				}
				if (!cursor) return [element];
				if (cursor < run.content.length) out.push({ text_run: { ...run, content: run.content.slice(cursor) } });
				return out;
			});
			if (labelColors && block.block_type !== 14) text.elements = colorBoldColonLabels(text.elements);
		}
	}
	if (found.size !== mentions.size) throw new Error("Native converter lost PDF citations; refusing publication");
	return tree;
}

function descendants(ids: string[], byId: Map<string, NativeBlock>): NativeBlock[] {
	const result: NativeBlock[] = [];
	for (const id of ids) {
		const block = byId.get(id)!;
		result.push(block, ...descendants(block.children || [], byId));
	}
	return result;
}

/** Keep common top-level subtrees; journal replacement before any remote mutation. */
export async function syncNativeDocument(
	doc: string,
	markdown: string,
	host: NativeSyncHost,
	previous?: NativeState,
	title?: string
): Promise<NativeState> {
	if (!/^[A-Za-z0-9_-]+$/.test(doc)) throw new Error("Native export requires a canonical document ID");
	async function updateTitle(snapshot: { blocks: Map<string, NativeBlock> }): Promise<void> {
		if (title === undefined) return;
		const page = getNativeText(snapshot.blocks.get(doc)?.page);
		const current = page?.elements?.map((element) => element.text_run?.content || "").join("");
		if (current !== title)
			await host.api("PATCH", `${base(doc)}/blocks/${doc}`, {
				update_text_elements: { elements: [{ text_run: { content: title } }] }
			});
	}
	const labelStyleVersion = host.labelColors ? 1 : 0;
	let state: NativeState = previous
		? JSON.parse(JSON.stringify(previous)) as NativeState
		: { version: 1, sourceHash: "", units: [] };
	async function finishPending(): Promise<void> {
		const pending = state.pending!;
		if (!pending.inserted && pending.request.children_id.length) {
			const response = await host.api("POST", `${base(doc)}/blocks/${doc}/descendant`, pending.request, {
				client_token: pending.clientToken
			});
			const relations = new Map<string, string>();
			const mappings: unknown = response.block_id_relations ?? [];
			if (!Array.isArray(mappings)) throw new Error("Invalid created block mapping");
			for (const relation of mappings as unknown[]) {
				if (
					!isRecord(relation) || typeof relation.temporary_block_id !== "string" || typeof relation.block_id !== "string"
				)
					throw new Error("Invalid created block mapping");
				relations.set(relation.temporary_block_id, relation.block_id);
			}
			for (const unit of pending.units) {
				if (pending.request.children_id.includes(unit.id)) {
					const remote = relations.get(unit.id);
					if (!remote) throw new Error("Missing created block mapping; pending transaction retained");
					unit.id = remote;
				}
			}
			for (const image of pending.imageUploads || []) {
				const remote = relations.get(image.id);
				if (!remote) throw new Error("Missing native image block mapping");
				image.id = remote;
			}
			pending.inserted = true;
			await host.save(state);
		}
		for (const job of pending.imageUploads || []) {
			if (job.done) continue;
			const image = host.images?.find((image) => image.placeholder === job.placeholder);
			if (!image || !host.uploadImage) throw new Error("待上传图片资源不可用，请恢复对应源文件后重试。");
			if (!job.token) {
				const bytes = await readFile(image.absolutePath);
				if (createHash("sha256").update(bytes).digest("hex") !== image.contentHash)
					throw new Error("图片在准备后发生变化，请重新准备后同步。");
				job.token = await host.uploadImage(job.id, image);
				if (!job.token) throw new Error("图片上传未返回 token");
				await host.save(state);
			}
			await host.api("PATCH", `${base(doc)}/blocks/${job.id}`, {
				replace_image: {
					token: job.token,
					width: image.displayWidth || image.sourceWidth,
					height: image.displayHeight || image.sourceHeight
				}
			});
			const remote = await host.api("GET", `${base(doc)}/blocks/${job.id}`);
			if (!isRecord(remote.block) || !isRecord(remote.block.image) || remote.block.image.token !== job.token)
				throw new Error("原生图片 token 回读不一致");
			job.done = true;
			await host.save(state);
		}
		if (host.materialize && !pending.imageRoots) {
			const beforeMedia = await readNativeSnapshot(doc, host.api);
			pending.imageRoots = beforeMedia.roots.flatMap((id, index) => {
				if (!pending.units.some((unit) => unit.id === id)) return [];
				const block = beforeMedia.blocks.get(id)!;
				const text = getNativeText(block.text);
				const value = text?.elements?.map((element) => element.text_run?.content || "").join("") || "";
				return /^FEISHU_LARK_LOCAL_(?:IMAGE|VIDEO)_[a-f0-9]{64}$/.test(value.trim()) ? [{ id, index }] : [];
			});
			await host.save(state);
		}
		await host.materialize?.();
		let snapshot = await readNativeSnapshot(doc, host.api);
		for (const image of pending.imageRoots || []) {
			const unit = pending.units.find((unit) => unit.id === image.id);
			if (!unit || snapshot.roots.includes(image.id)) continue;
			const replacement = snapshot.roots[image.index];
			if (!replacement || ![27, 23, 33].includes(snapshot.blocks.get(replacement)?.block_type || 0))
				throw new Error("媒体替换位置不匹配，已停止同步。");
			unit.id = replacement;
			await host.save(state);
		}
		if (
			[...snapshot.blocks.values()].some(
				(block) =>
					block.block_type !== 14 &&
					/FEISHU_LARK_LOCAL_(?:IMAGE|VIDEO)_[a-f0-9]{64}/.test(JSON.stringify(block))
			)
		) {
			throw new Error("本地媒体尚未成功填入原生折叠块；旧内容已保留，请检查媒体上传后重试。");
		}
		const present = pending.remove.filter((id) => snapshot.roots.includes(id));
		if (present.some((id) => nativeTreeHash(id, snapshot.blocks) !== pending.removeHashes[id])) {
			throw new Error("替换期间远端旧内容发生变化，保留双方内容并停止删除。");
		}
		if (present.length) {
			const indexes = present.map((id) => snapshot.roots.indexOf(id)).sort((a, b) => a - b);
			if (indexes[indexes.length - 1]! - indexes[0]! + 1 !== indexes.length)
				throw new Error("待替换块之间出现新内容，已停止删除。");
			await host.api(
				"DELETE",
				`${base(doc)}/blocks/${doc}/children/batch_delete`,
				{
					start_index: indexes[0],
					end_index: indexes[indexes.length - 1]! + 1
				},
				{ document_revision_id: snapshot.revision }
			);
			snapshot = await readNativeSnapshot(doc, host.api);
		}
		const expected = pending.units.map((unit) => unit.id);
		if (JSON.stringify(snapshot.roots) !== JSON.stringify(expected))
			throw new Error("远端根块与本次同步计划不一致，事务已保留。");
		state = {
			version: 1,
			labelStyleVersion: pending.labelStyleVersion ?? 1,
			sourceHash: pending.sourceHash,
			units: pending.units.map((unit) => ({ ...unit, remoteHash: nativeTreeHash(unit.id, snapshot.blocks) }))
		};
		await host.save(state);
	}
	if (state.pending) await finishPending();
	const snapshot = await readNativeSnapshot(doc, host.api);
	if (state.sourceHash) {
		if (
			JSON.stringify(snapshot.roots) !== JSON.stringify(state.units.map((unit) => unit.id)) ||
			state.units.some((unit) => nativeTreeHash(unit.id, snapshot.blocks) !== unit.remoteHash)
		) {
			throw new Error("飞书正文已被修改，请先合并远端改动后再同步；折叠状态变化不受此限制。");
		}
		if (state.sourceHash === hash(markdown) && state.labelStyleVersion === labelStyleVersion) {
			await updateTitle(snapshot);
			return state;
		}
	}
	if (!state.sourceHash && snapshot.roots.length && host.allowReplaceUntracked === false)
		throw new Error("安全精确模式下缺少原生折叠映射，请先使用自动同步完成首次迁移。");
	const tree = await convertNativeDocument(markdown, host.api, host.images, host.labelColors);
	const byId = new Map(tree.blocks.map((block) => [block.block_id, block]));
	const units = tree.first_level_block_ids.map((id) => ({ id, hash: nativeTreeHash(id, byId), remoteHash: "" }));
	let prefix = 0,
		suffix = 0;
	while (prefix < units.length && prefix < state.units.length && units[prefix]!.hash === state.units[prefix]!.hash)
		prefix++;
	while (
		suffix < units.length - prefix &&
		suffix < state.units.length - prefix &&
		units[units.length - 1 - suffix]!.hash === state.units[state.units.length - 1 - suffix]!.hash
	)
		suffix++;
	const fresh = units.slice(prefix, units.length - suffix);
	const oldIds = state.sourceHash
		? state.units.slice(prefix, state.units.length - suffix).map((unit) => unit.id)
		: snapshot.roots;
	// Preserve reader fold choices for matching parent titles when their body changes.
	const folds = new Map<string, boolean[]>();
	const titleOf = (block: NativeBlock): string => {
		const text = getNativeText(block.text || block.bullet || block.ordered);
		return text?.elements.map((element) => element.text_run?.content || "").join("") || "";
	};
	for (const block of descendants(oldIds, snapshot.blocks)) {
		const text = getNativeText(block.text || block.bullet || block.ordered);
		if (block.children?.length && text?.style?.folded !== undefined) {
			const key = titleOf(block);
			const values = folds.get(key) || [];
			values.push(text.style.folded);
			folds.set(key, values);
		}
	}
	const requestBlocks = descendants(
		fresh.map((unit) => unit.id),
		byId
	);
	for (const block of requestBlocks) {
		const text = getNativeText(block.text || block.bullet || block.ordered);
		const values = folds.get(titleOf(block));
		if (block.children?.length && text?.style && values?.length) text.style.folded = values.shift();
	}
	if (requestBlocks.length > 1000) throw new Error("原生折叠单次变更超过 1000 块，未写入文档。");
	const imageUploads = requestBlocks.flatMap((block) => {
		const marker = isRecord(block.image) ? block.image.token : undefined;
		return block.block_type === 27 && typeof marker === "string" && marker.startsWith("FEISHU_LARK_LOCAL_IMAGE_")
			? [{ id: block.block_id, placeholder: marker }]
			: [];
	});
	const wireBlocks = JSON.parse(JSON.stringify(requestBlocks)) as NativeBlock[];
	for (const block of wireBlocks) {
		if (imageUploads.some((image) => image.id === block.block_id) && isRecord(block.image))
			delete block.image.token;
	}
	state.pending = {
		sourceHash: hash(markdown),
		labelStyleVersion,
		clientToken: randomUUID(),
		imageUploads,
		request: { children_id: fresh.map((unit) => unit.id), descendants: wireBlocks, index: prefix },
		remove: oldIds,
		removeHashes: Object.fromEntries(oldIds.map((id) => [id, nativeTreeHash(id, snapshot.blocks)])),
		units: [...state.units.slice(0, prefix), ...fresh, ...(suffix ? state.units.slice(-suffix) : [])]
	};
	await host.save(state);
	await finishPending();
	await updateTitle(await readNativeSnapshot(doc, host.api));
	return state;
}
