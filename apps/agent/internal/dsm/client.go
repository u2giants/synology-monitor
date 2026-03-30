package dsm

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	c.mu.Lock()
	sid := c.sid
	c.mu.Unlock()

	if sid == "" {
		if err := c.Login(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		sid = c.sid
		c.mu.Unlock()
	}

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
	CPU     CPUInfo     `json:"cpu"`
	Memory  MemoryInfo  `json:"memory"`
	Network []NetInfo   `json:"network"`
}

type CPUInfo struct {
	FifteenMinLoad int `json:"15min_load"`
	FiveMinLoad    int `json:"5min_load"`
	OneMinLoad     int `json:"1min_load"`
	SystemLoad     int `json:"system_load"`
	UserLoad       int `json:"user_load"`
}

type MemoryInfo struct {
	AvailReal  int `json:"avail_real"`
	AvailSwap  int `json:"avail_swap"`
	TotalReal  int `json:"total_real"`
	TotalSwap  int `json:"total_swap"`
	RealUsage  int `json:"real_usage"`
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
	ID        string     `json:"id"`
	VolPath   string     `json:"vol_path"`
	Status    string     `json:"status"`
	TotalSize int64      `json:"total_size"`
	UsedSize  int64      `json:"used_size"`
	FsType    string     `json:"fs_type"`
	RaidType  string     `json:"raid_type"`
	Container string     `json:"container"`
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
	ID        string `json:"id"`
	Name      string `json:"name"`
	Image     string `json:"image"`
	Status    string `json:"status"`
	State     string `json:"state"`
	UpTime    int64  `json:"up_time"`
	CPUUsage  float64
	MemUsage  int64
	MemLimit  int64
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

// === System Info ===

type SystemInfo struct {
	Model      string `json:"model"`
	RAMSize    int    `json:"ram_size"`
	Serial     string `json:"serial"`
	Temperature int   `json:"temperature"`
	Uptime     int64  `json:"uptime"`
	FirmwareVer string `json:"firmware_ver"`
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
