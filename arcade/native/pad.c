// arcade-pad: an XInput (Xbox-style) controller helper for the arcade mod.
// Reads the first connected controller straight from Windows (works whichever
// window has the focus) and writes one text line per event to stdout:
//   ready | hello pad=<n> | bye | down <btn> | up <btn> | repeat <btn> | alive
// <btn> is one of: up down left right a b x y lb rb lt rt start back ls rs.
// The left stick is merged into the directions. Directions auto-repeat: the
// first `repeat` 170 ms after `down`, then every 50 ms. `alive` every 2 s;
// when stdout stops accepting writes the parent is gone and the helper exits.

#include <windows.h>
#include <xinput.h>
#include <stdio.h>
#include <string.h>

#define STICK_ON 9000
#define STICK_OFF 7000
#define TRIGGER_THRESHOLD 40
#define RECHECK_MS 2000
#define ALIVE_MS 2000
#define REPEAT_FIRST_MS 170
#define REPEAT_NEXT_MS 50

enum { B_UP, B_DOWN, B_LEFT, B_RIGHT, B_A, B_B, B_X, B_Y, B_LB, B_RB, B_LT, B_RT, B_START, B_BACK, B_LS, B_RS, B_COUNT };
static const char *NAMES[B_COUNT] = { "up", "down", "left", "right", "a", "b", "x", "y", "lb", "rb", "lt", "rt", "start", "back", "ls", "rs" };

static int s_pad = -1;
static DWORD s_lastSearch;
static unsigned s_held;               // bit per button
static DWORD s_nextRepeat[4];         // deadlines for up/down/left/right
static int s_stick[2];                // left stick: x dir, y dir (-1,0,1) with hysteresis

static void emit(const char *a, const char *b)
{
    int ok;
    if (b) ok = fprintf(stdout, "%s %s\n", a, b) > 0;
    else ok = fprintf(stdout, "%s\n", a) > 0;
    if (!ok || fflush(stdout) != 0 || ferror(stdout)) exit(0);
}

// A connected controller; a search of empty slots is slow, so it runs at most
// every RECHECK_MS while none is held.
static int connected(XINPUT_STATE *state)
{
    if (s_pad >= 0) return XInputGetState((DWORD)s_pad, state) == ERROR_SUCCESS;
    DWORD now = GetTickCount();
    if (now - s_lastSearch < RECHECK_MS) return 0;
    s_lastSearch = now;
    for (int i = 0; i < XUSER_MAX_COUNT; i++)
        if (XInputGetState((DWORD)i, state) == ERROR_SUCCESS) {
            s_pad = i;
            char buf[16];
            sprintf(buf, "pad=%d", i);
            emit("hello", buf);
            return 1;
        }
    return 0;
}

static int axis(int cur, int v)
{
    if (cur == 0) return v > STICK_ON ? 1 : v < -STICK_ON ? -1 : 0;
    if (cur > 0) return v > STICK_OFF ? 1 : (v < -STICK_ON ? -1 : 0);
    return v < -STICK_OFF ? -1 : (v > STICK_ON ? 1 : 0);
}

static unsigned maskOf(const XINPUT_GAMEPAD *p)
{
    unsigned m = 0;
    WORD b = p->wButtons;
    s_stick[0] = axis(s_stick[0], p->sThumbLX);
    s_stick[1] = axis(s_stick[1], p->sThumbLY);
    if ((b & XINPUT_GAMEPAD_DPAD_UP) || s_stick[1] > 0) m |= 1u << B_UP;
    if ((b & XINPUT_GAMEPAD_DPAD_DOWN) || s_stick[1] < 0) m |= 1u << B_DOWN;
    if ((b & XINPUT_GAMEPAD_DPAD_LEFT) || s_stick[0] < 0) m |= 1u << B_LEFT;
    if ((b & XINPUT_GAMEPAD_DPAD_RIGHT) || s_stick[0] > 0) m |= 1u << B_RIGHT;
    if (b & XINPUT_GAMEPAD_A) m |= 1u << B_A;
    if (b & XINPUT_GAMEPAD_B) m |= 1u << B_B;
    if (b & XINPUT_GAMEPAD_X) m |= 1u << B_X;
    if (b & XINPUT_GAMEPAD_Y) m |= 1u << B_Y;
    if (b & XINPUT_GAMEPAD_LEFT_SHOULDER) m |= 1u << B_LB;
    if (b & XINPUT_GAMEPAD_RIGHT_SHOULDER) m |= 1u << B_RB;
    if (p->bLeftTrigger > TRIGGER_THRESHOLD) m |= 1u << B_LT;
    if (p->bRightTrigger > TRIGGER_THRESHOLD) m |= 1u << B_RT;
    if (b & XINPUT_GAMEPAD_START) m |= 1u << B_START;
    if (b & XINPUT_GAMEPAD_BACK) m |= 1u << B_BACK;
    if (b & XINPUT_GAMEPAD_LEFT_THUMB) m |= 1u << B_LS;
    if (b & XINPUT_GAMEPAD_RIGHT_THUMB) m |= 1u << B_RS;
    return m;
}

static void apply(unsigned want, DWORD now)
{
    for (int i = 0; i < B_COUNT; i++) {
        unsigned bit = 1u << i;
        int was = (s_held & bit) != 0, is = (want & bit) != 0;
        if (is && !was) {
            emit("down", NAMES[i]);
            if (i <= B_RIGHT) s_nextRepeat[i] = now + REPEAT_FIRST_MS;
        } else if (!is && was) {
            emit("up", NAMES[i]);
        } else if (is && i <= B_RIGHT && (int)(now - s_nextRepeat[i]) >= 0) {
            emit("repeat", NAMES[i]);
            s_nextRepeat[i] = now + REPEAT_NEXT_MS;
        }
    }
    s_held = want;
}

int main(int argc, char **argv)
{
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        puts("arcade-pad 1");
        return 0;
    }
    setvbuf(stdout, NULL, _IONBF, 0);
    timeBeginPeriod(1);
    emit("ready", NULL);
    DWORD lastAlive = GetTickCount();
    for (;;) {
        DWORD now = GetTickCount();
        XINPUT_STATE state;
        if (connected(&state)) {
            apply(maskOf(&state.Gamepad), now);
        } else if (s_pad >= 0) {
            // The held controller went away: release everything, then look again.
            apply(0, now);
            s_stick[0] = s_stick[1] = 0;
            s_pad = -1;
            emit("bye", NULL);
        }
        if (now - lastAlive >= ALIVE_MS) {
            lastAlive = now;
            emit("alive", NULL);
        }
        Sleep(16);
    }
}
