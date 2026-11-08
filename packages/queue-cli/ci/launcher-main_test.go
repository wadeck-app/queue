package main

// Unit tests of the config dir resolution of ci/launcher-main.go.tmpl. This file is not built by ci/scripts/build-launcher.mjs (build.sh copies the generated
// main.go only): src/cli/launcherGoUnit.test.ts renders the template, drops this file next to it and runs `go test`.

import (
	"path/filepath"
	"reflect"
	"testing"

	launcher "wadeck.ch/singleton-daemon-kit/go-launcher"
)

func TestHasExplicitConfig(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"no argument", nil, false},
		{"empty first argument", []string{""}, false},
		{"a command", []string{"status"}, false},
		{"a flag", []string{"--json"}, false},
		{"--config alone", []string{"--config"}, true},
		{"--config after a command", []string{"push", "onX", "--config", "/tmp/x"}, true},
		{"leading absolute posix path", []string{"/tmp/queue"}, true},
		{"leading home-relative path", []string{"~/queue"}, true},
		{"leading windows path with a backslash", []string{`C:\queue`}, true},
		{"leading windows path with a slash", []string{"C:/queue"}, true},
		{"a drive without a separator is not a path", []string{"C:"}, false},
		{"a colon later in the word is not a drive", []string{"ab:/x"}, false},
		{"a path that is not the first argument is not explicit", []string{"status", "/tmp/queue"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hasExplicitConfig(c.args); got != c.want {
				t.Fatalf("hasExplicitConfig(%q) = %v, want %v", c.args, got, c.want)
			}
		})
	}
}

func TestConfigArgs(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  string
		want []string
	}{
		{"no env: untouched", []string{"status"}, "", []string{"status"}},
		{"env, no argument", nil, "/tmp/cfg", []string{"--config", "/tmp/cfg"}},
		{"env, a command: --config comes first", []string{"status", "--json"}, "/tmp/cfg", []string{"--config", "/tmp/cfg", "status", "--json"}},
		{"--config in the arguments wins", []string{"--config", "/other", "status"}, "/tmp/cfg", []string{"--config", "/other", "status"}},
		{"a leading path wins", []string{"/other", "status"}, "/tmp/cfg", []string{"/other", "status"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := configArgs(c.args, c.env); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("configArgs(%q, %q) = %q, want %q", c.args, c.env, got, c.want)
			}
		})
	}
}

// The order the doc promises: --config, then QUEUE_CONFIG_DIR, then $XDG_CONFIG_HOME/queue, then $HOME/.config/queue. The home is a throwaway one, so the
// legacy ~/.queue migration of the SDK can never touch the real one.
func TestResolutionOrder(t *testing.T) {
	home := t.TempDir()
	xdg := t.TempDir()
	envDir := t.TempDir()
	explicit := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	t.Run("--config beats QUEUE_CONFIG_DIR", func(t *testing.T) {
		t.Setenv("XDG_CONFIG_HOME", xdg)
		dir, rest := launcher.ResolveConfigDir("queue", configArgs([]string{"--config", explicit, "status"}, envDir))
		if dir != explicit || !reflect.DeepEqual(rest, []string{"status"}) {
			t.Fatalf("got %q %q, want %q [status]", dir, rest, explicit)
		}
	})
	t.Run("QUEUE_CONFIG_DIR beats XDG_CONFIG_HOME, and the flag does not reach node", func(t *testing.T) {
		t.Setenv("XDG_CONFIG_HOME", xdg)
		dir, rest := launcher.ResolveConfigDir("queue", configArgs([]string{"status"}, envDir))
		if dir != envDir || !reflect.DeepEqual(rest, []string{"status"}) {
			t.Fatalf("got %q %q, want %q [status]", dir, rest, envDir)
		}
	})
	t.Run("XDG_CONFIG_HOME/queue without the variable", func(t *testing.T) {
		t.Setenv("XDG_CONFIG_HOME", xdg)
		dir, _ := launcher.ResolveConfigDir("queue", configArgs([]string{"status"}, ""))
		if want := filepath.Join(xdg, "queue"); dir != want {
			t.Fatalf("got %q, want %q", dir, want)
		}
	})
	t.Run("HOME/.config/queue without either", func(t *testing.T) {
		t.Setenv("XDG_CONFIG_HOME", "")
		dir, _ := launcher.ResolveConfigDir("queue", configArgs([]string{"status"}, ""))
		if want := filepath.Join(home, ".config", "queue"); dir != want {
			t.Fatalf("got %q, want %q", dir, want)
		}
	})
}
