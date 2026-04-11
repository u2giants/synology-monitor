package collector

// ConnectionsCollector parses /host/proc/net/tcp and /host/proc/net/tcp6
// to enumerate active ESTABLISHED connections grouped by remote IP and
// service (local port). Results are written to net_connections.
//
// This gives the copilot a top-N view of which clients are most actively
// connected to the NAS at any given moment, without requiring netfilter
// conntrack or privileged tools.
//
// Requires /proc:/host/proc:ro in the container volume mounts.

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"strconv"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

const (
	tcpStatePath  = "/host/proc/net/tcp"
	tcp6StatePath = "/host/proc/net/tcp6"
	maxConnPeers  = 30 // top-N remote IPs to store
	tcpEstablished = "01"
)

// portProtocol maps well-known local port numbers to service labels.
var portProtocol = map[int]string{
	22:   "ssh",
	80:   "http",
	139:  "smb",
	443:  "https",
	445:  "smb",
	873:  "rsync",
	2049: "nfs",
	5000: "dsm-http",
	5001: "dsm-https",
	6690: "drive",
	8080: "http-alt",
}

// connKey groups connections from the same remote IP on the same local service.
type connKey struct {
	remoteIP  string
	localPort int
}

// ConnectionsCollector collects active network session counts by remote peer.
type ConnectionsCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration
}

// NewConnectionsCollector creates a ConnectionsCollector.
func NewConnectionsCollector(s *sender.Sender, nasID string, interval time.Duration) *ConnectionsCollector {
	return &ConnectionsCollector{
		sender:   s,
		nasID:    nasID,
		interval: interval,
	}
}

// Run starts the collection loop.
func (c *ConnectionsCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[connections] collector started (interval: %s)", c.interval)
	c.collect()

	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[connections] collector stopped")
			return
		}
	}
}

func (c *ConnectionsCollector) collect() {
	now := time.Now().UTC()

	counts := make(map[connKey]int)

	for _, path := range []string{tcpStatePath, tcp6StatePath} {
		if err := parseTCPFile(path, counts); err != nil {
			// File may not exist; not fatal
			continue
		}
	}

	if len(counts) == 0 {
		return
	}

	// Sort by connection count descending and take top-N
	type entry struct {
		key   connKey
		count int
	}
	entries := make([]entry, 0, len(counts))
	for k, v := range counts {
		entries = append(entries, entry{k, v})
	}
	// Selection sort (maxConnPeers is small)
	for i := 0; i < len(entries) && i < maxConnPeers; i++ {
		best := i
		for j := i + 1; j < len(entries); j++ {
			if entries[j].count > entries[best].count {
				best = j
			}
		}
		entries[i], entries[best] = entries[best], entries[i]
	}
	if len(entries) > maxConnPeers {
		entries = entries[:maxConnPeers]
	}

	emitted := 0
	for _, e := range entries {
		proto := portProtocol[e.key.localPort]
		if proto == "" {
			proto = "other"
		}
		c.sender.QueueNetConnection(sender.NetConnectionPayload{
			NasID:      c.nasID,
			CapturedAt: now,
			RemoteIP:   e.key.remoteIP,
			LocalPort:  e.key.localPort,
			Protocol:   proto,
			ConnCount:  e.count,
		})
		emitted++
	}

	log.Printf("[connections] collected %d remote peers", emitted)
}

// parseTCPFile reads one of /proc/net/tcp or /proc/net/tcp6 and counts
// ESTABLISHED connections per (remoteIP, localPort) pair.
func parseTCPFile(path string, counts map[connKey]int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	isIPv6 := strings.Contains(path, "tcp6")

	scanner := bufio.NewScanner(f)
	// Skip header line
	scanner.Scan()

	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		// Format: sl local_addr rem_addr st tx_queue rx_queue ...
		if len(fields) < 4 {
			continue
		}

		state := fields[3]
		if state != tcpEstablished {
			continue
		}

		localAddr := fields[1]
		remAddr   := fields[2]

		localPort, err := parsePort(localAddr)
		if err != nil {
			continue
		}

		// Skip loopback connections
		remIP, err := parseIP(remAddr, isIPv6)
		if err != nil {
			continue
		}
		if isLoopback(remIP) {
			continue
		}

		key := connKey{remoteIP: remIP, localPort: localPort}
		counts[key]++
	}

	return scanner.Err()
}

// parsePort extracts the decimal port from an address like "0F02000A:01BB".
func parsePort(addr string) (int, error) {
	parts := strings.SplitN(addr, ":", 2)
	if len(parts) != 2 {
		return 0, fmt.Errorf("bad addr: %s", addr)
	}
	port, err := strconv.ParseInt(parts[1], 16, 32)
	if err != nil {
		return 0, err
	}
	return int(port), nil
}

// parseIP decodes the little-endian hex IP from /proc/net/tcp[6].
// For IPv4: "0F02000A" → bytes [0F 02 00 0A] → IP 10.0.2.15 (reversed).
// For IPv6: 32 hex chars, each group of 8 chars reversed in byte order.
func parseIP(addrHex string, isIPv6 bool) (string, error) {
	colonIdx := strings.Index(addrHex, ":")
	if colonIdx >= 0 {
		addrHex = addrHex[:colonIdx]
	}

	raw, err := hex.DecodeString(addrHex)
	if err != nil {
		return "", err
	}

	if !isIPv6 {
		if len(raw) != 4 {
			return "", fmt.Errorf("expected 4 bytes for IPv4, got %d", len(raw))
		}
		// Little-endian → network byte order
		ip := net.IP{raw[3], raw[2], raw[1], raw[0]}
		return ip.String(), nil
	}

	// IPv6: four 32-bit little-endian words
	if len(raw) != 16 {
		return "", fmt.Errorf("expected 16 bytes for IPv6, got %d", len(raw))
	}
	var ipRaw [16]byte
	for i := 0; i < 4; i++ {
		ipRaw[i*4+0] = raw[i*4+3]
		ipRaw[i*4+1] = raw[i*4+2]
		ipRaw[i*4+2] = raw[i*4+1]
		ipRaw[i*4+3] = raw[i*4+0]
	}
	ip := net.IP(ipRaw[:])
	return ip.String(), nil
}

// isLoopback returns true for 127.x.x.x and ::1.
func isLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	return parsed.IsLoopback()
}
