@echo off
rem frizzctl for a Windows shell that is not Git Bash (cmd, PowerShell). See frizzctl, beside this
rem file, for why FRIZZ_NODE is tried before a bare node.
if defined FRIZZ_NODE if exist "%FRIZZ_NODE%" (
  "%FRIZZ_NODE%" "%~dp0frizzctl.mjs" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0frizzctl.mjs" %*
exit /b %ERRORLEVEL%
