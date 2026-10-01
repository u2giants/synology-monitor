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

func TestLoginErrorOmitsPassword(t *testing.T) {
	const pw = "Sup3rS3cretPw!"
	// Unroutable/closed port forces a transport error that includes the URL.
	c := NewClient("http://127.0.0.1:1", "admin", pw, false)
	err := c.Login()
	if err == nil {
		t.Fatal("expected login error")
	}
	if strings.Contains(err.Error(), pw) || strings.Contains(err.Error(), url.QueryEscape(pw)) {
		t.Fatalf("password leaked: %s", err)
	}
}

func TestIsAuthRejected(t *testing.T) {
	if !IsAuthRejected(&APIError{Code: 400}) || !IsAuthRejected(&APIError{Code: 407}) || IsAuthRejected(&APIError{Code: 119}) || IsAuthRejected(errors.New("x")) {
		t.Fatal("IsAuthRejected misclassified")
	}
}
