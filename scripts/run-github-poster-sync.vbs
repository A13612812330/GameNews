Option Explicit
Dim shell, target, command, result
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
target = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & target & """"
' Wait for completion so Task Scheduler receives the actual uploader exit code.
result = shell.Run(command, 0, True)
WScript.Quit result
