package engine

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// An opt-in diagnostic log for a live problem: `RV_WHATSAPP_LOG=<file>` in
// the app's environment. It records connection states, event kinds and
// errors, whatsmeow's own information-level log included, never a message's
// text, a key or a QR. Off by default.
type fileLog struct {
	module string
	out    *os.File
	mu     *sync.Mutex
	dumped *atomic.Bool
}

func openDiagnostics() waLog.Logger {
	path := os.Getenv("RV_WHATSAPP_LOG")
	if path == "" {
		return waLog.Noop
	}
	out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return waLog.Noop
	}
	return &fileLog{module: "rv", out: out, mu: &sync.Mutex{}, dumped: &atomic.Bool{}}
}

func (l *fileLog) write(level, msg string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.out, "%s [%s %s] %s\n", time.Now().Format("15:04:05.000"), l.module, level, fmt.Sprintf(msg, args...))
}

func (l *fileLog) Warnf(msg string, args ...any) {
	l.write("WARN", msg, args...)
	// A handler stuck: where every goroutine waits, by function name only.
	if strings.HasPrefix(msg, "Node handling is taking long") && !l.dumped.Swap(true) {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		l.mu.Lock()
		fmt.Fprintf(l.out, "--- goroutines ---\n%s\n--- end ---\n", stackOnly(buf[:n]))
		l.mu.Unlock()
	}
}

// A goroutine dump without its argument values (pointers, lengths).
func stackOnly(dump []byte) string {
	var out strings.Builder
	for _, line := range strings.Split(string(dump), "\n") {
		if i := strings.Index(line, "("); i > 0 && !strings.HasPrefix(line, "\t") && !strings.HasPrefix(line, "goroutine") {
			line = line[:i] + "(...)"
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return out.String()
}

func (l *fileLog) Errorf(msg string, args ...any) { l.write("ERROR", msg, args...) }
func (l *fileLog) Infof(msg string, args ...any)  { l.write("INFO", msg, args...) }

// whatsmeow's debug level logs whole protocol nodes: never written here.
func (l *fileLog) Debugf(string, ...any) {}
func (l *fileLog) Sub(module string) waLog.Logger {
	return &fileLog{module: l.module + "/" + module, out: l.out, mu: l.mu, dumped: l.dumped}
}
