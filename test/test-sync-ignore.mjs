import assert from "node:assert/strict";
import esbuild from "esbuild";
import { rm } from "node:fs/promises";

const outfile = "test/.tmp-sync-ignore-test.mjs";
await esbuild.build({
	bundle: true, format: "esm", outfile, platform: "node", target: "node20",
	stdin: {
		contents: `export * from "./src/sync-ignore"; export { IgnoreRules } from "./src/ignore-rules";`,
		resolveDir: process.cwd(), loader: "ts"
	}
});

try {
	const {
		IGNORE_FILE_HEADER, IgnoreRules, buildIgnoreTree, clearRuleLines, computeIgnoreStates, formatRule,
		indexIgnoreTree, listRuleLines, setPathIgnored
	} = await import("./.tmp-sync-ignore-test.mjs");

	const file = (path, extension) => ({ path, name: path.split("/").pop(), extension });
	const folder = (path, children) => ({ path, name: path.split("/").pop() ?? "", children });
	const vault = folder("/", [
		folder("Proj", [
			folder("Proj/Notes", [
				file("Proj/Notes/a.md", "md"), file("Proj/Notes/b.md", "md"), file("Proj/Notes/odd [1].md", "md"),
				folder("Proj/Notes/Private", [file("Proj/Notes/Private/c.md", "md"), file("Proj/Notes/Private/d.md", "md")]),
				folder("Proj/Notes/Img", [file("Proj/Notes/Img/p.png", "png")])
			]),
			folder("Proj/Docs", [file("Proj/Docs/x.md", "md"), file("Proj/Docs/y.PDF", "PDF"), file("Proj/Docs/my file.md", "md")]),
			folder("Proj/Empty", [folder("Proj/Empty/Nested", [file("Proj/Empty/Nested/x.csv", "csv")])]),
			file("Proj/top.md", "md"),
			file("Proj/data.csv", "csv")
		]),
		file("Outside.md", "md")
	]);

	// The tree lists only what reaches Feishu and drops folders with nothing to sync.
	const tree = buildIgnoreTree(vault);
	const index = indexIgnoreTree(tree);
	assert.deepEqual(index.get("Proj").children.map((child) => child.path), ["Proj/Docs", "Proj/Notes", "Proj/top.md"]);
	assert.deepEqual(index.get("Proj/Docs").children.map((child) => child.path), ["Proj/Docs/my file.md", "Proj/Docs/x.md", "Proj/Docs/y.PDF"]);
	assert.ok(!index.has("Proj/Empty"), "folders holding no syncable files are hidden");
	assert.ok(!index.has("Proj/data.csv"));
	assert.deepEqual(buildIgnoreTree(file("a.csv", "csv")).children, []);
	assert.ok(indexIgnoreTree(buildIgnoreTree(folder("/", [file("diagram.SVG", "SVG")]))).has("diagram.SVG"));

	// States come from the rules that apply to each vault path, wherever they were written.
	const rules = new IgnoreRules();
	rules.setFile("Proj", "/Notes/Private/c.md\n*.PDF\n");
	rules.setFile("Proj/Docs", "!y.PDF\n/my file.md\n");
	const states = computeIgnoreStates(rules, index.get("Proj"));
	assert.equal(states.get("Proj/Notes/Private/c.md"), "ignored");
	assert.equal(states.get("Proj/Notes/Private/d.md"), "included");
	assert.equal(states.get("Proj/Notes/Private"), "partial");
	assert.equal(states.get("Proj/Notes"), "partial");
	assert.equal(states.get("Proj/Docs/y.PDF"), "included", "a deeper rule file overrides the parent's wildcard");
	assert.equal(states.get("Proj/Docs/my file.md"), "ignored");
	assert.equal(states.get("Proj/Docs"), "partial");
	assert.equal(states.get("Proj/top.md"), "included");
	assert.ok(!states.has("Proj"), "the sync folder itself has no state");
	rules.setFile("Proj", "/Notes/\n");
	const covered = computeIgnoreStates(rules, index.get("Proj"));
	assert.equal(covered.get("Proj/Notes"), "ignored");
	assert.equal(covered.get("Proj/Notes/Private/d.md"), "ignored", "everything under an ignored folder is ignored");

	// Editing the rule file. Rule paths are relative to the sync folder "Proj".
	const scope = "Proj";
	const treeIndex = index;
	const rulesFor = (text) => {
		const result = new IgnoreRules();
		result.setFile(scope, text);
		return result;
	};
	const ctx = {
		isIgnored: (text, path, isFolder) => rulesFor(text).isIgnored(`${scope}/${path}`, isFolder),
		explain: (text, path, isFolder) => JSON.stringify(rulesFor(text).explain(`${scope}/${path}`, isFolder)),
		listChildren: (path) => (treeIndex.get(path ? `${scope}/${path}` : scope)?.children ?? [])
			.map((child) => ({ path: child.path.slice(scope.length + 1), isFolder: child.isFolder }))
	};
	const edit = (text, path, isFolder, ignore) => {
		const result = setPathIgnored(text, path, isFolder, ignore, ctx);
		assert.ok(result.ok, `${ignore ? "ignore" : "include"} ${path}: ${result.reason}`);
		return result.text;
	};

	// A new file gets a header and one anchored line per choice.
	assert.equal(edit("", "top.md", false, true), `${IGNORE_FILE_HEADER}\n/top.md\n`);
	assert.equal(formatRule("Notes/Private", true), "/Notes/Private/");
	assert.equal(formatRule("Notes/odd [1].md", false), "/Notes/odd \\[1\\].md");
	assert.equal(formatRule("a.md", false, true), "!/a.md");

	// Ignoring something already covered, or including something already synced, changes nothing.
	assert.equal(edit("/Notes/\n", "Notes/a.md", false, true), "/Notes/\n");
	assert.equal(edit("/top.md\n", "Docs/x.md", false, false), "/top.md\n");

	// Including a file inside an ignored folder splits the folder, keeping the other children ignored.
	assert.equal(edit("/Notes/\n", "Notes/a.md", false, false),
		"/Notes/Img/\n/Notes/Private/\n/Notes/b.md\n/Notes/odd \\[1\\].md\n");
	assert.equal(edit("/Notes/\n", "Notes/Private/c.md", false, false),
		"/Notes/Img/\n/Notes/a.md\n/Notes/b.md\n/Notes/odd \\[1\\].md\n/Notes/Private/d.md\n");
	// Including a folder drops the rules inside it too.
	assert.equal(edit("/Notes/Private/c.md\n/Docs/\n", "Notes", true, false), "/Docs/\n");
	// When every child ends up ignored the folder takes over, so files added later follow.
	assert.equal(edit("/Docs/x.md\n/Docs/y.PDF\n", "Docs/my file.md", false, true), "/Docs/\n");
	const split = edit("/Docs/\n", "Docs/x.md", false, false);
	assert.equal(edit(split, "Docs/x.md", false, true), "/Docs/\n", "splitting and re-ignoring round-trips");

	// Wildcard rules written by hand are kept; a "!" line brings single items back.
	assert.equal(edit("*.md\n", "top.md", false, false), "*.md\n!/top.md\n");
	assert.equal(edit("*.md\n!/top.md\n", "top.md", false, true), "*.md\n", "ignoring again removes the exception");
	assert.equal(edit("# mine\n*.md\n", "top.md", false, true), "# mine\n*.md\n");
	// Checking a partial folder restores all descendants covered by handwritten wildcards,
	// and keeps siblings outside that folder ignored.
	for (const pattern of ["*.md", "**/*.md", "Notes/**", "Notes/*", "*.md\n!/Notes/**\nNotes/*.md"]) {
		const included = edit(`${pattern}\n`, "Notes", true, false);
		for (const line of pattern.split("\n").filter((line) => !line.startsWith("!"))) {
			assert.ok(included.split("\n").includes(line), "handwritten wildcard rules are preserved");
		}
		for (const node of treeIndex.values()) {
			if (node.path.startsWith("Proj/Notes/")) {
				assert.equal(rulesFor(included).isIgnored(node.path, node.isFolder), false, `${pattern}: ${node.path}`);
			}
		}
		assert.equal(rulesFor(included).isIgnored("Proj/Notes/future/deep/new.md"), false);
		if (pattern.includes("*.md")) assert.equal(rulesFor(included).isIgnored("Proj/Docs/x.md"), true);
		const ignoredAgain = edit(included, "Notes", true, true);
		assert.equal(rulesFor(ignoredAgain).isIgnored("Proj/Notes/a.md"), true);
	}
	// A deeper rule file cannot be overridden from this page; report its descendant
	// instead of claiming that the whole folder was successfully included.
	const nestedRules = (text) => {
		const nested = rulesFor(text);
		nested.setFile("Proj/Notes/Private", "/c.md\n");
		return nested;
	};
	const nestedContext = { ...ctx,
		isIgnored: (text, path, folder) => nestedRules(text).isIgnored(`Proj/${path}`, folder),
		explain: (text, path, folder) => JSON.stringify(nestedRules(text).explain(`Proj/${path}`, folder))
	};
	const blockedSubtree = setPathIgnored("*.md\n", "Notes", true, false, nestedContext);
	assert.equal(blockedSubtree.ok, false);
	assert.match(blockedSubtree.reason, /Proj\/Notes\/Private/);
	// A folder ignored by a wildcard cannot be reopened for a single file, and the page says why.
	const blocked = setPathIgnored("Private/\n", "Notes/Private/c.md", false, false, ctx);
	assert.equal(blocked.ok, false);
	assert.match(blocked.reason, /Private\//);

	// The rule lines of a file, without comments.
	assert.deepEqual(listRuleLines("# c\n\n/a.md\r\n*.log\n"), ["/a.md", "*.log"]);
	assert.equal(clearRuleLines("# c\n\n/a.md\n*.log\n"), "# c\n\n");
	assert.equal(clearRuleLines("/a.md\n"), "");

	// Random choices against a model: whatever the order of operations, the file ends up saying exactly
	// what was chosen, and its plain rules never repeat or sit inside an ignored folder.
	const nodes = [...treeIndex.values()].filter((node) => node.path.startsWith(`${scope}/`));
	const leaves = nodes.filter((node) => !node.isFolder).map((node) => node.path.slice(scope.length + 1));
	let seed = 20261022;
	const random = (limit) => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed % limit;
	};
	let text = "";
	const model = new Map(leaves.map((leaf) => [leaf, false]));
	for (let step = 0; step < 400; step += 1) {
		const node = nodes[random(nodes.length)];
		const path = node.path.slice(scope.length + 1);
		const ignore = random(2) === 0;
		text = edit(text, path, node.isFolder, ignore);
		for (const leaf of leaves) if (leaf === path || leaf.startsWith(`${path}/`)) model.set(leaf, ignore);

		const current = rulesFor(text);
		for (const leaf of leaves) {
			assert.equal(current.isIgnored(`${scope}/${leaf}`), model.get(leaf), `step ${step}: ${leaf} after ${ignore ? "ignoring" : "including"} ${path}\n${text}`);
		}
		const ruleLines = listRuleLines(text);
		assert.equal(new Set(ruleLines).size, ruleLines.length, `step ${step}: duplicate rule\n${text}`);
		const plainPaths = ruleLines.map((line) => line.replace(/^\//, "").replace(/\/$/, "").replace(/\\(.)/g, "$1"));
		for (const plain of plainPaths) {
			assert.ok(!plainPaths.some((other) => other !== plain && plain.startsWith(`${other}/`)), `step ${step}: ${plain} sits inside an ignored folder\n${text}`);
		}
		// Folder state follows its leaves.
		const folderStates = computeIgnoreStates(rulesFor(text), treeIndex.get(scope));
		for (const folderNode of nodes.filter((candidate) => candidate.isFolder)) {
			const below = leaves.filter((leaf) => `${scope}/${leaf}`.startsWith(`${folderNode.path}/`));
			const ignoredCount = below.filter((leaf) => model.get(leaf)).length;
			const expected = ignoredCount === below.length ? "ignored" : ignoredCount === 0 ? "included" : "partial";
			assert.equal(folderStates.get(folderNode.path), expected, `step ${step}: state of ${folderNode.path}\n${text}`);
		}
	}
} finally {
	await rm(outfile, { force: true });
}

console.log("sync ignore tests passed");
