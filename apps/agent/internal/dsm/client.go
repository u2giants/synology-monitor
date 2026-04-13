package dsm

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client interfaces with the Synology DSM Web API
type Client struct {
	baseURL    string
	username   string
	password   string
	httpClient *http.Client
	sid        string
	mu         sync.Mutex
}

// NewClient creates a new DSM API client
func NewClient(baseURL, username, password string, skipTLSVerify bool) *Client {
	transport := &http.Transport{}
	if skipTLSVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}

	return &Client{
		baseURL:  baseURL,
		username: username,
		password: password,
		httpClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
	}
}

// DSM API response wrapper
type apiResponse struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   *apiError       `json:"error"`
}

type apiError struct {
	Code int `json:"code"`
}

// Login authenticates with the DSM API
func (c *Client) Login() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	params := url.Values{
		"api":     {"SYNO.API.Auth"},
		"version": {"7"},
		"method":  {"login"},
		"account": {c.username},
		"passwd":  {c.password},
		"format":  {"sid"},
	}

	resp, err := c.rawRequest(params)
	if err != nil {
		return fmt.Errorf("login request failed: %w", err)
	}

	var loginData struct {
		SID string `json:"sid"`
	}
	if err := json.Unmarshal(resp, &loginData); err != nil {
		return fmt.Errorf("login parse failed: %w", err)
	}

	c.sid = loginData.SID
	return nil
}

// Logout ends the DSM API session
func (c *Client) Logout() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.sid == "" {
		return
	}

	params := url.Values{
		"api":     {"SYNO.API.Auth"},
		"version": {"7"},
		"method":  {"logout"},
		"_sid":    {c.sid},
	}

	c.rawRequest(params) //nolint:errcheck
	c.sid = ""
}

// request makes an authenticated API call
func (c *Client) request(api string, version int, method string, extra url.Values) (json.RawMessage, error) {
	// Hold mutex for entire login check and login operation to prevent race condition
	c.mu.Lock()
	sid := c.sid
	if sid == "" {
		// Release lock temporarily while logging in (Login() acquires its own lock)
		c.mu.Unlock()
		if err := c.Login(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		sid = c.sid
	}
	c.mu.Unlock()

	params := url.Values{
		"api":     {api},
		"version": {fmt.Sprintf("%d", version)},
		"method":  {method},
		"_sid":    {sid},
	}
	for k, v := range extra {
		params[k] = v
	}

	data, err := c.rawRequest(params)
	if err != nil {
		// Try re-login on auth error
		if loginErr := c.Login(); loginErr != nil {
			return nil, fmt.Errorf("re-login failed: %w", loginErr)
		}
		c.mu.Lock()
		params.Set("_sid", c.sid)
		c.mu.Unlock()
		return c.rawRequest(params)
	}

	return data, nil
}

func (c *Client) rawRequest(params url.Values) (json.RawMessage, error) {
	reqURL := fmt.Sprintf("%s/webapi/entry.cgi?%s", c.baseURL, params.Encode())

	resp, err := c.httpClient.Get(reqURL)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body failed: %w", err)
	}

	var apiResp apiResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, fmt.Errorf("parsing API response failed: %w", err)
	}

	if !apiResp.Success {
		code := 0
		if apiResp.Error != nil {
			code = apiResp.Error.Code
		}
		return nil, fmt.Errorf("API error code: %d", code)
	}

	return apiResp.Data, nil
}

// === System Utilization ===

type SystemUtilization struct {
	CPU     CPUInfo    `json:"cpu"`
	Memory  MemoryInfo `json:"memory"`
	Network []NetInfo  `json:"network"`
}

type CPUInfo struct {
	FifteenMinLoad int `json:"15min_load"`
	FiveMinLoad    int `json:"5min_load"`
	OneMinLoad     int `json:"1min_load"`
	SystemLoad     int `json:"system_load"`
	UserLoad       int `json:"user_load"`
}

type MemoryInfo struct {
	AvailReal int `json:"avail_real"`
	AvailSwap int `json:"avail_swap"`
	TotalReal int `json:"total_real"`
	TotalSwap int `json:"total_swap"`
	RealUsage int `json:"real_usage"`
}

