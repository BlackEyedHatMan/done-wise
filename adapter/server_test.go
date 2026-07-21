package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	appToken   = "app-secret"
	agentToken = "agent-secret"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(NewServer(store, appToken, agentToken, 0).Handler())
	t.Cleanup(ts.Close)
	return ts
}

func request(t *testing.T, ts *httptest.Server, method, path, token, body string, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&decoded)
	return resp, decoded
}

func TestAuth(t *testing.T) {
	ts := newTestServer(t)
	for _, tc := range []struct {
		method, path, token string
		want                int
	}{
		{"GET", "/healthz", "", 200},
		{"GET", "/v1/board", "", 401},
		{"GET", "/v1/board", "wrong", 401},
		{"GET", "/v1/board", appToken, 200},
		{"GET", "/v1/board", agentToken, 200},
		{"PUT", "/v1/board", appToken, 403},
	} {
		body := ""
		if tc.method == "PUT" {
			body = `{"base_revision": 0, "groups": [], "inbox": []}`
		}
		resp, _ := request(t, ts, tc.method, tc.path, tc.token, body, nil)
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s token=%q: status %d, want %d",
				tc.method, tc.path, tc.token, resp.StatusCode, tc.want)
		}
	}
}

func TestEtagFlow(t *testing.T) {
	ts := newTestServer(t)
	resp, _ := request(t, ts, "GET", "/v1/board", appToken, "", nil)
	etag := resp.Header.Get("ETag")
	if etag != `"0"` {
		t.Fatalf("fresh board ETag = %q, want %q", etag, `"0"`)
	}
	resp, _ = request(t, ts, "GET", "/v1/board", appToken, "", map[string]string{"If-None-Match": etag})
	if resp.StatusCode != 304 {
		t.Fatalf("If-None-Match with current ETag: status %d, want 304", resp.StatusCode)
	}
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "x"}`, nil)
	resp, _ = request(t, ts, "GET", "/v1/board", appToken, "", map[string]string{"If-None-Match": etag})
	if resp.StatusCode != 200 {
		t.Fatalf("stale ETag after mutation: status %d, want 200", resp.StatusCode)
	}
}

func TestPostIdempotentOnId(t *testing.T) {
	ts := newTestServer(t)
	_, first := request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "buy paper"}`, nil)
	resp, second := request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "buy paper"}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("replayed create: status %d, want 200", resp.StatusCode)
	}
	if first["revision"].(float64) != 1 || second["revision"].(float64) != 1 {
		t.Errorf("replay must not bump revision: first=%v second=%v",
			first["revision"], second["revision"])
	}
	_, board := request(t, ts, "GET", "/v1/board", appToken, "", nil)
	if inbox := board["inbox"].([]any); len(inbox) != 1 {
		t.Errorf("replay must not duplicate: inbox has %d tasks", len(inbox))
	}
}

func TestPostValidation(t *testing.T) {
	ts := newTestServer(t)
	resp, _ := request(t, ts, "POST", "/v1/tasks", appToken, `{"title": "   "}`, nil)
	if resp.StatusCode != 400 {
		t.Errorf("blank title: status %d, want 400", resp.StatusCode)
	}
	resp, _ = request(t, ts, "POST", "/v1/tasks", appToken, `{"title": "`+strings.Repeat("x", 501)+`"}`, nil)
	if resp.StatusCode != 400 {
		t.Errorf("oversize title: status %d, want 400", resp.StatusCode)
	}
	resp, _ = request(t, ts, "POST", "/v1/tasks", appToken, "not json", nil)
	if resp.StatusCode != 400 {
		t.Errorf("bad json: status %d, want 400", resp.StatusCode)
	}
}

