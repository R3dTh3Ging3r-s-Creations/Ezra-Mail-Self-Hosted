package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/openclaw/gogcli/internal/googleapi"
	"io"
	"net/http"
	"strings"
	"testing"
)

type ezraTransport func(*http.Request) (*http.Response, error)

func (f ezraTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const ezraOwner = "owner@gmail.test"
const ezraEventJSON = `{"id":"event","etag":"\"old\"","status":"confirmed","organizer":{"email":"owner@gmail.test","self":true},"creator":{"email":"owner@gmail.test","self":true}}`

func ezraResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
func TestEzraEventConditionalDelete(t *testing.T) {
	var calls []string
	client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		if len(calls) == 1 {
			return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
		}
		if r.Method == "GET" {
			return ezraResponse(200, ezraEventJSON), nil
		}
		if r.Header.Get("If-Match") != `"old"` || r.URL.Query().Get("sendUpdates") != "none" {
			t.Fatal("missing exact conditional headers")
		}
		return ezraResponse(204, ""), nil
	})}
	result, err := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", "delete", `"old"`)
	if err != nil || result.Status != "deleted" || len(calls) != 3 {
		t.Fatalf("result=%+v err=%v calls=%v", result, err, calls)
	}
}
func TestEzraEventBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name     string
		calendar string
		event    string
		status   int
		want     string
		wantErr  bool
	}{
		{"absent", `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`, "", 404, "absent", false},
		{"shared", `{"id":"owner@gmail.test","primary":true,"accessRole":"reader"}`, ezraEventJSON, 200, "", true},
		{"wrong primary", `{"id":"other@gmail.test","primary":true,"accessRole":"owner"}`, ezraEventJSON, 200, "", true},
		{"redirect", `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`, "", 302, "", true},
		{"error body", `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`, `{"id":"event"}`, 500, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := 0
			client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
				n++
				if n == 1 {
					return ezraResponse(200, tc.calendar), nil
				}
				return ezraResponse(tc.status, tc.event), nil
			})}
			r, e := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", "read", "")
			if (e != nil) != tc.wantErr || r.Status != tc.want {
				t.Fatalf("%+v %v", r, e)
			}
		})
	}
}
func TestEzraEventRejectsUnsupported(t *testing.T) {
	for _, patch := range []map[string]any{{"etag": "not-etag"}, {"id": "other"}, {"attendees": []any{map[string]any{}}}, {"recurrence": []any{}}, {"recurringEventId": "parent"}, {"conferenceData": map[string]any{}}, {"hangoutLink": "https://meet.test"}, {"status": "cancelled"}, {"eventType": "birthday"}, {"organizer": map[string]any{"email": ezraOwner, "self": false}}} {
		var event map[string]any
		_ = json.Unmarshal([]byte(ezraEventJSON), &event)
		for k, v := range patch {
			event[k] = v
		}
		body, _ := json.Marshal(event)
		n := 0
		client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
			n++
			if n == 1 {
				return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
			}
			return ezraResponse(200, string(body)), nil
		})}
		result, err := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", "delete", `"old"`)
		if err != nil || result.Status != "not_dispatched" || n != 2 {
			t.Fatalf("unsafe patch %v: %+v %v calls=%d", patch, result, err, n)
		}
	}
}
func TestEzraEventNoDuplicateDelete(t *testing.T) {
	for _, status := range []int{412, 404, 429, 500, 0} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			n := 0
			client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
				n++
				if n == 1 {
					return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
				}
				if n == 2 {
					return ezraResponse(200, ezraEventJSON), nil
				}
				if status == 0 {
					return nil, errors.New("lost response")
				}
				return ezraResponse(status, `{"error":"private details"}`), nil
			})}
			client.Transport = googleapi.NewRetryTransport(client.Transport)
			result, err := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", "delete", `"old"`)
			if n != 3 {
				t.Fatalf("duplicate dispatch: %d", n)
			}
			if status == 412 {
				if err != nil || result.Status != "precondition_failed" {
					t.Fatal(result, err)
				}
			} else if err == nil {
				t.Fatal("ambiguous delete accepted")
			}
		})
	}
}
func TestEzraEventPreflightAbsenceAndStale(t *testing.T) {
	for _, status := range []int{200, 404} {
		n := 0
		client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
			n++
			if n == 1 {
				return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
			}
			return ezraResponse(status, ezraEventJSON), nil
		})}
		result, err := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", "delete", `"stale"`)
		if err != nil || result.Status != "not_dispatched" || n != 2 {
			t.Fatal(result, err, n)
		}
	}
}

