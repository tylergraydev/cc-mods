// nes-cc: a headless NES (agnes) for the Claude Code nes-pane mod.
//
//   nes-cc.exe -rom <path> -ctrl <control file> [-sav <dir>]
//
// Video: each frame (256x224, the 8-line overscan cropped top and bottom) is
// box-filtered down to the pane's cells and packed as little-endian u32
// triplets [glyph, fg 0x00RRGGBB, bg], base64 encoded, one line per frame on
// stdout: "\x01F <cols> <rows> <base64>\n" (doom-pane's format exactly).
//
// Input: the mod rewrites a control file with lines
//   size <cols> <rows>       8..512 x 4..256
//   mode play|pause
//   hd on|off                2x2 quadrant pixels a cell, or 1x2 half blocks
//   window on|off            also show the game in a window of its own
//   k <seq> <button>         a key-down; up down left right a b start select
//   h <seq> <button> 1|0     latch / unlatch a button
//   save <seq> <slot>        1..9
//   load <seq> <slot>
//   quit
//   end
// The file is polled every few ms; a file without its "end" line is ignored
// (caught mid-write). Lines with a sequence number act once, when their number
// is past the last one seen. The terminal reports no key-ups, so holds are
// synthesized with timeouts (see pressKey).
//
// Besides frames, stdout carries status lines "\x01S <text>\n":
//   ready mapper <n> battery <0|1>, error <text>, play, input, window off,
//   saved <slot>, loaded <slot>, nostate <slot>, stateerror <slot> <text>
// Logs go to stderr as "nes-cc: ...".

#include "agnes.c"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>
#include <direct.h>
#include <windows.h>
#include <mmsystem.h>

#define SRC_W 256
#define SRC_H 224
#define OVERSCAN 8
#define MAX_COLS 512
#define MAX_ROWS 256
#define POLL_MS 8
#define WARMUP_FRAMES 45
#define MAX_ROM (4 * 1024 * 1024)
#define FRAME_PERIOD_MS (1000.0 / 60.0988)

#define DIR_FIRST_MS 420
#define DIR_REPEAT_MS 110
#define BTN_FIRST_MS 180
#define BTN_REPEAT_MS 110
#define TAP_MS 100
#define MIN_HOLD_FRAMES 2

// Box filter keeps HUD text legible; define NEAREST for nearest-neighbour.
/* #define NEAREST 1 */

enum { BTN_A, BTN_B, BTN_SELECT, BTN_START, BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_COUNT };
static const char *BUTTON_NAMES[BTN_COUNT] = {"a", "b", "select", "start", "up", "down", "left", "right"};

int CCW_IsOpen(void);
void CCW_Open(void);
void CCW_Close(void);
void CCW_SetTitle(const char *title);
void CCW_Present(void);
void CCW_Pump(void);
int CC_PadPoll(void);

// The picture the pane and the window draw from, 0x00RRGGBB, top-down.
uint32_t cc_rgb[SRC_W * SRC_H];

static agnes_t *s_agnes;
static unsigned char *s_rom;
static size_t s_romSize;
static uint32_t s_romCrc;
static int s_mapper;
static int s_hasBattery; // battery RAM this helper keeps (mappers 1 and 4)
static char s_savPath[MAX_PATH], s_statePrefix[MAX_PATH];
static uint8_t s_lastSram[8 * 1024];

static const char *s_ctrlPath;
static int s_cols = 80, s_rows = 30;
static int s_paused = 0;    // in effect: the game stands still
static int s_wantPause = 0; // as the control file asks
static int s_framesSent = 0;
static int s_quadrants = 1;
static int s_wantWindow = 0;
static int s_forceFrame = 0;
static int s_lastSeq = 0;
static LARGE_INTEGER s_freq, s_start;

// Synthesized holds: release deadline per button (0 when up), latches, and how
// many emulated frames each has been down (a press lasts at least 2).
static double s_releaseAt[BTN_COUNT];
static int s_latched[BTN_COUNT];
static int s_heldFrames[BTN_COUNT];
// Which of two opposite directions was pressed last wins.
static unsigned s_stamp[BTN_COUNT], s_stampNext = 1;
static int s_padMask, s_windowMask, s_lastExternal;
static int s_windowSwallowed;

