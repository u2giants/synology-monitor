package jobs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCleanShareRelPath(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"", "", true},
		{"/clients/acme/", "clients/acme", true},
		{`clients\acme`, "clients/acme", true},
		{"../outside", "", false},
		{"clients/../../outside", "", false},
	}
	for _, tc := range tests {
		got, err := CleanShareRelPath(tc.in)
		if tc.ok && err != nil {
			t.Fatalf("CleanShareRelPath(%q) unexpected error: %v", tc.in, err)
		}
		if !tc.ok && err == nil {
			t.Fatalf("CleanShareRelPath(%q) expected error", tc.in)
		}
		if got != tc.want {
			t.Fatalf("CleanShareRelPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestListShareDirsInRoot(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{
		"Clients/Acme",
		"Clients/Beta",
		"Archive/Old",
		"@eaDir/thumbs",
	} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(path)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "readme.txt"), []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}

	top, err := listShareDirsInRoot("files", "", root)
	if err != nil {
		t.Fatalf("listShareDirsInRoot top: %v", err)
	}
	if len(top.Dirs) != 1 || top.Dirs[0].Path != "Clients" {
		t.Fatalf("top dirs = %#v, want Clients only", top.Dirs)
	}

	clients, err := listShareDirsInRoot("files", "Clients", root)
	if err != nil {
		t.Fatalf("listShareDirsInRoot Clients: %v", err)
	}
	if len(clients.Dirs) != 2 || clients.Dirs[0].Path != "Clients/Acme" || clients.Dirs[1].Path != "Clients/Beta" {
		t.Fatalf("client dirs = %#v, want Acme and Beta", clients.Dirs)
	}
}
