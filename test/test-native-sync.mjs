import assert from "node:assert/strict";
import esbuild from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
await esbuild.build({
	bundle: true,
	entryPoints: ["src/native-sync.ts"],
	format: "esm",
	platform: "node",
	outfile: "test/.tmp-native-sync.mjs"
});
const { syncNativeDocument, nativeTreeHash, readNativeSnapshot, convertNativeDocument } = await import("./.tmp-native-sync.mjs");
const text = (id, value) => ({
	block_id: id,
	block_type: 2,
	text: { elements: [{ text_run: { content: value } }], style: { folded: false } }
});
function server() {
	let revision = 1,
		serial = 0,
		stored,
		convertCount = 0,
		failSave = false;
	const blocks = new Map([["doc", { block_id: "doc", block_type: 1, children: [] }]]);
	const tokens = new Map();
	const calls = [];
	const api = async (method, path, body, params) => {
		calls.push({ method, path, body: structuredClone(body) });
		if (path.endsWith("/convert")) {
			convertCount++;
			// This fixture models conversion boundaries; real API rendering needs manual acceptance.
			const parts = body.content
				.split(/\n\s*\n/)
				.map((s) => s.trim())
				.filter(Boolean);
			const imageUrls = [];
			const out = parts.map((part, i) => {
				const id = "temp" + convertCount + "-" + i;
				const img = /^!\[\]\(([^)]+)\)$/.exec(part);
				if (img) {
					imageUrls.push({ block_id: id, image_url: img[1] });
					return { block_id: id, block_type: 27, image: {} };
				}
				const block = text(id, "");
				block.text.elements = part
					.split(/(\*\*[^*]+\*\*)/)
					.filter(Boolean)
					.map((piece) => ({
						text_run: {
							content: piece.startsWith("**") ? piece.slice(2, -2) : piece,
							...(piece.startsWith("**") ? { text_element_style: { bold: true } } : {})
						}
					}));
				return block;
			});
			return {
				blocks: out,
				first_level_block_ids: out.map((b) => b.block_id),
				block_id_to_image_urls: imageUrls
			};
		}
		if (method === "GET" && path.endsWith("/documents/doc")) return { document: { revision_id: revision } };
		if (method === "GET" && path.endsWith("/blocks"))
			return { items: structuredClone([...blocks.values()]), has_more: false };
		if (method === "GET" && path.includes("/blocks/"))
			return { block: structuredClone(blocks.get(path.split("/").at(-1))) };
		if (method === "PATCH" && body.replace_image) {
			const block = blocks.get(path.split("/").at(-1));
			block.image = { ...block.image, ...body.replace_image };
			revision++;
			return { block: structuredClone(block) };
		}
		if (path.endsWith("/descendant")) {
			if (tokens.has(params.client_token)) return tokens.get(params.client_token);
			const ids = new Map(body.descendants.map((b) => [b.block_id, "remote" + ++serial]));
			for (const old of body.descendants) {
				const b = structuredClone(old);
				b.block_id = ids.get(old.block_id);
				if (b.children) b.children = b.children.map((id) => ids.get(id));
				blocks.set(b.block_id, b);
			}
			blocks.get("doc").children.splice(body.index, 0, ...body.children_id.map((id) => ids.get(id)));
			revision++;
			const response = {
				block_id_relations: [...ids].map(([temporary_block_id, block_id]) => ({ temporary_block_id, block_id }))
			};
			tokens.set(params.client_token, response);
			return response;
		}
		if (method === "DELETE") {
			assert.equal(params.document_revision_id, revision);
			const remove = (id) => {
				for (const c of blocks.get(id)?.children || []) remove(c);
				blocks.delete(id);
			};
			blocks
				.get("doc")
				.children.splice(body.start_index, body.end_index - body.start_index)
				.forEach(remove);
			revision++;
			return {};
		}
		throw new Error("Unexpected " + method + " " + path);
	};
	const host = {
		api,
		save: async (state) => {
			if (failSave && state.pending?.inserted) {
				failSave = false;
				throw new Error("disk failed");
			}
			stored = structuredClone(state);
		}
	};
	return {
		host,
		blocks,
		calls,
		get state() {
			return structuredClone(stored);
		},
		get convertCount() {
			return convertCount;
		},
		failNextInsertedSave() {
			failSave = true;
		}
	};
}
const s = server();
const source = "Main A\n\n> [!note]- Title\n> Body\n\nMain B";
let state = await syncNativeDocument("doc", source, s.host);
assert.equal(state.units.length, 3);
let root = s.blocks.get(state.units[1].id);
assert.equal(root.text.style.folded, true);
assert.equal(root.children.length, 1);
assert.equal(root.text.elements[0].text_run.content, "📝 Title");
const ids = state.units.map((u) => u.id);
const writes = () => s.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/convert")).length;
const count = writes();
state = await syncNativeDocument("doc", source, s.host, state);
assert.equal(writes(), count);
assert.equal(s.convertCount, 1);
root.text.style.folded = false;
state = await syncNativeDocument("doc", source, s.host, state);
assert.equal(writes(), count, "reader fold changes must not trigger a content rewrite");
state = await syncNativeDocument("doc", source.replace("Body", "Edited"), s.host, state);
assert.equal(state.units[0].id, ids[0]);
assert.equal(state.units[2].id, ids[2]);
assert.notEqual(state.units[1].id, ids[1]);
assert.equal(
	s.blocks.get(state.units[1].id).text.style.folded,
	false,
	"preserve reader fold choices across subtree replacement"
);
assert.equal(s.blocks.get("doc").children.length, 3);
// Conversion-local IDs must not change hashes.
assert.equal(
	nativeTreeHash("x", new Map([["x", text("x", "same")]])),
	nativeTreeHash("y", new Map([["y", text("y", "same")]]))
);
// A crashed persistence step retries with the same idempotency token, then finishes cleanup.
s.failNextInsertedSave();
await assert.rejects(
	() => syncNativeDocument("doc", source.replace("Body", "Retry body"), s.host, state),
	/disk failed/
);
assert.ok(s.state.pending);
state = await syncNativeDocument("doc", source.replace("Body", "Retry body"), s.host, s.state);
assert.equal(s.blocks.get("doc").children.length, 3);
assert.equal(state.pending, undefined);
// Remote edits are protected, including edits inside a nested subtree.
const child = s.blocks.get(state.units[1].id).children[0];
s.blocks.get(child).text.elements[0].text_run.content = "Remote human edit";
const before = writes();
await assert.rejects(() => syncNativeDocument("doc", source, s.host, state), /飞书正文已被修改/);
assert.equal(writes(), before);
console.log("Native sync transactions and incremental update tests passed");

