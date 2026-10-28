package provider

import (
	"slices"
	"testing"
)

// A key's value replaced in place (#1869) keeps the key's name, place,
// protocol, weight, on or off, and what was set for it by fingerprint;
// only the value and so the fingerprint change.
func TestReplaceKeyKeepsItsPlace(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if err := Save(Provider{ID: "relay", Name: "Relay", Chat: "https://relay.test/v1", Anthropic: "https://relay.test",
		Key: "sk-redacted", KeyName: "Personal", KeyWeight: 2,
		Keys: []KeyAccount{
			{Name: "Team", Key: "sk-redacted", Protocol: Anthropic, Weight: 3},
			{Name: "Spare", Key: "sk-redacted", Off: true},
		},
		AccountModels:      map[string][]string{keyID("sk-redacted"): {"m1"}},
		AccountProxies:     map[string]string{keyID("sk-redacted"): "direct"},
		AccountConcurrency: map[string]int{keyID("sk-redacted"): 4, keyID("sk-redacted"): 1},
	}); err != nil {
		t.Fatal(err)
	}
	was, now, err := ReplaceKey("relay", keyID("sk-redacted"), "  sk-redacted\n")
	if err != nil || was != keyID("sk-redacted") || now != keyID("sk-redacted") {
		t.Fatalf("%q %q %v", was, now, err)
	}
	p, _ := Find("relay")
	want := []KeyAccount{{Name: "Team", Key: "sk-redacted", Protocol: Anthropic, Weight: 3}, {Name: "Spare", Key: "sk-redacted", Off: true}}
	if p.Key != "sk-redacted" || p.KeyName != "Personal" || !slices.Equal(p.Keys, want) {
		t.Fatalf("keys %q %+v", p.Key, p.Keys)
	}
	if _, ok := p.AccountModels[was]; ok || !slices.Equal(p.AccountModels[now], []string{"m1"}) {
		t.Fatalf("models %v", p.AccountModels)
	}
	if p.AccountProxies[now] != "direct" || p.AccountConcurrency[now] != 4 || p.AccountConcurrency[keyID("sk-redacted")] != 1 || len(p.AccountConcurrency) != 2 {
		t.Fatalf("proxies %v concurrency %v", p.AccountProxies, p.AccountConcurrency)
	}

	// the first key: stays first, keeps its name and weight
	if _, _, err := ReplaceKey("relay", keyID("sk-redacted"), "sk-redacted"); err != nil {
		t.Fatal(err)
	}
	p, _ = Find("relay")
	if p.Key != "sk-redacted" || p.KeyName != "Personal" || p.KeyWeight != 2 || p.AccountConcurrency[keyID("sk-redacted")] != 1 {
		t.Fatalf("first %q %q %d %v", p.Key, p.KeyName, p.KeyWeight, p.AccountConcurrency)
	}

	// another key's value, nothing, or a key it doesn't have: refused,
	// nothing changed; its own value again: nothing to do
	for _, c := range []struct{ ref, key string }{
		{keyID("sk-redacted"), "sk-redacted"},
		{keyID("sk-redacted"), "  "},
		{keyID("sk-redacted"), "sk-redacted"},
	} {
		if _, _, err := ReplaceKey("relay", c.ref, c.key); err == nil {
			t.Errorf("%s → %q: no error", c.ref, c.key)
		}
	}
	if was, now, err := ReplaceKey("relay", keyID("sk-redacted"), "sk-redacted"); err != nil || was != now {
		t.Fatalf("same value: %q %q %v", was, now, err)
	}
	if q, _ := Find("relay"); q.Key != p.Key || !slices.Equal(q.Keys, p.Keys) {
		t.Fatalf("changed: %q %+v", q.Key, q.Keys)
	}
}
