//go:build linux

package executor

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestConfinedWorkingDirectoryRejectsSymlinkComponents(t *testing.T) {
	rootPath := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(rootPath, "linked")); err != nil {
		t.Fatal(err)
	}
	root, err := openWorkspaceRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()

	if cwd, err := openConfinedWorkingDirectory(root, "linked"); err == nil {
		_ = cwd.Close()
		t.Fatal("symlink cwd component was accepted")
	}
}

func TestConfinedWorkingDirectoryPinsCheckedDirectory(t *testing.T) {
	rootPath := t.TempDir()
	originalPath := filepath.Join(rootPath, "work")
	if err := os.Mkdir(originalPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := openWorkspaceRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()

	cwd, err := openConfinedWorkingDirectory(root, "work")
	if err != nil {
		t.Fatal(err)
	}
	defer cwd.Close()

	movedPath := filepath.Join(rootPath, "moved")
	if err := os.Rename(originalPath, movedPath); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, originalPath); err != nil {
		t.Fatal(err)
	}

	pinnedPath := fmt.Sprintf("/proc/self/fd/%d", cwd.Fd())
	resolved, err := filepath.EvalSymlinks(pinnedPath)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != movedPath {
		t.Fatalf("pinned cwd resolved to %q, want %q", resolved, movedPath)
	}
}

func TestWorkspaceRootRejectsSymlink(t *testing.T) {
	target := t.TempDir()
	parent := t.TempDir()
	link := filepath.Join(parent, "workspace")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if root, err := openWorkspaceRoot(link); err == nil {
		_ = root.Close()
		t.Fatal("symlink workspace root was accepted")
	}
}