func TestEzraEventCancelledTombstone(t *testing.T) {
	for _, tc := range []struct {
		body    string
		mode    string
		want    string
		wantErr bool
	}{
		{`{"id":"event","status":"cancelled"}`, "read", "absent", false},
		{`{"id":"event","status":"cancelled"}`, "delete", "not_dispatched", false},
		{`{"id":"wrong","status":"cancelled"}`, "read", "", true},
		{`{"id":"event","status":"cancelled","recurringEventId":"series"}`, "read", "", true},
		{`{"id":"event","status":"cancelled","originalStartTime":{}}`, "read", "", true},
	} {
		n := 0
		client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
			n++
			if n == 1 {
				return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
			}
			return ezraResponse(200, tc.body), nil
		})}
		revision := ""
		if tc.mode == "delete" {
			revision = `"old"`
		}
		result, err := ezraExactEvent(context.Background(), client, ezraOwner, ezraOwner, "event", tc.mode, revision)
		if (err != nil) != tc.wantErr || result.Status != tc.want || n != 2 {
			t.Fatalf("%s: %+v %v requests=%d", tc.body, result, err, n)
		}
	}
}

func TestEzraEventConditionalUpdate(t *testing.T) {
	patch := []byte(`{"summary":"After","description":"","reminders":{"useDefault":false,"overrides":[]}}`)
	digest := sha256.Sum256(patch)
	hash := hex.EncodeToString(digest[:])
	n := 0
	client := &http.Client{Transport: ezraTransport(func(r *http.Request) (*http.Response, error) {
		n++
		if n == 1 {
			return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
		}
		if n == 2 {
			return ezraResponse(200, ezraEventJSON), nil
		}
		body, _ := io.ReadAll(r.Body)
		if r.Method != "PATCH" || r.Header.Get("If-Match") != `"old"` || r.Header.Get("Content-Type") != "application/json" || r.URL.Query().Get("sendUpdates") != "none" || string(body) != string(patch) {
			t.Fatal("unbound update")
		}
		return ezraResponse(200, strings.Replace(ezraEventJSON, `\"old\"`, `\"new\"`, 1)), nil
	})}
	result, err := ezraExactEventPatch(context.Background(), client, ezraOwner, ezraOwner, "event", "update", `"old"`, patch, hash)
	if err != nil || result.Status != "updated" || result.Protocol != "ezra-event-update-v1" || result.PatchSha256 != hash || result.Raw["etag"] != `"new"` || n != 3 {
		t.Fatal(result, err, n)
	}
}
func TestEzraEventUpdatePayloadBoundaries(t *testing.T) {
	invalidUTF8 := "{\"summary\":\"" + string([]byte{0xff}) + "\"}"
	for _, body := range []string{invalidUTF8, `{}`, `{"attendees":[]}`, `{"summary":""}`, `{"reminders":{"useDefault":false,"overrides":[{"method":"email","minutes":5}]}}`, `{"visibility":"secret"}`, `{"start":{"date":"2026-02-30"},"end":{"date":"2026-03-01"}}`, `{"start":{"dateTime":"2026-10-01T10:00:00Z","timeZone":"UTC"}}`, `{"summary":"A","summary":"B"}`} {
		patch := []byte(body)
		digest := sha256.Sum256(patch)
		n := 0
		client := &http.Client{Transport: ezraTransport(func(*http.Request) (*http.Response, error) {
			n++
			return nil, errors.New("unexpected provider request")
		})}
		_, err := ezraExactEventPatch(context.Background(), client, ezraOwner, ezraOwner, "event", "update", `"old"`, patch, hex.EncodeToString(digest[:]))
		if err == nil || n != 0 {
			t.Fatalf("accepted invalid patch %s requests=%d", body, n)
		}
	}
}
func TestEzraEventUpdateNoRetry(t *testing.T) {
	for _, status := range []int{412, 429, 500, 0} {
		patch := []byte(`{"summary":"After"}`)
		digest := sha256.Sum256(patch)
		n := 0
		client := &http.Client{Transport: ezraTransport(func(*http.Request) (*http.Response, error) {
			n++
			if n == 1 {
				return ezraResponse(200, `{"id":"owner@gmail.test","primary":true,"accessRole":"owner"}`), nil
			}
			if n == 2 {
				return ezraResponse(200, ezraEventJSON), nil
			}
			if status == 0 {
				return nil, errors.New("lost")
			}
			return ezraResponse(status, `{"error":"sensitive"}`), nil
		})}
		client.Transport = googleapi.NewRetryTransport(client.Transport)
		result, err := ezraExactEventPatch(context.Background(), client, ezraOwner, ezraOwner, "event", "update", `"old"`, patch, hex.EncodeToString(digest[:]))
		if n != 3 {
			t.Fatalf("redispatched: %d", n)
		}
		if status == 412 {
			if err != nil || result.Status != "precondition_failed" {
				t.Fatal(result, err)
			}
		} else if err == nil {
			t.Fatal("uncertain update accepted")
		}
	}
}