static double realMs(void)
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return (double)(now.QuadPart - s_start.QuadPart) * 1000.0 / (double)s_freq.QuadPart;
}

/* ---------------------------------------------------------------- crc32 */

static uint32_t crc32(const unsigned char *p, size_t n)
{
    static uint32_t table[256];
    if (!table[1])
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++)
                c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++)
        c = table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

/* ---------------------------------------------------------------- output */

static void writeBattery(int force);

static void quitNow(int code)
{
    writeBattery(0);
    fflush(stdout);
    exit(code);
}

static void emitLine(const char *text)
{
    fprintf(stdout, "\001S %s\n", text);
    if (fflush(stdout) != 0)
        quitNow(0); // the mod went away
}

static void fail(int code, const char *text)
{
    char line[600];
    snprintf(line, sizeof line, "error %s", text);
    fprintf(stderr, "nes-cc: %s\n", line);
    emitLine(line);
    exit(code);
}

/* ---------------------------------------------------------------- files */

static void mkdirs(const char *path)
{
    char buf[MAX_PATH];
    snprintf(buf, sizeof buf, "%s", path);
    for (char *p = buf; *p; p++) {
        if ((*p == '\\' || *p == '/') && p > buf && p[-1] != ':') {
            char c = *p;
            *p = 0;
            _mkdir(buf);
            *p = c;
        }
    }
    _mkdir(buf);
}

// Writes the whole file through a temporary one, so a crash never leaves half.
static int writeFileAtomic(const char *path, const void *a, size_t na, const void *b, size_t nb)
{
    char tmp[MAX_PATH + 8];
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f)
        return 0;
    int ok = fwrite(a, 1, na, f) == na && (!nb || fwrite(b, 1, nb, f) == nb);
    ok = fclose(f) == 0 && ok;
    if (!ok || !MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileA(tmp);
        return 0;
    }
    return 1;
}

static unsigned char *readFile(const char *path, size_t limit, size_t *size)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    unsigned char *buf = (unsigned char *)malloc(limit + 1);
    size_t n = buf ? fread(buf, 1, limit + 1, f) : 0;
    fclose(f);
    if (!buf || n > limit) {
        free(buf);
        return NULL;
    }
    *size = n;
    return buf;
}

/* ---------------------------------------------------------------- battery */

static uint8_t *sram(void)
{
    if (s_mapper == 1)
        return s_agnes->mapper.m1.prg_ram;
    if (s_mapper == 4)
        return s_agnes->mapper.m4.prg_ram;
    return NULL;
}

static void writeBattery(int force)
{
    uint8_t *ram = s_hasBattery && s_agnes ? sram() : NULL;
    if (!ram || (!force && memcmp(ram, s_lastSram, sizeof s_lastSram) == 0))
        return;
    if (writeFileAtomic(s_savPath, ram, sizeof s_lastSram, NULL, 0))
        memcpy(s_lastSram, ram, sizeof s_lastSram);
    else
        fprintf(stderr, "nes-cc: cannot write %s\n", s_savPath);
}

static void loadBattery(void)
{
    uint8_t *ram = sram();
    size_t n = 0;
    unsigned char *data = readFile(s_savPath, sizeof s_lastSram, &n);
    if (data && n == sizeof s_lastSram) {
        memcpy(ram, data, n);
        fprintf(stderr, "nes-cc: loaded %s\n", s_savPath);
    }
    free(data);
    memcpy(s_lastSram, ram, sizeof s_lastSram);
}

/* ---------------------------------------------------------------- states */

#define STATE_MAGIC "NESCCST1"

static void stateFile(int slot, char *out, size_t size)
{
    snprintf(out, size, "%s.state%d", s_statePrefix, slot);
}

static void saveState(int slot)
{
    char path[MAX_PATH + 16], line[64];
    stateFile(slot, path, sizeof path);
    size_t size = agnes_state_size();
    unsigned char *buf = (unsigned char *)malloc(16 + size);
    if (!buf) {
        snprintf(line, sizeof line, "stateerror %d out of memory", slot);
        emitLine(line);
        return;
    }
    memcpy(buf, STATE_MAGIC, 8);
    uint32_t crc = s_romCrc, n = (uint32_t)size;
    memcpy(buf + 8, &crc, 4);
    memcpy(buf + 12, &n, 4);
    agnes_dump_state(s_agnes, (agnes_state_t *)(buf + 16));
    int ok = writeFileAtomic(path, buf, 16 + size, NULL, 0);
    free(buf);
    if (ok)
        snprintf(line, sizeof line, "saved %d", slot);
    else
        snprintf(line, sizeof line, "stateerror %d cannot write the state file", slot);
    emitLine(line);
}

