package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/openclaw/gogcli/internal/googleapi"
)

// This command intentionally has no URL, header, selector, or bulk options.
type CalendarEzraEventCmd struct {
	CalendarID  string `arg:"" name:"calendarId" help:"Exact owned primary calendar email"`
	EventID     string `arg:"" name:"eventId" help:"Exact event ID"`
	Mode        string `name:"mode" required:"" enum:"read,delete,update" help:"Read or conditionally modify this event"`
	IfMatch     string `name:"if-match" help:"Exact opaque event ETag required for a mutation"`
	PatchStdin  bool   `name:"patch-stdin" help:"Read a bounded update patch from stdin"`
	PatchSha256 string `name:"patch-sha256" help:"Exact SHA256 of update stdin bytes"`
}
type ezraEventResult struct {
	Protocol    string         `json:"protocol"`
	Account     string         `json:"account"`
	CalendarID  string         `json:"calendarId"`
	EventID     string         `json:"eventId"`
	Mode        string         `json:"mode"`
	IfMatch     string         `json:"ifMatch"`
	Status      string         `json:"status"`
	Raw         map[string]any `json:"raw,omitempty"`
	PatchSha256 string         `json:"patchSha256,omitempty"`
}

var errEzraEvent = errors.New("exact calendar event operation unavailable")
var ezraETag = regexp.MustCompile(`^(W/)?"[^"\x00-\x1f\x7f]+"$`)

