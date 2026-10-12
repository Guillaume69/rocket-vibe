package engine

import (
	"context"
	"sync"
)

// An unbounded first-in first-out queue of whatsmeow events: pushing never
// blocks whatsmeow, one goroutine handles them in order.
type eventQueue struct {
	mu    sync.Mutex
	ready *sync.Cond
	items []any
	done  bool
}

func newEventQueue() *eventQueue {
	q := &eventQueue{}
	q.ready = sync.NewCond(&q.mu)
	return q
}

func (q *eventQueue) push(evt any) {
	q.mu.Lock()
	q.items = append(q.items, evt)
	q.mu.Unlock()
	q.ready.Signal()
}

// Handles the events until the context ends; what is left then is dropped.
func (q *eventQueue) run(ctx context.Context, handle func(any)) {
	go func() {
		<-ctx.Done()
		q.mu.Lock()
		q.done = true
		q.mu.Unlock()
		q.ready.Broadcast()
	}()
	for {
		q.mu.Lock()
		for len(q.items) == 0 && !q.done {
			q.ready.Wait()
		}
		if q.done {
			q.mu.Unlock()
			return
		}
		evt := q.items[0]
		q.items[0] = nil
		q.items = q.items[1:]
		q.mu.Unlock()
		handle(evt)
	}
}
