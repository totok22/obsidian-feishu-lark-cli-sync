import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export interface SvgRenderInput {
	svg: string;
	width: number;
	height: number;
}
export type SvgRenderer = (input: SvgRenderInput) => Promise<Buffer>;

/** Normalize intrinsic sizes before either renderer sees the SVG; cap allocation before rendering. */
export function prepareSvgRenderInput(bytes: Buffer): SvgRenderInput & { displayWidth: number; displayHeight: number } {
	const source = bytes.toString("utf8");
	if (/<!ENTITY\s/i.test(source)) throw new Error("SVG 不支持实体声明，请导出为独立 SVG 后重试");
	const document = new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
		.parseFromString(source, "image/svg+xml");
	const root = document.documentElement;
	if (!root || root.localName !== "svg" || (root.namespaceURI && root.namespaceURI !== "http://www.w3.org/2000/svg"))
		throw new Error("文件不是有效 SVG 图片");
	const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
	for (const element of elements) {
		if (["script", "foreignObject"].includes(element.localName || ""))
			throw new Error("SVG 含脚本或 HTML 内容，请先导出为纯 SVG 或 PNG");
		for (const attribute of Array.from(element.attributes)) {
			if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
			if (attribute.localName === "href" || attribute.name === "src") {
				if (element.localName === "a") element.removeAttribute(attribute.name);
				else assertEmbeddedResource(attribute.value);
			}
			if (/url\s*\(|@import/i.test(attribute.value)) assertEmbeddedCss(attribute.value);
		}
		if (element.localName === "style") assertEmbeddedCss(element.textContent || "");
	}
	const viewBoxText = root.getAttribute("viewBox");
	const viewBox = viewBoxText?.trim().split(/[\s,]+/).map(Number);
	if (viewBox && (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))
		|| viewBox[2]! <= 0 || viewBox[3]! <= 0)) throw new Error("SVG viewBox 无效");
	const intrinsicWidth = svgLength(root.getAttribute("width"));
	const intrinsicHeight = svgLength(root.getAttribute("height"));
	const ratio = viewBox ? viewBox[2]! / viewBox[3]! : undefined;
	const logicalWidth = intrinsicWidth ?? (intrinsicHeight && ratio ? intrinsicHeight * ratio : viewBox?.[2] ?? 300);
	const logicalHeight = intrinsicHeight ?? (intrinsicWidth && ratio ? intrinsicWidth / ratio : viewBox?.[3] ?? 150);
	if (![logicalWidth, logicalHeight].every((value) => Number.isFinite(value) && value > 0))
		throw new Error("SVG 图片尺寸必须大于零");
	const scale = Math.min(2, 8192 / logicalWidth, 8192 / logicalHeight,
		Math.sqrt(16_000_000 / logicalWidth / logicalHeight));
	const width = Math.max(1, Math.floor(logicalWidth * scale));
	const height = Math.max(1, Math.floor(logicalHeight * scale));
	root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	// Give both renderers the same integer viewport. Resvg otherwise fits fractional
	// intrinsic sizes inside the requested box and can return fewer pixels than requested.
	if (!viewBox) root.setAttribute("viewBox", `0 0 ${logicalWidth} ${logicalHeight}`);
	root.setAttribute("width", String(width));
	root.setAttribute("height", String(height));
	// Serialize only the root, so XML processing instructions and external doctypes never reach the renderer.
	return {
		svg: new XMLSerializer().serializeToString(root), width, height,
		displayWidth: Math.max(1, Math.round(Math.min(820, logicalWidth))),
		displayHeight: Math.max(1, Math.round(logicalHeight * Math.min(820, logicalWidth) / logicalWidth))
	};
}

function svgLength(value: string | null): number | undefined {
	if (!value || value.endsWith("%")) return undefined;
	const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i);
	if (!match) throw new Error(`不支持的 SVG 尺寸：${value}`);
	const units: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };
	return Number(match[1]) * units[(match[2] || "px").toLowerCase()]!;
}

