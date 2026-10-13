@echo off
rem ntwinectl for a Windows shell that is not Git Bash (cmd, PowerShell). See ntwinectl, beside this
rem file, for why NTWINE_NODE is tried before a bare node.
if defined NTWINE_NODE if exist "%NTWINE_NODE%" (
  "%NTWINE_NODE%" "%~dp0ntwinectl.mjs" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0ntwinectl.mjs" %*
exit /b %ERRORLEVEL%