type NetInfo struct {
	Device string `json:"device"`
	RX     int64  `json:"rx"`
	TX     int64  `json:"tx"`
}

func (c *Client) GetSystemUtilization() (*SystemUtilization, error) {
	data, err := c.request("SYNO.Core.System.Utilization", 1, "get", nil)
	if err != nil {
		return nil, err
	}

	var util SystemUtilization
	if err := json.Unmarshal(data, &util); err != nil {
		return nil, fmt.Errorf("parsing utilization: %w", err)
	}
	return &util, nil
}

// === Storage ===

type StorageInfo struct {
	Volumes []VolumeInfo `json:"volumes"`
	Disks   []DiskInfo   `json:"disks"`
}

type VolumeInfo struct {
	ID        string `json:"id"`
	VolPath   string `json:"vol_path"`
	Status    string `json:"status"`
	TotalSize int64  `json:"total_size"`
	UsedSize  int64  `json:"used_size"`
	FsType    string `json:"fs_type"`
	RaidType  string `json:"raid_type"`
	Container string `json:"container"`
}

type DiskInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Device      string `json:"device"`
	Model       string `json:"model"`
	Serial      string `json:"serial"`
	SizeTotal   int64  `json:"size_total"`
	Temp        int    `json:"temp"`
	SmartStatus string `json:"smart_status"`
}

func (d *DiskInfo) UnmarshalJSON(data []byte) error {
	type diskInfoAlias struct {
		ID          string          `json:"id"`
		Name        string          `json:"name"`
		Device      string          `json:"device"`
		Model       string          `json:"model"`
		Serial      string          `json:"serial"`
		SizeTotal   json.RawMessage `json:"size_total"`
		Temp        json.RawMessage `json:"temp"`
		SmartStatus string          `json:"smart_status"`
	}

	var aux diskInfoAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	sizeTotal, err := parseInt64Value(aux.SizeTotal)
	if err != nil {
		return fmt.Errorf("parsing disk size_total: %w", err)
	}

	temp, err := parseIntValue(aux.Temp)
	if err != nil {
		return fmt.Errorf("parsing disk temp: %w", err)
	}

	d.ID = aux.ID
	d.Name = aux.Name
	d.Device = aux.Device
	d.Model = aux.Model
	d.Serial = aux.Serial
	d.SizeTotal = sizeTotal
	d.Temp = temp
	d.SmartStatus = aux.SmartStatus
	return nil
}

func (c *Client) GetStorageInfo() (*StorageInfo, error) {
	data, err := c.request("SYNO.Storage.CGI.Storage", 1, "load_info", nil)
	if err != nil {
		return nil, err
	}

	var info StorageInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, fmt.Errorf("parsing storage info: %w", err)
	}
	return &info, nil
}

// === Docker Containers ===

type DockerContainerList struct {
	Containers []DockerContainer `json:"containers"`
}

type DockerContainer struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Image    string `json:"image"`
	Status   string `json:"status"`
	State    string `json:"state"`
	UpTime   int64  `json:"up_time"`
	CPUUsage float64
	MemUsage int64
	MemLimit int64
}

func (d *DockerContainer) UnmarshalJSON(data []byte) error {
	type dockerContainerAlias struct {
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Image    string          `json:"image"`
		Status   string          `json:"status"`
		State    json.RawMessage `json:"state"`
		UpTime   json.RawMessage `json:"up_time"`
		CPUUsage json.RawMessage `json:"cpu_usage"`
		MemUsage json.RawMessage `json:"memory"`
		MemLimit json.RawMessage `json:"memory_limit"`
	}

	var aux dockerContainerAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	state, err := parseContainerState(aux.State)
	if err != nil {
		return fmt.Errorf("parsing container state: %w", err)
	}

	upTime, err := parseInt64Value(aux.UpTime)
	if err != nil {
		return fmt.Errorf("parsing container uptime: %w", err)
	}

	cpuUsage, err := parseFloat64Value(aux.CPUUsage)
	if err != nil {
		return fmt.Errorf("parsing container cpu_usage: %w", err)
	}

	memUsage, err := parseInt64Value(aux.MemUsage)
	if err != nil {
		return fmt.Errorf("parsing container memory: %w", err)
	}

	memLimit, err := parseInt64Value(aux.MemLimit)
	if err != nil {
		return fmt.Errorf("parsing container memory_limit: %w", err)
	}

	d.ID = aux.ID
	d.Name = aux.Name
	d.Image = aux.Image
	d.Status = firstNonEmpty(aux.Status, state)
	d.State = state
	d.UpTime = upTime
	d.CPUUsage = cpuUsage
	d.MemUsage = memUsage
	d.MemLimit = memLimit
	return nil
}

