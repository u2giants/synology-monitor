package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	// NAS identity
	NasID   string
	NasName string

	// DSM API
	DsmURL                string
	DsmUsername           string
	DsmPassword           string
	DsmInsecureSkipVerify bool

	// Supabase
	SupabaseURL        string
	SupabaseServiceKey string

	// Collection intervals
	MetricsInterval  time.Duration
	StorageInterval  time.Duration
	LogInterval      time.Duration
	DockerInterval   time.Duration
	SecurityInterval time.Duration

	// File system monitoring
	WatchPaths     []string
	ChecksumPaths  []string
	MaxInotifyDirs int
	LogDir         string

	// Data directory (SQLite WAL, checksums)
	DataDir string

	// Sender config
	BatchSize    int
	FlushTimeout time.Duration
	MaxWALSize   int64 // bytes
}

func Load() (*Config, error) {
	cfg := &Config{
		NasID:   getEnv("NAS_ID", "nas-1"),
		NasName: getEnv("NAS_NAME", "Synology NAS 1"),

		DsmURL:                getEnv("DSM_URL", "https://localhost:5001"),
		DsmUsername:           getEnv("DSM_USERNAME", ""),
		DsmPassword:           getEnv("DSM_PASSWORD", ""),
		DsmInsecureSkipVerify: getEnvBool("DSM_INSECURE_SKIP_VERIFY", true),

		SupabaseURL:        getEnv("SUPABASE_URL", ""),
		SupabaseServiceKey: getEnv("SUPABASE_SERVICE_KEY", ""),

		MetricsInterval:  getEnvDuration("METRICS_INTERVAL", 30*time.Second),
		StorageInterval:  getEnvDuration("STORAGE_INTERVAL", 60*time.Second),
		LogInterval:      getEnvDuration("LOG_INTERVAL", 10*time.Second),
		DockerInterval:   getEnvDuration("DOCKER_INTERVAL", 30*time.Second),
		SecurityInterval: getEnvDuration("SECURITY_INTERVAL", 15*time.Minute),

		WatchPaths:     getEnvList("WATCH_PATHS", []string{"/host/volume1"}),
		ChecksumPaths:  getEnvList("CHECKSUM_PATHS", []string{"/host/volume1"}),
		MaxInotifyDirs: getEnvInt("MAX_INOTIFY_DIRS", 5000),
		LogDir:         getEnv("LOG_DIR", "/host/log"),

		DataDir: getEnv("DATA_DIR", "/app/data"),

		BatchSize:    getEnvInt("BATCH_SIZE", 100),
		FlushTimeout: getEnvDuration("FLUSH_TIMEOUT", 30*time.Second),
		MaxWALSize:   int64(getEnvInt("MAX_WAL_SIZE_MB", 100)) * 1024 * 1024,
	}

	if cfg.DsmUsername == "" || cfg.DsmPassword == "" {
		return nil, fmt.Errorf("DSM_USERNAME and DSM_PASSWORD are required")
	}
	if cfg.SupabaseURL == "" || cfg.SupabaseServiceKey == "" {
		return nil, fmt.Errorf("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
	}

	return cfg, nil
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if v := os.Getenv(key); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		i, err := strconv.Atoi(v)
		if err == nil {
			return i
		}
	}
	return defaultVal
}

func getEnvDuration(key string, defaultVal time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return defaultVal
}

func getEnvList(key string, defaultVal []string) []string {
	if v := os.Getenv(key); v != "" {
		var result []string
		for _, s := range splitAndTrim(v) {
			if s != "" {
				result = append(result, s)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return defaultVal
}

func splitAndTrim(s string) []string {
	var result []string
	current := ""
	for _, c := range s {
		if c == ',' {
			result = append(result, trimSpaces(current))
			current = ""
		} else {
			current += string(c)
		}
	}
	result = append(result, trimSpaces(current))
	return result
}

func trimSpaces(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}

	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}

	return s[start:end]
}
