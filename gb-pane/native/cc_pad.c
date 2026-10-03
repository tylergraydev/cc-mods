// cc_pad: an XInput (Xbox-style) controller, read straight from Windows so it
// works whichever window has the focus and, unlike the terminal, reports every
// button held at once and its release. Adapted from doom-pane's cc_pad.c.
//
// CC_PadPoll returns the Game Boy buttons the controller holds as a bitmask
// (the bit order of gb-cc.c: A, B, Select, Start, Up, Down, Left, Right). A button
// newly pressed while the game is paused resumes it instead (CC_Resume) and is
// held back from the game until it is let go.

#include <windows.h>
#include <xinput.h>

int CC_WantsPause(void);
void CC_Resume(void);

#define GB_A (1 << 0)
#define GB_B (1 << 1)
#define GB_SELECT (1 << 2)
#define GB_START (1 << 3)
#define GB_UP (1 << 4)
#define GB_DOWN (1 << 5)
#define GB_LEFT (1 << 6)
#define GB_RIGHT (1 << 7)

#define STICK_DEADZONE 9000 /* the stick turns a direction on past this */
#define STICK_OFF 7000      /* and off again below this, so it does not flicker */
#define RECHECK_MS 2000

static int s_pad = -1; // the connected controller's slot
static DWORD s_lastSearch;
static int s_stick;    // directions the left stick holds now
static int s_last;     // buttons held at the last poll
static int s_swallowed;

// Finds a connected controller; asking an empty slot is slow, so a search
// runs at most every RECHECK_MS while none is connected.
static int connected(XINPUT_STATE *state)
{
    if (s_pad >= 0 && XInputGetState(s_pad, state) == ERROR_SUCCESS)
        return 1;
    s_pad = -1;
    DWORD now = GetTickCount();
    if (now - s_lastSearch < RECHECK_MS)
        return 0;
    s_lastSearch = now;
    for (int i = 0; i < XUSER_MAX_COUNT; i++)
        if (XInputGetState(i, state) == ERROR_SUCCESS) {
            s_pad = i;
            return 1;
        }
    return 0;
}

static int axis(int held, int bitNeg, int bitPos, int value)
{
    int limitPos = (held & bitPos) ? STICK_OFF : STICK_DEADZONE;
    int limitNeg = (held & bitNeg) ? STICK_OFF : STICK_DEADZONE;
    if (value > limitPos)
        return bitPos;
    if (value < -limitNeg)
        return bitNeg;
    return 0;
}

/** Reads the controller: the Game Boy buttons it holds, less any that resumed the game. */
int CC_PadPoll(void)
{
    XINPUT_STATE state;
    int mask = 0;
    if (connected(&state)) {
        const XINPUT_GAMEPAD *pad = &state.Gamepad;
        WORD b = pad->wButtons;
        s_stick = axis(s_stick, GB_DOWN, GB_UP, pad->sThumbLY) | axis(s_stick, GB_LEFT, GB_RIGHT, pad->sThumbLX);
        mask = s_stick;
        if (b & XINPUT_GAMEPAD_DPAD_UP) mask |= GB_UP;
        if (b & XINPUT_GAMEPAD_DPAD_DOWN) mask |= GB_DOWN;
        if (b & XINPUT_GAMEPAD_DPAD_LEFT) mask |= GB_LEFT;
        if (b & XINPUT_GAMEPAD_DPAD_RIGHT) mask |= GB_RIGHT;
        if (b & (XINPUT_GAMEPAD_A | XINPUT_GAMEPAD_Y)) mask |= GB_A;
        if (b & (XINPUT_GAMEPAD_B | XINPUT_GAMEPAD_X)) mask |= GB_B;
        if (b & XINPUT_GAMEPAD_START) mask |= GB_START;
        if (b & XINPUT_GAMEPAD_BACK) mask |= GB_SELECT;
    } else {
        s_stick = 0;
    }

    int pressed = mask & ~s_last;
    s_last = mask;
    if (pressed && CC_WantsPause()) {
        CC_Resume();
        s_swallowed |= pressed;
    }
    s_swallowed &= mask; // a let-go button is no longer held back
    return mask & ~s_swallowed;
}
