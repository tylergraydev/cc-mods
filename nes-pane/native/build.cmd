@echo off
rem Builds nes-cc.exe with MSVC into ..\bin (or the folder given).
setlocal
set OUT=%~1
if "%OUT%"=="" set OUT=%~dp0..\bin
rem A long inherited PATH overflows vcvars; start it from a clean one.
set "PATH=%SystemRoot%\system32;%SystemRoot%;%ProgramFiles(x86)%\Microsoft Visual Studio\Installer"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%~dp0obj" mkdir "%~dp0obj"
if not exist "%OUT%" mkdir "%OUT%"
pushd "%~dp0obj"
cl -nologo -O2 -MT -W3 -std:c11 -DNDEBUG -D_CRT_SECURE_NO_WARNINGS -I..\agnes ..\nes-cc.c ..\cc_pad.c ..\cc_window.c -Fe"%OUT%\nes-cc.exe" user32.lib gdi32.lib xinput9_1_0.lib winmm.lib
set ERR=%ERRORLEVEL%
popd
exit /b %ERR%
