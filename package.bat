@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Blog Manager 打包工具

cd /d "%~dp0"

set "ROOT=%CD%"
set "DIST=%ROOT%\dist"
set "TEMP_PACKAGE=%DIST%\_temp_package"

echo.
echo ========================================
echo   Blog Manager 打包工具
echo ========================================
echo.

echo [1/4] 准备打包目录...
if not exist "%DIST%" (
  mkdir "%DIST%" >nul 2>&1
  if not exist "%DIST%" (
    echo [错误] 无法创建 dist 目录：
    echo %DIST%
    echo.
    pause
    exit /b 1
  )
)

if exist "%TEMP_PACKAGE%" (
  rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  if exist "%TEMP_PACKAGE%" (
    echo [错误] 无法清理旧的临时目录：
    echo %TEMP_PACKAGE%
    echo 请关闭占用该目录的程序后重试。
    echo.
    pause
    exit /b 1
  )
)

mkdir "%TEMP_PACKAGE%" >nul 2>&1
if not exist "%TEMP_PACKAGE%" (
  echo [错误] 无法创建临时打包目录：
  echo %TEMP_PACKAGE%
  echo.
  pause
  exit /b 1
)

echo [2/4] 复制项目文件...
robocopy "%ROOT%" "%TEMP_PACKAGE%" /E /XD ".venv" "__pycache__" ".git" "dist" "node_modules" ".e2e-yaml-probe" ".userdata" ".deps" ".testblog" ".blogmanager-trash" /XF "*.pyc" "*.log" "config.json" "settings.json" "*.blogmanager.bak" "*.blogmanager.tmp" "*.bak" "*.tmp" "push.bat" "package-lock.json" >nul
set "ROBOCOPY_CODE=%ERRORLEVEL%"

if %ROBOCOPY_CODE% GEQ 8 (
  echo [错误] 复制项目文件失败，robocopy 返回代码：%ROBOCOPY_CODE%
  if exist "%TEMP_PACKAGE%" rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  echo.
  pause
  exit /b 1
)

echo [3/4] 生成日期和压缩包...
set "DATE_TAG="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"`) do set "DATE_TAG=%%D"

if not defined DATE_TAG (
  echo [错误] 无法获取当前日期。
  if exist "%TEMP_PACKAGE%" rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  echo.
  pause
  exit /b 1
)

set "ZIP_FILE=%DIST%\BlogManager_%DATE_TAG%.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%TEMP_PACKAGE%\*' -DestinationPath '%ZIP_FILE%' -Force"
if errorlevel 1 (
  echo [错误] 压缩文件失败。
  echo 目标文件：%ZIP_FILE%
  if exist "%TEMP_PACKAGE%" rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  echo.
  pause
  exit /b 1
)


if not exist "%ZIP_FILE%" (
  echo [错误] 压缩包未生成：
  echo %ZIP_FILE%
  if exist "%TEMP_PACKAGE%" rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('%ZIP_FILE%'); $sep=[string][char]92; $bad=@($z.Entries | ForEach-Object { $_.FullName.Replace($sep,'/') } | Where-Object { $_ -match '(?i)(^|/)(\.venv|\.git|\.userdata|\.deps|\.testblog|\.blogmanager-trash|__pycache__|dist|logs|node_modules|\.e2e[^/]*)(/|$)|(^|/)(config\.json|settings\.json|push\.bat|package-lock\.json)$|\.(pyc|log|bak|tmp)$' } | Sort-Object -Unique); $z.Dispose(); if($bad.Count -gt 0){ Write-Host ('[错误] 压缩包包含敏感文件：' + ($bad -join ', ')); exit 1 }"
if errorlevel 1 (
  echo [错误] 打包后检测到敏感文件，已删除压缩包。
  if exist "%ZIP_FILE%" del /f /q "%ZIP_FILE%" >nul 2>&1
  if exist "%TEMP_PACKAGE%" rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
  echo.
  pause
  exit /b 1
)

echo [4/4] 清理临时目录...
rmdir /s /q "%TEMP_PACKAGE%" >nul 2>&1
if exist "%TEMP_PACKAGE%" (
  echo [警告] 临时目录未能完全删除：
  echo %TEMP_PACKAGE%
  echo 可以手动删除该目录，不影响已生成的压缩包。
)

echo.
echo ========================================
echo   打包完成
echo ========================================
echo.
echo 生成的压缩包：
echo %ZIP_FILE%
echo.
echo 已排除：.venv、__pycache__、.git、dist、node_modules、.e2e-yaml-probe、.userdata、.deps、.testblog、.blogmanager-trash、push.bat、package-lock.json、config.json、settings.json、*.blogmanager.bak、*.blogmanager.tmp、*.bak、*.tmp、*.pyc、*.log
echo.
pause
exit /b 0
