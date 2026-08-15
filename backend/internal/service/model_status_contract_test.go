package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestModelStatusWireFormatContainsOnlyRawSlotCounters(t *testing.T) {
	payload, err := json.Marshal(ModelStatusSnapshot{
		Model: "gpt-test", Window: "24h", SlotSeconds: 3600,
		Total: 3, Success: 2, Failure: 1,
		Slots: []ModelStatusSlot{{Timestamp: 1700000000, Total: 3, Success: 2, Failure: 1}},
	})
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	encoded := string(payload)
	for _, redundant := range []string{"status", "success_rate", "current_status", "start_time", "end_time", "display_name"} {
		if strings.Contains(encoded, redundant) {
			t.Fatalf("compact payload contains derived field %q: %s", redundant, encoded)
		}
	}
	for _, required := range []string{`"t":1700000000`, `"n":3`, `"ok":2`, `"fail":1`} {
		if !strings.Contains(encoded, required) {
			t.Fatalf("compact payload missing %s: %s", required, encoded)
		}
	}
}
