/* gba-pane: a silent stand-in for the band-limited resampler mGBA's audio
 * code calls. Written for gba-pane (MIT, see the mod's LICENSE); it declares
 * the same functions and constants mGBA uses, so <mgba/core/blip_buf.h>
 * resolves here (native/mgba-shim comes first on the include path) and
 * native/blip_stub.c answers every call without producing any sound. */
#ifndef GBA_PANE_BLIP_BUF_H
#define GBA_PANE_BLIP_BUF_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct blip_t blip_t;

enum { blip_max_ratio = 0x100000 };
enum { blip_max_frame = 4000 };

blip_t *blip_new(int sample_count);
void blip_set_rates(blip_t *buf, double clock_rate, double sample_rate);
void blip_clear(blip_t *buf);
void blip_add_delta(blip_t *buf, unsigned int clock_time, int delta);
void blip_add_delta_fast(blip_t *buf, unsigned int clock_time, int delta);
int blip_clocks_needed(const blip_t *buf, int sample_count);
void blip_end_frame(blip_t *buf, unsigned int clock_duration);
int blip_samples_avail(const blip_t *buf);
int blip_read_samples(blip_t *buf, short out[], int count, int stereo);
void blip_delete(blip_t *buf);

typedef blip_t blip_buffer_t;

#ifdef __cplusplus
}
#endif

#endif