// Top-level image placeholders may be replaced with different remote IDs by the media uploader.
const media = server();
const placeholder = "FEISHU_LARK_LOCAL_IMAGE_" + "a".repeat(64);
const mediaHost = {
	...media.host,
	materialize: async () => {
		const root = media.blocks.get("doc");
		for (let i = 0; i < root.children.length; i++) {
			const id = root.children[i],
				block = media.blocks.get(id);
			if (block?.text?.elements?.[0]?.text_run?.content === placeholder) {
				media.blocks.delete(id);
				const replacement = "image-" + id;
				media.blocks.set(replacement, {
					block_id: replacement,
					block_type: 27,
					image: { token: "image-token" }
				});
				root.children[i] = replacement;
			}
		}
	}
};
const mediaState = await syncNativeDocument("doc", placeholder, mediaHost);
assert.equal(media.blocks.get(mediaState.units[0].id).block_type, 27);
await syncNativeDocument("doc", placeholder, mediaHost, mediaState);
assert.equal(media.blocks.get("doc").children.length, 1);
const untracked = server();
untracked.blocks.set("human", text("human", "Keep"));
untracked.blocks.get("doc").children.push("human");
await assert.rejects(
	() => syncNativeDocument("doc", source, { ...untracked.host, allowReplaceUntracked: false }),
	/安全精确模式/
);
assert.deepEqual(untracked.blocks.get("doc").children, ["human"]);
console.log("Native media mapping and safe migration tests passed");

