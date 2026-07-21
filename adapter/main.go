package main

// DoneWise reference adapter — a tiny always-on provider implementing
// docs/provider-contract.md. The desktop app polls it; an AI agent
// reorganises it with a handful of curl calls. Configuration is env-only:
//
//	DONEWISE_APP_TOKEN           required — token for the desktop app
//	DONEWISE_AGENT_TOKEN         optional — token for the agent (gates PUT /v1/board);
//	                             unset ⇒ the app token has full access
//	DONEWISE_DATA_DIR            default /data
//	DONEWISE_LISTEN_ADDR         default :8080
//	DONEWISE_DONE_RETENTION_DAYS default 0 (never) — agentless tidy-up

import (
	"log"
	"net/http"
	"os"
	"strconv"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	appToken := os.Getenv("DONEWISE_APP_TOKEN")
	if appToken == "" {
		log.Fatal("DONEWISE_APP_TOKEN is required")
	}
	retentionDays, err := strconv.Atoi(envOr("DONEWISE_DONE_RETENTION_DAYS", "0"))
	if err != nil {
		log.Fatal("DONEWISE_DONE_RETENTION_DAYS must be an integer")
	}

	store, err := NewStore(envOr("DONEWISE_DATA_DIR", "/data"))
	if err != nil {
		log.Fatalf("could not prepare data dir: %v", err)
	}
	server := NewServer(store, appToken, os.Getenv("DONEWISE_AGENT_TOKEN"), retentionDays)

	addr := envOr("DONEWISE_LISTEN_ADDR", ":8080")
	log.Printf("done-wise adapter listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, server.Handler()))
}
