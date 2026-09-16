// Thin Win32 bindings via koffi. Loaded lazily so the app can still start on
// non-Windows machines (dev/preview mode) — every export is null there.
'use strict';

const isWin = process.platform === 'win32';

let koffi = null;
let user32 = null;
let kernel32 = null;

function load() {
  if (!isWin) return null;
  if (user32) return module.exports;
  koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  kernel32 = koffi.load('kernel32.dll');

  const fn = (lib, name, ret, args) => lib.func('__stdcall', name, ret, args);

  Object.assign(module.exports, {
    koffi,
    FindWindowW: fn(user32, 'FindWindowW', 'uint64', ['str16', 'str16']),
    FindWindowExW: fn(user32, 'FindWindowExW', 'uint64', ['uint64', 'uint64', 'str16', 'str16']),
    SendMessageTimeoutW: fn(user32, 'SendMessageTimeoutW', 'uint64', ['uint64', 'uint32', 'uint64', 'uint64', 'uint32', 'uint32', 'void *']),
    SetParent: fn(user32, 'SetParent', 'uint64', ['uint64', 'uint64']),
    SetWindowPos: fn(user32, 'SetWindowPos', 'bool', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32']),
    MoveWindow: fn(user32, 'MoveWindow', 'bool', ['uint64', 'int', 'int', 'int', 'int', 'bool']),
    GetSystemMetrics: fn(user32, 'GetSystemMetrics', 'int', ['int']),
    IsWindow: fn(user32, 'IsWindow', 'bool', ['uint64']),
    IsWindowVisible: fn(user32, 'IsWindowVisible', 'bool', ['uint64']),
    ShowWindow: fn(user32, 'ShowWindow', 'bool', ['uint64', 'int']),
    GetWindowLongPtrW: fn(user32, 'GetWindowLongPtrW', 'int64', ['uint64', 'int']),
    SetWindowLongPtrW: fn(user32, 'SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64']),
    SystemParametersInfoW: fn(user32, 'SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'void *', 'uint32']),
    InvalidateRect: fn(user32, 'InvalidateRect', 'bool', ['uint64', 'void *', 'bool']),
    GetWindowRect: fn(user32, 'GetWindowRect', 'bool', ['uint64', 'void *']),
    GetForegroundWindow: fn(user32, 'GetForegroundWindow', 'uint64', []),
    GetClassNameW: fn(user32, 'GetClassNameW', 'int', ['uint64', 'void *', 'int']),
    GetWindowThreadProcessId: fn(user32, 'GetWindowThreadProcessId', 'uint32', ['uint64', 'void *']),
    GetMonitorInfoW: fn(user32, 'GetMonitorInfoW', 'bool', ['uint64', 'void *']),
    OpenProcess: fn(kernel32, 'OpenProcess', 'uint64', ['uint32', 'bool', 'uint32']),
    CloseHandle: fn(kernel32, 'CloseHandle', 'bool', ['uint64']),
    QueryFullProcessImageNameW: fn(kernel32, 'QueryFullProcessImageNameW', 'bool', ['uint64', 'uint32', 'void *', 'void *']),
  });

  // Callback prototypes
  const EnumWindowsProc = koffi.proto('__stdcall', 'EnumWindowsProc', 'bool', ['uint64', 'int64']);
  const MonitorEnumProc = koffi.proto('__stdcall', 'MonitorEnumProc', 'bool', ['uint64', 'uint64', 'void *', 'int64']);
  const WinEventProc = koffi.proto('__stdcall', 'WinEventProc', 'void', ['uint64', 'uint32', 'uint64', 'int32', 'int32', 'uint32', 'uint32']);
  Object.assign(module.exports, {
    EnumWindowsProc, MonitorEnumProc, WinEventProc,
    EnumWindows: fn(user32, 'EnumWindows', 'bool', [koffi.pointer(EnumWindowsProc), 'int64']),
    EnumDisplayMonitors: fn(user32, 'EnumDisplayMonitors', 'bool', ['uint64', 'void *', koffi.pointer(MonitorEnumProc), 'int64']),
    SetWinEventHook: fn(user32, 'SetWinEventHook', 'uint64', ['uint32', 'uint32', 'uint64', koffi.pointer(WinEventProc), 'uint32', 'uint32', 'uint32']),
    UnhookWinEvent: fn(user32, 'UnhookWinEvent', 'bool', ['uint64']),
  });
  return module.exports;
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

function readRect(buf) {
  return { l: buf.readInt32LE(0), t: buf.readInt32LE(4), r: buf.readInt32LE(8), b: buf.readInt32LE(12) };
}

function utf16z(buf) {
  return buf.toString('utf16le').replace(/\0.*$/, '');
}

module.exports = { isWin, load, num, readRect, utf16z };