const imageTest = server();
const imageDir = await mkdtemp(join(tmpdir(), "native-image-test-"));
try {
	const bytes = Buffer.from("test bytes");
	const file = join(imageDir, "image.png");
	await writeFile(file, bytes);
	const marker = "FEISHU_LARK_LOCAL_IMAGE_" + "b".repeat(64);
	const image = {
		placeholder: marker,
		absolutePath: file,
		contentHash: createHash("sha256").update(bytes).digest("hex"),
		displayWidth: 320,
		displayHeight: 160,
		sourceWidth: 640,
		sourceHeight: 320
	};
	let uploads = 0,
		failPatch = true;
	const host = {
		...imageTest.host,
		images: [image],
		uploadImage: async () => {
			uploads++;
			return "uploaded-image-token";
		},
		api: async (...args) => {
			if (failPatch && args[0] === "PATCH" && args[2]?.replace_image) {
				failPatch = false;
				throw new Error("temporary patch failure");
			}
			return imageTest.host.api(...args);
		}
	};
	const input = "Before\n\n> [!note]- With image\n> " + marker + "\n\nAfter";
	await assert.rejects(() => syncNativeDocument("doc", input, host), /temporary patch failure/);
	assert.equal(uploads, 1);
	assert.equal(imageTest.state.pending.imageUploads[0].token, "uploaded-image-token");
	const resumed = await syncNativeDocument("doc", input, host, imageTest.state);
	assert.equal(uploads, 1, "saved uploaded token must be reused on retry");
	const parent = imageTest.blocks.get(resumed.units[1].id);
	assert.equal(parent.children.length, 1);
	const picture = imageTest.blocks.get(parent.children[0]);
	assert.equal(picture.block_type, 27);
	assert.equal(picture.image.token, "uploaded-image-token");
	assert.equal(picture.image.width, 320);
	await syncNativeDocument("doc", input, host, resumed);
	assert.equal(uploads, 1);
	assert.equal(imageTest.blocks.get("doc").children.length, 3);
} finally {
	await rm(imageDir, { recursive: true, force: true });
}
console.log("Nested native images and upload-token recovery tests passed");