func (c *Client) GetDockerContainers() ([]DockerContainer, error) {
	data, err := c.request("SYNO.Docker.Container", 1, "list", url.Values{
		"limit":  {"-1"},
		"offset": {"0"},
	})
	if err != nil {
		return nil, err
	}

	var list DockerContainerList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("parsing docker containers: %w", err)
	}
	return list.Containers, nil
}

func parseIntValue(raw json.RawMessage) (int, error) {
	value, err := parseInt64Value(raw)
	if err != nil {
		return 0, err
	}
	return int(value), nil
}

func parseInt64Value(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}

	var asInt int64
	if err := json.Unmarshal(raw, &asInt); err == nil {
		return asInt, nil
	}

	var asFloat float64
	if err := json.Unmarshal(raw, &asFloat); err == nil {
		return int64(asFloat), nil
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		var parsed int64
		_, scanErr := fmt.Sscanf(asString, "%d", &parsed)
		if scanErr == nil {
			return parsed, nil
		}
		return 0, nil
	}

	return 0, nil
}

func parseFloat64Value(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}

	var asFloat float64
	if err := json.Unmarshal(raw, &asFloat); err == nil {
		return asFloat, nil
	}

	var asInt int64
	if err := json.Unmarshal(raw, &asInt); err == nil {
		return float64(asInt), nil
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		var parsed float64
		_, scanErr := fmt.Sscanf(asString, "%f", &parsed)
		if scanErr == nil {
			return parsed, nil
		}
		return 0, nil
	}

	return 0, nil
}

func parseContainerState(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString, nil
	}

	var asObject struct {
		Status string `json:"status"`
		State  string `json:"state"`
		Value  string `json:"value"`
	}
	if err := json.Unmarshal(raw, &asObject); err == nil {
		return firstNonEmpty(asObject.Status, asObject.State, asObject.Value), nil
	}

	return "", nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// === System Info ===

type SystemInfo struct {
	Model       string `json:"model"`
	RAMSize     int    `json:"ram_size"`
	Serial      string `json:"serial"`
	Temperature int    `json:"temperature"`
	Uptime      int64  `json:"uptime"`
	FirmwareVer string `json:"firmware_ver"`
}

// === Drive Admin API ===

// DriveTeamFolder represents a Synology Drive team folder
type DriveTeamFolder struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Encoding    string `json:"encoding"`
	IsExternal  bool   `json:"is_external"`
	Priority    string `json:"priority"`
	QuotaLimit  int64  `json:"quota_limit"`
	QuotaUsed   int64  `json:"quota_used"`
	MemberCount int    `json:"member_count"`
	SyncCount   int    `json:"sync_count"`
	Status      string `json:"status"`
}

// DriveUserActivity represents a user's activity in Drive
type DriveUserActivity struct {
	User      string `json:"user"`
	LoginTime string `json:"login_time"`
	IP        string `json:"ip"`
	Device    string `json:"device"`
	Action    string `json:"action"`
	FilePath  string `json:"file_path"`
	Timestamp string `json:"timestamp"`
}

// DriveAdminTeamFolders returns list of team folders
func (c *Client) DriveAdminTeamFolders() ([]DriveTeamFolder, error) {
	data, err := c.request("SYNO.Drive.TeamFolder", 1, "list", url.Values{
		"sort_by":    {"name"},
		"sort_order": {"ASC"},
	})
	if err != nil {
		return nil, err
	}

	var response struct {
		TeamFolders []DriveTeamFolder `json:"items"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("parsing team folders: %w", err)
	}
	return response.TeamFolders, nil
}

// DriveAdminUserActivity returns recent user activity
func (c *Client) DriveAdminUserActivity(limit int) ([]DriveUserActivity, error) {
	data, err := c.request("SYNO.Drive.Activity", 1, "list", url.Values{
		"limit": {fmt.Sprintf("%d", limit)},
	})
	if err != nil {
		return nil, err
	}

	var response struct {
		Activities []DriveUserActivity `json:"activities"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("parsing user activity: %w", err)
	}
	return response.Activities, nil
}