static void loadState(int slot)
{
    char path[MAX_PATH + 16], line[96];
    stateFile(slot, path, sizeof path);
    size_t size = agnes_state_size(), n = 0;
    unsigned char *buf = readFile(path, 16 + size, &n);
    if (!buf) {
        snprintf(line, sizeof line, "nostate %d", slot);
        emitLine(line);
        return;
    }
    uint32_t crc, stored;
    memcpy(&crc, buf + 8, 4);
    memcpy(&stored, buf + 12, 4);
    if (n != 16 + size || memcmp(buf, STATE_MAGIC, 8) != 0 || crc != s_romCrc || stored != (uint32_t)size) {
        snprintf(line, sizeof line, "stateerror %d state is from another ROM or build", slot);
    } else {
        agnes_restore_state(s_agnes, (const agnes_state_t *)(buf + 16));
        s_forceFrame = 1;
        snprintf(line, sizeof line, "loaded %d", slot);
    }
    free(buf);
    emitLine(line);
}

/* ---------------------------------------------------------------- input */

static int buttonIndex(const char *name)
{
    for (int i = 0; i < BTN_COUNT; i++)
        if (strcmp(name, BUTTON_NAMES[i]) == 0)
            return i;
    return -1;
}

static int isDirection(int b)
{
    return b >= BTN_UP;
}

static int opposite(int b)
{
    switch (b) {
    case BTN_UP: return BTN_DOWN;
    case BTN_DOWN: return BTN_UP;
    case BTN_LEFT: return BTN_RIGHT;
    case BTN_RIGHT: return BTN_LEFT;
    }
    return -1;
}

static void releaseAll(void)
{
    for (int b = 0; b < BTN_COUNT; b++) {
        s_releaseAt[b] = 0;
        s_latched[b] = 0;
    }
}

// A key-down from the terminal. It reports no key-ups and repeats a held key
// after a delay, so a press holds for a while and each repeat extends it.
static void pressKey(int b)
{
    if (b < 0 || s_latched[b])
        return;
    double now = realMs();
    int first = isDirection(b) ? DIR_FIRST_MS : b <= BTN_B ? BTN_FIRST_MS : TAP_MS;
    int repeat = isDirection(b) ? DIR_REPEAT_MS : b <= BTN_B ? BTN_REPEAT_MS : 0;
    if (s_releaseAt[b]) {
        if (repeat && now + repeat > s_releaseAt[b])
            s_releaseAt[b] = now + repeat; // auto-repeat: keep holding
        return;
    }
    s_releaseAt[b] = now + first;
    s_heldFrames[b] = 0;
    s_stamp[b] = s_stampNext++;
    int o = opposite(b);
    if (o >= 0) {
        s_releaseAt[o] = 0;
        s_latched[o] = 0;
    }
}

// A latched button stays down until unlatched: how the terminal, which repeats
// only the last key held, can hold a direction and run while it jumps.
static void latchKey(int b, int isDown)
{
    if (b < 0)
        return;
    s_latched[b] = isDown;
    s_releaseAt[b] = 0;
    if (isDown) {
        s_stamp[b] = s_stampNext++;
        int o = opposite(b);
        if (o >= 0) {
            s_releaseAt[o] = 0;
            s_latched[o] = 0;
        }
    }
}

static void expireKeys(void)
{
    double now = realMs();
    for (int b = 0; b < BTN_COUNT; b++)
        if (s_releaseAt[b] && now >= s_releaseAt[b] && s_heldFrames[b] >= MIN_HOLD_FRAMES)
            s_releaseAt[b] = 0;
}

