// Isolated TLS latency and sustained-transfer fixture. Never point this at production.
package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func fail(err error) {
	if err != nil {
		panic(err)
	}
}
func backend(dir string) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	fail(err)
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "tls.bench.test"},
		DNSNames: []string{"tls.bench.test"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	fail(err)
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	fail(os.WriteFile(dir+"/cert.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644))
	plain, err := net.Listen("tcp", "127.0.0.1:29791")
	fail(err)
	secure, err := tls.Listen("tcp", "127.0.0.1:29792", &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12, SessionTicketsDisabled: true})
	fail(err)
	payload := make([]byte, 256*1024)
	_, err = rand.Read(payload)
	fail(err)
	serve := func(listener net.Listener, isTLS bool) {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.SetDeadline(time.Now().Add(8 * time.Second))
				r := bufio.NewReader(c)
				line, err := r.ReadString('\n')
				if err != nil {
					return
				}
				for {
					h, e := r.ReadString('\n')
					if e != nil {
						return
					}
					if h == "\r\n" {
						break
					}
				}
				if isTLS {
					io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
					return
				}
				c.SetDeadline(time.Time{})
				if strings.Contains(line, "/bulk") {
					var pace time.Duration
					fields := strings.Fields(line)
					if len(fields) > 1 && strings.HasPrefix(fields[1], "/bulk?bps=") {
						bps, e := strconv.ParseFloat(strings.TrimPrefix(fields[1], "/bulk?bps="), 64)
						if e == nil && bps > 0 {
							pace = time.Duration(float64(len(payload)) * float64(time.Second) / bps)
						}
					}
					next := time.Now()
					for {
						if pace > 0 {
							next = next.Add(pace)
							if pause := time.Until(next); pause > 0 {
								time.Sleep(pause)
							}
						}
						if _, e := c.Write(payload); e != nil {
							return
						}
					}
				}
				io.WriteString(c, "S")
				io.Copy(c, r)
			}()
		}
	}
	go serve(plain, false)
	go serve(secure, true)
	fmt.Println("ready")
	select {}
}

type stat struct{ TCP, TLS, Total, HTTP float64 }

