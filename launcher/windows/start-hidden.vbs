' Runs the dashboard server without a console window and (with --open) opens the browser.
' Used by the desktop shortcut and the startup shortcut created by install.bat.
Option Explicit
Dim fso, sh, root, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
sh.CurrentDirectory = root
sh.Run "cmd /c node --disable-warning=ExperimentalWarning server\server.js" & args & " >> data\server.log 2>&1", 0, False
