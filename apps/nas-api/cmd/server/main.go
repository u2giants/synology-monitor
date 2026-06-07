// Command server runs the NAS API HTTP service.
// It exposes three-tier shell execution behind a bearer-token + HMAC approval gate.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/nas-api/internal/auth"
	"github.com/synology-monitor/nas-api/internal/executor"
	"github.com/synology-monitor/nas-api/internal/jobs"
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
	TimeoutMs     int64  `json:"timeout_ms,omitempty"`     // 0 → DefaultTimeout
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

	// File-inventory job system (Phase 1). State persists under the durable
	// /app/data/jobs bind mount; nasName is the logical NAS name the web/MCP
	// target this box by (edgesynology1/2) — deliberately separate from the
	// agent's NAS_NAME (see docker-compose.agent.yml).
	jobsDir := envOr("NAS_API_JOBS_DIR", "/app/data/jobs")
	nasName := envOr("NAS_API_NAME", hostnameOrEmpty())
	store := jobs.NewStore(jobsDir)
	mgr := jobs.New(store, nasName)
	mgr.RecoverOnStart()
	mgr.StartScheduler()
	if !mgr.Ready() {
		log.Printf("WARNING: jobs dir %s not writable — inventory endpoints will return 503 until `docker compose up -d` materializes the mount", jobsDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /exec", requireAuth(v, handleExec(v)))
	mux.HandleFunc("POST /preview", requireAuth(v, handlePreview))

	mux.HandleFunc("POST /jobs/inventory", requireAuth(v, requireApproval(v, jobs.OpStart, 2, nasName, handleInventoryStart(mgr))))
	mux.HandleFunc("POST /jobs/inventory/schedule", requireAuth(v, requireApproval(v, jobs.OpSchedule, 2, nasName, handleInventorySchedule(mgr))))
	mux.HandleFunc("GET /jobs/inventory", requireAuth(v, handleInventoryList(mgr)))
	mux.HandleFunc("GET /jobs/inventory/{id}", requireAuth(v, handleInventoryStatus(mgr)))
	mux.HandleFunc("GET /jobs/inventory/{id}/result", requireAuth(v, handleInventoryResult(mgr, store)))
	mux.HandleFunc("POST /jobs/inventory/{id}/cancel", requireAuth(v, requireApproval(v, jobs.OpCancel, 2, nasName, handleInventoryCancel(mgr))))

	// Archive-move (Phase 2). Tier 2: plan, cancel. Tier 3: execute, rollback.
	mux.HandleFunc("POST /jobs/archive-move/plan", requireAuth(v, requireApproval(v, jobs.OpMovePlan, 2, nasName, handleMovePlan(mgr))))
	mux.HandleFunc("GET /jobs/archive-move", requireAuth(v, handleMoveList(mgr)))
	mux.HandleFunc("GET /jobs/archive-move/{id}", requireAuth(v, handleMoveStatus(mgr)))
	mux.HandleFunc("GET /jobs/archive-move/{id}/manifest", requireAuth(v, handleMoveManifest(mgr)))
	mux.HandleFunc("GET /jobs/archive-move/{id}/result", requireAuth(v, handleMoveResult(mgr)))
	mux.HandleFunc("POST /jobs/archive-move/{id}/execute", requireAuth(v, requireApproval(v, jobs.OpMoveExecute, 3, nasName, handleMoveExecute(mgr))))
	mux.HandleFunc("POST /jobs/archive-move/{id}/cancel", requireAuth(v, requireApproval(v, jobs.OpMoveCancel, 2, nasName, handleMoveCancel(mgr))))
	mux.HandleFunc("POST /jobs/archive-move/{id}/rollback", requireAuth(v, requireApproval(v, jobs.OpMoveRollback, 3, nasName, handleMoveRollback(mgr))))
	mux.HandleFunc("POST /jobs/archive-move/{id}/verify", requireAuth(v, handleMoveVerify(mgr)))

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
	// On a hard-block, return WHY (actionable, and explicit that the block is
	// permanent/stateless) instead of just echoing the command — that summary is
	// the only signal an MCP session gets, and a bare echo is what makes sessions
	// misread a refusal as "rate limit" / "session degradation".
	summary := validator.Summary(req.Command)
	if tier == -1 {
		summary = validator.BlockExplanation(req.Command)
	}
	writeJSON(w, http.StatusOK, previewResponse{
		Tier:    tier,
		Summary: summary,
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

func hostnameOrEmpty() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

// ── File-inventory job endpoints ───────────────────────────────────────────────

// requireApproval enforces an HMAC approval token for state-changing job ops at
// the given tier (2 for service ops, 3 for destructive ops). It rebuilds the
// canonical operation string from the SERVER's NAS name plus the request
// body/path and verifies the token via the same auth.Verifier used by /exec. The
// token is sent in the X-Approval-Token header.
func requireApproval(v *auth.Verifier, op jobs.Op, tier int, nasName string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		token := r.Header.Get("X-Approval-Token")
		if token == "" {
			writeJSON(w, http.StatusForbidden, errResp{"approval token required (X-Approval-Token header)"})
			return
		}
		canonical, ok := buildCanonical(w, op, nasName, r.PathValue("id"), body)
		if !ok {
			return // buildCanonical already wrote a 400
		}
		if err := v.VerifyApprovalToken(token, canonical, tier); err != nil {
			writeJSON(w, http.StatusForbidden, errResp{err.Error()})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body)) // restore for the handler
		next(w, r)
	}
}

// buildCanonical rebuilds the signed canonical op string for an inventory or
// archive-move operation from the request body/path.
func buildCanonical(w http.ResponseWriter, op jobs.Op, nasName, id string, body []byte) (string, bool) {
	switch op {
	case jobs.OpCancel:
		return jobs.CanonicalOpString(op, nasName, id, nil), true
	case jobs.OpStart, jobs.OpSchedule:
		var req jobs.StartRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
			return "", false
		}
		req.Normalize()
		return jobs.CanonicalOpString(op, nasName, "", &req), true
	case jobs.OpMovePlan:
		var req jobs.MovePlanRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
			return "", false
		}
		req.Normalize()
		return jobs.MoveCanonicalOpString(op, nasName, "", &req), true
	case jobs.OpMoveExecute, jobs.OpMoveCancel, jobs.OpMoveRollback:
		return jobs.MoveCanonicalOpString(op, nasName, id, nil), true
	default:
		writeJSON(w, http.StatusBadRequest, errResp{"unknown operation"})
		return "", false
	}
}