func percentile(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	sort.Float64s(v)
	return v[int(float64(len(v)-1)*p)]
}
func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
func load(addr, dir string, nIdle, nBulk, seconds, rate, mbps int) {
	pool := x509.NewCertPool()
	data, err := os.ReadFile(dir + "/cert.pem")
	fail(err)
	if !pool.AppendCertsFromPEM(data) {
		panic("certificate")
	}
	tc := &tls.Config{ServerName: "tls.bench.test", RootCAs: pool, MinVersion: tls.VersionTLS12}
	held := make([]net.Conn, nIdle)
	var wg sync.WaitGroup
	var setupErrors, bulkErrors, heartErrors atomic.Int64
	sem := make(chan struct{}, 32)
	for i := range held {
		sem <- struct{}{}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			c, e := net.DialTimeout("tcp", addr, 5*time.Second)
			if e != nil {
				setupErrors.Add(1)
				return
			}
			c.SetDeadline(time.Now().Add(5 * time.Second))
			_, e = io.WriteString(c, "GET /hold HTTP/1.1\r\nHost: bulk.bench.test\r\n\r\n")
			var b [1]byte
			if e == nil {
				_, e = io.ReadFull(c, b[:])
			}
			if e != nil || b[0] != 'S' {
				setupErrors.Add(1)
				c.Close()
				return
			}
			c.SetDeadline(time.Time{})
			held[i] = c
		}(i)
	}
	wg.Wait()
	var bytes atomic.Uint64
	var finished atomic.Bool
	bulk := make([]net.Conn, 0, nBulk)
	for i := 0; i < nBulk; i++ {
		c, e := net.DialTimeout("tcp", addr, 5*time.Second)
		if e != nil {
			setupErrors.Add(1)
			continue
		}
		_, e = fmt.Fprintf(c, "GET /bulk?bps=%.0f HTTP/1.1\r\nHost: bulk.bench.test\r\n\r\n", float64(mbps)*1e6/8/float64(nBulk))
		if e != nil {
			setupErrors.Add(1)
			c.Close()
			continue
		}
		bulk = append(bulk, c)
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 256*1024)
			for {
				n, e := c.Read(buf)
				bytes.Add(uint64(n))
				if e != nil {
					if !finished.Load() {
						bulkErrors.Add(1)
					}
					return
				}
			}
		}()
	}
	// Periodic checks on already established connections during the workload.
	stopHeart := make(chan struct{})
	heartDone := make(chan struct{})
	go func() {
		defer close(heartDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		index := 0
		for {
			select {
			case <-stopHeart:
				return
			case <-ticker.C:
				for j := 0; j < min(16, nIdle); j++ {
					c := held[index%nIdle]
					index++
					if c == nil {
						continue
					}
					c.SetDeadline(time.Now().Add(3 * time.Second))
					_, e := c.Write([]byte("ping"))
					var b [4]byte
					if e == nil {
						_, e = io.ReadFull(c, b[:])
					}
					if e != nil || string(b[:]) != "ping" {
						heartErrors.Add(1)
					}
					c.SetDeadline(time.Time{})
				}
			}
		}
	}()
	time.Sleep(time.Second) // identical bulk warm-up for every trial
	startBytes := bytes.Load()
	started := time.Now()
	var results []stat
	var mu sync.Mutex
	errors := map[string]int{}
	recordError := func(stage string, e error) { mu.Lock(); errors[stage+":"+e.Error()]++; mu.Unlock() }
	var handshakes sync.WaitGroup
	ticker := time.NewTicker(time.Second / time.Duration(rate))
	for i := 0; i < seconds*rate; i++ {
		<-ticker.C
		handshakes.Add(1)
		go func() {
			defer handshakes.Done()
			begin := time.Now()
			c, e := net.DialTimeout("tcp", addr, 5*time.Second)
			connected := time.Now()
			if e != nil {
				recordError("connect", e)
				return
			}
			defer c.Close()
			c.SetDeadline(begin.Add(5 * time.Second))
			s := tls.Client(c, tc)
			e = s.Handshake()
			ready := time.Now()
			if e != nil {
				recordError("tls", e)
				return
			}
			_, e = io.WriteString(s, "GET / HTTP/1.1\r\nHost: tls.bench.test\r\nConnection: close\r\n\r\n")
			if e == nil {
				var body []byte
				body, e = io.ReadAll(s)
				if e == nil && !strings.HasSuffix(string(body), "\r\n\r\nOK") {
					e = fmt.Errorf("wrong response")
				}
			}
			if e != nil {
				recordError("http", e)
				return
			}
			row := stat{ms(connected.Sub(begin)), ms(ready.Sub(connected)), ms(ready.Sub(begin)), ms(time.Since(begin))}
			mu.Lock()
			results = append(results, row)
			mu.Unlock()
		}()
	}
	ticker.Stop()
	handshakes.Wait()
	elapsed := time.Since(started).Seconds()
	endBytes := bytes.Load()
	close(stopHeart)
	<-heartDone
	// All held connections must remain usable, not just the periodic sample.
	var finalErrors atomic.Int64
	var final sync.WaitGroup
	for _, c := range held {
		if c == nil {
			continue
		}
		sem <- struct{}{}
		final.Add(1)
		go func(c net.Conn) {
			defer final.Done()
			defer func() { <-sem }()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			_, e := c.Write([]byte("done"))
			var b [4]byte
			if e == nil {
				_, e = io.ReadFull(c, b[:])
			}
			if e != nil || string(b[:]) != "done" {
				finalErrors.Add(1)
			}
		}(c)
	}
	final.Wait()
	out := map[string]any{"idle": nIdle, "bulk": nBulk, "target_mbps": mbps, "requested": seconds * rate, "success": len(results), "errors": errors,
		"setup_errors": setupErrors.Load(), "bulk_errors": bulkErrors.Load(), "heartbeat_errors": heartErrors.Load(),
		"held_connection_errors": finalErrors.Load(), "elapsed_s": elapsed, "bulk_gbps": float64(endBytes-startBytes) * 8 / elapsed / 1e9}
	for _, item := range []struct {
		name string
		get  func(stat) float64
	}{
		{"tcp", func(s stat) float64 { return s.TCP }}, {"tls", func(s stat) float64 { return s.TLS }},
		{"handshake", func(s stat) float64 { return s.Total }}, {"http", func(s stat) float64 { return s.HTTP }}} {
		values := make([]float64, len(results))
		for i, s := range results {
			values[i] = item.get(s)
		}
		out[item.name+"_p50_ms"] = percentile(values, .5)
		out[item.name+"_p95_ms"] = percentile(values, .95)
		out[item.name+"_p99_ms"] = percentile(values, .99)
		out[item.name+"_max_ms"] = percentile(values, 1)
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
	finished.Store(true)
	for _, c := range bulk {
		c.Close()
	}
	for _, c := range held {
		if c != nil {
			c.Close()
		}
	}
	wg.Wait()
	if setupErrors.Load()+bulkErrors.Load()+heartErrors.Load()+finalErrors.Load() > 0 || len(errors) > 0 {
		os.Exit(2)
	}
}
func main() {
	switch os.Args[1] {
	case "backend":
		backend(os.Args[2])
	case "load":
		vals := make([]int, 5)
		for i := range vals {
			v, e := strconv.Atoi(os.Args[4+i])
			fail(e)
			vals[i] = v
		}
		load(os.Args[2], os.Args[3], vals[0], vals[1], vals[2], vals[3], vals[4])
	default:
		panic("backend DIR | load ADDR DIR IDLE BULK SECONDS RATE MBPS")
	}
}
