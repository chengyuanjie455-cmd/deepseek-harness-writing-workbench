// Wawu's private, parent-owned host entry point. The gateway and protocol
// adapters below are Magpie's real implementation, not a replacement proxy.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/provider"
)

type configuration struct {
	ID        string              `json:"id"`
	Token     string              `json:"token"`
	Providers []provider.Provider `json:"providers"`
}

// Only explicit API connections from the host are accepted. No account
// discovery, community plugins, config migration or independent retry pools.
func valid(ps []provider.Provider) bool {
	seen := map[string]bool{}
	for _, p := range ps {
		if !strings.HasPrefix(p.ID, "wawu-") || p.ID != provider.Slug(p.ID) || seen[p.ID] || p.Key == "" || len(p.Models) != 1 || len(p.Fallback) != 0 || len(p.Keys) != 0 || p.Account != nil {
			return false
		}
		seen[p.ID] = true
		count := 0
		for _, base := range []string{p.Chat, p.Responses, p.Anthropic, p.Gemini} {
			if base == "" {
				continue
			}
			count++
			u, err := url.Parse(base)
			if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1" || u.Hostname() == "localhost")) {
				return false
			}
		}
		if count != 1 {
			return false
		}
	}
	return true
}

func main() {
	// This entry never invokes cli.Main or loads GUI/plugin/account services.
	os.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	os.Setenv("DO_NOT_TRACK", "1")
	log.SetOutput(io.Discard) // provider errors/prompts must not enter parent logs
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 4096), 8<<20)
	output := json.NewEncoder(os.Stdout)
	var server *http.Server
	token := ""
	for input.Scan() {
		var config configuration
		if json.Unmarshal(input.Bytes(), &config) != nil || len(config.Token) < 32 || !valid(config.Providers) || token != "" && token != config.Token {
			output.Encode(map[string]any{"id": config.ID, "error": "invalid_configuration"})
			continue
		}
		if provider.Mirror(config.Providers, nil) != nil {
			output.Encode(map[string]any{"id": config.ID, "error": "configuration_write_failed"})
			continue
		}
		if server == nil {
			token = config.Token
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				output.Encode(map[string]any{"id": config.ID, "error": "listen_failed"})
				return
			}
			handler := gateway.NewHostOwned().Handler()
			server = &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
					http.Error(w, "unauthorized", 401)
					return
				}
				if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
					http.NotFound(w, r)
					return
				}
				// Do not expose Magpie's admin, files, agents or media endpoints.
				r.Header.Set("Authorization", "Bearer "+gateway.Token)
				handler.ServeHTTP(w, r.WithContext(gateway.HostAttempt(r.Context())))
			})}
			go server.Serve(listener)
			output.Encode(map[string]any{"id": config.ID, "url": "http://" + listener.Addr().String() + "/v1", "state": "ready"})
		} else {
			output.Encode(map[string]any{"id": config.ID, "state": "configured"})
		}
	}
	// Closing the parent's private stdin also stops the child after a crash.
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		server.Shutdown(ctx)
		server.Close()
	}
}
