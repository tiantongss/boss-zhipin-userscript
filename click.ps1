param([int]$x, [int]$y)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, IntPtr e);
}
'@
[U32]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 150
[U32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[U32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
"OK"