static int inputMask(void)
{
    int mask = 0, external = s_padMask | s_windowMask;
    for (int b = 0; b < BTN_COUNT; b++) {
        if (s_releaseAt[b] || s_latched[b])
            mask |= 1 << b;
        if ((external & ~s_lastExternal) & (1 << b))
            s_stamp[b] = s_stampNext++;
    }
    s_lastExternal = external;
    mask |= external;
    static const int pairs[2][2] = {{BTN_UP, BTN_DOWN}, {BTN_LEFT, BTN_RIGHT}};
    for (int i = 0; i < 2; i++) {
        int x = pairs[i][0], y = pairs[i][1];
        if ((mask & (1 << x)) && (mask & (1 << y)))
            mask &= ~(1 << (s_stamp[x] > s_stamp[y] ? y : x));
    }
    return mask;
}

static void toAgnes(int mask, agnes_input_t *in)
{
    in->a = (mask >> BTN_A) & 1;
    in->b = (mask >> BTN_B) & 1;
    in->select = (mask >> BTN_SELECT) & 1;
    in->start = (mask >> BTN_START) & 1;
    in->up = (mask >> BTN_UP) & 1;
    in->down = (mask >> BTN_DOWN) & 1;
    in->left = (mask >> BTN_LEFT) & 1;
    in->right = (mask >> BTN_RIGHT) & 1;
}

// Whether the mod wants the game paused (cc_pad.c and the window resume it).
int CC_WantsPause(void)
{
    return s_wantPause;
}

// A button on the controller or in the window resumed the game: tell the mod.
void CC_Resume(void)
{
    if (!s_wantPause)
        return;
    s_wantPause = 0;
    emitLine("play");
}

// A button held or let go in the window: real presses and releases.
void CC_InputButton(int pressed, int b)
{
    if (b < 0 || b >= BTN_COUNT)
        return;
    if (pressed && s_wantPause) {
        CC_Resume();
        s_windowSwallowed |= 1 << b; // the press that resumed does not also act
        return;
    }
    if (!pressed && (s_windowSwallowed & (1 << b))) {
        s_windowSwallowed &= ~(1 << b);
        return;
    }
    if (pressed)
        s_windowMask |= 1 << b;
    else
        s_windowMask &= ~(1 << b);
}

void CC_WindowClosed(void)
{
    s_wantWindow = 0;
    s_windowMask = 0;
    CCW_Close();
    emitLine("window off");
}

/* ---------------------------------------------------------------- control */

static void pollControl(void)
{
    static char buf[16384];
    FILE *f = fopen(s_ctrlPath, "rb");
    if (!f)
        return;
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    if (!strstr(buf, "\nend"))
        return;

    static int lastFileMode = -1, lastFileWindow = -1;
    int cols = s_cols, rows = s_rows, fileMode = -1, fileWindow = -1, maxSeq = s_lastSeq;
    int isQuit = 0;
    char *next = NULL;
    for (char *line = strtok_s(buf, "\r\n", &next); line; line = strtok_s(NULL, "\r\n", &next)) {
        int a, b, held;
        char word[16];
        if (sscanf(line, "size %d %d", &a, &b) == 2) {
            if (a >= 8 && a <= MAX_COLS && b >= 4 && b <= MAX_ROWS) {
                cols = a;
                rows = b;
            }
        } else if (strncmp(line, "quit", 4) == 0) {
            isQuit = 1;
        } else if (sscanf(line, "mode %15s", word) == 1) {
            fileMode = strcmp(word, "play") != 0;
        } else if (sscanf(line, "window %15s", word) == 1) {
            fileWindow = strcmp(word, "on") == 0;
        } else if (sscanf(line, "hd %15s", word) == 1) {
            s_quadrants = strcmp(word, "off") != 0;
        } else if ((line[0] == 'k' && sscanf(line, "k %d %15s", &a, word) == 2) ||
                   (line[0] == 'h' && sscanf(line, "h %d %15s %d", &a, word, &held) == 3) ||
                   (line[0] == 's' && sscanf(line, "save %d %d", &a, &b) == 2) ||
                   (line[0] == 'l' && sscanf(line, "load %d %d", &a, &b) == 2)) {
            // A restarted mod starts its sequence over: treat a big drop as a reset.
            if (a < s_lastSeq - 1000)
                s_lastSeq = 0;
            if (a > s_lastSeq) {
                if (line[0] == 'h')
                    latchKey(buttonIndex(word), held != 0);
                else if (line[0] == 'k')
                    pressKey(buttonIndex(word));
                else if (b >= 1 && b <= 9 && line[0] == 's')
                    saveState(b);
                else if (b >= 1 && b <= 9)
                    loadState(b);
                if (a > maxSeq)
                    maxSeq = a;
            }
        }
    }
    s_lastSeq = maxSeq;
    s_cols = cols;
    s_rows = rows;
    if (fileMode != -1 && fileMode != lastFileMode)
        s_wantPause = lastFileMode = fileMode;
    if (fileWindow != -1 && fileWindow != lastFileWindow)
        s_wantWindow = lastFileWindow = fileWindow;
    if (isQuit) {
        fprintf(stderr, "nes-cc: quit\n");
        quitNow(0);
    }
}

