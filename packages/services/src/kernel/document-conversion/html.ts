import { DOCUMENT_LIMITS as L } from "./limits.js";
import { DocumentFailure } from "./types.js";

export async function sanitizeConvertedHtml(value: string): Promise<string> {
  if (Buffer.byteLength(value) > L.htmlBytes) throw new DocumentFailure("too_large", "source");
  const sanitize = (await import("sanitize-html")).default;
  const html = sanitize(value, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "ol",
      "ul",
      "li",
      "strong",
      "b",
      "em",
      "i",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
    ],
    allowedAttributes: {},
    allowedSchemes: [],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
  });
  if (Buffer.byteLength(html) > L.htmlBytes) throw new DocumentFailure("too_large", "source");
  return html;
}
