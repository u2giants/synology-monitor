package activity

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
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

func TestArchiveSQLIsBoundedAndReadOnlyOnSource(t *testing.T) {
	q := ArchiveSQL(1795617934)
	for _, want := range []string{"mode=ro", "WITHOUT ROWID", "INSERT OR IGNORE", "cmd IN ('write','rename','create','move','delete')",
		"DELETE FROM smb_saves WHERE time < 1761057934"} {
		if !strings.Contains(q, want) {
			t.Fatalf("archive SQL missing %q:\n%s", want, q)
		}
	}
}

func TestArchiveOnceWritesOnlyTheArchive(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, nil
	}
	if err := ArchiveOnce(context.Background(), time.Unix(1795617934, 0), run); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !contains(calls[1], ArchiveDB) || contains(calls[1], SMBDB) {
		t.Fatalf("unexpected calls: %v", calls)
	}
}

func TestLookupMergesArchiveWithoutDuplicates(t *testing.T) {
	ev := `[{"source":"smb","time":10,"username":"IML\\asilva","action":"write","size":5,"path":"/mac/x.ai"}]`
	old := `[{"source":"smb","time":3,"username":"IML\\b","action":"rename","size":5,"path":"/mac/y.ai"}]`
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		all := strings.Join(args, " ")
		switch {
		case strings.Contains(all, "SMBXFERDB"):
			return []byte(ev), nil
		case strings.Contains(all, ArchiveDB):
			return []byte(ev[:len(ev)-1] + "," + old[1:]), nil
		}
		return []byte("[]"), nil
	}
	res := Lookup(context.Background(), Request{Since: 1, Until: 100}, run)
	if len(res.Events) != 2 || len(res.Errors) != 0 {
		t.Fatalf("want live+archived event once each, got %+v %v", res.Events, res.Errors)
	}
}

func TestFileStationAndTransferCommands(t *testing.T) {
	r := Request{Since: 10, Until: 20}
	if q := FileStationQuery(r); !strings.Contains(q, "'filestation' as source") || !strings.Contains(q, "'upload'") {
		t.Fatalf("file station query: %s", q)
	}
	for _, q := range []string{SMBQuery(r), ArchiveSQL(100)} {
		if !strings.Contains(q, "'move'") || !strings.Contains(q, "'delete'") {
			t.Fatalf("move/delete missing: %s", q)
		}
	}
	var dbs []string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		dbs = append(dbs, args[len(args)-2])
		if strings.Contains(args[len(args)-2], "DSMFMXFERDB") {
			return []byte(`[{"source":"filestation","time":15,"username":"ai","action":"upload","size":63,"path":"/mac/x.txt"}]`), nil
		}
		return []byte(""), nil
	}
	res := Lookup(context.Background(), r, run)
	if len(res.Events) != 1 || res.Events[0].Source != "filestation" {
		t.Fatalf("events %+v (dbs %v)", res.Events, dbs)
	}
}
