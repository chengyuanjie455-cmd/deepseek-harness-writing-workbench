package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/provider"
)

func TestHostRejectsImplicitAccountsAndUnsafeEndpoints(t *testing.T) {
	p := provider.Provider{ID: "wawu-fixture", Key: "synthetic-only", Chat: "https://synthetic.invalid/v1", Models: []string{"synthetic"}}
	if !valid([]provider.Provider{p}) {
		t.Fatal("explicit API connection rejected")
	}
	for _, base := range []string{"http://remote.invalid/v1", "file:///private", "https://key@synthetic.invalid", "https://synthetic.invalid/?key=secret"} {
		bad := p
		bad.Chat = base
		if valid([]provider.Provider{bad}) {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	p.Fallback = []string{"another"}
	if valid([]provider.Provider{p}) {
		t.Fatal("implicit fallback accepted")
	}
}

func TestHostOwnedConcurrentFailuresHaveOneUpstreamSendEach(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	t.Setenv("DO_NOT_TRACK", "1")
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		io.WriteString(w, `{"error":{"message":"synthetic unavailable"}}`)
	}))
	defer upstream.Close()
	if err := provider.Mirror([]provider.Provider{{ID: "wawu-fixture", Name: "Synthetic", Key: "synthetic-only", Chat: upstream.URL, Models: []string{"synthetic"}}}, nil); err != nil {
		t.Fatal(err)
	}
	handler := gateway.NewHostOwned().Handler()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			r := httptest.NewRequest("POST", "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"model":"wawu-fixture/synthetic","stream":true,"messages":[{"role":"user","content":"synthetic"}]}`))
			r.RemoteAddr = "127.0.0.1:12345"
			r = r.WithContext(gateway.HostAttempt(r.Context()))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code < 400 {
				t.Errorf("failure became success: %d", w.Code)
			}
		})
	}
	wg.Wait()
	if calls.Load() != 8 {
		t.Fatalf("got %d upstream sends, want 8", calls.Load())
	}
}
