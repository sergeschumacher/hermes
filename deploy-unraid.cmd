@echo off
REM RecoStream Unraid Deployment Script for Windows
REM Builds Docker image locally, transfers to Unraid, and runs with Intel QSV GPU support

setlocal enabledelayedexpansion

REM =============================================================================
REM CONFIGURATION - EDIT THESE VALUES
REM =============================================================================
set UNRAID_HOST=192.168.10.100
set UNRAID_USER=root
set UNRAID_PASS=
set CONTAINER_NAME=recostream
set IMAGE_NAME=recostream:latest
set HOST_PATH=/mnt/disks/Movies
set DATA_PATH=/recostreamdata/data
set PORT=4000

REM =============================================================================
REM SCRIPT START
REM =============================================================================

echo.
echo ========================================
echo        RecoStream Unraid Deployment
echo ========================================
echo.

REM Check if IP is configured
if "%UNRAID_HOST%"=="192.168.178.xxx" (
    echo ERROR: Please edit this script and set UNRAID_HOST to your Unraid IP address
    exit /b 1
)

REM Check if Docker is available
where docker >nul 2>nul
if errorlevel 1 (
    echo ERROR: Docker is not installed or not in PATH
    exit /b 1
)

REM Prompt for password if not set
if "%UNRAID_PASS%"=="" (
    set /p UNRAID_PASS="Enter password for %UNRAID_USER%@%UNRAID_HOST%: "
)

REM Check if plink/pscp are available (from PuTTY)
where plink >nul 2>nul
if errorlevel 1 (
    echo ERROR: plink not found. Please install PuTTY and add it to PATH
    echo Download from: https://www.putty.org/
    exit /b 1
)

where pscp >nul 2>nul
if errorlevel 1 (
    echo ERROR: pscp not found. Please install PuTTY and add it to PATH
    exit /b 1
)

REM Step 1: Build image for linux/amd64
echo.
echo [1/6] Building Docker image for linux/amd64...
docker buildx build --platform linux/amd64 -f Dockerfile.unraid -t %IMAGE_NAME% --load .
if errorlevel 1 (
    echo ERROR: Failed to build Docker image
    exit /b 1
)
echo OK: Image built

REM Step 2: Save image to tar
echo.
echo [2/6] Saving image to tar archive...
docker save %IMAGE_NAME% -o recostream-image.tar
if errorlevel 1 (
    echo ERROR: Failed to save image
    exit /b 1
)
echo OK: Image saved

REM Step 3: Copy to Unraid
echo.
echo [3/6] Copying image to Unraid (this may take a few minutes)...
pscp -pw %UNRAID_PASS% -batch recostream-image.tar %UNRAID_USER%@%UNRAID_HOST%:/tmp/
if errorlevel 1 (
    echo ERROR: Failed to copy image to Unraid
    del recostream-image.tar 2>nul
    exit /b 1
)
echo OK: Image transferred

REM Step 4: Load image on Unraid
echo.
echo [4/6] Loading image on Unraid...
plink -pw %UNRAID_PASS% -batch %UNRAID_USER%@%UNRAID_HOST% "docker load -i /tmp/recostream-image.tar && rm /tmp/recostream-image.tar"
if errorlevel 1 (
    echo ERROR: Failed to load image on Unraid
    del recostream-image.tar 2>nul
    exit /b 1
)
echo OK: Image loaded

REM Step 5: Stop/remove existing container
echo.
echo [5/6] Stopping existing container (if any)...
plink -pw %UNRAID_PASS% -batch %UNRAID_USER%@%UNRAID_HOST% "docker stop %CONTAINER_NAME% 2>/dev/null || true; docker rm %CONTAINER_NAME% 2>/dev/null || true"
echo OK: Old container removed

REM Step 6: Create data directory and start container
echo.
echo [6/6] Starting container with Intel QSV GPU...
plink -pw %UNRAID_PASS% -batch %UNRAID_USER%@%UNRAID_HOST% "mkdir -p %HOST_PATH%/data && docker run -d --name %CONTAINER_NAME% --restart unless-stopped --device=/dev/dri:/dev/dri -p %PORT%:3000 -v %HOST_PATH%:/recostreamdata -e DATA_PATH=%DATA_PATH% %IMAGE_NAME%"
if errorlevel 1 (
    echo ERROR: Failed to start container
    del recostream-image.tar 2>nul
    exit /b 1
)
echo OK: Container started

REM Cleanup local tar
del recostream-image.tar 2>nul

REM Verify container is running
echo.
echo Verifying deployment...
timeout /t 2 /nobreak >nul
plink -pw %UNRAID_PASS% -batch %UNRAID_USER%@%UNRAID_HOST% "docker inspect -f '{{.State.Status}}' %CONTAINER_NAME%"

echo.
echo ========================================
echo      Deployment Complete!
echo ========================================
echo.
echo RecoStream is now running at: http://%UNRAID_HOST%:%PORT%
echo.
echo First-time setup:
echo   1. Open http://%UNRAID_HOST%:%PORT%/settings
echo   2. Configure your IPTV sources
echo   3. Set Hardware Acceleration to 'vaapi' for Intel QSV
echo.
echo Useful commands (run via PuTTY or SSH):
echo   View logs:  docker logs -f %CONTAINER_NAME%
echo   Stop:       docker stop %CONTAINER_NAME%
echo   Start:      docker start %CONTAINER_NAME%
echo   Restart:    docker restart %CONTAINER_NAME%
echo.

endlocal
