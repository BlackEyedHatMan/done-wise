package main

// Atomic single-file persistence: write temp + rename, keeping one previous
// copy as board.json.bak for hand recovery. The in-memory board (behind the
// server's mutex) is the source of truth; a missing or corrupt file simply
// starts an empty board.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

type Store struct {
	path string
}

func NewStore(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dataDir, "board.json")}, nil
}

func (s *Store) Load() *Board {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("store: could not read %s: %v (starting empty)", s.path, err)
		}
		return NewBoard()
	}
	board := NewBoard()
	if err := json.Unmarshal(raw, board); err != nil {
		log.Printf("store: corrupt %s: %v (starting empty, previous copy in .bak)", s.path, err)
		return NewBoard()
	}
	return board
}

func (s *Store) Save(board *Board) error {
	raw, err := json.MarshalIndent(board, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	// Best-effort backup of the previous good file.
	if _, err := os.Stat(s.path); err == nil {
		_ = os.Rename(s.path, s.path+".bak")
	}
	return os.Rename(tmp, s.path)
}