// DriveAdminStats returns Drive statistics
func (c *Client) DriveAdminStats() (map[string]interface{}, error) {
	data, err := c.request("SYNO.Drive.Admin", 1, "stats", nil)
	if err != nil {
		return nil, err
	}

	var stats map[string]interface{}
	if err := json.Unmarshal(data, &stats); err != nil {
		return nil, fmt.Errorf("parsing drive stats: %w", err)
	}
	return stats, nil
}

func (c *Client) GetSystemInfo() (*SystemInfo, error) {
	data, err := c.request("SYNO.Core.System", 2, "info", url.Values{
		"type": {"storage"},
	})
	if err != nil {
		return nil, err
	}

	var info SystemInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, fmt.Errorf("parsing system info: %w", err)
	}
	return &info, nil
}

// === ShareSync Task API ===

// ShareSyncTask represents a Synology Drive ShareSync task.
type ShareSyncTask struct {
	ID               string `json:"task_id"`
	Name             string `json:"task_name"`
	Status           string `json:"status"`
	BacklogCount     int    `json:"backlog_count"`
	BacklogBytes     int64  `json:"backlog_bytes"`
	CurrentFile      string `json:"current_file"`
	CurrentFolder    string `json:"current_folder"`
	RetryCount       int    `json:"retry_count"`
	LastError        string `json:"last_error"`
	TransferredFiles int    `json:"transferred_files"`
	TransferredBytes int64  `json:"transferred_bytes"`
	SpeedBPS         int64  `json:"speed"`
	IndexingQueue    int    `json:"indexing_queue"`
	RemoteHost       string `json:"remote_host"`
	Direction        string `json:"direction"`
	LocalShareName   string `json:"local_share_name"`
	RemoteShareName  string `json:"remote_share_name"`
	TaskUUID         string `json:"task_uuid"`
	Enabled          bool   `json:"enabled"`
}

// GetShareSyncTasks attempts to query ShareSync task list via DSM API.
// Returns an empty slice (not an error) if the API is not available on this
// DSM version, so the caller can fall back to log parsing.
func (c *Client) GetShareSyncTasks() ([]ShareSyncTask, error) {
	// Try the v1 admin endpoint first; fall back to v2 if it fails.
	for _, apiSpec := range []struct {
		api     string
		version int
		method  string
	}{
		{"SYNO.SynologyDrive.Admin.ShareSync", 1, "list"},
		{"SYNO.SynologyDrive.ShareSync", 1, "list"},
		{"SYNO.SynologyDrive.Admin", 1, "sharesync_list"},
	} {
		data, err := c.request(apiSpec.api, apiSpec.version, apiSpec.method, url.Values{
			"limit":  {"-1"},
			"offset": {"0"},
		})
		if err != nil {
			continue
		}

		// The response structure varies; try multiple known shapes.
		var wrapped struct {
			Tasks []ShareSyncTask `json:"tasks"`
			Items []ShareSyncTask `json:"items"`
			List  []ShareSyncTask `json:"list"`
		}
		if err := json.Unmarshal(data, &wrapped); err != nil {
			continue
		}
		tasks := wrapped.Tasks
		if len(tasks) == 0 {
			tasks = wrapped.Items
		}
		if len(tasks) == 0 {
			tasks = wrapped.List
		}
		return tasks, nil
	}

	// API not available on this DSM version – caller uses log-based fallback.
	return nil, nil
}

// === Share Management API ===

// ShareInfo represents a DSM shared folder (SYNO.Core.Share)
type ShareInfo struct {
	Name              string                 `json:"name"`
	Path              string                 `json:"vol_path"`
	Description       string                 `json:"desc"`
	IsUSB             bool                   `json:"is_usb_share"`
	RecycleBinEnabled bool                   `json:"enable_recycle_bin"`
	Encryption        int                    `json:"encryption"`
	Additional        map[string]interface{} `json:"additional"`
}