func (c *CalendarEzraEventCmd) Run(ctx context.Context, flags *RootFlags) error {
	if flags == nil || !flags.JSON || !flags.NoInput || flags.DryRun || flags.ResultsOnly || flags.Select != "" || flags.WrapUntrusted || hasDirectAccessToken(flags) || isADCAuthMode(flags) || ((c.Mode == "delete" || c.Mode == "update") && (!flags.Force || flags.ReadOnly)) {
		return errEzraEvent
	}
	var patch []byte
	if c.Mode == "update" {
		if !c.PatchStdin {
			return errEzraEvent
		}
		var err error
		patch, err = io.ReadAll(io.LimitReader(os.Stdin, 65_537))
		if err != nil || !ezraValidPatch(patch, c.PatchSha256) {
			return errEzraEvent
		}
	} else if c.PatchStdin || c.PatchSha256 != "" {
		return errEzraEvent
	}
	account, err := requireAccount(flags)
	if err != nil || account != flags.Account {
		return errEzraEvent
	}
	client, err := calendarHTTPClient(ctx, account)
	if err != nil {
		return errEzraEvent
	}
	result, err := ezraExactEventPatch(ctx, client, account, c.CalendarID, c.EventID, c.Mode, c.IfMatch, patch, c.PatchSha256)
	if err != nil {
		return errEzraEvent
	}
	return json.NewEncoder(stdoutWriter(ctx)).Encode(result)
}
func ezraExactEvent(ctx context.Context, original *http.Client, account, calendarID, eventID, mode, revision string) (ezraEventResult, error) {
	return ezraExactEventPatch(ctx, original, account, calendarID, eventID, mode, revision, nil, "")
}
func ezraExactEventPatch(ctx context.Context, original *http.Client, account, calendarID, eventID, mode, revision string, patch []byte, patchHash string) (ezraEventResult, error) {
	result := ezraEventResult{Protocol: "ezra-event-v1", Account: account, CalendarID: calendarID, EventID: eventID, Mode: mode, IfMatch: revision}
	if mode == "update" {
		result.Protocol = "ezra-event-update-v1"
		result.PatchSha256 = patchHash
		if !ezraValidPatch(patch, patchHash) {
			return result, errEzraEvent
		}
	} else if len(patch) != 0 || patchHash != "" {
		return result, errEzraEvent
	}
	address, err := mail.ParseAddress(account)
	if err != nil || address.Address != account || !strings.EqualFold(calendarID, account) || !ezraExactID(eventID) || (mode != "read" && mode != "delete" && mode != "update") || (mode == "read" && revision != "") || (mode != "read" && !ezraValidETag(revision)) || original == nil {
		return result, errEzraEvent
	}
	ctx, cancel := context.WithTimeout(googleapi.WithoutRetries(ctx), 110*time.Second)
	defer cancel()
	client := *original
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errEzraEvent }
	primary, status, err := ezraRequest(ctx, &client, "GET", "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary", "")
	if err != nil || status != 200 || primary["primary"] != true || primary["accessRole"] != "owner" {
		return result, errEzraEvent
	}
	id, ok := primary["id"].(string)
	if !ok || !strings.EqualFold(id, account) || id != calendarID {
		return result, errEzraEvent
	}
	endpoint := "https://www.googleapis.com/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events/" + url.PathEscape(eventID)
	raw, status, err := ezraRequest(ctx, &client, "GET", endpoint, "")
	if err != nil {
		return result, errEzraEvent
	}
	if status == 404 {
		if mode == "read" {
			result.Status = "absent"
		} else {
			result.Status = "not_dispatched"
		}
		return result, nil
	}
	if status != 200 {
		return result, errEzraEvent
	}
	if raw["status"] == "cancelled" && raw["id"] == eventID {
		recurrence := false
		for _, key := range []string{"recurrence", "recurringEventId", "originalStartTime"} {
			if _, ok := raw[key]; ok {
				recurrence = true
			}
		}
		if !recurrence {
			if mode == "read" {
				result.Status = "absent"
			} else {
				result.Status = "not_dispatched"
			}
			return result, nil
		}
	}
	if !ezraSupportedEvent(raw, account, eventID) {
		if mode != "read" {
			result.Status = "not_dispatched"
			return result, nil
		}
		return result, errEzraEvent
	}
	if mode == "read" {
		result.Status = "found"
		result.Raw = raw
		return result, nil
	}
	if raw["etag"] != revision {
		result.Status = "not_dispatched"
		return result, nil
	}
	if mode == "update" {
		var body map[string]any
		_ = json.Unmarshal(patch, &body)
		if raw["locked"] == true || raw["endTimeUnspecified"] == true || raw["originalStartTime"] != nil {
			result.Status = "not_dispatched"
			return result, nil
		}
		if start, ok := body["start"].(map[string]any); ok {
			beforeStart, ok := raw["start"].(map[string]any)
			if !ok || (start["date"] != nil) != (beforeStart["date"] != nil) {
				result.Status = "not_dispatched"
				return result, nil
			}
		}
		updated, status, err := ezraRequestBody(ctx, &client, "PATCH", endpoint+"?sendUpdates=none", revision, patch)
		if err != nil {
			return result, errEzraEvent
		}
		if status == 412 {
			result.Status = "precondition_failed"
			return result, nil
		}
		if status != 200 || !ezraSupportedEvent(updated, account, eventID) || updated["etag"] == revision {
			return result, errEzraEvent
		}
		result.Status = "updated"
		result.Raw = updated
		return result, nil
	}
	_, status, err = ezraRequest(ctx, &client, "DELETE", endpoint+"?sendUpdates=none", revision)
	if err != nil {
		return result, errEzraEvent
	}
	if status == 412 {
		result.Status = "precondition_failed"
		return result, nil
	}
	if status != 204 {
		return result, errEzraEvent
	}
	result.Status = "deleted"
	return result, nil
}
func ezraExactID(id string) bool {
	if len(id) == 0 || len(id) > 1024 || strings.Contains(id, "*") {
		return false
	}
	for _, r := range id {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func ezraValidETag(value string) bool { return len(value) <= 2048 && ezraETag.MatchString(value) }
func ezraSupportedEvent(raw map[string]any, account, id string) bool {
	etag, ok := raw["etag"].(string)
	if !ok || !ezraValidETag(etag) || raw["id"] != id || raw["status"] != "confirmed" {
		return false
	}
	for _, key := range []string{"organizer", "creator"} {
		who, ok := raw[key].(map[string]any)
		if !ok || who["self"] != true {
			return false
		}
		email, ok := who["email"].(string)
		if !ok || !strings.EqualFold(email, account) {
			return false
		}
	}
	for _, key := range []string{"recurrence", "recurringEventId", "conferenceData", "hangoutLink"} {
		if _, ok := raw[key]; ok {
			return false
		}
	}
	if kind, ok := raw["eventType"]; ok && kind != "default" {
		return false
	}
	if value, ok := raw["attendees"]; ok {
		attendees, ok := value.([]any)
		if !ok || len(attendees) != 0 {
			return false
		}
	}
	return true
}
func ezraRequest(ctx context.Context, client *http.Client, method, endpoint, revision string) (map[string]any, int, error) {
	return ezraRequestBody(ctx, client, method, endpoint, revision, nil)
}
func ezraRequestBody(ctx context.Context, client *http.Client, method, endpoint, revision string, body []byte) (map[string]any, int, error) {
	var input io.Reader
	if body != nil {
		input = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, input)
	if err != nil {
		return nil, 0, errEzraEvent
	}
	if revision != "" {
		req.Header.Set("If-Match", revision)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, errEzraEvent
	}
	defer res.Body.Close()
	// Status codes are evidence; provider error bodies never enter output or logs.
	if res.StatusCode != 200 {
		return nil, res.StatusCode, nil
	}
	body, err = io.ReadAll(io.LimitReader(res.Body, 4_194_305))
	if err != nil || len(body) > 4_194_304 {
		return nil, 0, errEzraEvent
	}
	var raw map[string]any
	if json.Unmarshal(body, &raw) != nil || raw == nil {
		return nil, 0, errEzraEvent
	}
	return raw, res.StatusCode, nil
}

// Reject duplicate JSON names before validation; ambiguous payloads cannot bind a receipt.
func ezraPatchValue(dec *json.Decoder, depth int) (any, error) {
	if depth > 12 {
		return nil, errEzraEvent
	}
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); ok {
		switch delim {
		case '{':
			value := map[string]any{}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, err
				}
				name, ok := key.(string)
				if !ok {
					return nil, errEzraEvent
				}
				if _, exists := value[name]; exists {
					return nil, errEzraEvent
				}
				item, err := ezraPatchValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				value[name] = item
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim('}') {
				return nil, errEzraEvent
			}
			return value, nil
		case '[':
			value := []any{}
			for dec.More() {
				item, err := ezraPatchValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				value = append(value, item)
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim(']') {
				return nil, errEzraEvent
			}
			return value, nil
		default:
			return nil, errEzraEvent
		}
	}
	return token, nil
}
func ezraPatchBoundary(value any) (time.Time, bool, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return time.Time{}, false, false
	}
	if date, ok := object["date"].(string); ok {
		parsed, err := time.Parse("2006-01-02", date)
		return parsed, true, err == nil && len(object) == 1
	}
	instant, ok := object["dateTime"].(string)
	if !ok {
		return time.Time{}, false, false
	}
	zone, ok := object["timeZone"].(string)
	if !ok || len(zone) > 100 || zone == "" || len(object) != 2 {
		return time.Time{}, false, false
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return time.Time{}, false, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, instant)
	return parsed, false, err == nil
}
func ezraValidPatch(input []byte, hash string) bool {
	if len(input) == 0 || len(input) > 65_536 || !utf8.Valid(input) {
		return false
	}
	digest := sha256.Sum256(input)
	if hex.EncodeToString(digest[:]) != hash {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(input))
	value, err := ezraPatchValue(dec, 0)
	if err != nil {
		return false
	}
	if _, err := dec.Token(); err != io.EOF {
		return false
	}
	body, ok := value.(map[string]any)
	if !ok || len(body) == 0 {
		return false
	}
	for key, value := range body {
		switch key {
		case "summary", "description", "location":
			text, ok := value.(string)
			if !ok {
				return false
			}
			limit := 10_000
			if key == "summary" {
				limit = 300
				if strings.TrimSpace(text) == "" {
					return false
				}
			}
			if key == "location" {
				limit = 500
			}
			if utf8.RuneCountInString(text) > limit {
				return false
			}
		case "visibility":
			if value != "default" && value != "private" && value != "public" {
				return false
			}
		case "transparency":
			if value != "opaque" && value != "transparent" {
				return false
			}
		case "start", "end": // Validate together below.
		case "reminders":
			reminders, ok := value.(map[string]any)
			if !ok {
				return false
			}
			useDefault, ok := reminders["useDefault"].(bool)
			if !ok {
				return false
			}
			if useDefault {
				if len(reminders) != 1 {
					return false
				}
			} else {
				overrides, ok := reminders["overrides"].([]any)
				if !ok || len(reminders) != 2 || len(overrides) > 1 {
					return false
				}
				for _, item := range overrides {
					popup, ok := item.(map[string]any)
					if !ok || len(popup) != 2 || popup["method"] != "popup" {
						return false
					}
					minutes, ok := popup["minutes"].(float64)
					if !ok || minutes < 0 || minutes > 40320 || minutes != float64(int(minutes)) {
						return false
					}
				}
			}
		default:
			return false
		}
	}
	start, hasStart := body["start"]
	end, hasEnd := body["end"]
	if hasStart != hasEnd {
		return false
	}
	if hasStart {
		a, allDayA, ok := ezraPatchBoundary(start)
		if !ok {
			return false
		}
		b, allDayB, ok := ezraPatchBoundary(end)
		if !ok || allDayA != allDayB || !a.Before(b) {
			return false
		}
	}
	return true
}
