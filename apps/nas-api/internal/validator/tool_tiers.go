package validator

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed nas_tool_minimum_tiers.json
var namedToolMinimumTiersJSON []byte

var namedToolMinimumTiers = mustLoadNamedToolMinimumTiers()

func mustLoadNamedToolMinimumTiers() map[string]int {
	var tiers map[string]int
	if err := json.Unmarshal(namedToolMinimumTiersJSON, &tiers); err != nil {
		panic(fmt.Sprintf("invalid named-tool minimum-tier contract: %v", err))
	}
	for name, tier := range tiers {
		if tier < TierRead || tier > TierFile {
			panic(fmt.Sprintf("invalid minimum tier %d for named tool %q", tier, name))
		}
	}
	return tiers
}

// EffectiveTier combines lexical classification with the server-owned minimum
// declared for a named registry tool. An empty tool name is the free-form path
// used by run_command and deliberately keeps pure lexical classification.
func EffectiveTier(command, toolName string) (int, error) {
	classified := ClassifyTier(command)
	if classified == -1 || toolName == "" {
		return classified, nil
	}
	minimum, ok := namedToolMinimumTiers[toolName]
	if !ok {
		return -1, fmt.Errorf("unknown named tool %q", toolName)
	}
	if minimum > classified {
		return minimum, nil
	}
	return classified, nil
}
