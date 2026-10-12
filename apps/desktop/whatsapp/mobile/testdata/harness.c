// Drives librv_whatsapp.so as Kotlin does, for mobile_test.go.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "librv_whatsapp.h"

static int frames = 0;
static void on_frame(int64_t handle, const char *frame) {
	frames++;
	printf("%lld %s\n", (long long)handle, frame);
	fflush(stdout);
}

int main(int argc, char **argv) {
	uint8_t key[32];
	memset(key, 7, sizeof key);
	int64_t h = rvwa_open(argv[1], key, 32, on_frame);
	int64_t busy = rvwa_open(argv[1], key, 32, on_frame);
	int64_t wrong = rvwa_open(argv[1], key, 31, on_frame);
	printf("open %lld busy %lld wrong %lld\n", (long long)h, (long long)busy, (long long)wrong);
	int running = rvwa_handle(h, "{\"type\":\"replay\"}");
	int stopped = rvwa_handle(h, "{\"type\":\"stop\"}");
	int unknown = rvwa_handle(999, "{\"type\":\"stop\"}");
	rvwa_close(h);
	rvwa_close(h);
	printf("running %d stopped %d unknown %d frames %d\n", running, stopped, unknown, frames);
	return h > 0 && busy == -1 && wrong == -2 && running == 1 && stopped == 0 && unknown == 0 && frames > 0 ? 0 : 1;
}