// Pauses or resumes as asked, but only once the game has drawn for a while: a
// helper started paused would otherwise show the pane nothing but black.
static void applyPause(void)
{
    int paused = s_wantPause && s_framesSent >= WARMUP_FRAMES;
    if (paused == s_paused)
        return;
    fprintf(stderr, "nes-cc: %s\n", paused ? "pause" : "play");
    CCW_SetTitle(paused ? "NES - paused: press any key here to play" : "NES");
    if (paused)
        releaseAll();
    s_paused = paused;
}

/* ---------------------------------------------------------------- frames */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64(const unsigned char *in, size_t len, char *out)
{
    size_t o = 0, i = 0;
    for (; i + 2 < len; i += 3) {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
    }
    if (i < len) {
        uint32_t v = in[i] << 16;
        if (i + 1 < len)
            v |= in[i + 1] << 8;
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    return o;
}

static void buildRgb(void)
{
    const uint8_t *screen = s_agnes->ppu.screen_buffer + OVERSCAN * AGNES_SCREEN_WIDTH;
    for (int i = 0; i < SRC_W * SRC_H; i++) {
        agnes_color_t c = g_colors[screen[i] & 0x3f];
        cc_rgb[i] = ((uint32_t)c.r << 16) | ((uint32_t)c.g << 8) | c.b;
    }
}

// Average of the source box [x0,x1) x [y0,y1), as 0x00RRGGBB.
static uint32_t boxAverage(int x0, int x1, int y0, int y1)
{
#ifdef NEAREST
    return cc_rgb[((y0 + y1) / 2) * SRC_W + (x0 + x1) / 2];
#else
    uint32_t r = 0, g = 0, b = 0, n = 0;
    if (x1 <= x0)
        x1 = x0 + 1;
    if (y1 <= y0)
        y1 = y0 + 1;
    for (int y = y0; y < y1; y++) {
        const uint32_t *row = cc_rgb + y * SRC_W;
        for (int x = x0; x < x1; x++) {
            uint32_t p = row[x];
            r += (p >> 16) & 255;
            g += (p >> 8) & 255;
            b += p & 255;
            n++;
        }
    }
    return ((r / n) << 16) | ((g / n) << 8) | (b / n);
#endif
}

// Quadrant glyphs by mask: bit 0 top-left, 1 top-right, 2 bottom-left,
// 3 bottom-right set means that quarter takes the foreground color.
static const uint32_t QUADRANT[16] = {
    0x0020, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B,
    0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588,
};

static int channel(uint32_t c, int shift)
{
    return (c >> shift) & 255;
}

// Packs four pixels into one cell of two colors: of the 7 ways to split them
// in two groups (a mask and its complement are the same split), the one whose
// group averages are nearest the pixels.
static void quadrantCell(const uint32_t quad[4], uint32_t *cell)
{
    long bestError = -1;
    for (int mask = 1; mask < 8; mask++) {
        long sum[2][3] = {{0}}, n[2] = {0};
        for (int i = 0; i < 4; i++) {
            int g = (mask >> i) & 1;
            sum[g][0] += channel(quad[i], 16);
            sum[g][1] += channel(quad[i], 8);
            sum[g][2] += channel(quad[i], 0);
            n[g]++;
        }
        long mean[2][3], error = 0;
        for (int g = 0; g < 2; g++)
            for (int k = 0; k < 3; k++)
                mean[g][k] = n[g] ? sum[g][k] / n[g] : 0;
        for (int i = 0; i < 4; i++) {
            int g = (mask >> i) & 1;
            for (int k = 0; k < 3; k++) {
                long d = channel(quad[i], 16 - 8 * k) - mean[g][k];
                error += d * d;
            }
        }
        if (bestError < 0 || error < bestError) {
            bestError = error;
            cell[0] = QUADRANT[mask];
            cell[1] = (uint32_t)((mean[1][0] << 16) | (mean[1][1] << 8) | mean[1][2]);
            cell[2] = (uint32_t)((mean[0][0] << 16) | (mean[0][1] << 8) | mean[0][2]);
        }
    }
}

// Sends the current picture to the pane. Paused (onlyIfChanged), it sends only
// when the size or the glyph mode changed, or a loaded state replaced it.
static void sendFrame(int onlyIfChanged)
{
    static uint32_t cells[MAX_COLS * MAX_ROWS * 3];
    static char text[MAX_COLS * MAX_ROWS * 12 * 4 / 3 + 64];
    static int lastCols, lastRows, lastQuadrants = -1;
    int cols = s_cols, rows = s_rows, h = rows * 2;

    int isChanged = cols != lastCols || rows != lastRows || s_quadrants != lastQuadrants || s_forceFrame;
    if (onlyIfChanged && !isChanged)
        return;
    s_forceFrame = 0;
    s_framesSent++;
    lastCols = cols;
    lastRows = rows;
    lastQuadrants = s_quadrants;
    buildRgb();

    for (int cy = 0; cy < rows; cy++) {
        for (int cx = 0; cx < cols; cx++) {
            int ya = (cy * 2) * SRC_H / h, yb = (cy * 2 + 1) * SRC_H / h;
            int yc = (cy * 2 + 2) * SRC_H / h;
            uint32_t *cell = cells + (cy * cols + cx) * 3;
            if (!s_quadrants) {
                int x0 = cx * SRC_W / cols, x1 = (cx + 1) * SRC_W / cols;
                cell[0] = 0x2580;
                cell[1] = boxAverage(x0, x1, ya, yb);
                cell[2] = boxAverage(x0, x1, yb, yc);
                continue;
            }
            int w = cols * 2;
            int xa = (cx * 2) * SRC_W / w, xb = (cx * 2 + 1) * SRC_W / w;
            int xc = (cx * 2 + 2) * SRC_W / w;
            uint32_t quad[4] = {
                boxAverage(xa, xb, ya, yb), boxAverage(xb, xc, ya, yb),
                boxAverage(xa, xb, yb, yc), boxAverage(xb, xc, yb, yc),
            };
            quadrantCell(quad, cell);
        }
    }
    size_t len = base64((const unsigned char *)cells, (size_t)cols * rows * 12, text);
    fprintf(stdout, "\001F %d %d ", cols, rows);
    fwrite(text, 1, len, stdout);
    fputc('\n', stdout);
    if (fflush(stdout) != 0)
        quitNow(0); // the mod went away
}

/* ---------------------------------------------------------------- main */

static void exeDir(char *out, size_t size)
{
    GetModuleFileNameA(NULL, out, (DWORD)size);
    char *slash = strrchr(out, '\\');
    if (slash)
        *slash = 0;
}

static void setupSaves(const char *romPath, const char *savDir)
{
    char dir[MAX_PATH];
    if (savDir) {
        snprintf(dir, sizeof dir, "%s", savDir);
    } else {
        char exe[MAX_PATH];
        exeDir(exe, sizeof exe);
        snprintf(dir, sizeof dir, "%s\\..\\run\\saves", exe);
    }
    mkdirs(dir);

    const char *base = romPath;
    for (const char *p = romPath; *p; p++)
        if (*p == '\\' || *p == '/')
            base = p + 1;
    char name[MAX_PATH];
    snprintf(name, sizeof name, "%s", base);
    char *dot = strrchr(name, '.');
    if (dot && _stricmp(dot, ".nes") == 0)
        *dot = 0;
    snprintf(s_statePrefix, sizeof s_statePrefix, "%s/%s-%08x", dir, name, s_romCrc);
    snprintf(s_savPath, sizeof s_savPath, "%s.sav", s_statePrefix);
}

int main(int argc, char **argv)
{
    const char *romPath = NULL, *savDir = NULL;
    for (int i = 1; i < argc; i++) {
        if (i + 1 < argc && strcmp(argv[i], "-rom") == 0)
            romPath = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "-ctrl") == 0)
            s_ctrlPath = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "-sav") == 0)
            savDir = argv[++i];
        else
            romPath = NULL, i = argc;
    }
    if (!romPath || !s_ctrlPath) {
        fprintf(stderr, "usage: nes-cc -rom <path> -ctrl <control file> [-sav <dir>]\n");
        return 2;
    }

    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, NULL, _IOFBF, 1 << 20);
    QueryPerformanceFrequency(&s_freq);
    QueryPerformanceCounter(&s_start);
    timeBeginPeriod(1);

    char line[600];
    s_rom = readFile(romPath, MAX_ROM, &s_romSize);
    if (!s_rom) {
        snprintf(line, sizeof line, "cannot read ROM %s", romPath);
        fail(3, line);
    }
    if (s_romSize < 16 || memcmp(s_rom, "NES\x1a", 4) != 0)
        fail(4, "not an iNES ROM (.nes)");
    s_romCrc = crc32(s_rom, s_romSize);

    unsigned char *h = s_rom;
    s_mapper = (h[6] >> 4) | (h[7] & 0xF0);
    if ((h[7] & 0x0C) != 0x08 && (h[12] | h[13] | h[14] | h[15])) {
        // A dirty header ("DiskDude!"): its byte 7 is junk, not the mapper's high bits.
        s_mapper = h[6] >> 4;
        h[7] &= 0x0F;
    }
    int battery = (h[6] & 2) != 0;
    if (s_mapper != 0 && s_mapper != 1 && s_mapper != 2 && s_mapper != 3 && s_mapper != 4 && s_mapper != 7) {
        snprintf(line, sizeof line, "unsupported mapper %d (nes-pane plays mappers 0, 1, 2, 3, 4 and 7)", s_mapper);
        fail(4, line);
    }
    s_agnes = agnes_make();
    if (!s_agnes || !agnes_load_ines_data(s_agnes, s_rom, s_romSize))
        fail(4, "ROM could not be loaded");

    setupSaves(romPath, savDir);
    s_hasBattery = battery && (s_mapper == 1 || s_mapper == 4);
    if (s_hasBattery)
        loadBattery();

    snprintf(line, sizeof line, "ready mapper %d battery %d", s_mapper, battery);
    emitLine(line);
    fprintf(stderr, "nes-cc: %s, %s\n", line, romPath);

    pollControl();

    double next = realMs(), lastPoll = -POLL_MS, lastActive = -3000, lastBattery = 0;
    unsigned emulated = 0;
    for (;;) {
        double now = realMs();
        if (now - lastPoll >= POLL_MS) {
            pollControl();
            lastPoll = now;
            // The mod pauses after a while without keys; it sees none of the
            // controller's, so say it is in use every few seconds.
            s_padMask = CC_PadPoll();
            if (s_padMask && now - lastActive >= 3000) {
                lastActive = now;
                emitLine("input");
            }
        }
        if (s_wantWindow && !CCW_IsOpen()) {
            buildRgb();
            CCW_Open();
            CCW_SetTitle(s_paused ? "NES - paused: press any key here to play" : "NES");
            CCW_Present();
        } else if (!s_wantWindow && CCW_IsOpen()) {
            s_windowMask = 0;
            CCW_Close();
        }
        CCW_Pump();
        applyPause();
        if (now - lastBattery >= 5000) {
            lastBattery = now;
            writeBattery(0);
        }
        if (s_paused) {
            if (s_forceFrame && CCW_IsOpen()) {
                buildRgb();
                CCW_Present();
            }
            sendFrame(1); // only when the pane's size changed
            Sleep(20);
            next = realMs();
            continue;
        }
        while (now >= next) {
            expireKeys();
            int mask = inputMask();
            agnes_input_t in;
            toAgnes(mask, &in);
            agnes_set_input(s_agnes, &in, NULL);
            if (!agnes_next_frame(s_agnes))
                fail(5, "the game's CPU stopped (jam)");
            for (int b = 0; b < BTN_COUNT; b++)
                if (mask & (1 << b))
                    s_heldFrames[b]++;
            emulated++;
            next += FRAME_PERIOD_MS;
            if (now - next > 100)
                next = now; // fell behind: drop the time, do not burst
            if (emulated % 2 == 0)
                sendFrame(0);
            if (CCW_IsOpen()) {
                buildRgb();
                CCW_Present();
            }
        }
        Sleep(1);
    }
}
