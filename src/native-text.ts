export interface NativeTextElement {
	text_run?: {
		content: string;
		text_element_style?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface NativeText {
	elements: NativeTextElement[];
	style?: { folded?: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextElement(value: unknown): value is NativeTextElement {
	if (!isRecord(value)) return false;
	if (value.text_run === undefined) return true;
	const run = value.text_run;
	if (!isRecord(run) || typeof run.content !== "string") return false;
	return run.text_element_style === undefined || isRecord(run.text_element_style);
}

/** Narrow only the fields we use; retain mentions, equations and API extensions. */
export function getNativeText(value: unknown): NativeText | undefined {
	if (!isRecord(value) || !Array.isArray(value.elements) || !value.elements.every(isTextElement)) return;
	if (
		value.style !== undefined &&
		(!isRecord(value.style) || (value.style.folded !== undefined && typeof value.style.folded !== "boolean"))
	) return;
	return value as NativeText;
}