// GetShares returns all shared folders and their configuration.
// This is critical for diagnosing "Failed to SYNOShareGet" errors.
func (c *Client) GetShares() ([]ShareInfo, error) {
	data, err := c.request("SYNO.Core.Share", 1, "list", url.Values{
		"additional": {`["vol_path","encryption","recycle_bin","quota","enable_share_compress"]`},
		"limit":      {"-1"},
		"offset":     {"0"},
		"shareType":  {"all"},
	})
	if err != nil {
		return nil, err
	}

	var response struct {
		Shares []ShareInfo `json:"shares"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("parsing shares: %w", err)
	}
	return response.Shares, nil
}

// === Package Management API ===

// PackageInfo represents an installed DSM package (SYNO.Core.Package)
type PackageInfo struct {
	ID      string `json:"id"`
	Name    string `json:"dname"`
	Version string `json:"version"`
	Status  string `json:"additional_status"`
	Type    string `json:"type"`
}

// GetInstalledPackages returns all installed packages with their status.
// Key for checking if SynologyDrive is properly registered/installed.
func (c *Client) GetInstalledPackages() ([]PackageInfo, error) {
	data, err := c.request("SYNO.Core.Package", 1, "list", url.Values{
		"additional": {`["status","description"]`},
	})
	if err != nil {
		return nil, err
	}

	var response struct {
		Packages []PackageInfo `json:"packages"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("parsing packages: %w", err)
	}
	return response.Packages, nil
}

// === System Logs API ===

// SystemLogEntry represents a log from DSM's structured log system.
type SystemLogEntry struct {
	Time    string   `json:"time"`
	Level   LogLevel `json:"level"`
	Message string   `json:"msg"`
	Who     string   `json:"who"`
	Descr   string   `json:"descr"`
	LogName string   `json:"logname"`
}

// LogLevel accepts DSM log severity values encoded as either numbers or strings.
type LogLevel int

func (l *LogLevel) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*l = 0
		return nil
	}

	var asInt int
	if err := json.Unmarshal(data, &asInt); err == nil {
		*l = LogLevel(asInt)
		return nil
	}

	var asString string
	if err := json.Unmarshal(data, &asString); err == nil {
		switch strings.ToLower(strings.TrimSpace(asString)) {
		case "emerg", "panic", "alert", "crit", "critical", "err", "error":
			*l = 4
		case "warning", "warn":
			*l = 3
		case "notice", "info", "information":
			*l = 2
		case "debug":
			*l = 1
		default:
			*l = 0
		}
		return nil
	}

	return fmt.Errorf("parsing log level: unsupported value %s", string(data))
}