function assertEmbeddedResource(value: string): void {
	if (!value.trim() || /^(?:#|data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,)/i.test(value.trim())) return;
	throw new Error("SVG 引用了外部资源，请将图片嵌入 SVG 后重试");
}

function assertEmbeddedCss(css: string): void {
	if (/@import|\\/i.test(css)) throw new Error("SVG 不支持外部或转义 CSS 资源，请导出为独立 SVG 后重试");
	for (const match of css.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) assertEmbeddedResource(match[2] || "");
}

export async function prepareSvgImage(bytes: Buffer, render?: SvgRenderer): Promise<{
	absolutePath: string; png: Buffer; displayWidth: number; displayHeight: number;
}> {
	const input = prepareSvgRenderInput(bytes);
	const browser = typeof document !== "undefined" && typeof Image !== "undefined";
	const key = createHash("sha256").update(bytes).update(JSON.stringify({
		version: 1, renderer: render ? "custom" : browser ? "chromium" : "resvg", width: input.width, height: input.height
	})).digest("hex");
	const cache = join(tmpdir(), "feishu-docs-publisher-svg-v1");
	const absolutePath = join(cache, `${key}.png`);
	let png: Buffer | undefined;
	try { png = await readFile(absolutePath); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!png || !isRenderedPng(png, input)) {
		png = await (render || (browser ? renderSvgInBrowser : renderSvgWithResvg))(input);
		if (!isRenderedPng(png, input)) throw new Error("SVG 转换未返回预期尺寸的 PNG 图片");
		await mkdir(cache, { recursive: true });
		const temporary = `${absolutePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, png);
			await rename(temporary, absolutePath);
		} finally { await rm(temporary, { force: true }); }
	}
	return { absolutePath, png, displayWidth: input.displayWidth, displayHeight: input.displayHeight };
}

function isRenderedPng(png: Buffer, input: SvgRenderInput): boolean {
	return png.length > 32 && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
		&& png.readUInt32BE(16) === input.width && png.readUInt32BE(20) === input.height;
}

/** Obsidian's Chromium decodes SVG as an inert image; no external executable is needed. */
export async function renderSvgInBrowser(input: SvgRenderInput): Promise<Buffer> {
	const url = URL.createObjectURL(new Blob([input.svg], { type: "image/svg+xml" }));
	const image = new Image();
	const canvas = document.createElement("canvas");
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { image.src = ""; reject(new Error("SVG 图片解码超时")); }, 30_000);
			image.onload = () => { clearTimeout(timer); resolve(); };
			image.onerror = () => { clearTimeout(timer); reject(new Error("无法解码 SVG 图片，请检查文件内容")); };
			image.src = url;
		});
		canvas.width = input.width;
		canvas.height = input.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("无法创建 SVG 渲染画布");
		context.drawImage(image, 0, 0, input.width, input.height);
		return Buffer.from(canvas.toDataURL("image/png").split(",")[1]!, "base64");
	} finally {
		image.onload = null;
		image.onerror = null;
		URL.revokeObjectURL(url);
		canvas.width = canvas.height = 0;
	}
}

/** The standalone Git hook has no DOM, so use resvg from PATH. */
export async function renderSvgWithResvg(input: SvgRenderInput): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const process = execFile("resvg", ["--width", String(input.width), "--height", String(input.height), "-", "-c"],
			{ encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
				if (error) reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT"
					? "Git hook 转换 SVG 需要 resvg，请安装并加入 PATH，或在 Obsidian 内同步。macOS 可运行 brew install resvg。"
					: "SVG 转 PNG 失败，请检查 SVG 文件或在 Obsidian 内同步"));
				else resolve(stdout);
			});
		process.stdin?.on("error", () => { /* execFile reports process failure in its callback. */ });
		process.stdin?.end(input.svg);
	});
}
