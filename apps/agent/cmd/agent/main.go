package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

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

	// Stop channel for graceful shutdown
	stop := make(chan struct{})

	// Start sender loop
	go s.Run(stop)

	// Start collectors
	systemCollector := collector.NewSystemCollector(dsmClient, s, cfg.NasID, cfg.MetricsInterval)
	go systemCollector.Run(stop)

	storageCollector := collector.NewStorageCollector(dsmClient, s, cfg.NasID, cfg.StorageInterval)
	go storageCollector.Run(stop)

	dockerCollector := collector.NewDockerCollector(dsmClient, s, cfg.NasID, cfg.DockerInterval)
	go dockerCollector.Run(stop)

	// Start log watcher
	logW := logwatcher.New(s, cfg.NasID, cfg.LogDir, cfg.WatchPaths, cfg.ExtraLogFiles, cfg.LogInterval)
	go logW.Run(stop)

	// Start security watcher
	secW, err := security.NewWatcher(s, cfg.NasID, cfg.WatchPaths, cfg.MaxInotifyDirs, cfg.DataDir)
	if err != nil {
		log.Printf("Warning: security watcher failed to initialize: %v", err)
	} else {
		defer secW.Close()
		go secW.Run(stop)
	}

	// Periodic heartbeat
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				model := "DS1621xs+"
				dsmVer := ""
				if sysInfo != nil {
					model = sysInfo.Model
					dsmVer = sysInfo.FirmwareVer
				}
				s.SendHeartbeat(cfg.NasID, cfg.NasName, model, dsmVer)
			case <-stop:
				return
			}
		}
	}()

	log.Printf("Agent running for NAS: %s (%s)", cfg.NasName, cfg.NasID)

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down...")
	close(stop)

	// Give goroutines time to flush
	time.Sleep(2 * time.Second)
	log.Println("Agent stopped")
}
