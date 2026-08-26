package validator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The tier-3 rename tools live in TypeScript (packages/shared/src/nas-tools.ts) but
// their security depends on how THIS classifier reads their output. That split is
// exactly where a regression hides: ClassifyTier matches filePatterns line-by-line
// and Go regexes do not cross newlines, so a harmless-looking refactor of the builder
// (hoisting the path into a shell variable, `mv "$src" "$dest"`) silently reclassifies
// a user-data write from tier 3 to tier 2 — no error, no failing build, just a weaker
// approval than the operator was promised. Measured, not hypothetical: that refactor
// was written and caught here during the 2026-07-16 injection fix.
//
// Go cannot invoke the TypeScript builder, so the seam is a golden file generated from
// the real builder. packages/shared/src/nas-tools.golden.test.ts fails if the golden
// drifts from what the builder emits, so a stale golden cannot silently pass here.
//
// If this test fails after an intentional builder change: regenerate the golden
// (UPDATE_GOLDEN=1 npx vitest run src/nas-tools.golden.test.ts) and then decide
// whether the new tier is correct — do not just update the expectation.

type goldenCase struct {
	Tool         string `json:"tool"`
	Filter       string `json:"filter"`
	ExactPath    string `json:"exactPath"`
	ExpectedTier int    `json:"expectedTier"`
	Command      string `json:"command"`
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "shared", "src", "__fixtures__", "nas-write-commands.golden.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading golden %s: %v (generate it with: UPDATE_GOLDEN=1 npx vitest run src/nas-tools.golden.test.ts)", path, err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parsing golden: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("golden is empty; it must cover the tier-3 write tools")
	}
	return cases
}

func TestNasWriteToolsClassifyAtDeclaredTier(t *testing.T) {
	for _, c := range loadGolden(t) {
		t.Run(c.Tool+" "+c.Filter, func(t *testing.T) {
			if IsHardBlocked(c.Command) {
				t.Fatalf("command is hard-blocked, so the tool cannot run at all:\n%s", c.Command)
			}
			if got := ClassifyTier(c.Command); got != c.ExpectedTier {
				t.Errorf("ClassifyTier = %d, want %d.\n"+
					"A user-data write classified below tier 3 loses the approval token "+
					"(buildApprovalToken fires on tier >= 2).\nCommand:\n%s",
					got, c.ExpectedTier, c.Command)
			}
		})
	}
}

// A hostile filter must be inert DATA in the generated command, never a second
// command the classifier cannot see. This is the original 2026-07-16 defect:
// filter='/volume1/x$(touch /tmp/INJECTED).txt' produced
// `mv "/volume1/x$(touch /tmp/INJECTED).txt" ...`, which classified as an ordinary
// rename while the payload ran as root at word-expansion time.
func TestNasWriteToolsCarryHostileFiltersAsQuotedData(t *testing.T) {
	for _, c := range loadGolden(t) {
		if !strings.Contains(c.Filter, "$(") && !strings.Contains(c.Filter, "`") {
			continue
		}
		t.Run("hostile "+c.Filter, func(t *testing.T) {
			quoted := singleQuotedMask(c.Command)
			for _, payload := range []string{"touch /tmp/OWNED"} {
				for i := 0; i < len(c.Command); i++ {
					idx := strings.Index(c.Command[i:], payload)
					if idx == -1 {
						break
					}
					at := i + idx
					if !quoted[at] {
						t.Errorf("hostile filter is NOT inside single quotes at offset %d, so it executes:\n%s",
							at, lineAt(c.Command, at))
					}
					i = at + 1
				}
			}
		})
	}
}

// singleQuotedMask reports, per byte, whether that byte is inside a POSIX sh
// single-quoted string — the only context that makes $( ) and ` ` inert.
//
// This replaces an earlier per-line "does the line contain an apostrophe?" check.
// That heuristic passed any line with a quote ANYWHERE on it, including a line
// carrying the payload outside the quotes, and it also assumed every tool passes
// the filter as a standalone quoted path (true of the rename tools, false of
// tools that embed it in a message or map it differently). The 2026-07-16
// registry audit added such tools to the golden, so the check had to become an
// actual quoting question rather than a proxy for one.
func singleQuotedMask(cmd string) []bool {
	mask := make([]bool, len(cmd))
	inSingle, inDouble, escaped := false, false, false
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && !inSingle:
			// Inside single quotes a backslash is literal; elsewhere it escapes.
			escaped = true
		case c == '\'' && !inDouble:
			inSingle = !inSingle
			continue // the delimiter itself is not "inside"
		case c == '"' && !inSingle:
			inDouble = !inDouble
			continue
		}
		mask[i] = inSingle
	}
	return mask
}

func lineAt(cmd string, at int) string {
	start := strings.LastIndex(cmd[:at], "\n") + 1
	end := strings.Index(cmd[at:], "\n")
	if end == -1 {
		return cmd[start:]
	}
	return cmd[start : at+end]
}
