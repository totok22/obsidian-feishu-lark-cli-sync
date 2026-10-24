import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { tmpdir } from "os";
import {
	buildLocalMediaFileIndex,
	LocalImageFileIndex,
	LocalImageReference,
	LocalImageResource,
	replaceImageReferences,
	resolveLocalImageVaultPath
} from "./local-image";
import { transformProse } from "./obsidian-export";

export interface PdfCropReference extends LocalImageReference {
	page: number;
	rect?: [number, number, number, number];
}
export type PdfCropRenderer = (file: string, page: number, rect?: [number, number, number, number]) => Promise<Buffer>;
const run = promisify(execFile);

function isValidPng(png: Buffer): boolean {
	return (
		png.length >= 24 &&
		png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
		png.readUInt32BE(16) > 0 &&
		png.readUInt32BE(20) > 0
	);
}

export function scanPdfCropReferences(content: string): PdfCropReference[] {
	const refs: PdfCropReference[] = [];
	transformProse(content, (text, offset) => {
		for (const match of text.matchAll(/!\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g)) {
			const raw = match[1]!;
			const hash = raw.indexOf("#");
			if (hash < 0 || !/\.pdf$/i.test(raw.slice(0, hash))) continue;
			let backslashes = 0;
			for (let n = match.index - 1; n >= 0 && text[n] === "\\"; n--) backslashes++;
			if (backslashes % 2) continue;
			const params = new URLSearchParams(raw.slice(hash + 1));
			if (!params.has("rect") && !params.has("page")) continue;
			const page = Number(params.get("page") || "1");
			if (!Number.isInteger(page) || page < 1 || page > 100000) throw new Error(`无效 PDF 页码：${raw}`);
			const coords = params.has("rect") ? params.get("rect")!.split(",").map(Number) : undefined;
			if (
				coords &&
				(coords.length !== 4 ||
					coords.some((n) => !Number.isFinite(n)) ||
					coords[2]! <= coords[0]! ||
					coords[3]! <= coords[1]!)
			)
				throw new Error(`无效 PDF 裁剪区域：${raw}`);
			const size = match[2]?.match(/^(\d+)(?:x(\d+))?$/);
			const width = size ? Number(size[1]) : undefined,
				height = size?.[2] ? Number(size[2]) : undefined;
			if (width === 0 || height === 0) throw new Error("PDF 图片尺寸必须大于零");
			refs.push({
				sourceSyntax: match[0],
				target: raw.slice(0, hash),
				page,
				rect: coords as PdfCropReference["rect"],
				start: offset + match.index,
				end: offset + match.index + match[0].length,
				displayWidth: width,
				displayHeight: height,
				alt: size ? undefined : match[2]
			});
		}
		return text;
	});
	return refs;
}

