package main

import (
	"testing"
	"time"
)

var now = time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)

func intp(v int) *int { return &v }

func mkTask(id, title string, createdRev int) Task {
	return Task{ID: id, Title: title, CreatedAt: now, CreatedBy: "user", CreatedRev: createdRev}
}

// storedBoard: revision 10; "t-old" grouped in "work", "t-new" in inbox
// created at revision 9.
func storedBoard() *Board {
	return &Board{
		Version:  1,
		Revision: 10,
		Groups: []Group{{
			ID: "work", Name: "Work", Priority: "high",
			Tasks: []Task{mkTask("t-old", "old task", 3)},
		}},
		Inbox: []Task{mkTask("t-new", "new task", 9)},
	}
}

func TestMergeOrganisationFromPayloadDoneFromStore(t *testing.T) {
	stored := storedBoard()
	doneAt := now.Add(-time.Hour)
	stored.Groups[0].Tasks[0].Done = true
	stored.Groups[0].Tasks[0].DoneAt = &doneAt

	merged := Merge(stored, PutPayload{
		BaseRevision: intp(10),
		Groups: []Group{{ID: "focus", Name: "Focus", Priority: "low", Tasks: []Task{
			{ID: "t-old", Title: "old task (tidied)", Done: false}, // agent tries to untick — ignored
		}}},
		Inbox: []Task{{ID: "t-new", Title: "new task"}},
	}, now)

	if merged.Revision != 11 {
		t.Fatalf("revision = %d, want 11", merged.Revision)
	}
	got := merged.Groups[0].Tasks[0]
	if got.Title != "old task (tidied)" {
		t.Errorf("title = %q, agent rewrite should apply", got.Title)
	}
	if !got.Done || got.DoneAt == nil || !got.DoneAt.Equal(doneAt) {
		t.Errorf("done-state must come from store, got done=%v doneAt=%v", got.Done, got.DoneAt)
	}
	if got.CreatedRev != 3 {
		t.Errorf("created_rev must be preserved, got %d", got.CreatedRev)
	}
}

func TestMergeUnseenTaskPreservedToInbox(t *testing.T) {
	// Agent worked from revision 8, so it never saw t-new (created_rev 9).
	merged := Merge(storedBoard(), PutPayload{
		BaseRevision: intp(8),
		Groups:       []Group{},
		Inbox:        []Task{},
	}, now)
	if len(merged.Inbox) != 1 || merged.Inbox[0].ID != "t-new" {
		t.Fatalf("task created mid-think must be preserved to inbox, got %+v", merged.Inbox)
	}
	if merged.FindTask("t-old") != nil {
		t.Error("t-old (created_rev 3 <= base 8) was deliberately dropped and must be deleted")
	}
}

func TestMergeOmissionDeletesSeenTasks(t *testing.T) {
	merged := Merge(storedBoard(), PutPayload{
		BaseRevision: intp(10),
		Groups:       []Group{},
		Inbox:        []Task{},
	}, now)
	if len(merged.Inbox) != 0 || len(merged.Groups) != 0 {
		t.Fatalf("agent saw everything (base 10) and omitted everything: board must be empty, got %+v", merged)
	}
}

func TestMergeAgentNewTask(t *testing.T) {
	merged := Merge(storedBoard(), PutPayload{
		BaseRevision: intp(10),
		Groups: []Group{{Name: "Prime Focus", Tasks: []Task{
			{Title: "agent-created", Done: true},
		}}},
		Inbox: []Task{{ID: "t-new", Title: "new task"}, {ID: "t-old", Title: "old task"}},
	}, now)
	g := merged.Groups[0]
	if g.ID != "prime-focus" {
		t.Errorf("missing group id should be slugified from name, got %q", g.ID)
	}
	if g.Priority != "medium" {
		t.Errorf("missing priority should normalize to medium, got %q", g.Priority)
	}
	task := g.Tasks[0]
	if task.ID == "" || task.CreatedRev != 11 || task.CreatedBy != "agent" {
		t.Errorf("agent-new task badly initialised: %+v", task)
	}
	if !task.Done || task.DoneAt == nil {
		t.Error("agent-new task may arrive done (import case) and gets done_at stamped")
	}
}

func TestMergeDuplicateIdFirstPlacementWins(t *testing.T) {
	merged := Merge(storedBoard(), PutPayload{
		BaseRevision: intp(10),
		Groups: []Group{
			{ID: "a", Name: "A", Tasks: []Task{{ID: "t-old", Title: "old task"}}},
			{ID: "b", Name: "B", Tasks: []Task{{ID: "t-old", Title: "old task"}}},
		},
		Inbox: []Task{{ID: "t-new", Title: "new task"}},
	}, now)
	if len(merged.Groups[0].Tasks) != 1 || len(merged.Groups[1].Tasks) != 0 {
		t.Errorf("duplicate id: first placement wins, got A=%d B=%d",
			len(merged.Groups[0].Tasks), len(merged.Groups[1].Tasks))
	}
}

func TestPruneDone(t *testing.T) {
	board := storedBoard()
	old := now.AddDate(0, 0, -10)
	board.Inbox[0].Done = true
	board.Inbox[0].DoneAt = &old

	if board.PruneDone(0, now) {
		t.Error("retention 0 must never prune")
	}
	if !board.PruneDone(7, now) {
		t.Error("10-day-old done task must prune at 7-day retention")
	}
	if len(board.Inbox) != 0 {
		t.Errorf("inbox should be empty, got %+v", board.Inbox)
	}
	if board.PruneDone(7, now) {
		t.Error("second prune finds nothing")
	}
}

func TestSlugify(t *testing.T) {
	for input, want := range map[string]string{
		"Prime Focus":  "prime-focus",
		"  Walk ~10  ": "walk-10",
		"Évening":      "vening",
	} {
		if got := Slugify(input); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", input, got, want)
		}
	}
	if got := Slugify("«»"); len(got) != 8 {
		t.Errorf("unusable name should yield an 8-char random slug, got %q", got)
	}
}
