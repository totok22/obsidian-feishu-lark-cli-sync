import { NativeTextElement } from "./native-text";

/** Feishu's native bright yellow background (10) and red foreground (1). */
export function colorBoldColonLabels(elements: NativeTextElement[]): NativeTextElement[] {
	const result: NativeTextElement[] = [];
	const eligible = (element: NativeTextElement | undefined) =>
		element?.text_run?.text_element_style?.bold === true && !element.text_run.text_element_style.inline_code;
	for (let i = 0; i < elements.length; ) {
		if (!eligible(elements[i])) {
			result.push(elements[i]!);
			i++;
			continue;
		}
		let end = i;
		while (end < elements.length && eligible(elements[end])) end++;
		const combined = elements
			.slice(i, end)
			.map((e) => e.text_run?.content || "")
			.join("");
		const colon = combined.search(/[:：]/);
		const follows = /^\s*[:：]/.test(elements[end]?.text_run?.content || "");
		const labelEnd = colon >= 0 ? colon : follows ? combined.length : 0;
		const prefix = combined.slice(0, labelEnd);
		const begin = prefix.length - prefix.trimStart().length;
		const stop = prefix.trimEnd().length;
		let offset = 0;
		for (; i < end; i++) {
			const element = elements[i]!,
				run = element.text_run!,
				content = run.content;
			const a = Math.max(0, Math.min(content.length, begin - offset));
			const b = Math.max(0, Math.min(content.length, stop - offset));
			if (b <= a) result.push(element);
			else {
				if (a) result.push({ text_run: { ...run, content: content.slice(0, a) } });
				result.push({
					text_run: {
						...run,
						content: content.slice(a, b),
						text_element_style: { ...run.text_element_style, background_color: 10, text_color: 1 }
					}
				});
				if (b < content.length) result.push({ text_run: { ...run, content: content.slice(b) } });
			}
			offset += content.length;
		}
	}
	return result;
}
