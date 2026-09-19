package graphexecutor

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type SyntheticSpec struct {
	DelayMillis   int    `json:"delay_ms,omitempty"`
	Result        string `json:"result,omitempty"`
	Fail          bool   `json:"fail,omitempty"`
	WaitForCancel bool   `json:"wait_for_cancel,omitempty"`
}

func RunSynthetic(ctx context.Context, envelope Envelope) ([]byte, error) {
	var spec SyntheticSpec
	if err := json.Unmarshal(envelope.ExecutionSpec, &spec); err != nil {
		return nil, err
	}
	if spec.WaitForCancel {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if spec.DelayMillis > 0 {
		timer := time.NewTimer(time.Duration(spec.DelayMillis) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	if spec.Fail {
		return nil, errors.New("synthetic execution failure")
	}
	return []byte(spec.Result), nil
}
