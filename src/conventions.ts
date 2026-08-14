export const ACM_INTERNAL_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);

/** Bounds backward protocol-complete searches so one unclosed batch cannot cause a full-branch O(n²) anchor walk. */
export const ANCHOR_SEARCH_WINDOW = 200;

/** `root` is a structural target keyword and cannot safely be used as an alias. */
export function isReservedTargetName(name: string): boolean {
 return name.toLowerCase() === "root";
}

/** Neutralize terminal control characters in dynamic TUI text while preserving tabs and line breaks. */
export function sanitizeTerminalText(value: string): string {
 return value
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/** Optional tool parameters: a provider may legitimately send `null` for "absent". */
export function optionalString(value: unknown): string | undefined {
 const trimmed = typeof value === "string" ? value.trim() : "";
 return trimmed.length > 0 ? trimmed : undefined;
}
