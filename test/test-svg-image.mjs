import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import esbuild from "esbuild";
import {
	buildLocalImageFileIndex, buildLocalImageFileIndexFromPaths, buildMediaInsertArgs,
	findReferencingMarkdownFiles, isSupportedImagePath, prepareLocalImages, scanLocalImageReferences
} from "../lark-sync-core.mjs";

const outfile = "test/.tmp-svg-image-test.mjs";
await esbuild.build({ bundle: true, entryPoints: ["src/svg-image.ts"], format: "esm", outfile, platform: "node" });
const { prepareSvgRenderInput, renderSvgWithResvg } = await import("./.tmp-svg-image-test.mjs");
const workspace = await mkdtemp(join(tmpdir(), "svg-image-test-"));
const cachedPaths = new Set();
const svg = (attributes = 'width="4" height="2"', body = '<rect width="4" height="2" fill="red"/>') =>
	`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const inputFor = (attributes, body) => prepareSvgRenderInput(Buffer.from(svg(attributes, body)));
try {
	assert.equal(isSupportedImagePath("diagram.SVG"), true);
	const content = '![[diagram.SVG|300]]\n![图|120x80](../assets/vector.svg)\n![remote](https://example.com/a.svg)\n`![[code.svg]]`';
	assert.deepEqual(scanLocalImageReferences(content).map((ref) => ref.target), ["diagram.SVG", "../assets/vector.svg"]);
	assert.deepEqual([...buildLocalImageFileIndexFromPaths(["a.svg", "b.SVG", "c.txt"]).paths], ["a.svg", "b.SVG"]);
	assert.equal(inputFor('viewBox="0 0 4 2"').width, 8);
	assert.equal(inputFor('width="100%" height="100%" viewBox="0,0,4,2"').height, 4);
	assert.equal(inputFor('width="8" viewBox="0 0 4 2"').height, 8);
	assert.equal(inputFor('height="6" viewBox="0 0 4 2"').width, 24);
	assert.equal(inputFor('width="1in" height="36pt"').width, 192);
	assert.equal(inputFor('width="1in" height="36pt"').height, 96);
	assert.equal(inputFor("").width, 600);
	const fractional = inputFor('width="505" height="133.9" viewBox="0 0 505 133.9"');
	assert.equal(fractional.width, 1010);
	assert.equal(fractional.height, 267);
	assert.match(fractional.svg, /width="1010" height="267"/);
	const large = inputFor('width="100000" height="100000"');
	assert.ok(large.width <= 8192 && large.width * large.height <= 16_000_000);
	for (const attributes of ['width="0"', 'height="-1"', 'width="NaN"', 'viewBox="0 0 0 2"'])
		assert.throws(() => inputFor(attributes));
	assert.throws(() => prepareSvgRenderInput(Buffer.from('<svg><path></svg>')));
	assert.throws(() => prepareSvgRenderInput(Buffer.from('<html/>')), /有效 SVG/);
	for (const body of [
		'<image href="file:///private/file.png"/>', '<use href="other.svg#id"/>',
		'<image href="https://example.com/image.png"/>', '<style>@import "https://example.com/a.css";</style>',
		'<path style="fill:url(https://example.com/a.svg#paint)"/>', '<foreignObject><div/></foreignObject>'
	]) assert.throws(() => inputFor(undefined, body));
	assert.doesNotThrow(() => inputFor(undefined, '<defs><path id="a" d="M0 0L1 1"/></defs><use href="#a"/>'));

	await mkdir(join(workspace, "assets"));
	const original = svg(undefined, `<desc>${randomUUID()}</desc><rect width="4" height="2" fill="red"/>`);
	const sourcePath = join(workspace, "assets", "diagram.SVG");
	await writeFile(sourcePath, original);
	await writeFile(join(workspace, "note.md"), "![[diagram.SVG]]");
	const index = await buildLocalImageFileIndex(workspace);
	assert.ok(index.paths.has("assets/diagram.SVG"));
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace, markdownPaths: ["note.md"], changedImagePaths: ["assets/diagram.SVG"]
	}), ["note.md"]);
	let renders = 0;
	const prepare = (content = "![[diagram.SVG]]", renderSvg = async (input) => {
		renders++;
		return png(input.width, input.height, input.svg.includes('fill="blue"') ? 100 : 255);
	}) => prepareLocalImages({ vaultRoot: workspace, markdownPath: "note.md", content, imageIndex: index, renderSvg });
	const first = (await prepare()).images[0];
	cachedPaths.add(first.absolutePath);
	assert.equal(first.vaultPath, "assets/diagram.SVG", "source identity stays the SVG vault path");
	assert.match(first.absolutePath, /\.png$/);
	assert.equal(first.mimeType, "image/png");
	assert.equal(first.sourceWidth, 8);
	assert.equal(first.sourceHeight, 4);
	assert.equal(first.displayWidth, 4, "2x rasterization does not double the displayed size");
	assert.equal(first.displayHeight, 2);
	assert.equal(first.contentHash, createHash("sha256").update(await readFile(first.absolutePath)).digest("hex"));
	const command = buildMediaInsertArgs("doc", first);
	assert.equal(command[command.indexOf("--file") + 1], `./${basename(first.absolutePath)}`);
	const cachedTime = (await stat(first.absolutePath)).mtimeMs;
	assert.deepEqual((await prepare()).images[0], first);
	assert.equal(renders, 1);
	assert.equal((await stat(first.absolutePath)).mtimeMs, cachedTime);
	const sized = await prepare("![图|120](assets/diagram.SVG)\n![[diagram.SVG|80x60]]\n![[diagram.SVG|80x60]]");
	assert.equal(sized.images[0].displayWidth, 120);
	assert.equal(sized.images[0].displayHeight, 60);
	assert.equal(sized.images[0].alt, "图");
	assert.equal(sized.images[1].displayHeight, 60);
	assert.notEqual(sized.images[1].placeholder, sized.images[2].placeholder);
	assert.equal(renders, 1, "all occurrences and display sizes share the rendered file");
	assert.equal(await readFile(sourcePath, "utf8"), original);
	await writeFile(first.absolutePath, "incomplete cache");
	assert.equal((await prepare()).images[0].contentHash, first.contentHash);
	assert.equal(renders, 2, "interrupted or truncated cache entries are regenerated");
	await rm(first.absolutePath);
	const alternateEncoding = (await prepare(undefined, async (input) => png(input.width, input.height, 120))).images[0];
	assert.notEqual(alternateEncoding.contentHash, first.contentHash);
	assert.equal(alternateEncoding.placeholder, first.placeholder, "browser and hook PNG encodings keep the same SVG sync identity");
	await writeFile(sourcePath, original.replace('fill="red"', 'fill="blue"'));
	const changed = (await prepare()).images[0];
	cachedPaths.add(changed.absolutePath);
	assert.notEqual(changed.absolutePath, first.absolutePath);
	assert.notEqual(changed.contentHash, first.contentHash);
	assert.notEqual(changed.placeholder, first.placeholder, "SVG-only changes invalidate note sync");
	await assert.rejects(prepare("![[missing.svg]]"), (error) => error.reason === "image-missing");
	await writeFile(sourcePath, original + " ");
	await assert.rejects(prepare(undefined, async () => { throw new Error("render failed"); }),
		(error) => error.reason === "svg-render-failed" && /render failed.*note.md.*diagram.SVG/.test(error.message));
	await assert.rejects(prepare(undefined, async () => Buffer.from("not PNG")), /预期尺寸的 PNG/);

	const savedPath = process.env.PATH;
	try {
		process.env.PATH = workspace;
		await assert.rejects(renderSvgWithResvg(inputFor()), /需要 resvg.*Obsidian/);
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
	}
} finally {
	await rm(workspace, { recursive: true, force: true });
	for (const path of cachedPaths) await rm(path, { force: true });
	await rm(outfile, { force: true });
}
console.log("SVG image tests passed");

// A real PNG fixture also works for decoder-level checks outside these tests.
function png(width, height, red) {
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const header = Buffer.alloc(4), footer = Buffer.alloc(4);
		header.writeUInt32BE(data.length);
		let crc = 0xffffffff;
		for (const byte of body) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([header, body, footer]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
	const pixels = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = y * (1 + width * 4) + 1 + x * 4;
		pixels[offset] = red; pixels[offset + 3] = 255;
	}
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
