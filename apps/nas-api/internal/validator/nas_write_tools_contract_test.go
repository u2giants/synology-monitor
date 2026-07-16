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
			for _, line := range strings.Split(c.Command, "\n") {
				// Any line that both references the payload and is not carrying it
				// inside single quotes would be executing it.
				if strings.Contains(line, "touch /tmp/OWNED") && !strings.Contains(line, "'") {
					t.Errorf("hostile filter appears outside single quotes, so it would execute:\n%s", line)
				}
			}
			if !strings.Contains(c.Command, "'"+strings.Replace(c.Filter, "/volume1", "/btrfs/volume1", 1)+"'") {
				t.Errorf("expected the filter to appear single-quoted in the command:\n%s", c.Command)
			}
		})
	}
}