// jobsReady returns false and writes 503 when the durable jobs mount is absent.
func jobsReady(w http.ResponseWriter, mgr *jobs.Manager) bool {
	if mgr.Ready() {
		return true
	}
	writeJSON(w, http.StatusServiceUnavailable, errResp{"jobs mount not present — run `docker compose up -d` on this NAS to materialize /app/data/jobs"})
	return false
}

func decodeStartRequest(w http.ResponseWriter, r *http.Request) (jobs.StartRequest, bool) {
	var req jobs.StartRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
		return req, false
	}
	return req, true
}

func handleInventoryStart(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		req, ok := decodeStartRequest(w, r)
		if !ok {
			return
		}
		job, err := mgr.Start(req)
		if errors.Is(err, jobs.ErrBusy) {
			writeJSON(w, http.StatusConflict, errResp{err.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, job)
	}
}

func handleInventorySchedule(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		req, ok := decodeStartRequest(w, r)
		if !ok {
			return
		}
		job, err := mgr.Schedule(req)
		if errors.Is(err, jobs.ErrBusy) {
			writeJSON(w, http.StatusConflict, errResp{err.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, job)
	}
}

func handleInventoryList(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		list, err := mgr.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errResp{err.Error()})
			return
		}
		if list == nil {
			list = []*jobs.Job{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobs": list})
	}
}

func handleInventoryStatus(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		job, err := mgr.Get(r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func handleInventoryCancel(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		if err := mgr.Cancel(r.PathValue("id")); err != nil {
			if errors.Is(err, jobs.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errResp{err.Error()})
				return
			}
			writeJSON(w, http.StatusConflict, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling"})
	}
}

// resultCap bounds the non-download (MCP) response so an oversized CSV can never
// be pulled into a model context.
const (
	resultDefaultLimit = 1000
	resultMaxLimit     = 5000
)

func handleInventoryResult(mgr *jobs.Manager, store *jobs.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		id := r.PathValue("id")
		job, err := mgr.Get(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{err.Error()})
			return
		}
		kind := r.URL.Query().Get("result")
		if kind == "" {
			kind = "yearly"
		}
		path, ok := store.ResultPath(id, kind)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errResp{"unknown result kind (want yearly|cutoff|dirs|overlay)"})
			return
		}
		if !job.ResultReady {
			writeJSON(w, http.StatusConflict, errResp{"result not ready (job status: " + string(job.Status) + ")"})
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{"result file not found: " + kind})
			return
		}

		// Web download path: stream the full CSV as an attachment.
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Type", "text/csv")
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", id+"-"+kind+".csv"))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}

		// MCP path: bounded JSON envelope (header + paged rows).
		lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		header := ""
		var rows []string
		if len(lines) > 0 {
			header = lines[0]
			rows = lines[1:]
		}
		limit := clampInt(queryInt(r, "limit", resultDefaultLimit), 1, resultMaxLimit)
		cursor := clampInt(queryInt(r, "cursor", 0), 0, len(rows))
		end := cursor + limit
		if end > len(rows) {
			end = len(rows)
		}
		next := -1
		if end < len(rows) {
			next = end
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"result":      kind,
			"header":      header,
			"rows":        rows[cursor:end],
			"total_rows":  len(rows),
			"next_cursor": next,
		})
	}
}

