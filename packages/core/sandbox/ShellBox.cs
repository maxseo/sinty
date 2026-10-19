using System;
using System.Runtime.InteropServices;

static class ShellBox {
  const int SE_FILE_OBJECT = 1;
  const int DACL_SECURITY_INFORMATION = 4;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;

  static int Main(string[] args) {
    var name = "Sinty.Shell";
    IntPtr sid;
    var hr = CreateAppContainerProfile(name, name, "Sinty command cage", IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (hr != 0) return Fail("profile " + hr.ToString("X"));
    if (args.Length > 0 && args[0] == "--sid") {
      IntPtr str;
      ConvertSidToStringSid(sid, out str);
      Console.WriteLine(Marshal.PtrToStringUni(str));
      return 0;
    }
    string cwd = null, tools = null;
    var commandAt = -1;
    for (var i = 0; i < args.Length; i++) {
      if (args[i] == "--cwd" && i + 1 < args.Length) cwd = args[++i];
      else if (args[i] == "--tools" && i + 1 < args.Length) tools = args[++i];
      else if (args[i] == "--command") { commandAt = i + 1; break; }
    }
    if (cwd == null || commandAt < 0 || commandAt >= args.Length) return Fail("usage");
    var command = string.Join(" ", args, commandAt, args.Length - commandAt);
    if (!string.IsNullOrEmpty(tools)) {
      Grant(tools, sid);
      command = "set \"PATH=" + tools + ";%PATH%\" && " + command;
    }
    Grant(cwd, sid);

    var size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    var list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) return Fail("attr " + Marshal.GetLastWin32Error());
    var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
    var capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(caps));
    Marshal.StructureToPtr(caps, capsPtr, false);
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capsPtr, (IntPtr)Marshal.SizeOf(caps), IntPtr.Zero, IntPtr.Zero))
      return Fail("update " + Marshal.GetLastWin32Error());

    var si = new STARTUPINFOEX { StartupInfo = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFOEX)) }, lpAttributeList = list };
    var pi = new PROCESS_INFORMATION();
    var cmd = "cmd.exe /d /s /c " + command;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi))
      return Fail("start " + Marshal.GetLastWin32Error());
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;
  }

  static void Grant(string dir, IntPtr sid) {
    IntPtr sidStr;
    ConvertSidToStringSid(sid, out sidStr);
    var text = Marshal.PtrToStringUni(sidStr);
    var psi = new System.Diagnostics.ProcessStartInfo("icacls", "\"" + dir + "\" /grant *" + text + ":(OI)(CI)M /C /Q") { CreateNoWindow = true, UseShellExecute = false };
    System.Diagnostics.Process.Start(psi).WaitForExit();
  }

  static int Fail(string msg) { Console.Error.WriteLine(msg); return 2; }

  struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string n, string d, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string n, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
}
