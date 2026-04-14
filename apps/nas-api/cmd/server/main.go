// Command server runs the NAS API HTTP service.
// It exposes three-tier shell execution behind a bearer-token + HMAC approval gate.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/synology-monitor/nas-api/internal/auth"
	"github.com/synology-monitor/nas-api/internal/executor"
	"github.com/synology-monitor/nas-api/internal/validator"
)

const (
	maxBodyBytes     = 16 * 1024
	maxCommandLength = 4096
)

// Build-time version info — injected via -ldflags by the Dockerfile.
var (
	BuildSHA  = "dev"
	BuildTime = "unknown"
)

// execRequest is the body expected on POST /exec.
type execRequest struct {
	Command       string `json:"command"`
	Tier          int    `json:"tier"`
	TimeoutMs     int64  `json:"timeout_ms,omitempty"`    // 0 → DefaultTimeout
	ApprovalToken string `json:"approval_token,omitempty"` // required for tier 2/3
}

// previewRequest is the body expected on POST /preview.
type previewRequest struct {
	Command string `json:"command"`
}

// previewResponse is returned by POST /preview.
type previewResponse struct {
	Tier    int    `json:"tier"`    // -1=blocked, 1=read, 2=service, 3=file
	Summary string `json:"summary"` // human-readable description for approval UI
	Blocked bool   `json:"blocked"`
}

// errResp is returned when any request fails validation.
type errResp struct {
	Error string `json:"error"`
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Printf("NAS API starting… (sha=%s built=%s)", BuildSHA, BuildTime)

	apiKey := mustEnv("NAS_API_SECRET")
	signingKey := mustEnv("NAS_API_APPROVAL_SIGNING_KEY")
	port := envOr("NAS_API_PORT", "7734")

	v := auth.NewVerifier(apiKey, signingKey)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /exec", requireAuth(v, handleExec(v)))
	mux.HandleFunc("POST /preview", requireAuth(v, handlePreview))

	addr := ":" + port
	log.Printf("Listening on %s", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// handleHealth responds with 200 OK and basic build info.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":     "ok",
		"build_sha":  BuildSHA,
		"build_time": BuildTime,
	})
}

// handleExec validates, optionally verifies an approval token, and executes the command.
func handleExec(v *auth.Verifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		var req execRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
			return
		}

		if req.Command == "" {
			writeJSON(w, http.StatusBadRequest, errResp{"command is required"})
			return
		}
		if req.Tier < 1 || req.Tier > 3 {
			writeJSON(w, http.StatusBadRequest, errResp{"tier must be 1, 2, or 3"})
			return
		}
		if len(req.Command) > maxCommandLength {
			writeJSON(w, http.StatusBadRequest, errResp{fmt.Sprintf("command exceeds %d bytes", maxCommandLength)})
			return
		}

		// Validate the command against tier rules.
		if err := validator.Validate(req.Command, req.Tier); err != nil {
			writeJSON(w, http.StatusForbidden, errResp{err.Error()})
			return
		}

		// Tier 2 and 3 require a valid approval token signed by the web app.
		if req.Tier >= 2 {
			if req.ApprovalToken == "" {
				writeJSON(w, http.StatusForbidden, errResp{"approval_token required for tier 2/3"})
				return
			}
			if err := v.VerifyApprovalToken(req.ApprovalToken, req.Command, req.Tier); err != nil {
				writeJSON(w, http.StatusForbidden, errResp{err.Error()})
				return
			}
		}

		timeout := time.Duration(req.TimeoutMs) * time.Millisecond
		result := executor.Run(req.Command, timeout)

		writeJSON(w, http.StatusOK, result)
	}
}

// handlePreview classifies a command's tier and returns a human-readable summary
// without executing anything. Used by the web app to build the approval prompt.
func handlePreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req previewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
		return
	}
	if req.Command == "" {
		writeJSON(w, http.StatusBadRequest, errResp{"command is required"})
		return
	}
	if len(req.Command) > maxCommandLength {
		writeJSON(w, http.StatusBadRequest, errResp{fmt.Sprintf("command exceeds %d bytes", maxCommandLength)})
		return
	}

	tier := validator.ClassifyTier(req.Command)
	writeJSON(w, http.StatusOK, previewResponse{
		Tier:    tier,
		Summary: validator.Summary(req.Command),
		Blocked: tier == -1,
	})
}

// requireAuth wraps a handler with bearer-token authentication.
func requireAuth(v *auth.Verifier, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		bearer := strings.TrimPrefix(raw, "Bearer ")
		if !v.VerifyAPIKey(bearer) {
			writeJSON(w, http.StatusUnauthorized, errResp{"unauthorized"})
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required env var %s is not set", key)
	}
	return v
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
