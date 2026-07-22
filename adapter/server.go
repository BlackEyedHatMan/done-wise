package main

// HTTP handlers for the provider contract (docs/provider-contract.md).
// One mutex serialises everything — the board is one user's todo list.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const maxBodyBytes = 1 << 20 // 1 MiB → 413

type Server struct {
	mu            sync.Mutex
	board         *Board
	store         *Store
	appToken      string
	agentToken    string
	retentionDays int
	now           func() time.Time
}

func NewServer(store *Store, appToken, agentToken string, retentionDays int) *Server {
	return &Server{
		board:         store.Load(),
		store:         store,
		appToken:      appToken,
		agentToken:    agentToken,
		retentionDays: retentionDays,
		now:           time.Now,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/board", s.auth(false, s.handleGetBoard))
	mux.HandleFunc("PUT /v1/board", s.auth(true, s.handlePutBoard))
	mux.HandleFunc("POST /v1/tasks", s.auth(false, s.handlePostTask))
	mux.HandleFunc("PATCH /v1/tasks/{id}", s.auth(false, s.handlePatchTask))
	mux.HandleFunc("DELETE /v1/tasks/{id}", s.auth(false, s.handleDeleteTask))
	return mux
}

// --- auth ---

// auth gates a handler: every caller needs a valid token; agentOnly handlers
// additionally require the agent token. With no agent token configured the
// app token has full access (standalone/testing mode).
func (s *Server) auth(agentOnly bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing bearer token")
			return
		}
		isAgent := s.agentToken != "" && token == s.agentToken
		isApp := token == s.appToken
		if !isAgent && !isApp {
			writeError(w, http.StatusUnauthorized, "unauthorized", "unknown token")
			return
		}
		if agentOnly && !isAgent && s.agentToken != "" {
			writeError(w, http.StatusForbidden, "forbidden", "agent token required")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		next(w, r)
	}
}

// --- handlers ---

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	revision := s.board.Revision
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "revision": revision})
}

func (s *Server) handleGetBoard(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.board.PruneDone(s.retentionDays, s.now()) {
		s.bumpAndPersistLocked()
	}
	etag := fmt.Sprintf(`"%d"`, s.board.Revision)
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, s.board)
}

func (s *Server) handlePutBoard(w http.ResponseWriter, r *http.Request) {
	var payload PutPayload
	if !decodeBody(w, r, &payload) {
		return
	}
	if payload.BaseRevision == nil {
		writeError(w, http.StatusBadRequest, "invalid", "base_revision is required")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if match := r.Header.Get("If-Match"); match != "" &&
		match != fmt.Sprintf(`"%d"`, s.board.Revision) {
		writeError(w, http.StatusConflict, "conflict",
			fmt.Sprintf("If-Match failed: board is at revision %d", s.board.Revision))
		return
	}
	s.board = Merge(s.board, payload, s.now())
	s.persistLocked()
	writeJSON(w, http.StatusOK, map[string]any{"revision": s.board.Revision})
}

func (s *Server) handlePostTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		CreatedBy string `json:"created_by"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > MaxTitleLength {
		writeError(w, http.StatusBadRequest, "invalid", "title must be 1-500 characters")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Idempotent on id: replaying a create returns the existing task.
	if req.ID != "" {
		if existing := s.board.FindTask(req.ID); existing != nil {
			writeJSON(w, http.StatusOK, taskResponse(existing, s.board.Revision))
			return
		}
	}
	if req.ID == "" {
		req.ID = NewID()
	}
	if req.CreatedBy == "" {
		req.CreatedBy = "user"
	}
	task := Task{
		ID: req.ID, Title: req.Title, CreatedAt: s.now(), CreatedBy: req.CreatedBy,
		CreatedRev: s.board.Revision + 1,
	}
	s.board.Inbox = append(s.board.Inbox, task)
	s.bumpAndPersistLocked()
	writeJSON(w, http.StatusOK, taskResponse(&task, s.board.Revision))
}

func (s *Server) handlePatchTask(w http.ResponseWriter, r *http.Request) {
	var req map[string]json.RawMessage
	if !decodeBody(w, r, &req) {
		return
	}
	if len(req) == 0 {
		writeError(w, http.StatusBadRequest, "invalid", "PATCH accepts done and/or title")
		return
	}
	var done *bool
	var title *string
	for key, raw := range req {
		switch key {
		case "done":
			done = new(bool)
			if err := json.Unmarshal(raw, done); err != nil {
				writeError(w, http.StatusBadRequest, "invalid", "done must be a boolean")
				return
			}
		case "title":
			title = new(string)
			if err := json.Unmarshal(raw, title); err != nil {
				writeError(w, http.StatusBadRequest, "invalid", "title must be a string")
				return
			}
			*title = strings.TrimSpace(*title)
			if *title == "" || len(*title) > MaxTitleLength {
				writeError(w, http.StatusBadRequest, "invalid", "title must be 1-500 characters")
				return
			}
		default:
			writeError(w, http.StatusBadRequest, "invalid", "PATCH accepts done and/or title")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.board.FindTask(r.PathValue("id"))
	if task == nil {
		writeError(w, http.StatusNotFound, "not-found", "no such task")
		return
	}
	changed := false
	if done != nil && task.Done != *done {
		task.Done = *done
		if *done {
			now := s.now()
			task.DoneAt = &now
		} else {
			task.DoneAt = nil
		}
		changed = true
	}
	if title != nil && task.Title != *title {
		task.Title = *title
		changed = true
	}
	if changed {
		s.bumpAndPersistLocked()
	}
	writeJSON(w, http.StatusOK, taskResponse(task, s.board.Revision))
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.board.RemoveTask(r.PathValue("id")) {
		writeError(w, http.StatusNotFound, "not-found", "no such task")
		return
	}
	s.bumpAndPersistLocked()
	writeJSON(w, http.StatusOK, map[string]any{"revision": s.board.Revision})
}

// --- helpers ---

func (s *Server) bumpAndPersistLocked() {
	s.board.Revision++
	s.board.UpdatedAt = s.now()
	s.persistLocked()
}

func (s *Server) persistLocked() {
	if err := s.store.Save(s.board); err != nil {
		log.Printf("store: could not persist board: %v", err)
	}
}

func taskResponse(task *Task, revision int) map[string]any {
	return map[string]any{"task": task, "revision": revision}
}

func decodeBody(w http.ResponseWriter, r *http.Request, dest any) bool {
	err := json.NewDecoder(r.Body).Decode(dest)
	if err == nil {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "too-large", "body over 1 MiB")
	} else {
		writeError(w, http.StatusBadRequest, "invalid", "invalid JSON body")
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
