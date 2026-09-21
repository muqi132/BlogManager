@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "BASE_PY="
set "RUN_PY="

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m pip --version >nul 2>&1
  if not errorlevel 1 set "RUN_PY=%CD%\.venv\Scripts\python.exe"
)

if not defined RUN_PY (
  where py >nul 2>&1
  if not errorlevel 1 set "BASE_PY=py"
)

if not defined RUN_PY if not defined BASE_PY (
  where python >nul 2>&1
  if not errorlevel 1 set "BASE_PY=python"
)

if not defined RUN_PY if not defined BASE_PY (
  echo.
  echo [Blog Manager] 未检测到 Python。
  echo 请先安装 Python 3.10 或更高版本。
  echo.
  pause
  exit /b 1
)

if not defined RUN_PY (
  echo [Blog Manager] 首次运行，正在尝试创建独立 Python 环境...
  "%BASE_PY%" -m venv ".venv" >nul 2>&1
  if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m pip --version >nul 2>&1
    if not errorlevel 1 set "RUN_PY=%CD%\.venv\Scripts\python.exe"
  )
)

if not defined RUN_PY set "RUN_PY=%BASE_PY%"

"%RUN_PY%" -c "import flask, ruamel.yaml" >nul 2>&1
if errorlevel 1 (
  echo [Blog Manager] 正在安装运行依赖...
  "%RUN_PY%" -m pip install --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    echo [Blog Manager] 重试用户级安装...
    "%RUN_PY%" -m pip install --user --disable-pip-version-check -r requirements.txt
  )
  if errorlevel 1 (
    echo.
    echo [Blog Manager] 依赖安装失败，请检查网络后重新运行 start.bat。
    echo.
    pause
    exit /b 1
  )
)

if exist ".venv\Scripts\pythonw.exe" if defined RUN_PY (
  echo "%RUN_PY%" | find /I ".venv" >nul
  if not errorlevel 1 (
    start "" "%CD%\.venv\Scripts\pythonw.exe" "%CD%\app.py"
    exit /b 0
  )
)

if /I "%BASE_PY%"=="py" (
  where pyw >nul 2>&1
  if not errorlevel 1 (
    start "" pyw "%CD%\app.py"
    exit /b 0
  )
)

where pythonw >nul 2>&1
if not errorlevel 1 (
  start "" pythonw "%CD%\app.py"
  exit /b 0
)

"%RUN_PY%" "%CD%\app.py"
