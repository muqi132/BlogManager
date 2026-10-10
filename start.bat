@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "PYPI=https://pypi.tuna.tsinghua.edu.cn/simple"
set "VENV_PY=%CD%\.venv\Scripts\python.exe"
set "VENV_PYW=%CD%\.venv\Scripts\pythonw.exe"
set "BASE_PY="
set "RUN_PY="

if exist "%VENV_PY%" (
  "%VENV_PY%" -m pip --version >nul 2>&1
  if errorlevel 1 (
    echo [Blog Manager] 虚拟环境损坏，正在重建...
    rmdir /s /q ".venv" >nul 2>&1
  )
)

if not exist "%VENV_PY%" (
  where py >nul 2>&1
  if not errorlevel 1 set "BASE_PY=py"
)

if not exist "%VENV_PY%" if not defined BASE_PY (
  where python >nul 2>&1
  if not errorlevel 1 set "BASE_PY=python"
)

if not exist "%VENV_PY%" if not defined BASE_PY (
  echo.
  echo [Blog Manager] 未检测到 Python。
  echo 请安装 Python 3.10 或更高版本，并在安装时勾选 Add Python to PATH。
  echo 即将打开 Python 官方下载页面。
  start "" "https://www.python.org/downloads/windows/"
  echo.
  pause
  exit /b 1
)

if not exist "%VENV_PY%" (
  echo [1/3] 正在创建独立 Python 环境...
  if /I "%BASE_PY%"=="py" (
    py -3 -m venv ".venv"
  ) else (
    python -m venv ".venv"
  )
  if not exist "%VENV_PY%" (
    echo.
    echo [Blog Manager] 无法创建 .venv 虚拟环境。
    echo 请确认 Python 安装完整，并且当前目录具有写入权限。
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/3] 已检测到独立 Python 环境。
)

set "RUN_PY=%VENV_PY%"
if not exist "%RUN_PY%" (
  echo [Blog Manager] 虚拟环境中的 python.exe 不存在。
  pause
  exit /b 1
)

echo [2/3] 正在检查并更新运行依赖...
set "PIP_OK="
"%RUN_PY%" -m pip install --disable-pip-version-check -r requirements.txt -i "%PYPI%" >nul 2>&1
if not errorlevel 1 set "PIP_OK=1"

if not defined PIP_OK (
  echo [Blog Manager] 国内镜像暂不可用，正在回退到官方 PyPI...
  "%RUN_PY%" -m pip install --disable-pip-version-check -r requirements.txt >nul 2>&1
  if not errorlevel 1 set "PIP_OK=1"
)

if not defined PIP_OK (
  "%RUN_PY%" -c "import flask, ruamel.yaml; from importlib.metadata import version; assert tuple(map(int, version('Werkzeug').split('.'))) >= (3,1,9); assert tuple(map(int, version('Jinja2').split('.'))) >= (3,1,6)" >nul 2>&1
  if not errorlevel 1 set "PIP_OK=1"
)

if not defined PIP_OK (
  echo.
  echo [Blog Manager] 依赖安装失败。
  echo 请检查网络连接，或手动确认 Python 可以访问 PyPI。
  echo.
  pause
  exit /b 1
)

"%RUN_PY%" -B -c "import app" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Blog Manager] 程序启动检查失败。
  echo 请确认 app.py 和 static、templates 目录完整，然后重新运行 start.bat。
  echo.
  pause
  exit /b 1
)

echo [3/3] 正在启动 Blog Manager...
set "PYTHONUTF8=1"
if exist "%VENV_PYW%" (
  start "" "%VENV_PYW%" "%CD%\app.py"
) else (
  start "" "%RUN_PY%" "%CD%\app.py"
)

exit /b 0
