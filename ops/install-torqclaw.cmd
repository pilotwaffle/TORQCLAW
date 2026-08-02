@echo off
setlocal
title TORQCLAW install
set "ROOT_DIR=%~dp0.."
pushd "%ROOT_DIR%" >nul 2>&1
if errorlevel 1 (
  echo [TORQCLAW] Could not enter the repository directory.
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo [TORQCLAW] Node.js is required. Install Node.js 20.9 or newer.
  popd
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<20||(a===20&&b<9)) process.exit(1)"
if errorlevel 1 (
  echo [TORQCLAW] Node.js 20.9 or newer is required.
  popd
  exit /b 1
)
node ops\install.mjs
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