/** Desktop Obsidian supplies a PDF.js renderer. The standalone Git hook uses Poppler. */
export async function preparePdfCropImages(input: {
	vaultRoot: string;
	markdownPath: string;
	content: string;
	imageIndex?: LocalImageFileIndex;
	render?: PdfCropRenderer;
}): Promise<{ content: string; images: LocalImageResource[] }> {
	const refs = scanPdfCropReferences(input.content);
	if (!refs.length) return { content: input.content, images: [] };
	const index = input.imageIndex || (await buildLocalMediaFileIndex(input.vaultRoot, true));
	const root = await realpath(input.vaultRoot);
	const cache = join(tmpdir(), "feishu-docs-publisher-pdf-crops-v1");
	await mkdir(cache, { recursive: true });
	const images: LocalImageResource[] = [];
	for (const [occurrence, ref] of refs.entries()) {
		const vaultPath = resolveLocalImageVaultPath(ref.target, input.markdownPath, index);
		if (!vaultPath) throw new Error(`找不到 PDF 附件：${ref.target}`);
		const path = await realpath(resolve(root, vaultPath));
		const rel = relative(root, path);
		if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === ".." || resolve(root, rel) !== path)
			throw new Error("PDF 附件超出 Vault 范围");
		const bytes = await readFile(path);
		const key = createHash("sha256")
			.update(bytes)
			.update(JSON.stringify({ page: ref.page, rect: ref.rect, scale: 2 }))
			.digest("hex");
		const output = join(cache, `${key}.png`);
		let png: Buffer | undefined;
		try {
			png = await readFile(output);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!png || !isValidPng(png)) {
			png = await (input.render || renderPdfCropWithPoppler)(path, ref.page, ref.rect);
			if (!isValidPng(png)) throw new Error("PDF 渲染未返回有效 PNG");
			// Publish a complete cache entry atomically; interrupted renders can retry.
			const temporary = `${output}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, png);
				await rename(temporary, output);
			} finally {
				await rm(temporary, { force: true });
			}
		}
		const sourceWidth = png.readUInt32BE(16),
			sourceHeight = png.readUInt32BE(20);
		const displayWidth = ref.displayWidth || Math.min(820, sourceWidth);
		const displayHeight = ref.displayHeight || Math.max(1, Math.round((sourceHeight * displayWidth) / sourceWidth));
		const contentHash = createHash("sha256").update(png).digest("hex");
		const identity = createHash("sha256")
			.update(
				JSON.stringify({ path: input.markdownPath, key, displayWidth, displayHeight, alt: ref.alt, occurrence })
			)
			.digest("hex");
		images.push({
			placeholder: `FEISHU_LARK_LOCAL_IMAGE_${identity}`,
			sourceSyntax: ref.sourceSyntax,
			vaultPath,
			absolutePath: output,
			contentHash,
			mimeType: "image/png",
			sourceWidth,
			sourceHeight,
			displayWidth,
			displayHeight,
			alt: ref.alt || `${basename(vaultPath)} · p.${ref.page}`
		});
	}
	return { content: replaceImageReferences(input.content, refs, images), images };
}

export async function renderPdfCropWithPoppler(
	file: string,
	page: number,
	rect?: [number, number, number, number]
): Promise<Buffer> {
	let info: string;
	try {
		info = (await run("pdfinfo", ["-f", String(page), "-l", String(page), "-box", file])).stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(
				"Git hook 渲染 PDF 图片需要 Poppler（pdfinfo/pdftoppm）；请安装后重试，或在 Obsidian 内发布。"
			);
		throw new Error(`无法读取 PDF 第 ${page} 页，请检查文件与页码：${basename(file)}`);
	}
	const rotation = Number(info.match(new RegExp(`Page\\s+${page}\\s+rot:\\s+(-?\\d+)`))?.[1] || 0);
	const box = info.match(
		new RegExp(`Page\\s+${page}\\s+CropBox:\\s+([\\d.-]+)\\s+([\\d.-]+)\\s+([\\d.-]+)\\s+([\\d.-]+)`)
	);
	if (!box || rotation !== 0)
		throw new Error("此 PDF 的旋转/页面边界需使用 Obsidian 内的 PDF.js 渲染器，请在 Obsidian 发布。");
	const [left, bottom, right, top] = box.slice(1).map(Number) as [number, number, number, number];
	const [x1, y1, x2, y2] = rect || [left, bottom, right, top];
	if (x1 < left || y1 < bottom || x2 > right || y2 > top) throw new Error("PDF 裁剪区域超出页面边界");
	const args = [
		"-f",
		String(page),
		"-l",
		String(page),
		"-singlefile",
		"-cropbox",
		"-r",
		"144",
		"-png",
		"-x",
		String(Math.floor((x1 - left) * 2)),
		"-y",
		String(Math.floor((top - y2) * 2)),
		"-W",
		String(Math.ceil((x2 - x1) * 2)),
		"-H",
		String(Math.ceil((y2 - y1) * 2)),
		file
	];
	const { stdout } = await run("pdftoppm", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}
