package executor

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"hash"
)

type boundedDigestWriter struct {
	hash   hash.Hash
	buffer bytes.Buffer
	limit  int64
	total  int64
}

func newBoundedDigestWriter(limit int64) *boundedDigestWriter {
	return &boundedDigestWriter{
		hash:  sha256.New(),
		limit: limit,
	}
}

func (writer *boundedDigestWriter) Write(data []byte) (int, error) {
	_, _ = writer.hash.Write(data)
	writer.total += int64(len(data))

	remaining := writer.limit - int64(writer.buffer.Len())
	if remaining > 0 {
		capture := data
		if int64(len(capture)) > remaining {
			capture = capture[:remaining]
		}
		_, _ = writer.buffer.Write(capture)
	}
	return len(data), nil
}

func (writer *boundedDigestWriter) base64() string {
	if writer.buffer.Len() == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(writer.buffer.Bytes())
}

func (writer *boundedDigestWriter) sha256() string {
	return "sha256:" + hex.EncodeToString(writer.hash.Sum(nil))
}

func (writer *boundedDigestWriter) truncated() bool {
	return writer.total > int64(writer.buffer.Len())
}
