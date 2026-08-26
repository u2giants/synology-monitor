// Rendering helpers for the write-tool approval preview.
//
// The text these functions wrap is untrusted: a generated command embeds
// caller-supplied content (a filename discovered on the NAS, a share name), and
// an nas-api summary echoes that command back. Shell injection itself was closed
// in ff4c8c0, but the operator reading the preview is the last line of defence
// for tier-3 writes on a root/CAP_SYS_ADMIN service — the whole tier system
// assumes the human sees an accurate rendering of what will run. So untrusted
// text must not be able to alter the approval message around it.

/**
 * Marks every line of untrusted content. Content can contain this prefix too,
 * so the prefix alone does not authenticate a line — it works because the fence
 * bounds the block and the header tells the operator to expect it.
 */
export const QUOTE_PREFIX = "| ";

const TAB = 0x09;
const NEWLINE = 0x0a;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

// Invisible bidirectional-formatting characters. These are not control
// characters — they are legal Unicode that reorders how the *rest of the line*
// is drawn, so a filename like `report<RLO>cod.exe<PDF>` displays as
// `reportexe.doc` while its real bytes spell `cod.exe`. That is worse than the
// backtick breakout: it doesn't inject visible text, it changes what the real
// command looks like. Escaping them to a marker is the only way the operator
// sees the true character sequence. (The "Trojan Source" class, CVE-2021-42574.)
const BIDI_EMBEDDINGS_AND_OVERRIDES = new Set([
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x061c, // ARABIC LETTER MARK
]);

/**
 * Tab and newline are legitimate command content. Everything else in the C0 and
 * C1 blocks is not, including CR: a bare CR lets a terminal overwrite the line
 * it already drew, hiding what precedes it. Bidi formatting characters are
 * escaped too — they reorder the visible line without adding any text.
 */
function isDeceptiveChar(code: number): boolean {
  if (code === TAB || code === NEWLINE) return false;
  if (code < C1_START) return code <= 0x1f || code === DELETE;
  if (code <= C1_END) return true;
  if (code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return true;
  return BIDI_EMBEDDINGS_AND_OVERRIDES.has(code);
}

/**
 * Replaces control and bidi-formatting characters with a visible `<U+XXXX>`
 * marker, so the operator reads the true character sequence of the command.
 */
export function escapeControlChars(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += isDeceptiveChar(code)
      ? `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`
      : char;
  }
  return out;
}

/**
 * Picks a backtick run longer than any in `text`, so the content cannot close
 * the fence early and start writing markdown structure of its own.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Renders untrusted text as fenced, per-line-quoted lines. Returns the lines to
 * splice into a preview message. Multi-line input stays multi-line — many
 * generated commands are genuinely scripts, and collapsing them would cost the
 * operator the readability the preview exists for.
 */
export function renderUntrustedBlock(text: string): string[] {
  const escaped = escapeControlChars(text);
  const fence = fenceFor(escaped);
  const body = escaped.split("\n").map((line) => `${QUOTE_PREFIX}${line}`);
  return [fence, ...body, fence];
}

/** The line that tells the operator how to read a quoted block. */
export const QUOTE_LEGEND = `Each line below is prefixed with "${QUOTE_PREFIX}". Text without that prefix is not part of the command.`;
