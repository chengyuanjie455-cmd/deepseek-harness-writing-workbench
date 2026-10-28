package gateway

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
)

// NewHostOwned keeps the embedding host's retry receipts authoritative. It
// retains Magpie's protocol gateway but never spends a second upstream request
// inside one host attempt. The ordinary Magpie entry points are unchanged.
func NewHostOwned() *Server {
	s := New()
	s.hostSingleAttempt = true
	// Do not use replayable's implicit idempotency mark for paid POSTs.
	s.client.Transport = hostAttemptTransport{rpmTransport{vendorTransport(upstreamHeaderWait)}}
	s.client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return s
}

type hostAttemptKey struct{}

// HostAttempt scopes a single upstream-send budget to this exact HTTP request.
func HostAttempt(ctx context.Context) context.Context {
	return context.WithValue(ctx, hostAttemptKey{}, new(atomic.Bool))
}

type hostAttemptTransport struct{ next http.RoundTripper }

func (t hostAttemptTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if sent, ok := r.Context().Value(hostAttemptKey{}).(*atomic.Bool); ok && sent.Swap(true) {
		return nil, errors.New("host owns retries: second upstream request refused")
	}
	return t.next.RoundTrip(r)
}