// GetRecentSystemLogs returns recent system logs via the DSM API.
// These are the structured logs visible in Log Center — they contain
// events like share database errors that may not appear in text log files.
func (c *Client) GetRecentSystemLogs(limit int) ([]SystemLogEntry, error) {
	data, err := c.request("SYNO.Core.SyslogClient.Log", 1, "list", url.Values{
		"limit":  {fmt.Sprintf("%d", limit)},
		"offset": {"0"},
	})
	if err != nil {
		return nil, err
	}

	var response struct {
		Items []SystemLogEntry `json:"items"`
		Logs  []SystemLogEntry `json:"logs"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("parsing system logs: %w", err)
	}
	logs := response.Items
	if len(logs) == 0 {
		logs = response.Logs
	}
	return logs, nil
}

// === Scheduled Tasks API ===

// ScheduledTask represents a DSM task scheduler entry.
type ScheduledTask struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Enable     bool   `json:"enable"`
	NextTime   string `json:"next_trigger_time"`
	LastRun    string `json:"last_run_time"`
	Status     string `json:"status"`
	Owner      string `json:"owner"`
	LastResult int    `json:"last_result"`
}

// GetRunningScheduledTasks returns task scheduler entries that are currently
// running. Returns nil (no error) when the API is unavailable.
func (c *Client) GetRunningScheduledTasks() ([]ScheduledTask, error) {
	tasks, err := c.getScheduledTasks(50)
	if err != nil {
		return nil, err
	}

	var running []ScheduledTask
	for _, t := range tasks {
		if t.Status == "running" {
			running = append(running, t)
		}
	}
	return running, nil
}

// GetAllScheduledTasks returns ALL task scheduler entries without filtering.
// Returns nil (no error) when the API is unavailable.
func (c *Client) GetAllScheduledTasks() ([]ScheduledTask, error) {
	return c.getScheduledTasks(200)
}

func (c *Client) getScheduledTasks(limit int) ([]ScheduledTask, error) {
	var errs []string

	for _, version := range []int{4, 3, 2, 1} {
		data, err := c.request("SYNO.Core.TaskScheduler", version, "list", url.Values{
			"sort_by":    {"next_trigger_time"},
			"sort_order": {"ASC"},
			"limit":      {fmt.Sprintf("%d", limit)},
			"offset":     {"0"},
		})
		if err != nil {
			errs = append(errs, fmt.Sprintf("v%d list: %v", version, err))
			continue
		}

		var response struct {
			Tasks []ScheduledTask `json:"tasks"`
			Items []ScheduledTask `json:"items"`
			List  []ScheduledTask `json:"list"`
		}
		if err := json.Unmarshal(data, &response); err != nil {
			errs = append(errs, fmt.Sprintf("v%d parse: %v", version, err))
			continue
		}

		tasks := response.Tasks
		if len(tasks) == 0 {
			tasks = response.Items
		}
		if len(tasks) == 0 {
			tasks = response.List
		}
		return tasks, nil
	}

	if len(errs) == 0 {
		return nil, nil
	}
	return nil, fmt.Errorf("scheduled task API unavailable: %s", strings.Join(errs, "; "))
}

// === Hyper Backup API ===

// BackupTask represents a Hyper Backup task.
type BackupTask struct {
	ID               string `json:"task_id"`
	Name             string `json:"task_name"`
	Enabled          bool   `json:"enabled"`
	Status           string `json:"status"`
	LastResult       string `json:"last_result"`
	LastRunTime      string `json:"last_run_time"`
	NextRunTime      string `json:"next_run_time"`
	DestType         string `json:"dest_type"`
	DestName         string `json:"dest_name"`
	TotalBytes       int64  `json:"total_size"`
	TransferredBytes int64  `json:"transferred_size"`
	SpeedBPS         int64  `json:"speed"`
}

// GetHyperBackupTasks tries SYNO.Backup.Task v1 list, then
// SYNO.Core.Backup.Task v1 list. Returns nil/nil if both fail.
func (c *Client) GetHyperBackupTasks() ([]BackupTask, error) {
	var errs []string

	for _, apiSpec := range []struct {
		api     string
		version int
		method  string
	}{
		{"SYNO.Backup.Task", 1, "list"},
		{"SYNO.Core.Backup.Task", 1, "list"},
	} {
		data, err := c.request(apiSpec.api, apiSpec.version, apiSpec.method, url.Values{
			"limit":  {"-1"},
			"offset": {"0"},
		})
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s v%d %s: %v", apiSpec.api, apiSpec.version, apiSpec.method, err))
			continue
		}

		var wrapped struct {
			Tasks []BackupTask `json:"tasks"`
			Items []BackupTask `json:"items"`
			List  []BackupTask `json:"list"`
		}
		if err := json.Unmarshal(data, &wrapped); err != nil {
			errs = append(errs, fmt.Sprintf("%s v%d %s parse: %v", apiSpec.api, apiSpec.version, apiSpec.method, err))
			continue
		}
		tasks := wrapped.Tasks
		if len(tasks) == 0 {
			tasks = wrapped.Items
		}
		if len(tasks) == 0 {
			tasks = wrapped.List
		}
		return tasks, nil
	}

	if len(errs) == 0 {
		return nil, nil
	}
	return nil, fmt.Errorf("hyper backup API unavailable: %s", strings.Join(errs, "; "))
}

// === Snapshot Replication API ===

// SnapshotReplicaTask represents a snapshot replication task.
type SnapshotReplicaTask struct {
	ID           string `json:"task_id"`
	Name         string `json:"task_name"`
	Status       string `json:"status"`
	SrcShareName string `json:"src_share_name"`
	DstShareName string `json:"dst_share_name"`
	DstHost      string `json:"dst_host"`
	LastResult   string `json:"last_result"`
	LastRunTime  string `json:"last_run_time"`
	NextRunTime  string `json:"next_run_time"`
}

// GetSnapshotReplicationTasks tries SYNO.Core.Share.Snapshot.ReplicaTask v1
// list, then the Snapshot Replication package APIs actually advertised on DSM.
// Returns nil/nil if both fail.
func (c *Client) GetSnapshotReplicationTasks() ([]SnapshotReplicaTask, error) {
	var errs []string

	for _, apiSpec := range []struct {
		api     string
		version int
		method  string
	}{
		{"SYNO.DR.Plan", 3, "list"},
		{"SYNO.DR.Plan", 2, "list"},
		{"SYNO.DR.Plan", 1, "list"},
		{"SYNO.DR.Plan.Site", 1, "list"},
		{"SYNO.Core.Share.Snapshot.ReplicaTask", 1, "list"},
		{"SYNO.SynologyDrive.SnapshotReplication", 1, "list"},
		{"SYNO.Replica.Share", 1, "list"},
		{"SYNO.Replica.Volume", 1, "list"},
		{"SYNO.Btrfs.Replica", 1, "list"},
	} {
		data, err := c.request(apiSpec.api, apiSpec.version, apiSpec.method, url.Values{
			"limit":  {"-1"},
			"offset": {"0"},
		})
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s v%d %s: %v", apiSpec.api, apiSpec.version, apiSpec.method, err))
			continue
		}

		tasks, err := parseSnapshotReplicaTasks(data)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s v%d %s parse: %v", apiSpec.api, apiSpec.version, apiSpec.method, err))
			continue
		}
		return tasks, nil
	}

	if len(errs) == 0 {
		return nil, nil
	}
	return nil, fmt.Errorf("snapshot replication API unavailable: %s", strings.Join(errs, "; "))
}

func parseSnapshotReplicaTasks(data []byte) ([]SnapshotReplicaTask, error) {
	var direct struct {
		Tasks []SnapshotReplicaTask `json:"tasks"`
		Items []SnapshotReplicaTask `json:"items"`
		List  []SnapshotReplicaTask `json:"list"`
		Plans []SnapshotReplicaTask `json:"plans"`
	}
	if err := json.Unmarshal(data, &direct); err == nil {
		switch {
		case len(direct.Tasks) > 0:
			return direct.Tasks, nil
		case len(direct.Items) > 0:
			return direct.Items, nil
		case len(direct.List) > 0:
			return direct.List, nil
		case len(direct.Plans) > 0:
			return direct.Plans, nil
		}
	}

	var generic struct {
		Tasks []map[string]interface{} `json:"tasks"`
		Items []map[string]interface{} `json:"items"`
		List  []map[string]interface{} `json:"list"`
		Plans []map[string]interface{} `json:"plans"`
	}
	if err := json.Unmarshal(data, &generic); err != nil {
		return nil, err
	}

	var rawItems []map[string]interface{}
	switch {
	case len(generic.Tasks) > 0:
		rawItems = generic.Tasks
	case len(generic.Items) > 0:
		rawItems = generic.Items
	case len(generic.List) > 0:
		rawItems = generic.List
	case len(generic.Plans) > 0:
		rawItems = generic.Plans
	default:
		return nil, nil
	}

	tasks := make([]SnapshotReplicaTask, 0, len(rawItems))
	for _, item := range rawItems {
		task := SnapshotReplicaTask{
			ID:           firstMapString(item, "task_id", "id", "plan_id", "uuid"),
			Name:         firstMapString(item, "task_name", "name", "plan_name"),
			Status:       firstMapString(item, "status", "state"),
			SrcShareName: firstMapString(item, "src_share_name", "source_share_name", "src_share", "source_share"),
			DstShareName: firstMapString(item, "dst_share_name", "destination_share_name", "dst_share", "target_share"),
			DstHost:      firstMapString(item, "dst_host", "destination_host", "remote_host", "target_host"),
			LastResult:   firstMapString(item, "last_result", "result"),
			LastRunTime:  firstMapString(item, "last_run_time", "last_time", "last_exec_time"),
			NextRunTime:  firstMapString(item, "next_run_time", "next_time", "next_exec_time"),
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func firstMapString(item map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		value, ok := item[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return typed
			}
		case float64:
			return fmt.Sprintf("%.0f", typed)
		case bool:
			if typed {
				return "true"
			}
			return "false"
		default:
			if s := strings.TrimSpace(fmt.Sprint(typed)); s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}
