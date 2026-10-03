// blip_stub: the resampler mGBA's audio code feeds, doing nothing. gba-pane
// has no audio path, and the real one (blip_buf) is LGPL, so it is not
// vendored. A buffer always reports zero samples, which mGBA's audio code
// handles as "nothing produced yet" when no sync or stream is attached.

#include <stdlib.h>
#include <mgba/core/blip_buf.h>

blip_t *blip_new(int sample_count)
{
    (void)sample_count;
    return (blip_t *)calloc(1, 16); // never NULL in practice: callers keep the pointer
}

void blip_set_rates(blip_t *buf, double clock_rate, double sample_rate)
{
    (void)buf, (void)clock_rate, (void)sample_rate;
}

void blip_clear(blip_t *buf)
{
    (void)buf;
}

void blip_add_delta(blip_t *buf, unsigned int clock_time, int delta)
{
    (void)buf, (void)clock_time, (void)delta;
}

void blip_add_delta_fast(blip_t *buf, unsigned int clock_time, int delta)
{
    (void)buf, (void)clock_time, (void)delta;
}

int blip_clocks_needed(const blip_t *buf, int sample_count)
{
    (void)buf, (void)sample_count;
    return 0;
}

void blip_end_frame(blip_t *buf, unsigned int clock_duration)
{
    (void)buf, (void)clock_duration;
}

int blip_samples_avail(const blip_t *buf)
{
    (void)buf;
    return 0;
}

int blip_read_samples(blip_t *buf, short out[], int count, int stereo)
{
    (void)buf, (void)out, (void)count, (void)stereo;
    return 0;
}

void blip_delete(blip_t *buf)
{
    free(buf);
}