func TestPatchOnlyDone(t *testing.T) {
	ts := newTestServer(t)
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "x"}`, nil)

	resp, body := request(t, ts, "PATCH", "/v1/tasks/t1", appToken, `{"done": true}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("patch: status %d", resp.StatusCode)
	}
	task := body["task"].(map[string]any)
	if task["done"] != true || task["done_at"] == nil {
		t.Errorf("done flip must stamp done_at: %v", task)
	}

	resp, _ = request(t, ts, "PATCH", "/v1/tasks/t1", appToken, `{"done": false, "title": "sneaky"}`, nil)
	if resp.StatusCode != 400 {
		t.Errorf("extra PATCH field: status %d, want 400", resp.StatusCode)
	}
	resp, _ = request(t, ts, "PATCH", "/v1/tasks/ghost", appToken, `{"done": true}`, nil)
	if resp.StatusCode != 404 {
		t.Errorf("unknown task: status %d, want 404", resp.StatusCode)
	}
}

func TestDelete(t *testing.T) {
	ts := newTestServer(t)
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "x"}`, nil)
	resp, _ := request(t, ts, "DELETE", "/v1/tasks/t1", appToken, "", nil)
	if resp.StatusCode != 200 {
		t.Errorf("delete: status %d", resp.StatusCode)
	}
	resp, _ = request(t, ts, "DELETE", "/v1/tasks/t1", appToken, "", nil)
	if resp.StatusCode != 404 {
		t.Errorf("re-delete: status %d, want 404 (callers treat as success)", resp.StatusCode)
	}
}

func TestPutRequiresBaseRevisionAndMerges(t *testing.T) {
	ts := newTestServer(t)
	resp, _ := request(t, ts, "PUT", "/v1/board", agentToken, `{"groups": [], "inbox": []}`, nil)
	if resp.StatusCode != 400 {
		t.Fatalf("PUT without base_revision: status %d, want 400", resp.StatusCode)
	}

	// App creates a task; agent (working from revision 0) organises the board.
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "reply to client"}`, nil)
	put := `{"base_revision": 0, "groups": [{"id": "work", "name": "Work", "priority": "high",
		"tasks": []}], "inbox": []}`
	resp, _ = request(t, ts, "PUT", "/v1/board", agentToken, put, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("PUT: status %d", resp.StatusCode)
	}
	// t1 was created at revision 1 > base 0 → preserved to inbox despite omission.
	_, board := request(t, ts, "GET", "/v1/board", appToken, "", nil)
	if inbox := board["inbox"].([]any); len(inbox) != 1 {
		t.Errorf("mid-think task must survive the PUT, inbox: %v", board["inbox"])
	}
	if groups := board["groups"].([]any); len(groups) != 1 {
		t.Errorf("agent group must exist: %v", board["groups"])
	}
}

func TestPutIfMatchConflict(t *testing.T) {
	ts := newTestServer(t)
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "x"}`, nil)
	resp, _ := request(t, ts, "PUT", "/v1/board", agentToken,
		`{"base_revision": 0, "groups": [], "inbox": []}`,
		map[string]string{"If-Match": `"0"`})
	if resp.StatusCode != 409 {
		t.Errorf("stale If-Match: status %d, want 409", resp.StatusCode)
	}
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewStore(dir)
	ts := httptest.NewServer(NewServer(store, appToken, agentToken, 0).Handler())
	request(t, ts, "POST", "/v1/tasks", appToken, `{"id": "t1", "title": "survives"}`, nil)
	ts.Close()

	store2, _ := NewStore(dir)
	ts2 := httptest.NewServer(NewServer(store2, appToken, agentToken, 0).Handler())
	defer ts2.Close()
	_, board := request(t, ts2, "GET", "/v1/board", appToken, "", nil)
	if inbox := board["inbox"].([]any); len(inbox) != 1 {
		t.Fatalf("board must survive restart, inbox: %v", board["inbox"])
	}
	if board["revision"].(float64) != 1 {
		t.Errorf("revision must survive restart: %v", board["revision"])
	}
}

func TestBodyTooLarge(t *testing.T) {
	ts := newTestServer(t)
	huge := fmt.Sprintf(`{"id": "t1", "title": "x", "notes": %q}`, strings.Repeat("y", maxBodyBytes+10))
	resp, _ := request(t, ts, "POST", "/v1/tasks", appToken, huge, nil)
	if resp.StatusCode != 413 {
		t.Errorf("oversize body: status %d, want 413", resp.StatusCode)
	}
}
