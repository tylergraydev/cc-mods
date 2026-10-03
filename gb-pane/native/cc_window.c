// cc_window: the game in a window of its own at full resolution, beside the
// pane. Adapted from doom-pane's cc_window.c. It reads real key presses and
// releases (the terminal has only presses) and hands them to gb-cc.c through
// CC_InputButton; closing it calls CC_WindowClosed.

#include <windows.h>
#include <stdint.h>

#define SRC_W 160
#define SRC_H 144

enum { BTN_A, BTN_B, BTN_SELECT, BTN_START, BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_COUNT };

extern uint32_t cc_rgb[SRC_W * SRC_H];
void CC_InputButton(int pressed, int button);
void CC_WindowClosed(void);

static HWND s_hwnd;
static BITMAPINFO s_bmi;
static unsigned char s_down[BTN_COUNT]; // buttons held in this window

static int toGbButton(WPARAM vk, LPARAM lParam)
{
    switch (vk) {
    case VK_UP: return BTN_UP;
    case VK_DOWN: return BTN_DOWN;
    case VK_LEFT: return BTN_LEFT;
    case VK_RIGHT: return BTN_RIGHT;
    case 'Z': case 'J': return BTN_B;
    case 'X': case 'K': return BTN_A;
    case VK_RETURN: return BTN_START;
    case VK_BACK: return BTN_SELECT;
    case VK_SHIFT:
        // Right shift only (scan code 0x36): Select, as on many emulators.
        return ((lParam >> 16) & 0xFF) == 0x36 ? BTN_SELECT : -1;
    }
    return -1;
}

static void releaseHeld(void)
{
    for (int b = 0; b < BTN_COUNT; b++)
        if (s_down[b]) {
            s_down[b] = 0;
            CC_InputButton(0, b);
        }
}

// Draws the 160x144 frame at 10:9 (square pixels), letterboxed in black.
static void paint(HDC dc)
{
    RECT client;
    GetClientRect(s_hwnd, &client);
    int cw = client.right, ch = client.bottom;
    int w = cw, h = cw * 9 / 10;
    if (h > ch) {
        h = ch;
        w = ch * 10 / 9;
    }
    int x = (cw - w) / 2, y = (ch - h) / 2;
    HBRUSH black = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RECT bars[4] = {{0, 0, cw, y}, {0, y + h, cw, ch}, {0, y, x, y + h}, {x + w, y, cw, y + h}};
    for (int i = 0; i < 4; i++)
        FillRect(dc, &bars[i], black);
    SetStretchBltMode(dc, COLORONCOLOR);
    StretchDIBits(dc, x, y, w, h, 0, 0, SRC_W, SRC_H, cc_rgb, &s_bmi, DIB_RGB_COLORS, SRCCOPY);
}

static LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN: {
        if (msg == WM_SYSKEYDOWN && wParam == VK_F4)
            break; // alt+F4 closes
        int b = toGbButton(wParam, lParam);
        if (b >= 0 && !(lParam & (1 << 30))) { // not an auto-repeat
            s_down[b] = 1;
            CC_InputButton(1, b);
        }
        return 0;
    }
    case WM_KEYUP:
    case WM_SYSKEYUP: {
        int b = toGbButton(wParam, lParam);
        if (b >= 0 && s_down[b]) {
            s_down[b] = 0;
            CC_InputButton(0, b);
        }
        return 0;
    }
    case WM_KILLFOCUS:
        releaseHeld();
        return 0;
    case WM_ERASEBKGND:
        return 1;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        paint(dc);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_CLOSE:
        CC_WindowClosed();
        return 0;
    }
    return DefWindowProcA(hwnd, msg, wParam, lParam);
}

int CCW_IsOpen(void)
{
    return s_hwnd != NULL;
}

void CCW_Open(void)
{
    static int isRegistered;
    if (s_hwnd)
        return;
    if (!isRegistered) {
        WNDCLASSA wc = {0};
        wc.lpfnWndProc = windowProc;
        wc.hInstance = GetModuleHandleA(NULL);
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.lpszClassName = "GbPaneWindow";
        RegisterClassA(&wc);
        isRegistered = 1;
    }
    s_bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    s_bmi.bmiHeader.biWidth = SRC_W;
    s_bmi.bmiHeader.biHeight = -SRC_H; // top-down rows
    s_bmi.bmiHeader.biPlanes = 1;
    s_bmi.bmiHeader.biBitCount = 32;
    s_bmi.bmiHeader.biCompression = BI_RGB;

    // 4x the 160x144 picture: 640x576.
    RECT rect = {0, 0, 640, 576};
    AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
    s_hwnd = CreateWindowExA(0, "GbPaneWindow", "Game Boy", WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT,
                             CW_USEDEFAULT, rect.right - rect.left, rect.bottom - rect.top, NULL, NULL,
                             GetModuleHandleA(NULL), NULL);
    SetForegroundWindow(s_hwnd);
}

void CCW_Close(void)
{
    if (!s_hwnd)
        return;
    releaseHeld();
    DestroyWindow(s_hwnd);
    s_hwnd = NULL;
}

void CCW_SetTitle(const char *title)
{
    if (s_hwnd)
        SetWindowTextA(s_hwnd, title);
}

// Draws the current frame now.
void CCW_Present(void)
{
    if (!s_hwnd)
        return;
    HDC dc = GetDC(s_hwnd);
    paint(dc);
    ReleaseDC(s_hwnd, dc);
}

// Handles the window's pending messages; call it often, paused or not.
void CCW_Pump(void)
{
    MSG msg;
    while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }
}
