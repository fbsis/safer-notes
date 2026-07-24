import DOMPurify from "dompurify";
import { marked } from "marked";
import TurndownService from "turndown";

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  headingStyle: "atx",
  strongDelimiter: "**"
});

turndown.keep(["u"]);
turndown.addRule("strikethrough", {
  filter: ["del", "s", "strike"],
  replacement(content) {
    return content ? `~~${content}~~` : "";
  }
});

export function editorToMarkdown(editor) {
  const html = typeof editor.getSemanticHTML === "function"
    ? editor.getSemanticHTML()
    : editor.root.innerHTML;
  return turndown.turndown(html).trim();
}

export function noteToDelta(editor, note) {
  if (typeof note?.markdown === "string") {
    const rendered = marked.parse(note.markdown, {
      async: false,
      breaks: false,
      gfm: true
    });
    const sanitized = DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true }
    });
    return editor.clipboard.convert({ html: sanitized, text: "" });
  }

  // Compatibilidade com notas criadas antes do armazenamento em Markdown.
  if (note?.delta && Array.isArray(note.delta.ops)) return note.delta;
  return { ops: [{ insert: "\n" }] };
}
