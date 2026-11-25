package activity

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	ok := Request{Since: 1000, Until: 1000 + 3600}
	if err := Validate(ok); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	for _, bad := range []Request{
		{Since: 0, Until: 10},
		{Since: 20, Until: 10},
		{Since: 1, Until: 1 + 7*3600},
		{Since: 1, Until: 2, Size: -1},
		{Since: 1, Until: 2, Contains: strings.Repeat("x", 600)},
	} {
		if Validate(bad) == nil {
			t.Fatalf("expected rejection for %+v", bad)
		}
	}
}

func TestQueriesUseOnlyIntegers(t *testing.T) {
	r := Request{Since: 1795565000, Until: 1795566000, Size: 2301462, Contains: "'; drop table logs; --"}
	for _, q := range []string{SMBQuery(r), DriveQuery(r)} {
		if strings.Contains(q, "drop") || strings.Contains(q, "--") {
			t.Fatalf("path fragment leaked into SQL: %s", q)
		}
		if !strings.Contains(q, "1795565000") || !strings.Contains(q, "1795566000") {
			t.Fatalf("window missing: %s", q)
		}
	}
	if !strings.Contains(SMBQuery(r), "filesize = 2301462") {
		t.Fatal("size filter missing")
	}
}

func TestLookupFiltersAndRunsReadOnly(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		if strings.Contains(strings.Join(args, " "), "SMBXFERDB") {
			return []byte(`[{"source":"smb","time":10,"username":"IML\\asilva","action":"rename","size":5,"path":"/mac/Decor/A/x.ai"},
			                {"source":"smb","time":11,"username":"IML\\b","action":"write","size":5,"path":"/mac/Decor/B/y.ai"}]`), nil
		}
		return nil, errors.New("no such file")
	}
	res := Lookup(context.Background(), Request{Since: 1, Until: 100, Contains: "decor/a/X.AI"}, run)
	if len(res.Events) != 1 || res.Events[0].Username != `IML\asilva` {
		t.Fatalf("unexpected events: %+v", res.Events)
	}
	if res.Errors["drive"] == "" {
		t.Fatal("drive error not reported")
	}
	for _, c := range calls {
		if c[0] != "nsenter" || !contains(c, "-readonly") {
			t.Fatalf("not a read-only host sqlite call: %v", c)
		}
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
