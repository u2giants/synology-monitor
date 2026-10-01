package dsm

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

func TestRedactURLError(t *testing.T) {
	e := &url.Error{Op: "Get", URL: "https://localhost:5001/webapi/entry.cgi?account=u&passwd=S3cret%40x&_sid=abc", Err: errors.New("timeout")}
	got := redactURLError(e).Error()
	if strings.Contains(got, "S3cret") || strings.Contains(got, "abc") {
		t.Fatalf("secret leaked: %s", got)
	}
	if !strings.Contains(got, "account=u") || !strings.Contains(got, "timeout") {
		t.Fatalf("lost context: %s", got)
	}
}
