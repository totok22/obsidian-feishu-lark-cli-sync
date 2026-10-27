import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMediaInsertArgs,
	buildMediaMoveArgs,
	buildPlaceholderRemoveArgs,
	buildLocalImageFileIndex,
	buildLocalImageFileIndexFromPaths,
	buildLocalMediaFileIndex,
	buildLocalMediaFileIndexFromPaths,
	buildSyncPlan,
	containsLocalImagePlaceholders,
	createSyncContentSignature,
	createMediaUploadJournal,
	findReferencingMarkdownFiles,
	invalidateLocalImageSyncState,
	isLocalVideoPlaceholder,
	isSupportedImagePath,
	isSupportedVideoPath,
	isSupportedLocalMediaPath,
	materializeLocalImages,
	prepareLocalImages,
	scanLocalImageReferences
} from "../lark-sync-core.mjs";

const workspace = await mkdtemp(join(tmpdir(), "local-image-test-"));
try {
	await mkdir(join(workspace, "notes"), { recursive: true });
	await mkdir(join(workspace, "assets"), { recursive: true });
	await writeFile(join(workspace, "root.png"), createPngHeader(2, 1));
	await writeFile(join(workspace, "assets", "relative.png"), createPngHeader(8, 4));

	const markdown = [
		"- 结论 ![[root.png|600]]",
		"",
		"![[root.png|600x400]]",
		"",
		"![架构图](../assets/relative.png)",
		"",
		"![remote](https://example.com/remote.png)",
		"",
		"```md",
		"![[root.png]]",
		"~~~",
		"![[root.png]]",
		"```"
	].join("\n");
	const references = scanLocalImageReferences(markdown);
	assert.equal(references.length, 3);
	assert.equal(scanLocalImageReferences("第一行\r\n![[root.png]]\r\n")[0].sourceSyntax, "![[root.png]]");
	assert.deepEqual(scanLocalImageReferences('`<!-- ![[hidden.png]]` then ![[root.png]] ![[clip.mp4]]')
		.map(reference => reference.target), ['root.png', 'clip.mp4']);
	assert.deepEqual(scanLocalImageReferences('<!-- ` ![[hidden.png]] --> ![[root.png]]')
		.map(reference => reference.target), ['root.png']);

	const prepared = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: markdown
	});
	assert.equal(prepared.images.length, 3);
	assert.equal(prepared.images[0].vaultPath, "root.png");
	assert.equal(prepared.images[0].displayWidth, 600);
	assert.equal(prepared.images[0].displayHeight, 300);
	assert.equal(prepared.images[1].displayWidth, 600);
	assert.equal(prepared.images[1].displayHeight, 400);
	assert.equal(prepared.images[2].vaultPath, "assets/relative.png");
	assert.equal(prepared.images[2].alt, "架构图");
	assert.match(prepared.content, /- 结论\s+FEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64}/);
	assert.match(prepared.content, /!\[remote\]\(https:\/\/example\.com\/remote\.png\)/);
	assert.match(prepared.content, /```md\n!\[\[root\.png\]\]\n~~~\n!\[\[root\.png\]\]\n```/);
	// Markdown alt suffixes use the same display sizes as wiki embeds, not literal captions.
	for (const [syntax, alt, width, height] of [
		["![image1|300](root.png)", "image1", 300, 150],
		["![架构图|600x400](../assets/relative.png)", "架构图", 600, 400],
		["![ 架构图 | 600 × 400 ](<../assets/relative.png> \"title\")", "架构图", 600, 400],
		["![|300](root.png)", undefined, 300, 150],
		["![管道|说明|300](root.png)", "管道|说明", 300, 150],
		["![[root.png|600 × 400]]", undefined, 600, 400],
		["![架构图|原尺寸](root.png)", "架构图|原尺寸", undefined, undefined],
		["![架构图|0](root.png)", "架构图|0", undefined, undefined],
		["![架构图|300x0](root.png)", "架构图|300x0", undefined, undefined],
		["![架构图|9007199254740992](root.png)", "架构图|9007199254740992", undefined, undefined]
	]) {
		const sized = await prepareLocalImages({
			vaultRoot: workspace, markdownPath: "notes/note.md", content: syntax
		});
		const image = sized.images[0];
		assert.equal(image.alt, alt, syntax);
		assert.equal(image.displayWidth, width, syntax);
		assert.equal(image.displayHeight, height, syntax);
		const args = buildMediaInsertArgs("doc-token", image);
		assert.equal(args.includes("--width"), width !== undefined, syntax);
		assert.equal(args.includes("--height"), height !== undefined, syntax);
		if (width !== undefined) assert.equal(args[args.indexOf("--width") + 1], String(width), syntax);
		if (height !== undefined) assert.equal(args[args.indexOf("--height") + 1], String(height), syntax);
		assert.equal(args.includes("--caption"), alt !== undefined, syntax);
		if (alt !== undefined) assert.equal(args[args.indexOf("--caption") + 1], alt, syntax);
	}
	const sizedIdentity = async (content) => (await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/note.md", content
	})).images[0].placeholder;
	assert.notEqual(await sizedIdentity("![image1|300](root.png)"), await sizedIdentity("![image1|450](root.png)"),
		"changing only the Markdown size must invalidate the sync cache");
	assert.equal(await sizedIdentity("![|300](root.png)"), await sizedIdentity("![[root.png|300]]"),
		"equivalent Markdown and wiki sizes have the same resource identity");
	assert.deepEqual(scanLocalImageReferences("`![example|300](missing.png)`\n\n<!-- ![example|300](missing.png) -->\n\n```md\n![example|300](missing.png)\n```"), []);
	assert.deepEqual(scanLocalImageReferences("![remote|300](https://example.com/image.png)"), []);
	assert.equal(scanLocalImageReferences("![video|300](clip.mp4)")[0].alt, "video|300",
		"image size syntax does not change video captions");
	const listAdjacentImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "- [ ] 验收交互\n![[root.png]]\n\n下一项"
	});
	assert.match(
		listAdjacentImage.content,
		/- \[ \] 验收交互\n\nFEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64}\n\n下一项/
	);
	const stableImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "![[root.png]]"
	});
	const legacyIdentity = JSON.stringify({
		markdownPath: "notes/note.md",
		vaultPath: stableImage.images[0].vaultPath,
		contentHash: stableImage.images[0].contentHash,
		alt: undefined,
		occurrenceIndex: 0
	});
	const legacyPlaceholder = `FEISHU_LARK_LOCAL_IMAGE_${createHash("sha256").update(legacyIdentity).digest("hex")}`;
	assert.equal(stableImage.images[0].placeholder, legacyPlaceholder);
	const shiftedStableImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "新增文字\n\n![[root.png]]"
	});
	assert.equal(stableImage.images[0].placeholder, shiftedStableImage.images[0].placeholder);
	const duplicatedImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "![[root.png]]\n\n![[root.png]]"
	});
	assert.notEqual(duplicatedImage.images[0].placeholder, duplicatedImage.images[1].placeholder);

	await writeFile(join(workspace, "notes", "note.md"), markdown);
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace,
		markdownPaths: ["notes/note.md"],
		changedImagePaths: ["root.png"]
	}), ["notes/note.md"]);
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace,
		markdownPaths: ["notes/note.md"],
		changedImagePaths: ["assets/relative.png"]
	}), ["notes/note.md"]);

	await assert.rejects(
		prepareLocalImages({
			vaultRoot: workspace,
			markdownPath: "notes/note.md",
			content: "![](../../outside.png)"
		}),
		(error) => error?.reason === "image-outside-vault"
	);

	await mkdir(join(workspace, "duplicate-a"));
	await mkdir(join(workspace, "duplicate-b"));
	await writeFile(join(workspace, "duplicate-a", "same.png"), createPngHeader(1, 1));
	await writeFile(join(workspace, "duplicate-b", "same.png"), createPngHeader(1, 1));
	await assert.rejects(
		prepareLocalImages({
			vaultRoot: workspace,
			markdownPath: "notes/note.md",
			content: "![[same.png]]"
		}),
		(error) => error?.reason === "image-path-ambiguous"
	);

	const [firstImage, secondImage] = prepared.images;
	let remoteXml = `<title id="title">Note</title><p id="first">${firstImage.placeholder}</p><p id="second">${secondImage.placeholder}</p>`;
	let revisionId = 1;
	const inserted = [];
	const moved = [];
	const deleted = [];
	const snapshot = await materializeLocalImages([firstImage, secondImage], {
		async fetchRemoteWithIds() {
			return { content: remoteXml, revisionId };
		},
		async insertImage(image) {
			inserted.push(image.placeholder);
			const blockId = `image-${inserted.length}`;
			remoteXml += `<img id="${blockId}"/>`;
			revisionId += 1;
			return { blockId };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			moved.push([blockId, targetBlockId]);
			remoteXml = remoteXml.replace(`<img id="${blockId}"/>`, "")
				.replace(
					new RegExp(`(<p id="${targetBlockId}">[^<]+</p>)`),
					`$1<img id="${blockId}"/>`
				);
			revisionId += 1;
		},
		async deleteBlock(blockId) {
			deleted.push(blockId);
			remoteXml = remoteXml.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
			revisionId += 1;
		}
	});
	assert.deepEqual(inserted, [firstImage.placeholder, secondImage.placeholder]);
	assert.deepEqual(moved, [["image-1", "first"]], "a trailing placeholder is already followed by the appended image");
	assert.deepEqual(deleted, ["first", "second"]);
	assert.doesNotMatch(snapshot.content, /FEISHU_LARK_LOCAL_IMAGE_/);

	// A recorded upload survives a restart and is reused by block id, not by name.
	const resumeXml = `<title id="title">Note</title><img id="done" name="root.png" src="x"/><p id="first">${firstImage.placeholder}</p><img id="uploaded" name="root.png" src="y"/>`;
	let resumeState = resumeXml;
	const resumeCalls = [];
	const journalDirectory = join(workspace, "media-uploads");
	await createMediaUploadJournal(journalDirectory, "resume-doc").save(firstImage, "uploaded");
	const resumeSnapshot = await materializeLocalImages([firstImage], {
		uploadJournal: createMediaUploadJournal(journalDirectory, "resume-doc"),
		async fetchRemoteWithIds() { return { content: resumeState, revisionId: 1 }; },
		async insertImage() { resumeCalls.push("insert"); return { blockId: "never" }; },
		async moveBlockAfter() { resumeCalls.push("move"); },
		async deleteBlock(blockId) {
			resumeCalls.push(`delete ${blockId}`);
			resumeState = resumeState.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
		}
	});
	assert.deepEqual(resumeCalls, ["delete first"]);
	assert.equal(resumeSnapshot.content, `<title id="title">Note</title><img id="done" name="root.png" src="x"/><img id="uploaded" name="root.png" src="y"/>`);
	assert.equal(await createMediaUploadJournal(journalDirectory, "resume-doc").load(firstImage), undefined,
		"completed uploads leave no pending record");

	// Adjacent images, including the same basename with different contents/dimensions,
	// never stand in for a new upload. A stale record after an overwrite is also ignored.
	for (const name of ["other.png", "root.png"]) {
		let otherState = `<p id="first">${firstImage.placeholder}</p><img id="other" name="${name}" src="z"/>`;
		const otherCalls = [];
		const uploadJournal = createMediaUploadJournal(journalDirectory, `new-${name}`);
		await uploadJournal.save(firstImage, "removed-by-overwrite");
		await materializeLocalImages([firstImage], {
			uploadJournal,
			async fetchRemoteWithIds() { return { content: otherState, revisionId: 1 }; },
			async insertImage() {
				otherCalls.push("insert");
				otherState += '<img id="new-image" name="root.png" src="n"/>';
				return { blockId: "new-image" };
			},
			async moveBlockAfter() {
				otherCalls.push("move");
				otherState = otherState.replace('<img id="new-image" name="root.png" src="n"/>', "")
					.replace('</p>', '</p><img id="new-image" name="root.png" src="n"/>');
			},
			async deleteBlock(blockId) {
				otherCalls.push(`delete ${blockId}`);
				otherState = otherState.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
			}
		});
		assert.deepEqual(otherCalls, ["insert", "move", "delete first"]);
		assert.equal((otherState.match(/<img\b/g) || []).length, 2);
	}

	// An interruption between append and move resumes the recorded block at the end.
	let interruptedXml = `<p id="first">${firstImage.placeholder}</p><p id="tail">tail</p>`;
	let uploadCount = 0;
	const interruptedHost = {
		uploadJournal: createMediaUploadJournal(journalDirectory, "interrupted-doc"),
		async fetchRemoteWithIds() { return { content: interruptedXml, revisionId: 1 }; },
		async insertImage() {
			uploadCount++;
			interruptedXml += '<img id="pending" name="root.png"/>';
			return { blockId: "pending" };
		},
		async moveBlockAfter() { throw new Error("interrupted before move"); },
		async deleteBlock(blockId) {
			interruptedXml = interruptedXml.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
		}
	};
	await assert.rejects(materializeLocalImages([firstImage], interruptedHost), /interrupted before move/);
	assert.equal(await createMediaUploadJournal(journalDirectory, "another-doc").load(firstImage), undefined,
		"the same image in a different document has its own record");
	await materializeLocalImages([firstImage], {
		...interruptedHost,
		uploadJournal: createMediaUploadJournal(journalDirectory, "interrupted-doc"),
		async moveBlockAfter() {
			interruptedXml = interruptedXml.replace('<img id="pending" name="root.png"/>', "")
				.replace('</p>', '</p><img id="pending" name="root.png"/>');
		}
	});
	assert.equal(uploadCount, 1, "a restart never reuploads the already recorded block");
	assert.equal(interruptedXml, '<img id="pending" name="root.png"/><p id="tail">tail</p>');

	// A copy of the placeholder left by an interrupted sync is cleaned up instead of failing the retry.
	let strayXml = `<title id="title">Note</title><p id="first">${firstImage.placeholder}</p><p id="stray">${firstImage.placeholder}</p>`;
	const strayDeleted = [];
	const straySnapshot = await materializeLocalImages([firstImage], {
		async fetchRemoteWithIds() {
			return { content: strayXml, revisionId: 1 };
		},
		async insertImage() {
			strayXml += `<img id="stray-image"/>`;
			return { blockId: "stray-image" };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			strayXml = strayXml.replace(`<img id="${blockId}"/>`, "")
				.replace(new RegExp(`(<p id="${targetBlockId}">[^<]+</p>)`), `$1<img id="${blockId}"/>`);
		},
		async deleteBlock(blockId) {
			strayDeleted.push(blockId);
			strayXml = strayXml.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
		}
	});
	assert.deepEqual(strayDeleted, ["first", "stray"]);
	assert.doesNotMatch(straySnapshot.content, /FEISHU_LARK_LOCAL_IMAGE_/);
	assert.match(straySnapshot.content, /<img id="stray-image"\/>/);

	// A placeholder that cannot be removed still fails, without retrying forever.
	let stuckDeletes = 0;
	const stuckXml = `<p id="first">${firstImage.placeholder}</p><img id="stuck-image"/>`;
	await assert.rejects(materializeLocalImages([firstImage], {
		async fetchRemoteWithIds() { return { content: stuckXml, revisionId: 1 }; },
		async insertImage() { return { blockId: "stuck-image" }; },
		async moveBlockAfter() {},
		async deleteBlock() { stuckDeletes += 1; }
	}), /图片占位块删除后仍然存在/);
	assert.equal(stuckDeletes, 6, "one normal delete plus a bounded number of stray cleanups");

	let embeddedRemoteXml = `<checkbox id="task">验收交互<br/>${firstImage.placeholder}</checkbox><p id="next">下一项</p>`;
	let embeddedRevisionId = 1;
	const embeddedMoves = [];
	const removedPlaceholders = [];
	const embeddedSnapshot = await materializeLocalImages([firstImage], {
		async fetchRemoteWithIds() {
			return { content: embeddedRemoteXml, revisionId: embeddedRevisionId };
		},
		async insertImage() {
			embeddedRemoteXml += "<img id=\"embedded-image\"/>";
			embeddedRevisionId += 1;
			return { blockId: "embedded-image" };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			embeddedMoves.push([blockId, targetBlockId]);
			embeddedRemoteXml = embeddedRemoteXml.replace(`<img id="${blockId}"/>`, "")
				.replace("</checkbox>", `</checkbox><img id="${blockId}"/>`);
			embeddedRevisionId += 1;
		},
		async deleteBlock() {
			assert.fail("嵌入待办块的占位符不应删除整个待办块");
		},
		async removePlaceholder(placeholder) {
			removedPlaceholders.push(placeholder);
			embeddedRemoteXml = embeddedRemoteXml.replace(placeholder, "");
			embeddedRevisionId += 1;
		}
	});
	assert.deepEqual(embeddedMoves, [["embedded-image", "task"]]);
	assert.deepEqual(removedPlaceholders, [firstImage.placeholder]);
	assert.match(embeddedSnapshot.content, /<checkbox id="task">验收交互<br\/><\/checkbox><img id="embedded-image"\/>/);
	assert.doesNotMatch(embeddedSnapshot.content, /FEISHU_LARK_LOCAL_IMAGE_/);

	const mediaArgs = buildMediaInsertArgs("doc-token", firstImage);
	assert.deepEqual(mediaArgs.slice(0, 2), ["docs", "+media-insert"]);
	assert.equal(mediaArgs[mediaArgs.indexOf("--file") + 1], "./root.png");
	assert.ok(!mediaArgs.includes("--selection-with-ellipsis"));
	assert.ok(!mediaArgs.includes("--before"));
	assert.ok(mediaArgs.includes("--width"));
	assert.ok(mediaArgs.includes("--height"));
	assert.deepEqual(buildMediaMoveArgs("doc-token", "image-block", "placeholder-block"), [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", "doc-token",
		"--command", "block_move_after", "--block-id", "placeholder-block",
		"--src-block-ids", "image-block", "--json"
	]);
	assert.deepEqual(buildPlaceholderRemoveArgs("doc-token", firstImage.placeholder, 7), [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", "doc-token",
		"--command", "str_replace", "--pattern", firstImage.placeholder, "--content", "",
		"--revision-id", "7", "--json"
	]);

	const baselineMarkdown = "- [ ] 验收交互\n\n下一项";
	const baselineSignature = await createSyncContentSignature(baselineMarkdown);
	const baselineState = {
		doc: "doc-token",
		contentHash: baselineSignature.contentHash,
		units: baselineSignature.units.map((unit, index) => ({
			stableId: `${index}:${unit.kind}`,
			kind: unit.kind,
			hash: unit.hash,
			blockId: `block-${index}`
		})),
		updatedAt: new Date(0).toISOString()
	};
	const addedImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "- [ ] 验收交互\n![[root.png]]\n\n下一项"
	});
	const addedImagePlan = await buildSyncPlan({
		doc: "doc-token",
		markdown: addedImage.content,
		contentFileName: "sync.md",
		strategy: "auto",
		state: baselineState
	});
	assert.equal(addedImagePlan.mode, "precise");
	assert.deepEqual(addedImagePlan.commands.map((command) => command.command), ["block_insert_after"]);

	const imageState = invalidateLocalImageSyncState({
		doc: "doc-token",
		contentHash: "content-hash",
		units: [
			{ stableId: "0:paragraph", kind: "paragraph", hash: "body", blockId: "body" },
			{ stableId: "1:img", kind: "img", hash: "image", blockId: "image" }
		],
		updatedAt: new Date(0).toISOString()
	});
	assert.equal(imageState.contentHash, "");
	assert.equal(imageState.units[0].hash, "body");
	assert.equal(imageState.units[1].hash, "");

	// Local video embeds use preview files; links, remote URLs and code remain untouched.
	const videoPath = join(workspace, "assets", "clip.mp4");
	const videoBytes = Buffer.alloc(150_000, 0x61);
	await writeFile(videoPath, videoBytes);
	const videoMarkdown = [
		"![[clip.mp4]]",
		"",
		"![片段](../assets/clip.mp4)",
		"",
		"[下载视频](../assets/clip.mp4)",
		"![](https://example.com/clip.mp4)",
		"![[https://example.com/clip.mp4]]",
		"![](//example.com/clip.mp4)",
		"![](file:///tmp/clip.mp4)",
		"`![[clip.mp4]]`",
		"`![](../assets/clip.mp4)`",
		"`before ``` ![[clip.mp4]] after`",
		"``before ` ![[clip.mp4]] after``",
		"\\![[clip.mp4]]",
		"```md",
		"![[clip.mp4]]",
		"```"
	].join("\n");
	assert.equal(scanLocalImageReferences(videoMarkdown).length, 2);
	for (const protectedMarkdown of [
		"    ![[missing.mp4]]",
		"\t![example](missing.mp4)",
		"`example\n![[missing.mp4]]\n`",
		"``example `\n![example](missing.mp4)\n``",
		"<!-- ![[missing.mp4]] -->",
		"<!--\n![example](missing.mp4)\n-->",
		"<!-- ![[missing.mp4]]",
		"````md\n```\n![[missing.mp4]]\n```\n````",
		"~~~~md\n~~~\n![example](missing.mp4)\n~~~\n~~~~"
	]) {
		assert.deepEqual(scanLocalImageReferences(protectedMarkdown), [], protectedMarkdown);
		assert.deepEqual(await prepareLocalImages({
			vaultRoot: workspace, markdownPath: "notes/videos.md", content: protectedMarkdown
		}), { content: protectedMarkdown, images: [] }, "examples must not require real video files");
	}
	const protectedExamples = [
		"<!-- ![[missing.mp4]] --> ![[clip.mp4]]",
		"",
		"`example\n![[missing.mp4]]\n` ![real](../assets/clip.mp4)",
		"",
		"    ![[missing.mp4]]",
		"",
		"![[clip.mp4]]"
	].join("\n");
	const preparedExamples = await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: protectedExamples
	});
	assert.equal(preparedExamples.images.length, 3, "real embeds outside protected regions still upload");
	assert.equal((preparedExamples.content.match(/!\[\[missing\.mp4\]\]/g) || []).length, 3);
	assert.equal(scanLocalImageReferences("````md\n```\n![[missing.mp4]]\n````\n\n![[clip.mp4]]").length, 1,
		"a shorter fence inside an example must not hide the real embed after the closing fence");
	await writeFile(join(workspace, "notes", "protected.md"), "`example\n![[clip.mp4]]\n`\n\n<!-- ![[clip.mp4]] -->");
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace, markdownPaths: ["notes/protected.md"], changedImagePaths: ["assets/clip.mp4"]
	}), [], "a video change must not select notes that only mention it in examples");
	assert.equal(isSupportedImagePath("clip.mp4"), false);
	assert.equal(isSupportedVideoPath("clip.MP4"), true);
	assert.equal(isSupportedLocalMediaPath("clip.webm"), true);
	assert.equal(isSupportedLocalMediaPath("clip.mkv"), false);
	const preparedVideos = await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: videoMarkdown
	});
	assert.equal(preparedVideos.images.length, 2);
	const video = preparedVideos.images[0];
	assert.equal(video.mediaType, "video");
	assert.equal(video.mimeType, "video/mp4");
	assert.equal(video.vaultPath, "assets/clip.mp4");
	assert.equal(video.contentHash, createHash("sha256").update(videoBytes).digest("hex"));
	assert.equal(isLocalVideoPlaceholder(video.placeholder), true);
	assert.equal(containsLocalImagePlaceholders(preparedVideos.content), true);
	assert.match(preparedVideos.content, /\[下载视频\]\(\.\.\/assets\/clip\.mp4\)/);
	const imageIndex = await buildLocalImageFileIndex(workspace);
	const mediaIndex = await buildLocalMediaFileIndex(workspace);
	assert.deepEqual(buildLocalImageFileIndexFromPaths(mediaIndex.paths), imageIndex);
	assert.deepEqual(buildLocalMediaFileIndexFromPaths([...mediaIndex.paths, "assets/clip.mp4", "note.md"]), mediaIndex,
		"the Vault path index includes videos while keeping gallery images separate");
	assert.equal(imageIndex.paths.has("assets/clip.mp4"), false, "the image gallery index stays image-only");
	assert.equal(mediaIndex.paths.has("assets/clip.mp4"), true);
	assert.equal(imageIndex.paths.has("root.png"), true);
	const sameVideo = await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: "修改正文\n\n![[clip.mp4|600]]"
	});
	assert.equal(sameVideo.images[0].placeholder, video.placeholder, "body and display width do not reupload a video");
	const duplicateVideos = await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: "![[clip.mp4|600]]\n\n![[clip.mp4|800]]"
	});
	assert.notEqual(duplicateVideos.images[0].placeholder, duplicateVideos.images[1].placeholder);
	for (const [extension, mimeType] of [["mov", "video/quicktime"], ["m4v", "video/mp4"], ["webm", "video/webm"]]) {
		await writeFile(join(workspace, "assets", `clip.${extension}`), videoBytes);
		const fixture = await prepareLocalImages({
			vaultRoot: workspace, markdownPath: "notes/videos.md", content: `![[clip.${extension}]]`
		});
		assert.equal(fixture.images[0].mimeType, mimeType);
	}
	await writeFile(join(workspace, "notes", "videos.md"), videoMarkdown);
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace, markdownPaths: ["notes/videos.md"], changedImagePaths: ["assets/clip.mp4"]
	}), ["notes/videos.md"]);
	const videoArgs = buildMediaInsertArgs("doc-token", video);
	assert.equal(videoArgs[videoArgs.indexOf("--type") + 1], "file");
	assert.equal(videoArgs[videoArgs.indexOf("--file-view") + 1], "preview");
	assert.equal(videoArgs[videoArgs.indexOf("--file") + 1], "./clip.mp4");
	assert.ok(!videoArgs.includes("--width") && !videoArgs.includes("--height") && !videoArgs.includes("--caption"));

	const figureXml = '<figure id="video-view" view-type="Preview"><source id="video-file" mime="video/mp4" token="existing-token"/></figure>';
	let videoRemote = `<p id="video-slot">${video.placeholder}</p><p id="tail">后续</p>`;
	let videoUploads = 0;
	const videoMoves = [];
	const videoHost = {
		async fetchRemoteWithIds() { return { content: videoRemote, revisionId: 3 }; },
		async insertImage() {
			videoUploads += 1;
			videoRemote += figureXml;
			return { blockId: "video-file" };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			videoMoves.push([blockId, targetBlockId]);
			videoRemote = videoRemote.replace(figureXml, "")
				.replace(`</p><p id="tail">`, `</p>${figureXml}<p id="tail">`);
		},
		async deleteBlock(blockId) {
			videoRemote = videoRemote.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
		},
		async removePlaceholder() { assert.fail("a standalone placeholder is removed by block id"); }
	};
	const videoSnapshot = await materializeLocalImages([video], videoHost);
	assert.deepEqual(videoMoves, [["video-view", "video-slot"]], "move the figure rather than its source");
	assert.equal(videoSnapshot.content, `${figureXml}<p id="tail">后续</p>`);
	await materializeLocalImages([video], videoHost);
	assert.equal(videoUploads, 1, "an already materialized video is never uploaded again");
	assert.equal(videoMoves.length, 1);
	for (const [index, invalidFigure] of [figureXml.replace('"Preview"', '"Card"'), figureXml.replace('video/mp4', 'application/pdf')].entries()) {
		let invalidUploads = 0;
		const invalidHost = {
			...videoHost,
			uploadJournal: createMediaUploadJournal(journalDirectory, `invalid-video-${index}`),
			async fetchRemoteWithIds() { return { content: `<p id="slot">${video.placeholder}</p>${invalidFigure}` }; },
			async insertImage() { invalidUploads += 1; return { blockId: "video-file" }; },
			async moveBlockAfter() { assert.fail("a generic file card is not a video preview"); }
		};
		await assert.rejects(materializeLocalImages([video], invalidHost), /未返回可播放的预览块/);
		await assert.rejects(materializeLocalImages([video], invalidHost), /未返回可播放的预览块/);
		assert.equal(invalidUploads, 1, "an existing unsupported preview must not be uploaded again on retry");
		assert.equal(await invalidHost.uploadJournal.load(video), "video-file");
	}

	// Persist the raw source id before the first read, and reuse it or the figure id after a restart.
	for (const failureStage of ["fetch", "move"]) {
		const anchor = `<p id="video-slot">${video.placeholder}</p>`;
		videoRemote = `${anchor}<p id="tail">后续</p>`;
		let interrupted = false;
		const uploadJournal = createMediaUploadJournal(journalDirectory, `video-${failureStage}`);
		const uploadsBefore = videoUploads;
		const interruptedVideoHost = {
			...videoHost,
			uploadJournal,
			async fetchRemoteWithIds() {
				if (failureStage === "fetch" && !interrupted && videoRemote.includes(figureXml)) {
					interrupted = true;
					throw new Error("interrupted after upload");
				}
				return { content: videoRemote, revisionId: 4 };
			},
			async moveBlockAfter(blockId, targetBlockId) {
				if (failureStage === "move" && !interrupted) {
					interrupted = true;
					throw new Error("interrupted before move");
				}
				await videoHost.moveBlockAfter(blockId, targetBlockId);
			}
		};
		await assert.rejects(materializeLocalImages([video], interruptedVideoHost), /interrupted/);
		assert.equal(await uploadJournal.load(video), failureStage === "fetch" ? "video-file" : "video-view");
		await materializeLocalImages([video], {
			...interruptedVideoHost,
			uploadJournal: createMediaUploadJournal(journalDirectory, `video-${failureStage}`)
		});
		assert.equal(videoUploads, uploadsBefore + 1, "a resumed video reuses its recorded upload");
		assert.equal(await uploadJournal.load(video), undefined);
		assert.equal(videoRemote, `${figureXml}<p id="tail">后续</p>`);
	}
	videoRemote = `<p id="video-slot">${video.placeholder}</p>`;
	const staleVideoJournal = createMediaUploadJournal(journalDirectory, "stale-video");
	await staleVideoJournal.save(video, "deleted-video");
	await materializeLocalImages([video], {
		...videoHost,
		uploadJournal: staleVideoJournal,
		async moveBlockAfter() { assert.fail("a trailing video is already adjacent to its placeholder"); }
	});
	assert.equal(videoRemote, figureXml);
	assert.equal(await staleVideoJournal.load(video), undefined);
	await writeFile(videoPath, Buffer.from("updated-video-content"));
	const changedVideo = await prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: "![[clip.mp4]]"
	});
	assert.notEqual(changedVideo.images[0].contentHash, video.contentHash);
	assert.notEqual(changedVideo.images[0].placeholder, video.placeholder);
	await assert.rejects(prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: "![[missing.mp4]]"
	}), (error) => error.reason === "video-missing");
	await writeFile(join(workspace, "empty.mp4"), "");
	await assert.rejects(prepareLocalImages({
		vaultRoot: workspace, markdownPath: "notes/videos.md", content: "![[empty.mp4]]"
	}), (error) => error.reason === "video-empty");
} finally {
	await rm(workspace, { recursive: true, force: true });
}

console.log("local image tests passed");

function createPngHeader(width, height) {
	const buffer = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}
