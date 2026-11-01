import assert from "node:assert/strict";
import esbuild from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [entry, outfile] of [
	["src/image-gallery.ts", "test/.tmp-image-gallery-test.mjs"],
	["src/local-image.ts", "test/.tmp-image-gallery-local-image-test.mjs"]
]) {
	await esbuild.build({ bundle: true, entryPoints: [entry], format: "esm", outfile, platform: "node", target: "node20" });
}

const {
	IMAGE_GALLERY_MARKER,
	buildImageGalleryBody,
	isImageGalleryContent,
	planImageGalleries,
	replaceImageGalleryBody,
	stripImageGalleryMarker
} = await import("./.tmp-image-gallery-test.mjs");
const { buildLocalImageFileIndex, buildLocalImageFileIndexFromPaths, collectReferencedLocalImagePaths } = await import("./.tmp-image-gallery-local-image-test.mjs");

const noteName = (folderName) => `${folderName} images`;
const plan = (input) => planImageGalleries({ referencedImagePaths: new Set(), noteName, ...input });

const svgIndex = buildLocalImageFileIndexFromPaths(["assets/used.svg", "assets/spare.svg"]);
const svgReferences = collectReferencedLocalImagePaths([{ path: "Note.md", content: "![[used.svg]]" }], svgIndex);
assert.deepEqual([...svgReferences], ["assets/used.svg"]);
assert.deepEqual(plan({ imagePaths: [...svgIndex.paths], notes: [], referencedImagePaths: svgReferences }),
	[{ notePath: "assets/assets images.md", exists: false, imagePaths: ["assets/spare.svg"] }]);

// A folder that only holds images gets a note named after the folder.
assert.deepEqual(plan({
	imagePaths: ["Shots/10.png", "Shots/2.png", "Shots/1.png"],
	notes: []
}), [{ notePath: "Shots/Shots images.md", exists: false, imagePaths: ["Shots/1.png", "Shots/2.png", "Shots/10.png"] }]);

// Folders that also hold hand-written notes still collect their unreferenced images.
assert.deepEqual(plan({
	imagePaths: ["Notes/a.png", "Notes/b.png"],
	notes: [{ path: "Notes/readme.md", isGallery: false }],
	referencedImagePaths: new Set(["Notes/a.png"])
}), [{ notePath: "Notes/Notes images.md", exists: false, imagePaths: ["Notes/b.png"] }]);

// Fully referenced folders get nothing; sub folders are planned independently.
assert.deepEqual(plan({
	imagePaths: ["Notes/a.png", "Notes/attachments/b.png"],
	notes: [{ path: "Notes/readme.md", isGallery: false }],
	referencedImagePaths: new Set(["Notes/a.png"])
}), [{ notePath: "Notes/attachments/attachments images.md", exists: false, imagePaths: ["Notes/attachments/b.png"] }]);
assert.deepEqual(plan({
	imagePaths: ["Notes/a.png"],
	notes: [{ path: "Notes/readme.md", isGallery: false }],
	referencedImagePaths: new Set(["Notes/a.png"])
}), []);

// A hand-written note with the generated name is never reused or overwritten.
assert.deepEqual(plan({
	imagePaths: ["Notes/a.png"],
	notes: [{ path: "Notes/Notes images.md", isGallery: false }]
}), [{ notePath: "Notes/Notes images 2.md", exists: false, imagePaths: ["Notes/a.png"] }]);

// An existing gallery is reused wherever it lives, and emptied when nothing is left.
assert.deepEqual(plan({
	imagePaths: ["Shots/a.png"],
	notes: [{ path: "Shots/renamed.md", isGallery: true }]
}), [{ notePath: "Shots/renamed.md", exists: true, imagePaths: ["Shots/a.png"] }]);
assert.deepEqual(plan({
	imagePaths: ["Shots/a.png"],
	notes: [{ path: "Shots/renamed.md", isGallery: true }],
	referencedImagePaths: new Set(["Shots/a.png"])
}), [{ notePath: "Shots/renamed.md", exists: true, imagePaths: [] }]);

// Images at the vault root use the root name supplied by the caller.
assert.deepEqual(plan({ imagePaths: ["a.png"], notes: [], noteName: (name) => `${name || "Vault"} images` }),
	[{ notePath: "Vault images.md", exists: false, imagePaths: ["a.png"] }]);

// The marker identifies generated notes locally and never reaches the remote document.
const body = buildImageGalleryBody(["Shots/a.png", "Shots/b.png"]);
assert.equal(body, `${IMAGE_GALLERY_MARKER}\n\n![[Shots/a.png]]\n\n![[Shots/b.png]]\n`);
assert.equal(isImageGalleryContent(body), true);
assert.equal(isImageGalleryContent("![[Shots/a.png]]\n"), false);
assert.equal(stripImageGalleryMarker(body), "![[Shots/a.png]]\n\n![[Shots/b.png]]\n");
assert.equal(stripImageGalleryMarker("# Title\n\ntext"), "# Title\n\ntext");

// Refreshing keeps the frontmatter that stores the Feishu binding.
const bound = `---\nlark_url: https://example.feishu.cn/docx/abc\n---\n${body}`;
assert.equal(replaceImageGalleryBody(bound, ["Shots/c.png"]),
	`---\nlark_url: https://example.feishu.cn/docx/abc\n---\n\n${buildImageGalleryBody(["Shots/c.png"])}`);
assert.equal(replaceImageGalleryBody(body, ["Shots/c.png"]), buildImageGalleryBody(["Shots/c.png"]));
assert.equal(replaceImageGalleryBody(bound, []), `---\nlark_url: https://example.feishu.cn/docx/abc\n---\n\n${IMAGE_GALLERY_MARKER}\n`);

// Referenced images are resolved like the sync does; unresolved or code-fenced references are ignored.
const workspace = await mkdtemp(join(tmpdir(), "image-gallery-test-"));
try {
	await mkdir(join(workspace, "Notes", "attachments"), { recursive: true });
	await mkdir(join(workspace, "Shots"), { recursive: true });
	for (const path of ["Notes/attachments/a.png", "Notes/b.png", "Shots/c.png", "Shots/d.png"]) {
		await writeFile(join(workspace, path), "x");
	}
	const index = await buildLocalImageFileIndex(workspace);
	const vaultIndex = buildLocalImageFileIndexFromPaths([
		"Notes/attachments/a.png", "Notes/b.png", "Shots/c.png", "Shots/d.png",
		"Notes/b.png", "Notes/readme.md", "Shots/../Shots/c.png"
	]);
	assert.deepEqual(vaultIndex, index, "a Vault path index resolves the same images without scanning disk");
	const duplicates = buildLocalImageFileIndexFromPaths(["Notes/a.png", "Shots/a.png"]);
	assert.deepEqual(duplicates.pathsByBasename.get("a.png"), ["Notes/a.png", "Shots/a.png"],
		"same-named images in different folders remain ambiguous");
	const referenced = collectReferencedLocalImagePaths([
		{ path: "Notes/readme.md", content: "![[a.png]]\n\n![x](b.png)\n\n![[missing.png]]\n\n```\n![[Shots/d.png]]\n```" },
		{ path: "Other.md", content: "![[Shots/c.png|300]]" }
	], index);
	assert.deepEqual(Array.from(referenced).sort(), ["Notes/attachments/a.png", "Notes/b.png", "Shots/c.png"]);
} finally {
	await rm(workspace, { force: true, recursive: true });
	await rm("test/.tmp-image-gallery-test.mjs", { force: true });
	await rm("test/.tmp-image-gallery-local-image-test.mjs", { force: true });
}

console.log("image gallery tests passed");
