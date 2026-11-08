package observability

import (
	"regexp"
	"testing"
)

func TestTraceGenerationAndLegacyReplay(t *testing.T) {
	trace := NewTrace()
	child := trace.Child()
	if trace.TraceID != child.TraceID || trace.SpanID == child.SpanID {
		t.Fatal("Child span must retain trace identity")
	}
	if !regexp.MustCompile(`^00-[a-f0-9]{32}-[a-f0-9]{16}-01$`).MatchString(child.Header()) {
		t.Fatal("Invalid traceparent")
	}
	first, replay := LegacyTrace("event"), LegacyTrace("event")
	if *first != *replay {
		t.Fatal("Legacy spool retry changed trace identity")
	}
	if *first == *LegacyTrace("other-event") {
		t.Fatal("Unrelated legacy events share a trace")
	}
}
