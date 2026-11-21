// HakersVPN proxy server.
//
// An authenticated HTTP/HTTPS forward proxy meant to sit behind the
// HakersVPN browser extension. Run it with TLS so that everything between
// the browser and this server (hostnames, plain-HTTP traffic, credentials)
// is encrypted.
//
// Configuration (environment variables):
//
//	LISTEN         address to listen on            (default ":8443")
//	PROXY_USER     username the extension uses     (required)
//	PROXY_PASS     password the extension uses     (required)
//	TLS_CERT       path to TLS certificate (PEM)   (strongly recommended)
//	TLS_KEY        path to TLS private key (PEM)
//	ALLOW_PRIVATE  "1" to allow connections to private/loopback addresses
//	               on the server's network (default: blocked)
package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	user, pass   []byte
	allowPrivate bool
)

func main() {
	listen := envOr("LISTEN", ":8443")
	user = []byte(os.Getenv("PROXY_USER"))
	pass = []byte(os.Getenv("PROXY_PASS"))
	allowPrivate = os.Getenv("ALLOW_PRIVATE") == "1"
	cert, key := os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY")

	if len(user) == 0 || len(pass) == 0 {
		log.Fatal("PROXY_USER and PROXY_PASS must be set")
	}
	if len(pass) < 12 {
		log.Println("warning: PROXY_PASS is short; use 12+ random characters")
	}

	srv := &http.Server{
		Addr:              listen,
		Handler:           http.HandlerFunc(handle),
		ReadHeaderTimeout: 15 * time.Second,
		// Force HTTP/1.1: CONNECT tunnels rely on connection hijacking.
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}

	if cert != "" && key != "" {
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		log.Printf("HakersVPN listening on %s (TLS)", listen)
		log.Fatal(srv.ListenAndServeTLS(cert, key))
	}
	log.Printf("warning: TLS_CERT/TLS_KEY not set; running WITHOUT encryption to the browser")
	log.Printf("HakersVPN listening on %s (plain HTTP)", listen)
	log.Fatal(srv.ListenAndServe())
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---- auth -----------------------------------------------------------------

func authorized(r *http.Request) bool {
	h := r.Header.Get("Proxy-Authorization")
	const prefix = "Basic "
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(h[len(prefix):])
	if err != nil {
		return false
	}
	u, p, ok := strings.Cut(string(raw), ":")
	if !ok {
		return false
	}
	uOK := subtle.ConstantTimeCompare([]byte(u), user)
	pOK := subtle.ConstantTimeCompare([]byte(p), pass)
	return uOK&pOK == 1
}

// ---- outbound dialing -----------------------------------------------------

// dialer refuses to connect to the server's own private network unless
// ALLOW_PRIVATE=1. The check runs on the resolved IP right before connect,
// so DNS tricks can't get around it.
var dialer = &net.Dialer{
	Timeout:   15 * time.Second,
	KeepAlive: 30 * time.Second,
	Control: func(network, address string, _ syscall.RawConn) error {
		if allowPrivate {
			return nil
		}
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if ip == nil || blockedIP(ip) {
			return fmt.Errorf("destination %s is not allowed", host)
		}
		return nil
	},
}

func blockedIP(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
		// 100.64.0.0/10 (carrier-grade NAT) and 0.0.0.0/8
		if ip[0] == 0 || (ip[0] == 100 && ip[1]&0xC0 == 64) {
			return true
		}
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

var transport = &http.Transport{
	Proxy:                 nil,
	DialContext:           dialer.DialContext,
	ForceAttemptHTTP2:     false,
	MaxIdleConns:          100,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 60 * time.Second,
}

// ---- request handling -----------------------------------------------------

func handle(w http.ResponseWriter, r *http.Request) {
	isProxyReq := r.Method == http.MethodConnect || r.URL.IsAbs()
	if !isProxyReq {
		// Someone browsed to the server directly. Look boring.
		http.NotFound(w, r)
		return
	}
	if !authorized(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="HakersVPN"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	if r.Method == http.MethodConnect {
		handleConnect(w, r)
	} else {
		handleHTTP(w, r)
	}
}

// handleConnect opens a raw TCP tunnel (used for HTTPS, WSS, etc.).
func handleConnect(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	upstream, err := dialer.DialContext(ctx, "tcp", r.Host)
	cancel()
	if err != nil {
		http.Error(w, "upstream connect failed", http.StatusBadGateway)
		log.Printf("CONNECT %s: %v", r.Host, err)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	client.SetDeadline(time.Time{}) // clear ReadHeaderTimeout for the tunnel

	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		client.Close()
		upstream.Close()
		return
	}
	// Anything the client already sent after the CONNECT headers.
	if n := buf.Reader.Buffered(); n > 0 {
		pending, _ := buf.Reader.Peek(n)
		upstream.Write(pending)
	}
	pipe(client, upstream)
}

func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			c.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}

var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func stripHop(h http.Header) {
	for _, f := range strings.Split(h.Get("Connection"), ",") {
		if f = strings.TrimSpace(f); f != "" {
			h.Del(f)
		}
	}
	for _, k := range hopHeaders {
		h.Del(k)
	}
}

// handleHTTP forwards a plain http:// request.
func handleHTTP(w http.ResponseWriter, r *http.Request) {
	out := r.Clone(r.Context())
	out.RequestURI = ""
	stripHop(out.Header)

	resp, err := transport.RoundTrip(out)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		http.Error(w, "upstream request failed", status)
		log.Printf("%s %s: %v", r.Method, r.URL.Host, err)
		return
	}
	defer resp.Body.Close()

	stripHop(resp.Header)
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