func queryInt(r *http.Request, key string, fallback int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// ── Archive-move handlers ──────────────────────────────────────────────────────

func moveStateErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, jobs.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errResp{err.Error()})
	case errors.Is(err, jobs.ErrBusy):
		writeJSON(w, http.StatusConflict, errResp{err.Error()})
	case errors.Is(err, jobs.ErrMoveState):
		writeJSON(w, http.StatusConflict, errResp{err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, errResp{err.Error()})
	}
}

func handleMovePlan(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		var req jobs.MovePlanRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errResp{"invalid JSON: " + err.Error()})
			return
		}
		job, err := mgr.PlanMove(req)
		if err != nil {
			moveStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, job)
	}
}

func handleMoveList(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		list, err := mgr.MoveList()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errResp{err.Error()})
			return
		}
		if list == nil {
			list = []*jobs.MoveJob{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobs": list})
	}
}

func handleMoveStatus(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		job, err := mgr.MoveGet(r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func handleMoveManifest(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		id := r.PathValue("id")
		limit := clampInt(queryInt(r, "limit", resultDefaultLimit), 1, resultMaxLimit)
		cursor := clampInt(queryInt(r, "cursor", 0), 0, 1<<30)
		lines, total, next, err := mgr.MoveManifestPage(id, cursor, limit)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{"manifest not available: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"lines":       lines,
			"total_rows":  total,
			"next_cursor": next,
		})
	}
}

func handleMoveResult(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		id := r.PathValue("id")
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = "move-report"
		}
		data, err := mgr.MoveResult(id, kind)
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{"result not available: " + err.Error()})
			return
		}
		if r.URL.Query().Get("download") == "1" {
			ext := "csv"
			if kind == "preflight" {
				ext = "json"
			}
			w.Header().Set("Content-Type", "text/"+ext)
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", id+"-"+kind+"."+ext))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"kind": kind, "content": string(data)})
	}
}

func handleMoveExecute(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		job, err := mgr.ExecuteMove(r.PathValue("id"))
		if err != nil {
			moveStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func handleMoveCancel(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		if err := mgr.CancelMove(r.PathValue("id")); err != nil {
			moveStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling"})
	}
}

func handleMoveRollback(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		job, err := mgr.RollbackMove(r.PathValue("id"))
		if err != nil {
			moveStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func handleMoveVerify(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !jobsReady(w, mgr) {
			return
		}
		job, report, err := mgr.ReVerifyMove(r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, errResp{err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"job": job, "verify_report": string(report)})
	}
}
