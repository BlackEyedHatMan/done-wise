package main

// Board types and the PUT /v1/board merge — the heart of the provider
// contract (docs/provider-contract.md). Everything here is pure: no IO, no
// clocks (time is injected), so the reconciliation rules are table-testable.

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

const (
	BoardVersion   = 1
	MaxTitleLength = 500
)

type Task struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Done      bool       `json:"done"`
	DoneAt    *time.Time `json:"done_at"`
	CreatedAt time.Time  `json:"created_at"`
	CreatedBy string     `json:"created_by,omitempty"`
	Notes     string     `json:"notes,omitempty"`
	// Revision at which the provider first saw this task; drives merge rule 2
	// (tasks the agent never saw are preserved, not deleted). Harmless on the
	// wire — clients ignore unknown fields.
	CreatedRev int `json:"created_rev,omitempty"`
}

type Group struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Priority string `json:"priority"`
	Tasks    []Task `json:"tasks"`
}

type Board struct {
	Version   int       `json:"version"`
	Revision  int       `json:"revision"`
	UpdatedAt time.Time `json:"updated_at"`
	Groups    []Group   `json:"groups"`
	Inbox     []Task    `json:"inbox"`
}

type PutPayload struct {
	BaseRevision *int    `json:"base_revision"`
	Groups       []Group `json:"groups"`
	Inbox        []Task  `json:"inbox"`
}

func NewBoard() *Board {
	return &Board{Version: BoardVersion, Groups: []Group{}, Inbox: []Task{}}
}

func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return hex.EncodeToString(b)
}

func NormalizePriority(p string) string {
	switch p {
	case "high", "medium", "low":
		return p
	default:
		return "medium"
	}
}

func Slugify(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('-')
		}
	}
	if b.Len() == 0 {
		return NewID()[:8]
	}
	return b.String()
}

// FindTask returns the task with the given id, wherever it lives.
func (bd *Board) FindTask(id string) *Task {
	for i := range bd.Inbox {
		if bd.Inbox[i].ID == id {
			return &bd.Inbox[i]
		}
	}
	for g := range bd.Groups {
		for i := range bd.Groups[g].Tasks {
			if bd.Groups[g].Tasks[i].ID == id {
				return &bd.Groups[g].Tasks[i]
			}
		}
	}
	return nil
}

// RemoveTask deletes the task with the given id; reports whether it existed.
func (bd *Board) RemoveTask(id string) bool {
	for i := range bd.Inbox {
		if bd.Inbox[i].ID == id {
			bd.Inbox = append(bd.Inbox[:i], bd.Inbox[i+1:]...)
			return true
		}
	}
	for g := range bd.Groups {
		tasks := bd.Groups[g].Tasks
		for i := range tasks {
			if tasks[i].ID == id {
				bd.Groups[g].Tasks = append(tasks[:i], tasks[i+1:]...)
				return true
			}
		}
	}
	return false
}

func (bd *Board) allTasks() map[string]*Task {
	tasks := map[string]*Task{}
	for i := range bd.Inbox {
		tasks[bd.Inbox[i].ID] = &bd.Inbox[i]
	}
	for g := range bd.Groups {
		for i := range bd.Groups[g].Tasks {
			tasks[bd.Groups[g].Tasks[i].ID] = &bd.Groups[g].Tasks[i]
		}
	}
	return tasks
}

// Merge applies an agent PUT to the stored board (contract §"The merge"):
//
//  1. task in payload and known         → organisation from payload, done-state from store
//  2. task in store, absent from payload → preserve to inbox if the agent never
//     saw it (created after base_revision), else delete (deliberate archive)
//  3. task in payload, unknown          → create as given
//  4. groups replaced wholesale
//
// Returns the merged board with Revision bumped once.
func Merge(stored *Board, payload PutPayload, now time.Time) *Board {
	base := stored.Revision
	if payload.BaseRevision != nil {
		base = *payload.BaseRevision
	}
	next := stored.Revision + 1
	known := stored.allTasks()
	seen := map[string]bool{}

	sanitize := func(t Task) Task {
		if t.ID == "" {
			t.ID = NewID()
		}
		if len(t.Title) > MaxTitleLength {
			t.Title = t.Title[:MaxTitleLength]
		}
		if old, ok := known[t.ID]; ok {
			// Rule 1: stored done-state, identity and provenance always win.
			t.Done, t.DoneAt = old.Done, old.DoneAt
			t.CreatedAt, t.CreatedBy, t.CreatedRev = old.CreatedAt, old.CreatedBy, old.CreatedRev
		} else {
			// Rule 3: agent-new task (may arrive done, e.g. imports).
			t.CreatedRev = next
			if t.CreatedAt.IsZero() {
				t.CreatedAt = now
			}
			if t.CreatedBy == "" {
				t.CreatedBy = "agent"
			}
			if t.Done && t.DoneAt == nil {
				t.DoneAt = &now
			}
		}
		return t
	}

	merged := NewBoard()
	merged.Revision = next
	merged.UpdatedAt = now

	for _, g := range payload.Groups {
		if g.ID == "" {
			g.ID = Slugify(g.Name)
		}
		group := Group{ID: g.ID, Name: g.Name, Priority: NormalizePriority(g.Priority), Tasks: []Task{}}
		for _, t := range g.Tasks {
			t = sanitize(t)
			if seen[t.ID] {
				continue // duplicate id in payload: first placement wins
			}
			seen[t.ID] = true
			group.Tasks = append(group.Tasks, t)
		}
		merged.Groups = append(merged.Groups, group)
	}
	for _, t := range payload.Inbox {
		t = sanitize(t)
		if seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		merged.Inbox = append(merged.Inbox, t)
	}

	// Rule 2 — walk the store in stable order (inbox, then groups).
	appendUnseen := func(tasks []Task) {
		for _, t := range tasks {
			if !seen[t.ID] && t.CreatedRev > base {
				seen[t.ID] = true
				merged.Inbox = append(merged.Inbox, t)
			}
		}
	}
	appendUnseen(stored.Inbox)
	for _, g := range stored.Groups {
		appendUnseen(g.Tasks)
	}

	return merged
}

// PruneDone drops done tasks whose done_at is older than the retention window.
// Used by agentless deployments (DONEWISE_DONE_RETENTION_DAYS); reports
// whether anything was removed.
func (bd *Board) PruneDone(retentionDays int, now time.Time) bool {
	if retentionDays <= 0 {
		return false
	}
	cutoff := now.AddDate(0, 0, -retentionDays)
	removed := false
	keep := func(tasks []Task) []Task {
		out := tasks[:0]
		for _, t := range tasks {
			if t.Done && t.DoneAt != nil && t.DoneAt.Before(cutoff) {
				removed = true
				continue
			}
			out = append(out, t)
		}
		return out
	}
	bd.Inbox = keep(bd.Inbox)
	for g := range bd.Groups {
		bd.Groups[g].Tasks = keep(bd.Groups[g].Tasks)
	}
	return removed
}