// Images bind in place; video previews must still materialize in the same transaction.
const mixed = server();
const mixedDir = await mkdtemp(join(tmpdir(), "native-mixed-media-"));
try {
	const bytes = Buffer.from("mixed image");
	const file = join(mixedDir, "image.png");
	await writeFile(file, bytes);
	const imageMarker = "FEISHU_LARK_LOCAL_IMAGE_" + "c".repeat(64);
	const videoMarker = "FEISHU_LARK_LOCAL_VIDEO_" + "d".repeat(64);
	const image = {
		placeholder: imageMarker,
		absolutePath: file,
		contentHash: createHash("sha256").update(bytes).digest("hex"),
		sourceWidth: 320,
		sourceHeight: 160
	};
	const video = { mediaType: "video", placeholder: videoMarker };
	let uploads = 0,
		materializations = 0,
		interrupt = true;
	const host = {
		...mixed.host,
		images: [image, video],
		uploadImage: async () => {
			uploads++;
			return "mixed-image-token";
		},
		materialize: async () => {
			materializations++;
			for (const parent of [...mixed.blocks.values()]) {
				for (let index = 0; index < (parent.children || []).length; index++) {
					const id = parent.children[index];
					const block = mixed.blocks.get(id);
					if (block?.text?.elements?.[0]?.text_run?.content !== videoMarker) continue;
					const figure = "figure-" + id,
						source = "source-" + id;
					mixed.blocks.delete(id);
					mixed.blocks.set(figure, {
						block_id: figure,
						block_type: 33,
						view: { view_type: 2 },
						children: [source]
					});
					mixed.blocks.set(source, { block_id: source, block_type: 23, file: { token: "video-token" } });
					parent.children[index] = figure;
				}
			}
			if (interrupt) {
				interrupt = false;
				throw new Error("interrupted after video placement");
			}
		}
	};
	const input = "Before\n\n> [!note]- Mixed media\n> " + imageMarker + "\n>\n> " + videoMarker + "\n\nAfter";
	await assert.rejects(() => syncNativeDocument("doc", input, host), /interrupted after video placement/);
	assert.ok(mixed.state.pending);
	assert.equal(uploads, 1);
	const result = await syncNativeDocument("doc", input, host, mixed.state);
	assert.equal(result.pending, undefined);
	assert.equal(uploads, 1, "native image upload survives media interruption");
	const parent = mixed.blocks.get(result.units[1].id);
	assert.deepEqual(
		parent.children.map((id) => mixed.blocks.get(id).block_type),
		[27, 33],
		"both media stay inside the folded parent"
	);
	assert.doesNotMatch(JSON.stringify([...mixed.blocks.values()]), /FEISHU_LARK_LOCAL_(?:IMAGE|VIDEO)_/);
	const calls = materializations;
	await syncNativeDocument("doc", input, host, result);
	assert.equal(materializations, calls, "unchanged mixed media is not reuploaded");
	// A top-level preview replaces its temporary text block and becomes the recorded unit.
	const top = await syncNativeDocument("doc", input + "\n\n" + videoMarker, host, result);
	assert.equal(mixed.blocks.get(top.units.at(-1).id).block_type, 33);
	await syncNativeDocument("doc", input + "\n\n" + videoMarker, host, top);
} finally {
	await rm(mixedDir, { recursive: true, force: true });
}
const unresolved = server();
await assert.rejects(
	() => syncNativeDocument("doc", "FEISHU_LARK_LOCAL_VIDEO_" + "e".repeat(64), unresolved.host),
	/本地媒体尚未成功/
);
assert.ok(unresolved.state.pending, "unresolved video placeholders must not be marked complete");
const styling = server();
let styled = await syncNativeDocument("doc", "**Label**: Value", styling.host);
assert.equal(styled.labelStyleVersion, 0);
styled = await syncNativeDocument("doc", "**Label**: Value", { ...styling.host, labelColors: true }, styled);
assert.equal(styling.blocks.get(styled.units[0].id).text.elements[0].text_run.text_element_style.background_color, 10);
assert.equal(styled.labelStyleVersion, 1);
assert.equal(styling.convertCount, 2, "changing style options reprocesses unchanged source");
styled = await syncNativeDocument("doc", "**Label**: Value", { ...styling.host, labelColors: false }, styled);
assert.equal(styled.labelStyleVersion, 0);
assert.equal(styling.convertCount, 3);
assert.equal(
	styling.blocks.get(styled.units[0].id).text.elements[0].text_run.text_element_style.background_color,
	undefined
);
const oversized = server();
await assert.rejects(
	() =>
		syncNativeDocument(
			"doc",
			Array.from({ length: 1001 }, (_, i) => "Paragraph " + i).join("\n\n"),
			oversized.host
		),
	/超过 1000 块/
);
assert.equal(oversized.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/convert")).length, 0);
const networkImage = server();
await assert.rejects(
	() => syncNativeDocument("doc", "![](https://example.com/photo.png)", networkImage.host),
	/不支持网络图片/
);
assert.equal(networkImage.blocks.get("doc").children.length, 0);
console.log("Mixed native media recovery, style settings, and pre-write validation tests passed");

// Reject malformed API data before constructing a native tree.
await assert.rejects(() => readNativeSnapshot("doc", async (_method, path) =>
	path.endsWith("/blocks") ? { items: [null] } : { document: { revision_id: 1 } }
), /Invalid native block response/);
await assert.rejects(() => convertNativeDocument("Text", async () => ({
	blocks: [text("x", "Text")], first_level_block_ids: [42]
})), /Native conversion response incomplete/);
