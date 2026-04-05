package main

import (
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/synology-monitor/agent/internal/collector"
	"github.com/synology-monitor/agent/internal/config"
	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/logwatcher"
	"github.com/synology-monitor/agent/internal/security"
	"github.com/synology-monitor/agent/internal/sender"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("Synology Monitor Agent starting...")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Ensure data directory exists
	os.MkdirAll(cfg.DataDir, 0755)

	// Initialize DSM API client
	dsmClient := dsm.NewClient(cfg.DsmURL, cfg.DsmUsername, cfg.DsmPassword, cfg.DsmInsecureSkipVerify)

	// Login to DSM
	if err := dsmClient.Login(); err != nil {
		log.Fatalf("Failed to login to DSM: %v", err)
	}
	defer dsmClient.Logout()
	log.Println("Connected to DSM API")

	// Initialize sender (Supabase + SQLite WAL)
	s, err := sender.New(
		cfg.SupabaseURL,
		cfg.SupabaseServiceKey,
		cfg.DataDir,
		cfg.BatchSize,
		cfg.FlushTimeout,
		cfg.MaxWALSize,
	)
	if err != nil {
		log.Fatalf("Failed to initialize sender: %v", err)
	}
	defer s.Close()

	// Send initial heartbeat
	sysInfo, err := dsmClient.GetSystemInfo()
	if err != nil {
		log.Printf("Warning: could not get system info: %v", err)
		s.SendHeartbeat(cfg.NasID, cfg.NasName, "DS1621xs+", "")
	} else {
		s.SendHeartbeat(cfg.NasID, cfg.NasName, sysInfo.Model, sysInfo.FirmwareVer)
	}

	// Stop channel and wait group for graceful shutdown
	stop := make(chan struct{})
	var wg sync.WaitGroup

	// Start sender loop
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.Run(stop)
	}()

	// Start collectors
	systemCollector := collector.NewSystemCollector(dsmClient, s, cfg.NasID, cfg.MetricsInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		systemCollector.Run(stop)
	}()

	storageCollector := collector.NewStorageCollector(dsmClient, s, cfg.NasID, cfg.StorageInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		storageCollector.Run(stop)
	}()

	dockerCollector := collector.NewDockerCollector(dsmClient, s, cfg.NasID, cfg.DockerInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		dockerCollector.Run(stop)
	}()

	// Start Drive Admin collector (team folders, user activity, stats, ShareSync tasks)
	driveCollector := collector.NewDriveCollector(dsmClient, s, cfg.NasID, cfg.MetricsInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		driveCollector.Run(stop)
	}()

	// Start per-process CPU / memory / disk I/O collector
	processCollector := collector.NewProcessCollector(s, cfg.NasID, cfg.ProcessInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		processCollector.Run(stop)
	}()

	// Start per-disk IOPS / latency / utilisation collector
	diskStatsCollector := collector.NewDiskStatsCollector(s, cfg.NasID, cfg.DiskStatsInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		diskStatsCollector.Run(stop)
	}()

	// Start active network connection enumerator
	connectionsCollector := collector.NewConnectionsCollector(s, cfg.NasID, cfg.ConnectionsInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		connectionsCollector.Run(stop)
	}()

	// Start log watcher
	logW := logwatcher.New(s, cfg.NasID, cfg.LogDir, cfg.WatchPaths, cfg.ExtraLogFiles, cfg.LogInterval)
	wg.Add(1)
	go func() {
		defer wg.Done()
		logW.Run(stop)
	}()

	// Start security watcher
	secW, err := security.NewWatcher(s, cfg.NasID, cfg.WatchPaths, cfg.MaxInotifyDirs, cfg.DataDir)
	if err != nil {
		log.Printf("Warning: security watcher failed to initialize: %v", err)
	} else {
		defer secW.Close()
		wg.Add(1)
		go func() {
			defer wg.Done()
			secW.Run(stop)
		}()
	}

	log.Printf("Agent running for NAS: %s (%s)", cfg.NasName, cfg.NasID)

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down...")
	close(stop)

	// Wait for all goroutines to finish
	wg.Wait()
	log.Println("Agent stopped")
}
